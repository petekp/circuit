import type { z } from 'zod';

import {
  FlowSchematic,
  type FlowSchematic as FlowSchematicValue,
} from '../schemas/flow-schematic.js';
import {
  buildCheckpointRegistry,
  buildCloseRegistry,
  buildComposeRegistry,
  buildCrossReportValidatorRegistry,
  buildReportFileSurfaceRegistry,
  buildReportSchemaRegistry,
  buildRuntimeSurfaceRegistry,
  buildSchemaHintMap,
  buildStructuralHintList,
  buildVerificationRegistry,
} from './catalog-derivations.js';
import {
  type FlowReportDeclaration,
  projectFlowReportDeclarations,
} from './report-declarations.js';
import type {
  CompiledFlowPackage,
  CompiledFlowPaths,
  CompiledFlowRelayReport,
  CompiledFlowReportSchema,
  CompiledFlowRuntimeSurface,
  CompiledFlowVisibility,
} from './types.js';

type FlowDefinitionSchematicInput = z.input<typeof FlowSchematic>;

type FlowDefinitionPaths = Omit<CompiledFlowPaths, 'schematic'> & {
  readonly schematic?: string;
};

type FlowDefinitionWriters = Partial<CompiledFlowPackage['writers']>;

export interface FlowDefinitionRuntimeSurface {
  readonly primaryResult?: CompiledFlowRuntimeSurface['primaryResult'];
  readonly progress?: CompiledFlowRuntimeSurface['progress'];
}

export interface FlowDefinitionCanonicalStagePolicyVariant {
  readonly canonicals: readonly string[];
  readonly omits: readonly string[];
  readonly title: string;
}

export type FlowDefinitionCanonicalStagePolicy =
  | {
      readonly kind: 'enforce';
      readonly canonicals: readonly string[];
      readonly omits: readonly string[];
      readonly optional_canonicals: readonly string[];
      readonly variants: readonly FlowDefinitionCanonicalStagePolicyVariant[];
      readonly title: string;
      readonly authority: string;
    }
  | {
      readonly kind: 'exempt';
      readonly reason: string;
    };

export interface FlowDefinitionInput {
  readonly id: string;
  readonly visibility: CompiledFlowVisibility;
  readonly schematic: FlowDefinitionSchematicInput;
  readonly paths?: FlowDefinitionPaths;
  readonly reportDeclarations?: readonly FlowReportDeclaration[];
  readonly relayReports?: readonly CompiledFlowRelayReport[];
  readonly reportSchemas?: readonly CompiledFlowReportSchema[];
  readonly writers?: FlowDefinitionWriters;
  readonly structuralHints?: CompiledFlowPackage['structuralHints'];
  readonly runtimeSurface?: FlowDefinitionRuntimeSurface;
  readonly canonicalStagePolicy?: FlowDefinitionCanonicalStagePolicy;
  readonly engineFlags?: CompiledFlowPackage['engineFlags'];
  readonly requiredConfig?: CompiledFlowPackage['requiredConfig'];
}

export interface FlowData extends Omit<FlowDefinitionInput, 'reportDeclarations'> {
  readonly reports?: readonly FlowReportDeclaration[];
  readonly reportWriterSchemaAliases?: readonly string[];
}

export interface FlowDefinition
  extends Omit<FlowDefinitionInput, 'schematic' | 'paths' | 'runtimeSurface'> {
  readonly schematic: FlowSchematicValue;
  readonly paths: FlowDefinitionPaths;
  readonly runtimeSurface?: FlowDefinitionRuntimeSurface;
}

export type DefineFlowDataError =
  | {
      readonly kind: 'flow-data-parse-error';
      readonly message: string;
    }
  | {
      readonly kind: 'duplicate-flow-data-report';
      readonly schemaName: string;
    }
  | {
      readonly kind: 'flow-data-report-writer-drift';
      readonly schemaName: string;
      readonly slot: keyof CompiledFlowPackage['writers'];
      readonly resultSchemaName: string;
    };

export type Validation<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly E[] };

function defaultSchematicPath(flowId: string): string {
  return `src/flows/${flowId}/schematic.json`;
}

export function defineFlow(definition: FlowDefinitionInput): FlowDefinition {
  const schematic = FlowSchematic.parse(definition.schematic);
  if (definition.id !== schematic.id) {
    throw new Error(
      `flow definition id '${definition.id}' does not match schematic id '${schematic.id}'`,
    );
  }
  return {
    ...definition,
    paths: definition.paths ?? {},
    schematic,
  };
}

export function defineFlowDataValue(
  data: FlowData,
): Validation<FlowDefinition, DefineFlowDataError> {
  const reportErrors = validateFlowDataReports({
    reports: data.reports ?? [],
    writerSchemaAliases: data.reportWriterSchemaAliases ?? [],
  });
  if (reportErrors.length > 0) return { ok: false, errors: reportErrors };
  try {
    return { ok: true, value: defineFlow(flowDefinitionInputFromData(data)) };
  } catch (error) {
    return {
      ok: false,
      errors: [{ kind: 'flow-data-parse-error', message: errorMessage(error) }],
    };
  }
}

