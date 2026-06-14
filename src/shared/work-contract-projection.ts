import {
  NORMAL_ROUTE_IDS,
  recoveryAllowedFailureCausesForKind,
  recoveryAttemptBudgetForKind,
  recoveryKindForRoute,
  recoveryOperatorAuthorityForKind,
  recoveryRequiredRefsForKind,
} from '../policy/recovery-route-policy.js';
import type { CompiledFlow } from '../schemas/compiled-flow.js';
import { sha256OfJson } from '../schemas/hashing.js';
import type { JsonObject } from '../schemas/json.js';
import type { Ref } from '../schemas/ref.js';
import type {
  CheckpointStep,
  FanoutBranch,
  FanoutBranchTemplate,
  FanoutStep,
  RelayStep,
  Step,
  SubRunStep,
} from '../schemas/step.js';
import {
  WorkContractProjectionV0,
  type WorkContractProjectionV0 as WorkContractProjectionValue,
} from '../schemas/work-contract-projection.js';

export { WorkContractProjectionV0 } from '../schemas/work-contract-projection.js';

export class WorkContractProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkContractProjectionError';
  }
}

interface ProjectWorkContractProjectionInput {
  readonly flow: CompiledFlow;
  readonly contractRefPath?: string;
}

const FLOW_KEYS = new Set([
  'schema_version',
  'id',
  'version',
  'purpose',
  'axes',
  'starts_at',
  'stages',
  'stage_path_policy',
  'steps',
  'default_selection',
  // Stage 3 (first-class composition): engine-visible behavior flags. They
  // describe how the engine runs the flow, not the authority/proof/recovery
  // surface the work contract projects, so they are classified here without
  // contributing a hint.
  'engine_flags',
]);

const STAGE_KEYS = new Set(['id', 'title', 'canonical', 'steps', 'selection']);

const STEP_KEYS: Readonly<Record<Step['kind'], ReadonlySet<string>>> = {
  compose: new Set([
    'id',
    'title',
    'protocol',
    'reads',
    'routes',
    'selection',
    'skill_slots',
    'route_from_report',
    'budgets',
    'executor',
    'kind',
    'writes',
    'check',
  ]),
  verification: new Set([
    'id',
    'title',
    'protocol',
    'reads',
    'routes',
    'selection',
    'skill_slots',
    'route_from_report',
    'budgets',
    'executor',
    'kind',
    'writes',
    'check',
  ]),
  checkpoint: new Set([
    'id',
    'title',
    'protocol',
    'reads',
    'routes',
    'selection',
    'skill_slots',
    'route_from_report',
    'budgets',
    'executor',
    'kind',
    'policy',
    'writes',
    'check',
  ]),
  relay: new Set([
    'id',
    'title',
    'protocol',
    'reads',
    'routes',
    'selection',
    'skill_slots',
    'route_from_report',
    'budgets',
    'executor',
    'kind',
    'role',
    'connector',
    'acceptance_criteria',
    'writes',
    'check',
  ]),
  'sub-run': new Set([
    'id',
    'title',
    'protocol',
    'reads',
    'routes',
    'selection',
    'skill_slots',
    'route_from_report',
    'budgets',
    'executor',
    'kind',
    'flow_ref',
    'goal',
    'depth',
    'writes',
    'check',
  ]),
  fanout: new Set([
    'id',
    'title',
    'protocol',
    'reads',
    'routes',
    'selection',
    'skill_slots',
    'route_from_report',
    'budgets',
    'executor',
    'kind',
    'branches',
    'concurrency',
    'on_child_failure',
    'rubric',
    'writes',
    'check',
  ]),
};

function sha256(value: unknown): string {
  return sha256OfJson(value);
}

function asJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

function sourceRef(flow: CompiledFlow, flowHash: string, ref: string): Ref {
  return {
    kind: 'work_contract',
    ref,
    sha256: flowHash,
    flow_id: flow.id,
  };
}

export function workContractProjectionPathForCompiledFlowPath(compiledFlowPath: string): string {
  if (!compiledFlowPath.endsWith('.json') || compiledFlowPath.endsWith('.work-contract.v0.json')) {
    throw new WorkContractProjectionError(
      `compiled flow path '${compiledFlowPath}' must end with a non-contract .json filename`,
    );
  }
  return compiledFlowPath.replace(/\.json$/, '.work-contract.v0.json');
}

