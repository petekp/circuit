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
import type { ExecutableFlow, ExecutableStep } from './executable-flow.js';

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
