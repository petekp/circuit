import type { z } from 'zod';

import type { ReportFileSurfaceDeclaration } from '../schemas/report-file-surface.js';
import type {
  CompiledFlowPackage,
  CompiledFlowRelayReport,
  CompiledFlowReportSchema,
} from './types.js';

type FlowWriters = CompiledFlowPackage['writers'];

export type FlowReportChannel = 'relay' | 'report';

export interface FlowReportDeclaration {
  readonly schemaName: string;
  readonly channel: FlowReportChannel;
  readonly schema: z.ZodTypeAny;
  readonly relayHint?: string;
  readonly crossReportValidate?: CompiledFlowRelayReport['crossReportValidate'];
  readonly fileSurface?: ReportFileSurfaceDeclaration;
  readonly writers?: Partial<FlowWriters>;
}

export interface FlowReportDeclarationProjection {
  readonly relayReports: readonly CompiledFlowRelayReport[];
  readonly reportSchemas: readonly CompiledFlowReportSchema[];
  readonly reportFileSurfaces: Readonly<Record<string, ReportFileSurfaceDeclaration>>;
  readonly writers: FlowWriters;
}

export function projectFlowReportDeclarations(
  declarations: readonly FlowReportDeclaration[],
): FlowReportDeclarationProjection {
  const relayReports: CompiledFlowRelayReport[] = [];
  const reportSchemas: CompiledFlowReportSchema[] = [];
  const compose: FlowWriters['compose'][number][] = [];
  const close: FlowWriters['close'][number][] = [];
  const verification: FlowWriters['verification'][number][] = [];
  const checkpoint: FlowWriters['checkpoint'][number][] = [];
  const reportFileSurfaces: Record<string, ReportFileSurfaceDeclaration> = {};

  for (const declaration of declarations) {
    if (declaration.channel === 'relay') {
      relayReports.push({
        schemaName: declaration.schemaName,
        schema: declaration.schema,
        ...(declaration.relayHint === undefined ? {} : { relayHint: declaration.relayHint }),
        ...(declaration.crossReportValidate === undefined
          ? {}
          : { crossReportValidate: declaration.crossReportValidate }),
      });
    } else {
      reportSchemas.push({
        schemaName: declaration.schemaName,
        schema: declaration.schema,
      });
    }

    if (declaration.fileSurface !== undefined) {
      reportFileSurfaces[declaration.schemaName] = declaration.fileSurface;
    }

    compose.push(...(declaration.writers?.compose ?? []));
    close.push(...(declaration.writers?.close ?? []));
    verification.push(...(declaration.writers?.verification ?? []));
    checkpoint.push(...(declaration.writers?.checkpoint ?? []));
  }

  return {
    relayReports,
    reportSchemas,
    reportFileSurfaces,
    writers: {
      compose,
      close,
      verification,
      checkpoint,
    },
  };
}