export function defineFlowData(data: FlowData): FlowDefinition {
  const result = defineFlowDataValue(data);
  if (result.ok) return result.value;
  throw new Error(result.errors.map(describeDefineFlowDataError).join('\n'));
}

function flowDefinitionInputFromData(data: FlowData): FlowDefinitionInput {
  const { reports, reportWriterSchemaAliases: _reportWriterSchemaAliases, ...definition } = data;
  const reportProjection =
    reports === undefined ? undefined : projectFlowReportDeclarations(reports);
  return {
    ...definition,
    ...(reports === undefined
      ? {}
      : {
          reportDeclarations: reports,
          relayReports: definition.relayReports ?? reportProjection?.relayReports ?? [],
          reportSchemas: definition.reportSchemas ?? reportProjection?.reportSchemas ?? [],
          writers: definition.writers ?? reportProjection?.writers ?? {},
        }),
  };
}

function validateFlowDataReports(input: {
  readonly reports: readonly FlowReportDeclaration[];
  readonly writerSchemaAliases: readonly string[];
}): readonly DefineFlowDataError[] {
  const errors: DefineFlowDataError[] = [];
  const writerSchemaAliases = new Set(input.writerSchemaAliases);
  const reports = input.reports;
  for (const schemaName of duplicateValues(reports.map((report) => report.schemaName))) {
    errors.push({ kind: 'duplicate-flow-data-report', schemaName });
  }
  for (const report of reports) {
    for (const slot of ['compose', 'close', 'verification', 'checkpoint'] as const) {
      for (const writer of report.writers?.[slot] ?? []) {
        if (
          writer.resultSchemaName !== report.schemaName &&
          !writerSchemaAliases.has(writer.resultSchemaName)
        ) {
          errors.push({
            kind: 'flow-data-report-writer-drift',
            schemaName: report.schemaName,
            slot,
            resultSchemaName: writer.resultSchemaName,
          });
        }
      }
    }
  }
  return errors;
}

