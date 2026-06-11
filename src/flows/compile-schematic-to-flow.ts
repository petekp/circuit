// Pure compiler: FlowSchematic → CompiledFlow(s). Takes a fully-populated schematic
// (schematic-level axes/stage_path_policy/stages/version present;
// per-item protocol/writes/check present) and produces compiled CompiledFlow
// objects shaped like the existing committed `generated/flows/<id>/`
// fixtures.
//
// Compile is per derived axis selection: routes are resolved against
// `route_overrides[outcome][mode.depth]` when the schematic declares one;
// reachability is computed against that resolved graph and unreachable
// items are dropped per axis selection. The result is a discriminated union:
//
//   - `kind: 'single'`  when the schematic declares no route_overrides anywhere.
//                       All axis selections share the same compiled graph.
//                       Build-time emit writes one `circuit.json`.
//
//   - `kind: 'per-mode'` when at least one item declares route_overrides.
//                        Returns one CompiledFlow per axis selection.
//                        Build-time emit groups by graph identity, writes
//                        the largest group to `circuit.json`, and writes
//                        remaining modes to `<mode-name>.json`.
//
// Failure modes are deliberate: if any compile-required field is missing,
// or any `kind ↔ report schema` pair is one the runner does not support,
// the compile throws with a clear message naming the offending item.

import type { CompiledFlow as CompiledFlowValue } from '../schemas/compiled-flow.js';
import { CompiledFlow } from '../schemas/compiled-flow.js';
import type { FlowContractRef } from '../schemas/flow-blocks.js';
import type {
  FlowAxisSelection,
  FlowSchematic,
  SchematicStep,
  StepWrites,
} from '../schemas/flow-schematic.js';
import {
  RUNTIME_SUCCESS_ROUTE,
  SCHEMATIC_SUCCESS_ROUTE_ALIASES,
  schematicOutcomeToRuntimeRoute,
} from '../schemas/route-policy.js';
import type { CanonicalStage } from '../schemas/stage.js';
import { CANONICAL_STAGES } from '../schemas/stage.js';
import type { Step } from '../schemas/step.js';
import { axisSelectionsForAxes } from './axis-selections.js';
import { findCheckpointBriefBuilder } from './registries/checkpoint-writers/registry.js';
import { findVerificationWriter } from './registries/verification-writers/registry.js';

export class FlowSchematicCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowSchematicCompileError';
  }
}

export type CompileResult =
  | { kind: 'single'; flow: CompiledFlowValue }
  | { kind: 'per-mode'; flows: Map<string, CompiledFlowValue> };

function fail(message: string): never {
  throw new FlowSchematicCompileError(message);
}

// (step kind, report schema) pairs the runner's writers actually
// understand. Both verification and checkpoint kinds consult their
// per-kind writer registries (the single source of truth — adding a
// writer there auto-permits the schema here).
function ensureSupportedKindReportPair(item: SchematicStep): void {
  if (item.execution.kind === 'verification') {
    if (findVerificationWriter(item.output as unknown as string) === undefined) {
      fail(
        `schematic item '${item.id}' has verification kind but writes '${item.output}'; no verification writer is registered for that schema (see src/flows/registries/verification-writers/registry.ts)`,
      );
    }
  }
  if (item.execution.kind === 'checkpoint' && item.writes?.report_path !== undefined) {
    if (findCheckpointBriefBuilder(item.output as unknown as string) === undefined) {
      fail(
        `schematic item '${item.id}' has checkpoint kind writing report '${item.output}'; no checkpoint writer is registered for that schema (see src/flows/registries/checkpoint-writers/registry.ts)`,
      );
    }
  }
}

function requireSchematicField<T>(value: T | undefined, fieldName: string, schematicId: string): T {
  if (value === undefined) {
    fail(`schematic '${schematicId}' is missing required compile-time field '${fieldName}'`);
  }
  return value;
}

