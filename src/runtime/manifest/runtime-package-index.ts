import type {
  RuntimeIndexedStep,
  RuntimeIndexedWrite,
  RuntimePackageIndex,
} from '../../flows/registries/runtime-index.js';
import {
  SelectionOverride,
  type SelectionOverride as SelectionOverrideValue,
} from '../../schemas/selection-policy.js';
import type { RunFileRef } from '../domain/run-file.js';
import type { Selection } from '../domain/selection.js';
import type { ExecutableFlow, ExecutableStep, FanoutStep } from './executable-flow.js';

function writeRef(ref: RunFileRef | undefined): RuntimeIndexedWrite {
  if (ref === undefined) return undefined;
  if (ref.schema !== undefined) return { path: ref.path, schema: ref.schema };
  return ref.path;
}

function indexedSelection(selection: Selection | undefined): SelectionOverrideValue | undefined {
  if (selection === undefined) return undefined;
  return SelectionOverride.parse({
    ...(selection.model === undefined ? {} : { model: selection.model }),
    ...(selection.effort === undefined ? {} : { effort: selection.effort }),
    skills: selection.skills ?? { mode: 'inherit' },
    ...(selection.depth === undefined ? {} : { depth: selection.depth }),
    invocation_options: selection.invocation_options ?? {},
  });
}

function baseStep(step: ExecutableStep) {
  const selection = indexedSelection(step.selection);
  return {
    id: step.id,
    title: step.title ?? step.id,
    protocol: step.protocol ?? step.id,
    reads: step.reads?.map((ref) => ref.path) ?? [],
    routes: Object.fromEntries(
      Object.entries(step.routes).map(([route, target]) => [
        route,
        target.kind === 'terminal' ? target.target : target.stepId,
      ]),
    ),
    writes: Object.fromEntries(
      Object.entries(step.writes ?? {}).map(([slot, ref]) => [slot, writeRef(ref)]),
    ),
    check: step.check,
    ...(selection === undefined ? {} : { selection }),
    ...(step.skillSlots === undefined ? {} : { skill_slots: step.skillSlots }),
    ...(step.equipmentScope === undefined ? {} : { equipment_scope: step.equipmentScope }),
    ...(step.budgets === undefined ? {} : { budgets: step.budgets }),
  };
}

// A fan-out's branches all share one execution shape, so a fan-out whose
// branches are relays has exactly one relay role, connector, and selection to
// report. A branch template that is a sub-run, or a static branch list with any
// non-relay in it, has none, and the index says so by leaving this undefined.
function fanoutBranchRelay(step: FanoutStep) {
  const branches = step.branches;
  const templates =
    branches.kind === 'dynamic' ? [branches.template] : (branches.branches as readonly unknown[]);
  const executions = templates.map((branch) => {
    const record = branch as { readonly execution?: { readonly role?: unknown } } | undefined;
    return record?.execution;
  });
  const first = executions[0] as { readonly kind?: unknown; readonly role?: unknown } | undefined;
  if (executions.length === 0 || first?.kind !== 'relay') return undefined;
  if (!executions.every((execution) => (execution as { kind?: unknown })?.kind === 'relay')) {
    return undefined;
  }
  const branchRecord = templates[0] as
    | { readonly connector?: string; readonly selection?: unknown }
    | undefined;
  // A connector named per item (`$item.connector_name`) is not knowable until
  // the items exist. Reporting the role default in its place would be a
  // confident wrong answer, so such a fan-out reports no relay shape at all.
  if (branchRecord?.connector?.includes('$') === true) return undefined;
  // A branch selection can be a template (`$variant.model`) rather than a
  // resolved one, and a template is not a selection any readout can report.
  // Those are left out rather than parsed into an error.
  const selection = branchSelection(branchRecord?.selection);
  return {
    role: first.role as 'researcher' | 'implementer' | 'reviewer',
    ...(branchRecord?.connector === undefined ? {} : { connector: branchRecord.connector }),
    ...(selection === undefined ? {} : { selection }),
  };
}

function branchSelection(selection: unknown): SelectionOverrideValue | undefined {
  if (selection === undefined || selection === null) return undefined;
  const parsed = SelectionOverride.safeParse({
    ...(selection as Record<string, unknown>),
    skills: (selection as { skills?: unknown }).skills ?? { mode: 'inherit' },
    invocation_options: (selection as { invocation_options?: unknown }).invocation_options ?? {},
  });
  return parsed.success ? parsed.data : undefined;
}

function indexedStep(step: ExecutableStep): RuntimeIndexedStep {
  const base = baseStep(step);
  if (step.kind === 'checkpoint') {
    return {
      ...base,
      kind: step.kind,
      policy: step.policy,
    } as unknown as RuntimeIndexedStep;
  }
  if (step.kind === 'relay') {
    return {
      ...base,
      kind: step.kind,
      role: step.role,
      ...(step.connector === undefined ? {} : { connector: step.connector }),
      ...(step.acceptanceCriteria === undefined
        ? {}
        : { acceptance_criteria: step.acceptanceCriteria }),
    } as unknown as RuntimeIndexedStep;
  }
  if (step.kind === 'fanout') {
    const relay = fanoutBranchRelay(step);
    return {
      ...base,
      kind: step.kind,
      ...(relay === undefined ? {} : { branch_relay: relay }),
    } as unknown as RuntimeIndexedStep;
  }
  return { ...base, kind: step.kind } as unknown as RuntimeIndexedStep;
}

export function buildRuntimePackageIndex(flow: ExecutableFlow): RuntimePackageIndex {
  const steps = flow.steps.map((step) => indexedStep(step));
  const defaultSelection = indexedSelection(flow.defaultSelection);
  const stepsById = new Map<string, RuntimeIndexedStep>();
  const reportPathBySchema = new Map<string, string>();
  for (const step of steps) {
    if (stepsById.has(step.id)) {
      throw new Error(`runtime package index duplicate step '${step.id}'`);
    }
    stepsById.set(step.id, step);
    const report = step.writes.report;
    if (typeof report !== 'object' || report === null) continue;
    if (!reportPathBySchema.has(report.schema)) {
      reportPathBySchema.set(report.schema, report.path);
    }
  }

  return {
    flow: {
      id: flow.id,
      version: flow.version,
      ...(flow.purpose === undefined ? {} : { purpose: flow.purpose }),
      ...(defaultSelection === undefined ? {} : { default_selection: defaultSelection }),
      stages: flow.stages.map((stage) => {
        const selection = indexedSelection(stage.selection);
        return {
          id: stage.id,
          steps: stage.stepIds,
          ...(selection === undefined ? {} : { selection }),
        };
      }),
      steps,
    },
    stepsById,
    reportPathBySchema,
  };
}
