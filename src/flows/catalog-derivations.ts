// Pure derivation helpers that turn flow packages into engine
// registries. Each registry file delegates to one of these so the
// derivation logic (with its duplicate-detection and default-package
// invariants) is testable in isolation against synthetic packages.

import type { z } from 'zod';
import type { ReportFileSurfaceDeclaration } from '../schemas/report-file-surface.js';
import { type FlowCatalog, FlowCatalogShape } from '../schemas/routing-contract-schemas.js';
import type { CheckpointBriefBuilder } from './registries/checkpoint-writers/types.js';
import type { CloseBuilder } from './registries/close-writers/types.js';
import type { ComposeBuilder } from './registries/compose-writers/types.js';
import type { CrossReportValidator } from './registries/cross-report-validators.js';
import type { StructuralShapeHint } from './registries/shape-hints/types.js';
import type { VerificationBuilder } from './registries/verification-writers/types.js';
import type {
  CompiledFlowPackage,
  CompiledFlowRuntimeSurface,
  CompiledFlowVisibility,
} from './types.js';

// Collect a Map keyed by builder.resultSchemaName from one writer slot
// across all packages. Throws on duplicate keys with a message that
// names both the slot and the offending flow id.
function collectBuilderRegistry<B extends { readonly resultSchemaName: string }>(
  packages: readonly CompiledFlowPackage[],
  slot: 'compose' | 'close' | 'verification' | 'checkpoint',
  pluck: (pkg: CompiledFlowPackage) => readonly B[],
): ReadonlyMap<string, B> {
  const map = new Map<string, B>();
  for (const pkg of packages) {
    for (const builder of pluck(pkg)) {
      if (map.has(builder.resultSchemaName)) {
        throw new Error(
          `duplicate ${slot} builder registered for schema '${builder.resultSchemaName}' (flow ${pkg.id})`,
        );
      }
      map.set(builder.resultSchemaName, builder);
    }
  }
  return map;
}

export function buildComposeRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, ComposeBuilder> {
  return collectBuilderRegistry(packages, 'compose', (pkg) => pkg.writers.compose);
}

export function buildCloseRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, CloseBuilder> {
  return collectBuilderRegistry(packages, 'close', (pkg) => pkg.writers.close);
}

export function buildVerificationRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, VerificationBuilder> {
  return collectBuilderRegistry(packages, 'verification', (pkg) => pkg.writers.verification);
}

export function buildCheckpointRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, CheckpointBriefBuilder> {
  return collectBuilderRegistry(packages, 'checkpoint', (pkg) => pkg.writers.checkpoint);
}

// The single merge core for report-schema zod registries. Two engine
// registries derive from it and they deliberately differ in coverage:
//
// - channels: 'relay' — pkg.relayReports only. This is parseReport's
//   registry (src/flows/registries/report-schemas.ts). parseReport
//   only ever sees connector relay result bodies, and the narrowness
//   is load-bearing: it is the runtime guard that a relay step's
//   `writes.report.schema` names a schema declared channel:'relay'.
//   A channel:'report' name routed through a relay step fails closed
//   instead of silently skipping relay-only machinery (relay hints,
//   cross-report validators).
// - channels: 'relay+report' — relayReports plus pkg.reportSchemas.
//   This is the run-file validation registry
//   (src/runtime/run-files/report-validator.ts), which must admit
//   EVERY report written into a run dir: compose / close /
//   verification / checkpoint / sub-run reports (channel:'report')
//   as well as materialized relay reports.
//
// `channels` is required so neither call site can drift to the other
// coverage by accident. Optional fixtures (engine builtins, test
// schemas) merge first; any name collision throws.
export interface ReportSchemaRegistryOptions {
  readonly channels: 'relay' | 'relay+report';
  readonly fixtures?: Readonly<Record<string, z.ZodType<unknown>>>;
}

export function buildReportSchemaRegistry(
  packages: readonly CompiledFlowPackage[],
  options: ReportSchemaRegistryOptions,
): Readonly<Record<string, z.ZodType<unknown>>> {
  const out: Record<string, z.ZodType<unknown>> = { ...(options.fixtures ?? {}) };
  const register = (schemaName: string, schema: z.ZodType<unknown>, flowId: string): void => {
    if (Object.hasOwn(out, schemaName)) {
      throw new Error(`duplicate report schema '${schemaName}' registered (flow ${flowId})`);
    }
    out[schemaName] = schema;
  };
  for (const pkg of packages) {
    for (const report of pkg.relayReports) {
      register(report.schemaName, report.schema, pkg.id);
    }
    if (options.channels === 'relay+report') {
      for (const report of pkg.reportSchemas ?? []) {
        register(report.schemaName, report.schema, pkg.id);
      }
    }
  }
  return Object.freeze(out);
}