function requireItemField<T>(value: T | undefined, fieldName: string, itemId: string): T {
  if (value === undefined) {
    fail(`schematic item '${itemId}' is missing required compile-time field '${fieldName}'`);
  }
  return value;
}

// Resolve a single schematic-side route outcome to its target after applying
// any depth-specific override. The override map is keyed by CompiledDepth so authors
// can express "lite-depth variants of this flow skip review" without naming
// individual axis selections.
function resolveRouteTarget(
  item: SchematicStep,
  outcome: string,
  mode: FlowAxisSelection,
): string | undefined {
  const overrides = item.route_overrides[outcome];
  const overridden = overrides?.[mode.depth];
  if (overridden !== undefined) return overridden;
  return item.routes[outcome];
}

// Compute the set of items reachable for a given mode by following every
// declared schematic route with mode-specific overrides applied. Rich route
// labels stay in the compiled flow, so steps reachable only through ask,
// handoff, retry, or revise are real runtime targets instead of hidden
// authoring notes.
function computeReachableForMode(schematic: FlowSchematic, mode: FlowAxisSelection): Set<string> {
  const itemById = new Map(schematic.items.map((item) => [item.id as unknown as string, item]));
  const reachable = new Set<string>();
  const queue: string[] = [schematic.starts_at as unknown as string];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) continue;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const item = itemById.get(id);
    if (item === undefined) {
      fail(
        `schematic '${schematic.id as unknown as string}' references unknown item id '${id}' through routes (or starts_at)`,
      );
    }
    for (const outcome of Object.keys(item.routes)) {
      const target = resolveRouteTarget(item, outcome, mode);
      if (target === undefined) continue;
      if (target.startsWith('@')) continue;
      queue.push(target);
    }
  }
  return reachable;
}

// Build a contract → producing item index from the reachable items. Used
// to resolve the read-paths for each consuming item's typed input
// contracts. If a contract has no producer (and is not in
// initial_contracts) the consumer's compile fails.
function buildContractProducerIndex(
  schematicId: string,
  items: readonly SchematicStep[],
): Map<FlowContractRef, SchematicStep> {
  const index = new Map<FlowContractRef, SchematicStep>();
  for (const item of items) {
    if (index.has(item.output)) {
      const prior = index.get(item.output);
      fail(
        `schematic '${schematicId}' items '${prior?.id}' and '${item.id}' both write contract '${item.output}' on the same compiled graph — read-path resolution requires a single producer per contract per mode`,
      );
    }
    index.set(item.output, item);
  }
  return index;
}

function readPathForProducer(producer: SchematicStep): string {
  // Prefer the typed report path; fall back to the relay result path
  // when the producer is a relay step that does not emit a typed
  // report (Review's audit-step pattern).
  const writes = requireItemField(producer.writes, 'writes', producer.id);
  if (writes.report_path !== undefined) return writes.report_path;
  if (writes.result_path !== undefined) return writes.result_path;
  fail(
    `schematic item '${producer.id}' produces '${producer.output}' but has no writes.report_path or writes.result_path — downstream consumers cannot find a read path`,
  );
}

function computeReads(
  item: SchematicStep,
  initialContracts: ReadonlySet<FlowContractRef>,
  producerByContract: ReadonlyMap<FlowContractRef, SchematicStep>,
): string[] {
  const reads: string[] = [];
  const seen = new Set<string>();
  // Iterate inputs in declaration order so the emitted reads list is
  // stable and matches the schematic author's intent.
  for (const contract of Object.values(item.input)) {
    if (initialContracts.has(contract)) continue;
    const producer = producerByContract.get(contract);
    if (producer === undefined) {
      fail(
        `schematic item '${item.id}' input contract '${contract}' has no producer reachable in this mode and is not in initial_contracts`,
      );
    }
    const path = readPathForProducer(producer);
    if (!seen.has(path)) {
      reads.push(path);
      seen.add(path);
    }
  }
  return reads;
}

