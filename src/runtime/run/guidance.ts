import { policyRefsForRuntimeInputs } from '../../policy/policy-envelope.js';
import type { ResolvedConnector } from '../../schemas/connector.js';
import type { GuidanceDecisionTraceEntryBody } from '../../schemas/guidance-decision.js';
import { CompiledFlowId, RunId, StepId } from '../../schemas/ids.js';
import type { RecoveryFailureCause, RecoveryRouteKind } from '../../schemas/recovery-route-kind.js';
import type { Ref } from '../../schemas/ref.js';
import type { ResolvedSelection } from '../../schemas/selection-policy.js';
import type { RelayRole } from '../../schemas/step.js';
import type { LoadedRelaySkill } from '../../shared/skill-loading.js';
import type { RunContext } from './run-context.js';

function guidanceBounds(context: RunContext):
  | {
      readonly workContractRef: Ref;
      readonly policyRefs: readonly Ref[];
    }
  | undefined {
  if (context.workContractRef === undefined) return undefined;
  return {
    workContractRef: context.workContractRef,
    policyRefs: policyRefsForRuntimeInputs({
      ...(context.selectionConfigLayers === undefined
        ? {}
        : { configLayers: context.selectionConfigLayers }),
      ...(context.policyLayers === undefined ? {} : { policyLayers: context.policyLayers }),
    }),
  };
}

function idPart(value: string): string {
  return value.replace(/[^a-z0-9._-]/g, '-').toLowerCase();
}

export async function appendFlowSelectionGuidance(
  context: RunContext,
): Promise<GuidanceDecisionTraceEntryBody | undefined> {
  const bounds = guidanceBounds(context);
  if (bounds === undefined) return;

  const flowId = CompiledFlowId.parse(context.flow.id);
  return (await context.trace.append({
    run_id: context.runId,
    kind: 'guidance.decision',
    decision_id: `gd-flow-selection-${idPart(flowId as unknown as string)}`,
    subject: 'flow_selection',
    scope: {
      run_id: context.runId,
    },
    source: 'deterministic',
    selected: {
      flow_id: flowId,
      work_contract_ref: bounds.workContractRef,
    },
    input_refs: [bounds.workContractRef],
    constraint_refs: [bounds.workContractRef, ...bounds.policyRefs],
    contract_refs: [bounds.workContractRef],
    policy_refs: bounds.policyRefs,
    reason_codes: ['bootstrap_flow_selected'],
  })) as GuidanceDecisionTraceEntryBody;
}