// Schema-keyed relay shape hints. Throws on duplicates so a hint
// authoring error fails loudly at registry construction.
export function buildSchemaHintMap(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const pkg of packages) {
    for (const report of pkg.relayReports) {
      if (report.relayHint === undefined) continue;
      if (map.has(report.schemaName)) {
        throw new Error(
          `duplicate shape hint registered for schema '${report.schemaName}' (flow ${pkg.id})`,
        );
      }
      map.set(report.schemaName, report.relayHint);
    }
  }
  return map;
}

export function buildCrossReportValidatorRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, CrossReportValidator> {
  const map = new Map<string, CrossReportValidator>();
  for (const pkg of packages) {
    for (const report of pkg.relayReports) {
      if (report.crossReportValidate === undefined) continue;
      if (map.has(report.schemaName)) {
        throw new Error(
          `duplicate cross-report validator registered for schema '${report.schemaName}' (flow ${pkg.id})`,
        );
      }
      map.set(report.schemaName, report.crossReportValidate);
    }
  }
  return map;
}

export function buildStructuralHintList(
  packages: readonly CompiledFlowPackage[],
): readonly StructuralShapeHint[] {
  const list: StructuralShapeHint[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    if (pkg.structuralHints === undefined) continue;
    for (const hint of pkg.structuralHints) {
      if (seen.has(hint.id)) {
        throw new Error(`duplicate structural shape hint id '${hint.id}' (flow ${pkg.id})`);
      }
      seen.add(hint.id);
      list.push(hint);
    }
  }
  return list;
}

export function buildRuntimeSurfaceRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, CompiledFlowRuntimeSurface> {
  const map = new Map<string, CompiledFlowRuntimeSurface>();
  for (const pkg of packages) {
    if (pkg.runtimeSurface === undefined) continue;
    if (map.has(pkg.id)) {
      throw new Error(`duplicate runtime surface registered for flow '${pkg.id}'`);
    }
    map.set(pkg.id, pkg.runtimeSurface);
  }
  return map;
}

export function buildReportFileSurfaceRegistry(
  packages: readonly CompiledFlowPackage[],
): Readonly<Record<string, ReportFileSurfaceDeclaration>> {
  const out: Record<string, ReportFileSurfaceDeclaration> = {};
  for (const pkg of packages) {
    for (const [schemaName, declaration] of Object.entries(pkg.reportFileSurfaces ?? {})) {
      if (Object.hasOwn(out, schemaName)) {
        throw new Error(
          `duplicate report file surface registered for schema '${schemaName}' (flow ${pkg.id})`,
        );
      }
      out[schemaName] = declaration;
    }
  }
  return Object.freeze(out);
}

// The minimal shape deriveFlowCatalog reads. A FlowDefinition satisfies it
// structurally (id + visibility + a schematic carrying title/purpose), so the
// derivation needs no import of the heavier FlowDefinition type and stays
// testable against synthetic sources.
export interface FlowCatalogSource {
  readonly id: string;
  readonly visibility: CompiledFlowVisibility;
  readonly schematic: { readonly title: string; readonly purpose: string };
}

// flow.catalog@v1 producer (M9-A3). Derive the static catalog the route block
// chooses from: the host-runnable (public) flows, each as {id, title, purpose}
// read straight from its schematic, in catalog (source) order. Internal flows
// (goal, runtime-proof) ship no host run surface, so a router cannot route to
// them — they are excluded. The result is validated against the typed
// FlowCatalogShape body, so an empty or malformed catalog fails closed here
// rather than reaching a consumer. This is the static-registry producer:
// a deterministic function of the fixed flow set, computed at
// build/compile time (serialized to generated/flows/catalog.json by the emit
// script). The contract layer is compile-time only today (no route step runs),
// so this closes the producer gap without a runtime route consumer.
export function deriveFlowCatalog(sources: readonly FlowCatalogSource[]): FlowCatalog {
  const flows = sources
    .filter((source) => source.visibility === 'public')
    .map((source) => ({
      id: source.id,
      title: source.schematic.title,
      purpose: source.schematic.purpose,
    }));
  return FlowCatalogShape.parse({ flows });
}