// Map schematic routes to CompiledFlow routes for a given mode. Schematic
// success aliases populate the runtime success edge because handlers advance
// on `pass`. The original schematic labels are preserved too, so checkpoint
// selections and rich route outcomes can execute without a second
// hand-maintained graph.
function compileRoutesForMode(
  item: SchematicStep,
  mode: FlowAxisSelection,
): Record<string, string> {
  const routes: Record<string, string> = {};
  let passSet = false;
  for (const outcome of Object.keys(item.routes)) {
    const target = resolveRouteTarget(item, outcome, mode);
    if (target === undefined) {
      fail(
        `schematic item '${item.id}' route outcome '${outcome}' has no target after applying mode '${mode.name}' (depth '${mode.depth}') overrides`,
      );
    }
    routes[outcome] = target;
    const flowRoute = schematicOutcomeToRuntimeRoute(outcome);
    if (flowRoute === undefined) continue;
    if (passSet) {
      fail(
        `schematic item '${item.id}' has multiple outcomes that map to '${RUNTIME_SUCCESS_ROUTE}' (only one allowed); pick whichever maps to the live runtime success edge`,
      );
    }
    routes[flowRoute] = target;
    passSet = true;
  }
  if (!passSet) {
    fail(
      `schematic item '${item.id}' has no outcome that maps to '${RUNTIME_SUCCESS_ROUTE}'; declare one success route (${SCHEMATIC_SUCCESS_ROUTE_ALIASES.join(' or ')}) so the compiled CompiledFlow has a success edge`,
    );
  }
  if (item.execution.kind === 'checkpoint' && item.checkpoint_policy?.choices !== undefined) {
    const successTarget = routes[RUNTIME_SUCCESS_ROUTE];
    if (successTarget === undefined) {
      fail(`schematic checkpoint '${item.id}' has no runtime success route`);
    }
    for (const choice of item.checkpoint_policy.choices) {
      routes[choice.id] ??= successTarget;
    }
  }
  return routes;
}

