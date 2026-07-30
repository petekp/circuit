// Compiled-flow to executable-flow adapter.
//
// Public compiled flows keep serialized schema names, string routes, and
// host-facing field names. The runtime converts them here into its executable
// graph shape, then validates the result. Do not add flow-specific execution
// behavior to this translation layer.
import type { CompiledFlow } from '../../schemas/compiled-flow.js';
import type { SelectionOverride } from '../../schemas/selection-policy.js';
import type { ReportRef } from '../../schemas/step.js';
import {
  type RouteTarget,
  type Routes,
  TERMINAL_TARGETS,
  type TerminalTarget,
} from '../domain/route.js';
import type { RunFileRef } from '../domain/run-file.js';
import type { Selection } from '../domain/selection.js';
import { manifestEngineFlagsToInCode } from '../run/engine-flags.js';
import type {
  BaseStep,
  CheckpointStep,
  ExecutableFlow,
  ExecutableStep,
  FanoutStep,
  RelayStep,
  SubRunStep,
} from './executable-flow.js';
import { assertExecutableFlow } from './validate-executable-flow.js';

type CompiledStep = CompiledFlow['steps'][number];

function isReportRef(value: unknown): value is ReportRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly path?: unknown }).path === 'string' &&
    typeof (value as { readonly schema?: unknown }).schema === 'string'
  );
}

function toRunFileRef(value: string | ReportRef): RunFileRef {
  if (isReportRef(value)) return { path: value.path, schema: value.schema };
  return { path: value };
}

function toWrites(
  writes: Record<string, string | ReportRef | undefined>,
): Record<string, RunFileRef> {
  const mapped: Record<string, RunFileRef> = {};
  for (const [slot, value] of Object.entries(writes)) {
    if (value === undefined) continue;
    mapped[slot] = toRunFileRef(value);
  }
  return mapped;
}

function toRoutes(routes: Record<string, string>): Routes {
  const terminalTargets = new Set<string>(TERMINAL_TARGETS);
  const mapped: Record<string, RouteTarget> = {};
  for (const [routeName, target] of Object.entries(routes)) {
    mapped[routeName] = terminalTargets.has(target)
      ? { kind: 'terminal', target: target as TerminalTarget }
      : { kind: 'step', stepId: target };
  }
  return mapped;
}

function toSelection(selection: SelectionOverride | undefined): Selection | undefined {
  if (selection === undefined) return undefined;
  return {
    ...(selection.model === undefined ? {} : { model: selection.model }),
    ...(selection.effort === undefined ? {} : { effort: selection.effort }),
    ...(selection.skills === undefined ? {} : { skills: selection.skills }),
    ...(selection.depth === undefined ? {} : { depth: selection.depth }),
    ...(selection.invocation_options === undefined
      ? {}
      : { invocation_options: selection.invocation_options }),
  };
}

function baseStep(step: CompiledStep): BaseStep {
  const selection = toSelection(step.selection);
  return {
    id: step.id,
    title: step.title,
    protocol: step.protocol,
    routes: toRoutes(step.routes),
    reads: step.reads.map((path) => ({ path })),
    writes: toWrites(step.writes as Record<string, string | ReportRef | undefined>),
    ...(selection === undefined ? {} : { selection }),
    ...(step.skill_slots === undefined ? {} : { skillSlots: step.skill_slots }),
    ...(step.equipment_scope === undefined ? {} : { equipmentScope: step.equipment_scope }),
    ...(step.route_from_report === undefined ? {} : { routeFromReport: step.route_from_report }),
    check: step.check,
    ...(step.budgets === undefined ? {} : { budgets: step.budgets }),
    ...(step.exhaustion_route === undefined ? {} : { exhaustionRoute: step.exhaustion_route }),
  };
}