function describeDefineFlowDataError(error: DefineFlowDataError): string {
  if (error.kind === 'flow-data-parse-error') return error.message;
  if (error.kind === 'duplicate-flow-data-report') {
    return `duplicate FlowData report schema '${error.schemaName}'`;
  }
  return `FlowData report '${error.schemaName}' binds ${error.slot} writer for '${error.resultSchemaName}'`;
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compilePaths(definition: FlowDefinition): CompiledFlowPaths {
  const paths: CompiledFlowPaths = {
    schematic: definition.paths.schematic ?? defaultSchematicPath(definition.id),
  };
  if (definition.paths.command !== undefined) {
    return definition.paths.contract === undefined
      ? { ...paths, command: definition.paths.command }
      : { ...paths, command: definition.paths.command, contract: definition.paths.contract };
  }
  return definition.paths.contract === undefined
    ? paths
    : { ...paths, contract: definition.paths.contract };
}

function validateProgressSurface(
  definition: FlowDefinition,
  progress: CompiledFlowRuntimeSurface['progress'],
): void {
  if (progress === undefined) return;
  const itemIds = new Set(definition.schematic.items.map((item) => item.id as unknown as string));
  const seen = new Set<string>();
  for (const [index, step] of progress.steps.entries()) {
    if (seen.has(step.stepId)) {
      throw new Error(
        `flow definition '${definition.id}' declares duplicate progress step '${step.stepId}'`,
      );
    }
    seen.add(step.stepId);
    if (!itemIds.has(step.stepId)) {
      throw new Error(
        `flow definition '${definition.id}' progress step '${step.stepId}' is not a schematic item`,
      );
    }
    if (step.taskTitle.length === 0 || step.activeText.length === 0) {
      throw new Error(
        `flow definition '${definition.id}' progress step ${index} must declare operator text`,
      );
    }
  }
}

function compileRuntimeSurface(definition: FlowDefinition): CompiledFlowRuntimeSurface | undefined {
  const runtimeSurface = definition.runtimeSurface;
  if (runtimeSurface === undefined) return undefined;
  validateProgressSurface(definition, runtimeSurface.progress);
  return {
    ...(runtimeSurface.primaryResult === undefined
      ? {}
      : { primaryResult: runtimeSurface.primaryResult }),
    ...(runtimeSurface.progress === undefined ? {} : { progress: runtimeSurface.progress }),
  };
}

function projectDefinitionReportSurfaces(definition: FlowDefinition): {
  readonly relayReports: readonly CompiledFlowRelayReport[];
  readonly reportSchemas?: readonly CompiledFlowReportSchema[];
  readonly reportFileSurfaces?: CompiledFlowPackage['reportFileSurfaces'];
  readonly writers: FlowDefinitionWriters;
} {
  const reportProjection =
    definition.reportDeclarations === undefined
      ? undefined
      : projectFlowReportDeclarations(definition.reportDeclarations);
  return {
    relayReports: definition.relayReports ?? reportProjection?.relayReports ?? [],
    ...(definition.reportSchemas !== undefined
      ? { reportSchemas: definition.reportSchemas }
      : reportProjection?.reportSchemas === undefined
        ? {}
        : { reportSchemas: reportProjection.reportSchemas }),
    ...(reportProjection === undefined ||
    Object.keys(reportProjection.reportFileSurfaces).length === 0
      ? {}
      : { reportFileSurfaces: reportProjection.reportFileSurfaces }),
    writers: definition.writers ?? reportProjection?.writers ?? {},
  };
}

export function compileFlowDefinition(definition: FlowDefinition): CompiledFlowPackage {
  const runtimeSurface = compileRuntimeSurface(definition);
  const reportSurfaces = projectDefinitionReportSurfaces(definition);
  return {
    id: definition.id,
    visibility: definition.visibility,
    paths: compilePaths(definition),
    relayReports: reportSurfaces.relayReports,
    ...(reportSurfaces.reportSchemas === undefined
      ? {}
      : { reportSchemas: reportSurfaces.reportSchemas }),
    ...(reportSurfaces.reportFileSurfaces === undefined
      ? {}
      : { reportFileSurfaces: reportSurfaces.reportFileSurfaces }),
    writers: {
      compose: reportSurfaces.writers.compose ?? [],
      close: reportSurfaces.writers.close ?? [],
      verification: reportSurfaces.writers.verification ?? [],
      checkpoint: reportSurfaces.writers.checkpoint ?? [],
    },
    ...(definition.structuralHints === undefined
      ? {}
      : { structuralHints: definition.structuralHints }),
    ...(runtimeSurface === undefined ? {} : { runtimeSurface }),
    ...(definition.engineFlags === undefined ? {} : { engineFlags: definition.engineFlags }),
    ...(definition.requiredConfig === undefined
      ? {}
      : { requiredConfig: definition.requiredConfig }),
  };
}

function validatePackageSet(packages: readonly CompiledFlowPackage[]): void {
  const ids = new Set<string>();
  const reportNames = new Map<string, string>();
  const writerNames = new Map<string, string>();
  for (const pkg of packages) {
    if (ids.has(pkg.id)) {
      throw new Error(`duplicate flow definition id '${pkg.id}'`);
    }
    ids.add(pkg.id);
    for (const report of [...pkg.relayReports, ...(pkg.reportSchemas ?? [])]) {
      const owner = reportNames.get(report.schemaName);
      if (owner !== undefined) {
        throw new Error(
          `duplicate report schema '${report.schemaName}' registered by '${owner}' and '${pkg.id}'`,
        );
      }
      reportNames.set(report.schemaName, pkg.id);
    }
    const knownPackageReports = new Set([
      ...pkg.relayReports.map((report) => report.schemaName),
      ...(pkg.reportSchemas ?? []).map((report) => report.schemaName),
    ]);
    for (const schemaName of Object.keys(pkg.reportFileSurfaces ?? {})) {
      if (!knownPackageReports.has(schemaName)) {
        throw new Error(
          `report file surface '${schemaName}' is not registered as a report schema for flow '${pkg.id}'`,
        );
      }
    }
    for (const [slot, builders] of Object.entries(pkg.writers)) {
      for (const builder of builders) {
        const owner = writerNames.get(builder.resultSchemaName);
        if (owner !== undefined) {
          throw new Error(
            `duplicate writer result schema '${builder.resultSchemaName}' registered by ${owner} and ${pkg.id}.${slot}`,
          );
        }
        writerNames.set(builder.resultSchemaName, `${pkg.id}.${slot}`);
      }
    }
  }
}

// Single explicit entry point for every package-set invariant the
// catalog must uphold. `validatePackageSet` enforces id and schema-name
// uniqueness directly; each derived registry is then built once. The
// builders throw on duplicate keys (writer result schemas, relay schema
// names, hint ids, runtime surfaces), so constructing them here surfaces
// catalog authoring errors at module load with a precise message. The
// registry return values are intentionally discarded — this is a
// validation pass, not a cache; the registries that the engine actually
// consumes are built lazily by their own modules.
function assertCatalogInvariants(packages: readonly CompiledFlowPackage[]): void {
  validatePackageSet(packages);
  buildComposeRegistry(packages);
  buildCloseRegistry(packages);
  buildVerificationRegistry(packages);
  buildCheckpointRegistry(packages);
  buildReportSchemaRegistry(packages);
  buildSchemaHintMap(packages);
  buildStructuralHintList(packages);
  buildCrossReportValidatorRegistry(packages);
  buildRuntimeSurfaceRegistry(packages);
  buildReportFileSurfaceRegistry(packages);
}

export function compileFlowDefinitions(
  definitions: readonly FlowDefinition[],
): readonly CompiledFlowPackage[] {
  const packages = definitions.map(compileFlowDefinition);
  assertCatalogInvariants(packages);
  return packages;
}

export function schematicForFlowDefinition(definition: FlowDefinition): FlowSchematicValue {
  return definition.schematic;
}