function compileItem(
  item: SchematicStep,
  reads: readonly string[],
  routes: Record<string, string>,
): Step {
  const protocol = requireItemField(item.protocol, 'protocol', item.id);
  const writes = requireItemField(item.writes, 'writes', item.id);
  const check = requireItemField(item.check, 'check', item.id);
  ensureSupportedKindReportPair(item);

  const stepBase = {
    id: item.id,
    title: item.title,
    protocol,
    reads: [...reads],
    routes,
    ...(item.selection !== undefined ? { selection: item.selection } : {}),
    ...(item.skill_slots.length === 0 ? {} : { skill_slots: item.skill_slots }),
    ...(item.route_from_report === undefined ? {} : { route_from_report: item.route_from_report }),
  } as const;

  switch (item.execution.kind) {
    case 'compose': {
      const reportPath = requireWritesField(writes, 'report_path', item.id, 'compose');
      return {
        ...stepBase,
        executor: 'orchestrator',
        kind: 'compose',
        writes: {
          report: { path: reportPath, schema: item.output },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: requireCheckField(check.required, 'required', item.id, 'compose'),
        },
      } as Step;
    }
    case 'verification': {
      const reportPath = requireWritesField(writes, 'report_path', item.id, 'verification');
      return {
        ...stepBase,
        executor: 'orchestrator',
        kind: 'verification',
        writes: {
          report: { path: reportPath, schema: item.output },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: requireCheckField(check.required, 'required', item.id, 'verification'),
        },
      } as Step;
    }
    case 'checkpoint': {
      const policy = requireItemField(item.checkpoint_policy, 'checkpoint_policy', item.id);
      const requestPath = requireWritesField(
        writes,
        'checkpoint_request_path',
        item.id,
        'checkpoint',
      );
      const responsePath = requireWritesField(
        writes,
        'checkpoint_response_path',
        item.id,
        'checkpoint',
      );
      const checkpointWrites: {
        request: string;
        response: string;
        report?: { path: string; schema: string };
      } = {
        request: requestPath,
        response: responsePath,
      };
      if (writes.report_path !== undefined) {
        checkpointWrites.report = { path: writes.report_path, schema: item.output };
      }
      return {
        ...stepBase,
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy,
        writes: checkpointWrites,
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          ...(check.allow === undefined
            ? {
                allow_from: requireCheckField(
                  check.allow_from,
                  'allow_from',
                  item.id,
                  'checkpoint',
                ),
              }
            : { allow: check.allow }),
        },
      } as Step;
    }
    case 'relay': {
      const role = item.execution.role;
      if (role === undefined) {
        fail(`schematic item '${item.id}' has relay kind but no execution.role`);
      }
      const requestPath = requireWritesField(writes, 'request_path', item.id, 'relay');
      const receiptPath = requireWritesField(writes, 'receipt_path', item.id, 'relay');
      const resultPath = requireWritesField(writes, 'result_path', item.id, 'relay');
      const relayWrites: {
        request: string;
        receipt: string;
        result: string;
        report?: { path: string; schema: string };
      } = {
        request: requestPath,
        receipt: receiptPath,
        result: resultPath,
      };
      if (writes.report_path !== undefined) {
        relayWrites.report = { path: writes.report_path, schema: item.output };
      }
      return {
        ...stepBase,
        executor: 'worker',
        kind: 'relay',
        role,
        ...(item.acceptance_criteria === undefined
          ? {}
          : { acceptance_criteria: item.acceptance_criteria }),
        writes: relayWrites,
        check: {
          kind: 'result_verdict',
          source: { kind: 'relay_result', ref: 'result' },
          pass: requireCheckField(check.pass, 'pass', item.id, 'relay'),
        },
      } as Step;
    }
    case 'sub-run': {
      const flowRef = item.execution.flow_ref;
      const goal = item.execution.goal;
      const depth = item.execution.depth;
      if (flowRef === undefined) {
        fail(`schematic item '${item.id}' has sub-run kind but no execution.flow_ref`);
      }
      if (goal === undefined) {
        fail(`schematic item '${item.id}' has sub-run kind but no execution.goal`);
      }
      if (depth === undefined) {
        fail(`schematic item '${item.id}' has sub-run kind but no execution.depth`);
      }
      const resultPath = requireWritesField(writes, 'result_path', item.id, 'sub-run');
      // Emit writes.report as a schema annotation pointing at the same
      // path as writes.result. The child's result.json IS the typed
      // report for downstream consumers — no separate materialization
      // is needed (the sub-run handler short-circuits the v0 abort when
      // report.path equals result path). This lets close-writers resolve
      // sub-run output schemas via reportPathForSchemaInRuntimeFlow
      // without special-casing sub-run.
      return {
        ...stepBase,
        executor: 'orchestrator',
        kind: 'sub-run',
        flow_ref: flowRef,
        goal,
        depth,
        writes: {
          result: resultPath,
          report: { path: resultPath, schema: item.output },
        },
        check: {
          kind: 'result_verdict',
          source: { kind: 'sub_run_result', ref: 'result' },
          pass: requireCheckField(check.pass, 'pass', item.id, 'sub-run'),
        },
      } as Step;
    }
    case 'fanout': {
      const fanout = requireItemField(item.fanout, 'fanout', item.id);
      const reportPath = requireWritesField(writes, 'report_path', item.id, 'fanout');
      const branchesDir = requireWritesField(writes, 'branches_dir_path', item.id, 'fanout');
      return {
        ...stepBase,
        executor: 'orchestrator',
        kind: 'fanout',
        branches: fanout.branches,
        ...(fanout.concurrency === undefined ? {} : { concurrency: fanout.concurrency }),
        ...(fanout.on_child_failure === undefined
          ? {}
          : { on_child_failure: fanout.on_child_failure }),
        ...(fanout.rubric === undefined ? {} : { rubric: fanout.rubric }),
        writes: {
          branches_dir: branchesDir,
          aggregate: { path: reportPath, schema: item.output },
        },
        check: {
          kind: 'fanout_aggregate',
          source: { kind: 'fanout_results', ref: 'aggregate' },
          join: fanout.join,
          verdicts: {
            admit: requireCheckField(check.pass, 'pass', item.id, 'fanout'),
          },
        },
      } as Step;
    }
  }
}