export async function appendRelayExecutionGuidance(
  context: RunContext,
  input: {
    readonly stepId: string;
    readonly attempt: number;
    readonly role: RelayRole;
    readonly connector: ResolvedConnector;
    readonly resolvedSelection: ResolvedSelection;
    readonly loadedSkills: readonly LoadedRelaySkill[];
    readonly requestPath: string;
    readonly requestPayloadHash: string;
  },
): Promise<GuidanceDecisionTraceEntryBody | undefined> {
  const bounds = guidanceBounds(context);
  if (bounds === undefined) return;

  const flowId = CompiledFlowId.parse(context.flow.id);
  const runId = RunId.parse(context.runId);
  const stepId = StepId.parse(input.stepId);
  const requestRef: Ref = {
    kind: 'request',
    ref: input.requestPath,
    sha256: input.requestPayloadHash,
    run_id: runId,
    flow_id: flowId,
    step_id: stepId,
    attempt: input.attempt,
  };
  const skills = input.loadedSkills.map((skill) => ({
    id: skill.id,
    ...(skill.slot === undefined ? {} : { slot: skill.slot }),
  }));

  // A connector-layer re-ask (top-level or fanout branch) re-plans the same
  // deterministic decision within the same attempt. The trace contract
  // requires decision ids to be unique, and the decision genuinely was made
  // once, so return the recorded entry instead of appending a duplicate. The
  // request hash must match: a same-id decision for a DIFFERENT request is a
  // conflict the contract should surface, never silently reuse.
  const decisionId = `gd-relay-${idPart(stepId as unknown as string)}-${input.attempt}`;
  for (const entry of context.trace.getAll()) {
    if (entry.kind !== 'guidance.decision') continue;
    if (entry.decision_id !== decisionId) continue;
    const selected = entry.selected as { readonly request_payload_hash?: string } | undefined;
    if (selected?.request_payload_hash === input.requestPayloadHash) {
      return entry as unknown as GuidanceDecisionTraceEntryBody;
    }
  }

  return (await context.trace.append({
    run_id: context.runId,
    kind: 'guidance.decision',
    decision_id: decisionId,
    subject: 'relay_execution',
    scope: {
      run_id: context.runId,
      flow_id: flowId,
      step_id: stepId,
      attempt: input.attempt,
    },
    source: 'deterministic',
    selected: {
      role: input.role,
      connector: input.connector,
      ...(input.resolvedSelection.model === undefined
        ? {}
        : { model: input.resolvedSelection.model }),
      ...(input.resolvedSelection.effort === undefined
        ? {}
        : { effort: input.resolvedSelection.effort }),
      skills,
      context_packet_ref: requestRef,
      request_payload_hash: input.requestPayloadHash,
    },
    input_refs: [requestRef],
    constraint_refs: [bounds.workContractRef, ...bounds.policyRefs],
    contract_refs: [bounds.workContractRef],
    policy_refs: bounds.policyRefs,
    reason_codes: ['relay_execution_selected'],
  })) as GuidanceDecisionTraceEntryBody;
}

function checkpointResolutionSource(source: string): 'declared-default' | 'operator' | 'policy' {
  if (source === 'declared-default') return 'declared-default';
  if (source === 'operator') return 'operator';
  return 'policy';
}

function checkpointDecisionSource(
  source: string,
): 'deterministic' | 'heuristic' | 'operator_override' {
  if (source === 'operator') return 'operator_override';
  if (source === 'declared-default') return 'deterministic';
  return 'heuristic';
}

function checkpointReasonCode(source: string): string {
  if (source === 'declared-default') return 'declared_default_allowed';
  if (source === 'operator') return 'operator_checkpoint_choice';
  return 'policy_checkpoint_resolution';
}

export async function appendCheckpointResolutionGuidance(
  context: RunContext,
  input: {
    readonly stepId: string;
    readonly attempt: number;
    readonly choiceId: string;
    readonly routeId: string;
    readonly autoResolved: boolean;
    readonly resolutionSource: string;
    readonly requestPath: string;
    readonly requestReportHash: string;
    readonly evidenceRefs?: readonly Ref[];
    readonly rejectedOptions?: GuidanceDecisionTraceEntryBody['rejected_options'];
  },
): Promise<GuidanceDecisionTraceEntryBody | undefined> {
  const bounds = guidanceBounds(context);
  if (bounds === undefined) return;

  const flowId = CompiledFlowId.parse(context.flow.id);
  const stepId = StepId.parse(input.stepId);
  const requestRef: Ref = {
    kind: 'request',
    ref: input.requestPath,
    sha256: input.requestReportHash,
    run_id: RunId.parse(context.runId),
    flow_id: flowId,
    step_id: stepId,
    attempt: input.attempt,
  };
  return (await context.trace.append({
    run_id: context.runId,
    kind: 'guidance.decision',
    decision_id: `gd-checkpoint-${idPart(stepId as unknown as string)}-${input.attempt}`,
    subject: 'checkpoint_resolution',
    scope: {
      run_id: context.runId,
      flow_id: flowId,
      step_id: stepId,
      attempt: input.attempt,
    },
    source: checkpointDecisionSource(input.resolutionSource),
    selected: {
      choice_id: input.choiceId,
      route_id: input.routeId,
      auto_resolved: input.autoResolved,
      resolution_source: checkpointResolutionSource(input.resolutionSource),
    },
    input_refs: [requestRef],
    constraint_refs: [bounds.workContractRef, ...bounds.policyRefs],
    contract_refs: [bounds.workContractRef],
    policy_refs: bounds.policyRefs,
    ...(input.evidenceRefs === undefined || input.evidenceRefs.length === 0
      ? {}
      : { evidence_refs: input.evidenceRefs }),
    reason_codes: [checkpointReasonCode(input.resolutionSource)],
    ...(input.rejectedOptions === undefined || input.rejectedOptions.length === 0
      ? {}
      : { rejected_options: input.rejectedOptions }),
  })) as GuidanceDecisionTraceEntryBody;
}