export function runtimeWorkContractRefForProjectedRef(ref: Ref): Ref {
  if (ref.sha256 === undefined) {
    throw new WorkContractProjectionError('projected WorkContract ref is missing sha256');
  }
  return {
    ...ref,
    ref: `runtime/work-contract/${ref.flow_id as unknown as string}/${ref.sha256}.json`,
  };
}

function rejectUnknownKeys(
  label: string,
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new WorkContractProjectionError(`${label}: ${unknown.join(', ')}`);
  }
}

function reportSlotsForStep(step: Step) {
  const reports: Array<{
    step_id: Step['id'];
    slot: string;
    path: string;
    schema: string;
  }> = [];
  for (const [slot, value] of Object.entries(step.writes)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'path' in value &&
      'schema' in value
    ) {
      const report = value as { path: string; schema: string };
      reports.push({ step_id: step.id, slot, path: report.path, schema: report.schema });
    }
  }
  return reports;
}

function choicesForCheckpoint(step: CheckpointStep) {
  if (step.policy.choices !== undefined) {
    return {
      kind: 'static' as const,
      ids: step.policy.choices.map((choice) => choice.id),
    };
  }
  return {
    kind: 'dynamic' as const,
    source_ref: asJsonObject(step.policy.choices_from),
  };
}

function guidanceSeedRefsForBranch(
  flow: CompiledFlow,
  flowHash: string,
  step: FanoutStep,
  branch: FanoutBranch | FanoutBranchTemplate,
  indexLabel: string,
): { selection?: Ref; connector?: Ref } {
  const refs: { selection?: Ref; connector?: Ref } = {};
  if ('selection' in branch && branch.selection !== undefined) {
    refs.selection = sourceRef(
      flow,
      flowHash,
      `compiled-flow/steps/${step.id}/branches/${indexLabel}/selection`,
    );
  }
  if ('connector' in branch && branch.connector !== undefined) {
    refs.connector = sourceRef(
      flow,
      flowHash,
      `compiled-flow/steps/${step.id}/branches/${indexLabel}/connector`,
    );
  }
  return refs;
}

function branchGuidanceSeedRefs(flow: CompiledFlow, flowHash: string, step: FanoutStep) {
  const selection: Ref[] = [];
  const connector: Ref[] = [];
  if (step.branches.kind === 'static') {
    for (const [index, branch] of step.branches.branches.entries()) {
      const refs = guidanceSeedRefsForBranch(flow, flowHash, step, branch, String(index));
      if (refs.selection !== undefined) selection.push(refs.selection);
      if (refs.connector !== undefined) connector.push(refs.connector);
    }
  } else {
    const refs = guidanceSeedRefsForBranch(
      flow,
      flowHash,
      step,
      step.branches.template,
      'template',
    );
    if (refs.selection !== undefined) selection.push(refs.selection);
    if (refs.connector !== undefined) connector.push(refs.connector);
  }
  return { selection, connector };
}

function stripBranchGuidanceAuthority(branch: FanoutBranch | FanoutBranchTemplate): JsonObject {
  const {
    selection: _selection,
    connector: _connector,
    ...contractBranch
  } = branch as Record<string, unknown>;
  return asJsonObject(contractBranch);
}

function contractFanoutBranches(step: FanoutStep): JsonObject {
  if (step.branches.kind === 'static') {
    return asJsonObject({
      kind: 'static',
      branches: step.branches.branches.map(stripBranchGuidanceAuthority),
    });
  }
  return asJsonObject({
    ...step.branches,
    template: stripBranchGuidanceAuthority(step.branches.template),
  });
}