function requireWritesField(
  writes: StepWrites,
  field: keyof StepWrites,
  itemId: string,
  kind: string,
): string {
  const value = writes[field];
  if (value === undefined) {
    fail(`schematic item '${itemId}' (${kind}) is missing writes.${field}`);
  }
  return value;
}

function requireCheckField<T>(
  value: T | undefined,
  field: 'required' | 'allow' | 'allow_from' | 'pass',
  itemId: string,
  kind: string,
): T {
  if (value === undefined) {
    fail(`schematic item '${itemId}' (${kind}) is missing check.${field}`);
  }
  return value;
}

function schematicHasOverrides(schematic: FlowSchematic): boolean {
  return schematic.items.some((item) => Object.keys(item.route_overrides).length > 0);
}

interface SchematicFrame {
  schematicId: string;
  version: string;
  purpose: string;
  axes: NonNullable<FlowSchematic['axes']>;
  startsAt: string;
  initialContracts: Set<FlowContractRef>;
  stageEntries: readonly { canonical: CanonicalStage; id: string; title: string }[];
  declaredOmits: readonly CanonicalStage[];
  stagePathRationale: string | undefined;
  defaultSelection: FlowSchematic['default_selection'];
}

function frameSchematic(schematic: FlowSchematic): SchematicFrame {
  const schematicId = schematic.id as unknown as string;
  const version = requireSchematicField(schematic.version, 'version', schematicId);
  const stageEntries = requireSchematicField(schematic.stages, 'stages', schematicId);
  const stagePathPolicy = requireSchematicField(
    schematic.stage_path_policy,
    'stage_path_policy',
    schematicId,
  );
  return {
    schematicId,
    version,
    purpose: schematic.purpose,
    axes: requireSchematicField(schematic.axes, 'axes', schematicId),
    startsAt: schematic.starts_at as unknown as string,
    initialContracts: new Set(schematic.initial_contracts),
    stageEntries: stageEntries.map((p) => ({
      canonical: p.canonical,
      id: p.id as unknown as string,
      title: p.title,
    })),
    declaredOmits: stagePathPolicy.mode === 'partial' ? stagePathPolicy.omits : [],
    stagePathRationale: stagePathPolicy.mode === 'partial' ? stagePathPolicy.rationale : undefined,
    defaultSelection: schematic.default_selection,
  };
}