export async function appendRecoveryRouteGuidance(
  context: RunContext,
  input: {
    readonly stepId: string;
    readonly attempt: number;
    readonly routeId: string;
    readonly recoveryKind: RecoveryRouteKind;
    readonly failureCause: RecoveryFailureCause;
    readonly failureRef: Ref;
    readonly bindingRef: Ref;
  },
): Promise<GuidanceDecisionTraceEntryBody | undefined> {
  const bounds = guidanceBounds(context);
  if (bounds === undefined) return;

  const flowId = CompiledFlowId.parse(context.flow.id);
  const stepId = StepId.parse(input.stepId);
  return (await context.trace.append({
    run_id: context.runId,
    kind: 'guidance.decision',
    decision_id: `gd-recovery-${idPart(stepId as unknown as string)}-${input.attempt}-${idPart(input.routeId)}`,
    subject: 'recovery_route',
    scope: {
      run_id: context.runId,
      flow_id: flowId,
      step_id: stepId,
      attempt: input.attempt,
    },
    source: 'deterministic',
    selected: {
      route_id: input.routeId,
      recovery_kind: input.recoveryKind,
      failure_cause: input.failureCause,
      failure_ref: input.failureRef,
      binding_ref: input.bindingRef,
    },
    input_refs: [input.failureRef],
    constraint_refs: [bounds.workContractRef, ...bounds.policyRefs],
    contract_refs: [bounds.workContractRef],
    policy_refs: bounds.policyRefs,
    evidence_refs: [input.failureRef],
    reason_codes: ['recovery_route_selected'],
  })) as GuidanceDecisionTraceEntryBody;
}

export async function appendProofPolicyGuidance(
  context: RunContext,
  input: {
    readonly stepId: string;
    readonly attempt: number;
    readonly requiredClaimKinds: readonly string[];
    readonly requiredEvidenceKinds: readonly string[];
    readonly closeRequiresProven: boolean;
    readonly inputRefs: readonly Ref[];
  },
): Promise<GuidanceDecisionTraceEntryBody | undefined> {
  const bounds = guidanceBounds(context);
  if (bounds === undefined) return;

  const flowId = CompiledFlowId.parse(context.flow.id);
  const stepId = StepId.parse(input.stepId);
  return (await context.trace.append({
    run_id: context.runId,
    kind: 'guidance.decision',
    decision_id: `gd-proof-${idPart(stepId as unknown as string)}-${input.attempt}`,
    subject: 'proof_policy',
    scope: {
      run_id: context.runId,
      flow_id: flowId,
      step_id: stepId,
      attempt: input.attempt,
    },
    source: 'deterministic',
    selected: {
      proof_profile: 'acceptance_criteria',
      required_claim_kinds: [...input.requiredClaimKinds],
      required_evidence_kinds: [...input.requiredEvidenceKinds],
      close_requires_proven: input.closeRequiresProven,
    },
    input_refs: input.inputRefs.length === 0 ? [bounds.workContractRef] : input.inputRefs,
    constraint_refs: [bounds.workContractRef, ...bounds.policyRefs],
    contract_refs: [bounds.workContractRef],
    policy_refs: bounds.policyRefs,
    reason_codes: ['proof_policy_selected'],
  })) as GuidanceDecisionTraceEntryBody;
}