// `baseStep` copies `step.check` verbatim into the base object, so every spread
// below already carries the correct check value at runtime. The base type only
// knows the wide `Check` union, though. Kinds whose executors read a specific
// check shape (checkpoint/sub-run/fanout) narrow `check` to that shape via a
// type-only assertion: the runtime object is unchanged, and the `Step` schema
// pins `check` to exactly one variant per `kind`, which `baseStep` already placed
// here. Compose/relay keep the wide `Check` (their executors never read it).
function convertStep(step: CompiledStep): ExecutableStep {
  const base = baseStep(step);
  if (step.kind === 'compose') {
    return { ...base, kind: 'compose', writer: step.protocol };
  }
  if (step.kind === 'verification') {
    return { ...base, kind: 'verification', check: step.check };
  }
  if (step.kind === 'checkpoint') {
    return {
      ...base,
      kind: 'checkpoint',
      choices: step.policy.choices?.map((choice) => choice.id) ?? [],
      policy: step.policy,
    } as CheckpointStep;
  }
  if (step.kind === 'relay') {
    return {
      ...base,
      kind: 'relay',
      role: step.role,
      ...(step.connector === undefined ? {} : { connector: step.connector }),
      ...(step.acceptance_criteria === undefined
        ? {}
        : { acceptanceCriteria: step.acceptance_criteria }),
      ...(step.writes.report === undefined ? {} : { report: toRunFileRef(step.writes.report) }),
    } as RelayStep;
  }
  if (step.kind === 'sub-run') {
    return {
      ...base,
      kind: 'sub-run',
      flowRef: step.flow_ref.flow_id,
      entryMode: step.flow_ref.entry_mode,
      ...(step.flow_ref.version === undefined ? {} : { version: step.flow_ref.version }),
      goal: step.goal,
      depth: step.depth,
    } as SubRunStep;
  }
  return {
    ...base,
    kind: 'fanout',
    branches: step.branches,
    concurrency: step.concurrency,
    onChildFailure: step.on_child_failure,
    ...(step.rubric === undefined ? {} : { rubric: step.rubric }),
  } as FanoutStep;
}

export function fromCompiledFlow(flow: CompiledFlow): ExecutableFlow {
  const defaultSelection = toSelection(flow.default_selection);
  // Stage 3 (first-class composition): translate the manifest's snake_case
  // engine flags into the in-code shape once, here, so the rest of the engine
  // reads them off `flow.engineFlags` and never sees the wire shape.
  const engineFlags = manifestEngineFlagsToInCode(flow.engine_flags);
  // Stage 3b (first-class composition): carry the manifest's execution-bearing
  // declarations onto the runtime flow. report_file_surfaces and required_config
  // are shape-identical to their in-code types, so they pass through; only
  // runtime_surface renames its snake_case fields to camelCase.
  const runtimeSurface =
    flow.runtime_surface?.primary_result === undefined
      ? undefined
      : {
          primaryResult: {
            schemaName: flow.runtime_surface.primary_result.schema_name,
            path: flow.runtime_surface.primary_result.path,
          },
        };
  const executable: ExecutableFlow = {
    id: flow.id,
    version: flow.version,
    purpose: flow.purpose,
    entry: flow.starts_at,
    stages: flow.stages.map((stage) => {
      const selection = toSelection(stage.selection);
      return {
        id: stage.id,
        title: stage.title,
        ...(stage.canonical === undefined ? {} : { canonical: stage.canonical }),
        stepIds: stage.steps,
        ...(selection === undefined ? {} : { selection }),
      };
    }),
    steps: flow.steps.map((step) => convertStep(step)),
    ...(defaultSelection === undefined ? {} : { defaultSelection }),
    stagePathPolicy: flow.stage_path_policy,
    metadata: {
      source: 'compiled-flow-v1',
      schema_version: flow.schema_version,
    },
    ...(engineFlags === undefined ? {} : { engineFlags }),
    ...(flow.report_file_surfaces === undefined
      ? {}
      : { reportFileSurfaces: flow.report_file_surfaces }),
    ...(runtimeSurface === undefined ? {} : { runtimeSurface }),
    ...(flow.required_config === undefined ? {} : { requiredConfig: flow.required_config }),
  };

  assertExecutableFlow(executable);
  return executable;
}