// Compile the schematic for a single derived axis selection. Reachability +
// overrides are applied; unreachable items are dropped, empty stages are filtered, and
// stage_path_policy.omits is widened to include any canonical that ends up
// empty in this mode (so the CompiledFlow validator's stage path completeness rule
// stays satisfied).
function compileForMode(
  schematic: FlowSchematic,
  frame: SchematicFrame,
  mode: FlowAxisSelection,
): CompiledFlowValue {
  const reachable = computeReachableForMode(schematic, mode);
  const reachableItems = schematic.items.filter((item) =>
    reachable.has(item.id as unknown as string),
  );
  if (reachableItems.length === 0) {
    fail(
      `schematic '${frame.schematicId}' has no reachable items from starts_at '${frame.startsAt}' for mode '${mode.name}'`,
    );
  }

  const producerByContract = buildContractProducerIndex(frame.schematicId, reachableItems);

  const stages: { id: string; title: string; canonical: CanonicalStage; steps: string[] }[] = [];
  const reachedCanonicals = new Set<CanonicalStage>();
  for (const stage of frame.stageEntries) {
    const items = reachableItems.filter((i) => i.stage === stage.canonical);
    if (items.length === 0) continue;
    reachedCanonicals.add(stage.canonical);
    stages.push({
      id: stage.id,
      title: stage.title,
      canonical: stage.canonical,
      steps: items.map((i) => i.id as unknown as string),
    });
  }
  if (stages.length === 0) {
    fail(`schematic '${frame.schematicId}' compiled to zero stages for mode '${mode.name}'`);
  }

  const steps: Step[] = reachableItems.map((item) => {
    const reads = computeReads(item, frame.initialContracts, producerByContract);
    const routes = compileRoutesForMode(item, mode);
    return compileItem(item, reads, routes);
  });

  // Per-mode stage_path_policy: union of schematic-declared omits and any
  // canonical that ended up empty for this mode. The rationale gets
  // a per-mode suffix so the file is self-explanatory.
  const declaredOmitSet = new Set<CanonicalStage>(frame.declaredOmits);
  const autoOmits: CanonicalStage[] = [];
  for (const canonical of CANONICAL_STAGES) {
    if (declaredOmitSet.has(canonical)) continue;
    if (reachedCanonicals.has(canonical)) continue;
    // Only add if the schematic had a stage entry for this canonical
    // (otherwise it was already absent at the schematic level).
    const wasDeclared = frame.stageEntries.some((p) => p.canonical === canonical);
    if (wasDeclared) autoOmits.push(canonical);
  }
  const omits: CanonicalStage[] = [...frame.declaredOmits, ...autoOmits];

  // SpinePolicy discriminator: 'strict' when zero omits, 'partial' when at
  // least one. If the schematic was 'strict' and per-mode reachability auto-
  // omits a stage, the compiled output flips to 'partial' with an auto-
  // generated rationale.
  const stagePathPolicy =
    omits.length === 0
      ? { mode: 'strict' as const }
      : {
          mode: 'partial' as const,
          omits,
          rationale: composeStagePathRationale(frame.stagePathRationale, autoOmits, mode),
        };

  const flow: unknown = {
    schema_version: '3',
    id: schematic.id,
    version: frame.version,
    purpose: frame.purpose,
    axes: frame.axes,
    starts_at: frame.startsAt,
    stages,
    stage_path_policy: stagePathPolicy,
    steps,
    ...(frame.defaultSelection !== undefined ? { default_selection: frame.defaultSelection } : {}),
  };

  const parsed = CompiledFlow.safeParse(flow);
  if (!parsed.success) {
    fail(
      `schematic '${frame.schematicId}' compiled to a CompiledFlow that fails parse for mode '${mode.name}': ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function composeStagePathRationale(
  declared: string | undefined,
  autoOmits: readonly CanonicalStage[],
  mode: FlowAxisSelection,
): string {
  if (autoOmits.length === 0) {
    return declared ?? '';
  }
  const autoNote = `mode '${mode.name}' (depth '${mode.depth}') also omits ${autoOmits
    .map((c) => `'${c}'`)
    .join(', ')} because route_overrides leave those canonicals with no reachable items.`;
  return declared !== undefined && declared.length > 0 ? `${declared} ${autoNote}` : autoNote;
}

export function compileSchematicToCompiledFlow(schematic: FlowSchematic): CompileResult {
  const frame = frameSchematic(schematic);
  const axisSelections = axisSelectionsForAxes(frame.schematicId, frame.axes);

  if (!schematicHasOverrides(schematic)) {
    // No mode-specific topology. Compile one graph; only route_overrides that
    // change reachability need per-mode JSON siblings for the CLI loader.
    const firstMode = axisSelections[0];
    if (firstMode === undefined) {
      fail(`schematic '${frame.schematicId}' has no derived axis selections`);
    }
    return { kind: 'single', flow: compileForMode(schematic, frame, firstMode) };
  }

  const flows = new Map<string, CompiledFlowValue>();
  for (const mode of axisSelections) {
    flows.set(mode.name, compileForMode(schematic, frame, mode));
  }
  return { kind: 'per-mode', flows };
}