export function projectWorkContractProjectionV0(
  input: ProjectWorkContractProjectionInput,
): WorkContractProjectionValue {
  const { flow } = input;
  const flowHash = sha256(flow);
  rejectUnknownKeys(
    'unclassified flow fields',
    flow as unknown as Record<string, unknown>,
    FLOW_KEYS,
  );
  const selectionHints: Ref[] = [];
  const connectorHints: Ref[] = [];
  const skillHints: Ref[] = [];
  const checkpointDefaultHints: Ref[] = [];
  const rejectedAuthority: WorkContractProjectionValue['rejected_authority'] = [];
  const relays: WorkContractProjectionValue['work_contract']['authority']['relays'] = [];
  const checkpoints: WorkContractProjectionValue['work_contract']['authority']['checkpoints'] = [];
  const subRuns: WorkContractProjectionValue['work_contract']['authority']['sub_runs'] = [];
  const fanouts: WorkContractProjectionValue['work_contract']['authority']['fanouts'] = [];
  const skillSlots: WorkContractProjectionValue['work_contract']['authority']['skill_slots'] = [];
  const reports: WorkContractProjectionValue['work_contract']['proof']['reports'] = [];
  const checks: WorkContractProjectionValue['work_contract']['proof']['checks'] = [];
  const acceptanceCriteria: WorkContractProjectionValue['work_contract']['proof']['acceptance_criteria'] =
    [];
  const recovery: WorkContractProjectionValue['work_contract']['recovery'] = [];
  const budgets: WorkContractProjectionValue['work_contract']['limits']['budgets'] = [];

  if (flow.default_selection !== undefined) {
    selectionHints.push(sourceRef(flow, flowHash, 'compiled-flow/default_selection'));
    if (flow.default_selection.skills.mode !== 'inherit') {
      skillHints.push(sourceRef(flow, flowHash, 'compiled-flow/default_selection/skills'));
    }
  }

  for (const stage of flow.stages) {
    rejectUnknownKeys(
      'unclassified stage fields',
      stage as unknown as Record<string, unknown>,
      STAGE_KEYS,
    );
    if (stage.selection !== undefined) {
      selectionHints.push(sourceRef(flow, flowHash, `compiled-flow/stages/${stage.id}/selection`));
    }
  }

  for (const step of flow.steps) {
    rejectUnknownKeys(
      'unclassified step fields',
      step as unknown as Record<string, unknown>,
      STEP_KEYS[step.kind],
    );
    if (step.selection !== undefined) {
      selectionHints.push(sourceRef(flow, flowHash, `compiled-flow/steps/${step.id}/selection`));
    }
    for (const slot of step.skill_slots ?? []) {
      skillSlots.push({
        step_id: step.id,
        slot_id: slot.id,
        description: slot.description,
      });
    }
    for (const report of reportSlotsForStep(step)) reports.push(report);
    checks.push({
      step_id: step.id,
      check_kind: step.check.kind,
      source: asJsonObject(step.check.source),
    });
    if (step.budgets !== undefined) {
      budgets.push({
        step_id: step.id,
        ...(step.budgets.max_attempts === undefined
          ? {}
          : { max_attempts: step.budgets.max_attempts }),
        ...(step.budgets.wall_clock_ms === undefined
          ? {}
          : { wall_clock_ms: step.budgets.wall_clock_ms }),
      });
    }

    for (const [routeId, target] of Object.entries(step.routes)) {
      if (NORMAL_ROUTE_IDS.has(routeId)) continue;
      const kind = recoveryKindForRoute({
        routeId,
        routeTarget: target,
        stepId: step.id,
      });
      if (kind === undefined) continue;
      recovery.push({
        schema_version: 0,
        step_id: step.id,
        route_id: routeId,
        route_target: target,
        kind,
        allowed_failure_causes: recoveryAllowedFailureCausesForKind(kind),
        required_refs: recoveryRequiredRefsForKind(kind),
        operator_authority: recoveryOperatorAuthorityForKind(kind),
        attempt_budget: recoveryAttemptBudgetForKind(kind),
        guidance: {
          subject: 'recovery_route',
          must_match_step_completed: true,
        },
        source_ref: sourceRef(flow, flowHash, `compiled-flow/steps/${step.id}/routes/${routeId}`),
      });
    }

    if (step.kind === 'relay') {
      const relayStep = step as RelayStep;
      if (relayStep.connector !== undefined) {
        connectorHints.push(sourceRef(flow, flowHash, `compiled-flow/steps/${step.id}/connector`));
      }
      if (relayStep.acceptance_criteria !== undefined) {
        acceptanceCriteria.push({
          kind: 'acceptance_criteria_input',
          step_id: step.id,
          criteria: asJsonObject(relayStep.acceptance_criteria),
        });
      }
      relays.push({
        step_id: step.id,
        role: relayStep.role,
        writes: asJsonObject(relayStep.writes),
        ...(relayStep.writes.report === undefined
          ? {}
          : {
              report: {
                step_id: step.id,
                slot: 'report',
                path: relayStep.writes.report.path,
                schema: relayStep.writes.report.schema,
              },
            }),
      });
      continue;
    }

    if (step.kind === 'checkpoint') {
      const checkpointStep = step as CheckpointStep;
      if (checkpointStep.policy.safe_default_choice !== undefined) {
        checkpointDefaultHints.push(
          sourceRef(flow, flowHash, `compiled-flow/steps/${step.id}/policy/safe_default_choice`),
        );
      }
      if (checkpointStep.policy.auto_resolution !== undefined) {
        rejectedAuthority.push({
          path: `compiled-flow/steps/${step.id}/policy/auto_resolution`,
          field: 'auto_resolution',
          reason: 'checkpoint auto-resolution must become a declared default or traced guidance',
          source_ref: sourceRef(
            flow,
            flowHash,
            `compiled-flow/steps/${step.id}/policy/auto_resolution`,
          ),
        });
      }
      checkpoints.push({
        step_id: step.id,
        choices: choicesForCheckpoint(checkpointStep),
        writes: asJsonObject(checkpointStep.writes),
      });
      continue;
    }

    if (step.kind === 'sub-run') {
      const subRunStep = step as SubRunStep;
      subRuns.push({
        step_id: step.id,
        flow_ref: asJsonObject(subRunStep.flow_ref),
        goal: subRunStep.goal,
        depth: subRunStep.depth,
        writes: asJsonObject(subRunStep.writes),
      });
      continue;
    }

    if (step.kind === 'fanout') {
      const fanoutStep = step as FanoutStep;
      const refs = branchGuidanceSeedRefs(flow, flowHash, fanoutStep);
      selectionHints.push(...refs.selection);
      connectorHints.push(...refs.connector);
      fanouts.push({
        step_id: step.id,
        branches: contractFanoutBranches(fanoutStep),
        writes: asJsonObject(fanoutStep.writes),
      });
    }
  }

  const workContract = {
    flow: {
      id: flow.id,
      version: flow.version,
      purpose: flow.purpose,
      axes: flow.axes,
      starts_at: flow.starts_at,
    },
    topology: {
      stages: flow.stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        ...(stage.canonical === undefined ? {} : { canonical: stage.canonical }),
        steps: [...stage.steps],
      })),
      stage_path_policy: asJsonObject(flow.stage_path_policy),
      routes: flow.steps.flatMap((step) =>
        Object.entries(step.routes).map(([routeId, target]) => ({
          step_id: step.id,
          route_id: routeId,
          target,
        })),
      ),
    },
    blocks: flow.steps.map((step) => ({
      step_id: step.id,
      title: step.title,
      kind: step.kind,
      executor: step.executor,
      protocol: step.protocol,
      reads: [...step.reads],
      writes: asJsonObject(step.writes),
      check: asJsonObject(step.check),
      routes: step.routes,
      ...(step.route_from_report === undefined
        ? {}
        : { route_from_report: asJsonObject(step.route_from_report) }),
    })),
    authority: {
      relays,
      checkpoints,
      sub_runs: subRuns,
      fanouts,
      skill_slots: skillSlots,
    },
    proof: {
      reports,
      checks,
      acceptance_criteria: acceptanceCriteria,
    },
    recovery,
    limits: {
      budgets,
    },
  } satisfies WorkContractProjectionValue['work_contract'];
  const contractRefPath =
    input.contractRefPath ??
    workContractProjectionPathForCompiledFlowPath(`generated/flows/${flow.id}/circuit.json`);
  const projection = {
    schema_version: 0,
    contract_ref: {
      kind: 'work_contract' as const,
      ref: contractRefPath,
      sha256: sha256(workContract),
      flow_id: flow.id,
    },
    work_contract: workContract,
    guidance_seed: {
      selection_hints: selectionHints,
      connector_hints: connectorHints,
      skill_hints: skillHints,
      checkpoint_default_hints: checkpointDefaultHints,
      host_recommendations: [],
    },
    rejected_authority: rejectedAuthority,
  } satisfies WorkContractProjectionValue;

  return WorkContractProjectionV0.parse(projection);
}
