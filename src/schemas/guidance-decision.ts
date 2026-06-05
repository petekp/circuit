import { z } from 'zod';
import { ResolvedConnector } from './connector.js';
import { CompiledFlowId, RunId, SkillId, SkillSlotId, StepId } from './ids.js';
import { JsonObject } from './json.js';
import { RecoveryFailureCause, RecoveryRouteKind } from './recovery-route-kind.js';
import { Ref, Sha256 } from './ref.js';
import { RuntimeTouchedFilesEvidenceRef } from './runtime-evidence.js';
import { Effort, ProviderScopedModel } from './selection-policy.js';
import { RelayRole } from './step.js';

export const GuidanceDecisionId = z.string().regex(/^gd-[a-z0-9][a-z0-9._-]*$/);
export type GuidanceDecisionId = z.infer<typeof GuidanceDecisionId>;

export const GuidanceDecisionSubject = z.enum([
  'flow_selection',
  'relay_execution',
  'checkpoint_resolution',
  'proof_policy',
  'recovery_route',
  'safe_apply',
]);
export type GuidanceDecisionSubject = z.infer<typeof GuidanceDecisionSubject>;

export const GuidanceDecisionSource = z.enum([
  'deterministic',
  'heuristic',
  'model_recommended',
  'host_recommended',
  'operator_override',
]);
export type GuidanceDecisionSource = z.infer<typeof GuidanceDecisionSource>;

const ReasonCode = z.string().regex(/^[a-z][a-z0-9_]*$/);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const GuidanceScope = z
  .object({
    run_id: RunId,
    flow_id: CompiledFlowId.optional(),
    step_id: StepId.optional(),
    attempt: z.number().int().positive().optional(),
    branch_id: z.string().min(1).optional(),
  })
  .strict();
export type GuidanceScope = z.infer<typeof GuidanceScope>;

const GuidanceSkillSelection = z
  .object({
    id: SkillId,
    slot: SkillSlotId.optional(),
  })
  .strict();

const RelayExecutionSelected = z
  .object({
    role: RelayRole,
    connector: ResolvedConnector,
    model: ProviderScopedModel.optional(),
    effort: Effort.optional(),
    skills: z.array(GuidanceSkillSelection),
    context_packet_ref: Ref,
    request_payload_hash: Sha256,
  })
  .strict();

const WorkContractRef = Ref.refine((ref) => ref.kind === 'work_contract', {
  message: 'must be a work_contract ref',
});

const FlowSelectionSelected = z
  .object({
    flow_id: CompiledFlowId,
    work_contract_ref: WorkContractRef,
    host_recommendation: z
      .object({
        flow_id: CompiledFlowId,
        accepted: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ProofPolicySelected = z
  .object({
    proof_profile: z.string().min(1),
    required_claim_kinds: z.array(z.string().min(1)),
    required_evidence_kinds: z.array(z.string().min(1)),
    close_requires_proven: z.boolean(),
  })
  .strict();

const ChangePacketRef = Ref.refine((ref) => ref.kind === 'change_packet', {
  message: 'change packet refs must use kind change_packet',
});

const BaseRef = Ref.refine((ref) => ref.kind === 'command', {
  message: 'safe_apply base refs must use command refs',
});

const FinalVerificationRef = Ref.refine((ref) => ref.kind === 'command', {
  message: 'safe_apply final verification refs must use command refs',
});

const SafeApplySelected = z
  .object({
    action: z.enum(['accept', 'reject', 'apply']),
    change_packet_ref: ChangePacketRef,
    base_ref: BaseRef,
    protected_file_decision: z.enum(['allowed', 'rejected', 'checkpointed']).optional(),
    final_verification_ref: FinalVerificationRef.optional(),
    touched_files_ref: RuntimeTouchedFilesEvidenceRef.optional(),
  })
  .strict()
  .superRefine((selected, ctx) => {
    if (selected.action === 'apply' && selected.final_verification_ref === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['final_verification_ref'],
        message: 'safe_apply apply decisions require final verification refs',
      });
    }
  });

const RecoveryRouteSelected = z
  .object({
    route_id: z.string().min(1),
    recovery_kind: RecoveryRouteKind,
    failure_cause: RecoveryFailureCause,
    failure_ref: Ref,
    binding_ref: WorkContractRef,
    touched_files_ref: RuntimeTouchedFilesEvidenceRef.optional(),
  })
  .strict()
  .superRefine((selected, ctx) => {
    if (['work_contract', 'policy', 'memory'].includes(selected.failure_ref.kind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['failure_ref', 'kind'],
        message:
          'recovery failure refs must point at failure evidence, not authority or memory refs',
      });
    }
    if (
      selected.failure_cause === 'unknown_failure' &&
      ['retry_same_step_with_feedback', 'run_verification', 'run_independent_review'].includes(
        selected.recovery_kind,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['recovery_kind'],
        message: 'unknown_failure cannot route to retry, verification, or independent review',
      });
    }
  });

const RejectedGuidanceOption = z
  .object({
    option: JsonObject,
    reason_code: ReasonCode,
    blocked_by: Ref.optional(),
  })
  .strict();

const NonEmptyRefs = z.array(Ref).min(1);
type RefValue = z.infer<typeof Ref>;

function sameRef(a: RefValue, b: RefValue): boolean {
  return (
    a.kind === b.kind &&
    a.ref === b.ref &&
    a.sha256 === b.sha256 &&
    a.run_id === b.run_id &&
    a.flow_id === b.flow_id &&
    a.step_id === b.step_id &&
    a.attempt === b.attempt &&
    a.sequence === b.sequence
  );
}

function isMemoryReasonCode(reasonCode: string): boolean {
  return reasonCode.startsWith('memory_');
}

function addScopedRefIssues(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  label: string,
  ref: RefValue,
  entry: GuidanceDecisionTraceEntryBody,
): void {
  if (ref.run_id !== entry.run_id) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'run_id'],
      message: `${label} run_id must match guidance run_id`,
    });
  }
  if (ref.flow_id !== entry.scope.flow_id) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'flow_id'],
      message: `${label} flow_id must match guidance scope.flow_id`,
    });
  }
  if (ref.step_id !== entry.scope.step_id) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'step_id'],
      message: `${label} step_id must match guidance scope.step_id`,
    });
  }
  if (ref.attempt !== entry.scope.attempt) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'attempt'],
      message: `${label} attempt must match guidance scope.attempt`,
    });
  }
}

export const GuidanceDecisionTraceEntryBody = z
  .object({
    schema_version: z.literal(1),
    sequence: z.number().int().nonnegative(),
    recorded_at: z.string().datetime(),
    run_id: RunId,
    kind: z.literal('guidance.decision'),
    decision_id: GuidanceDecisionId,
    subject: GuidanceDecisionSubject,
    scope: GuidanceScope,
    source: GuidanceDecisionSource,
    selected: z.union([FlowSelectionSelected, RelayExecutionSelected, JsonObject]),
    input_refs: NonEmptyRefs,
    constraint_refs: NonEmptyRefs,
    contract_refs: NonEmptyRefs,
    policy_refs: NonEmptyRefs,
    evidence_refs: NonEmptyRefs.optional(),
    memory_refs: NonEmptyRefs.optional(),
    reason_codes: z.array(ReasonCode).min(1),
    rejected_options: z.array(RejectedGuidanceOption).max(3).optional(),
  })
  .strict();
export type GuidanceDecisionTraceEntryBody = z.infer<typeof GuidanceDecisionTraceEntryBody>;

export function refineGuidanceDecisionTraceEntry(
  entry: GuidanceDecisionTraceEntryBody,
  ctx: z.RefinementCtx,
): void {
  if (entry.scope.run_id !== entry.run_id) {
    ctx.addIssue({
      code: 'custom',
      path: ['scope', 'run_id'],
      message: 'scope.run_id must match run_id',
    });
  }

  for (const [index, ref] of entry.constraint_refs.entries()) {
    if (ref.kind !== 'work_contract' && ref.kind !== 'policy') {
      ctx.addIssue({
        code: 'custom',
        path: ['constraint_refs', index, 'kind'],
        message: 'constraint_refs must use work_contract or policy refs in V0',
      });
    }
  }
  for (const [index, ref] of entry.contract_refs.entries()) {
    if (ref.kind !== 'work_contract') {
      ctx.addIssue({
        code: 'custom',
        path: ['contract_refs', index, 'kind'],
        message: 'contract_refs must use work_contract refs',
      });
    }
  }
  for (const [index, ref] of entry.policy_refs.entries()) {
    if (ref.kind !== 'policy') {
      ctx.addIssue({
        code: 'custom',
        path: ['policy_refs', index, 'kind'],
        message: 'policy_refs must use policy refs',
      });
    }
  }
  for (const [index, ref] of entry.memory_refs?.entries() ?? []) {
    if (ref.kind !== 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['memory_refs', index, 'kind'],
        message: 'memory_refs must use memory refs',
      });
    }
  }
  for (const [index, ref] of entry.evidence_refs?.entries() ?? []) {
    if (ref.kind === 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence_refs', index, 'kind'],
        message: 'memory refs cannot be evidence refs',
      });
    }
  }
  const rejectedOptionMemoryReasonCodes =
    entry.rejected_options?.filter((option) => isMemoryReasonCode(option.reason_code)) ?? [];
  const hasMemoryReasonCode =
    entry.reason_codes.some(isMemoryReasonCode) || rejectedOptionMemoryReasonCodes.length > 0;
  const hasMemoryRefs = (entry.memory_refs?.length ?? 0) > 0;
  if (hasMemoryReasonCode && !hasMemoryRefs) {
    ctx.addIssue({
      code: 'custom',
      path: ['memory_refs'],
      message: 'memory reason codes require memory_refs',
    });
  }
  if (hasMemoryRefs && !hasMemoryReasonCode) {
    ctx.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'memory_refs require a memory reason code',
    });
  }
  for (const [index, option] of entry.rejected_options?.entries() ?? []) {
    if (option.blocked_by?.kind === 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['rejected_options', index, 'blocked_by', 'kind'],
        message: 'memory refs cannot block guidance options',
      });
    }
    if (
      option.reason_code === 'memory_conflicts_with_policy' &&
      option.blocked_by?.kind !== 'policy'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['rejected_options', index, 'blocked_by', 'kind'],
        message: 'memory policy conflicts must be blocked by policy refs',
      });
    }
    if (
      option.reason_code === 'memory_conflicts_with_contract' &&
      option.blocked_by?.kind !== 'work_contract'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['rejected_options', index, 'blocked_by', 'kind'],
        message: 'memory contract conflicts must be blocked by work_contract refs',
      });
    }
  }

  if (entry.subject === 'flow_selection') {
    if (!FlowSelectionSelected.safeParse(entry.selected).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['selected'],
        message: 'flow_selection selected payload must name flow_id and work_contract_ref',
      });
    }
    return;
  }

  if (entry.scope.flow_id === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['scope', 'flow_id'],
      message: `${entry.subject} decisions require scope.flow_id`,
    });
  }
  if (entry.subject === 'proof_policy') {
    if ((entry.scope.step_id === undefined) !== (entry.scope.attempt === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scope', 'attempt'],
        message: 'proof_policy decisions must include step_id and attempt together',
      });
    }
  } else {
    if (entry.scope.step_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['scope', 'step_id'],
        message: `${entry.subject} decisions require scope.step_id`,
      });
    }
    if (entry.scope.attempt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['scope', 'attempt'],
        message: `${entry.subject} decisions require scope.attempt`,
      });
    }
  }

  if (
    entry.subject === 'relay_execution' &&
    !RelayExecutionSelected.safeParse(entry.selected).success
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['selected'],
      message:
        'relay_execution selected payload must name role, connector, skills, context ref, and request hash',
    });
  }

  if (entry.subject === 'proof_policy' && !ProofPolicySelected.safeParse(entry.selected).success) {
    ctx.addIssue({
      code: 'custom',
      path: ['selected'],
      message:
        'proof_policy selected payload must name proof_profile, required claim kinds, required evidence kinds, and whether close requires proven claims',
    });
  }

  if (entry.subject === 'safe_apply' && !SafeApplySelected.safeParse(entry.selected).success) {
    ctx.addIssue({
      code: 'custom',
      path: ['selected'],
      message:
        'safe_apply selected payload must name action, change_packet_ref, base_ref, and final verification refs when applying',
    });
  }
  if (entry.subject === 'safe_apply') {
    const safeApplySelected = SafeApplySelected.safeParse(entry.selected);
    if (safeApplySelected.success) {
      const { base_ref, change_packet_ref, final_verification_ref, touched_files_ref } =
        safeApplySelected.data;

      addScopedRefIssues(
        ctx,
        ['selected', 'change_packet_ref'],
        'safe_apply change_packet_ref',
        change_packet_ref,
        entry,
      );
      addScopedRefIssues(ctx, ['selected', 'base_ref'], 'safe_apply base_ref', base_ref, entry);

      if (!entry.input_refs.some((ref) => sameRef(ref, change_packet_ref))) {
        ctx.addIssue({
          code: 'custom',
          path: ['input_refs'],
          message: 'safe_apply input_refs must include selected.change_packet_ref',
        });
      }
      if (!entry.input_refs.some((ref) => sameRef(ref, base_ref))) {
        ctx.addIssue({
          code: 'custom',
          path: ['input_refs'],
          message: 'safe_apply input_refs must include selected.base_ref',
        });
      }

      if (final_verification_ref !== undefined) {
        addScopedRefIssues(
          ctx,
          ['selected', 'final_verification_ref'],
          'safe_apply final_verification_ref',
          final_verification_ref,
          entry,
        );
        if (!entry.evidence_refs?.some((ref) => sameRef(ref, final_verification_ref))) {
          ctx.addIssue({
            code: 'custom',
            path: ['evidence_refs'],
            message: 'safe_apply evidence_refs must include selected.final_verification_ref',
          });
        }
      }
      if (touched_files_ref !== undefined) {
        addScopedRefIssues(
          ctx,
          ['selected', 'touched_files_ref'],
          'safe_apply touched_files_ref',
          touched_files_ref,
          entry,
        );
        if (!entry.evidence_refs?.some((ref) => sameRef(ref, touched_files_ref))) {
          ctx.addIssue({
            code: 'custom',
            path: ['evidence_refs'],
            message: 'safe_apply evidence_refs must include selected.touched_files_ref',
          });
        }
      }
    }
  }

  if (
    entry.subject === 'recovery_route' &&
    !RecoveryRouteSelected.safeParse(entry.selected).success
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['selected'],
      message:
        'recovery_route selected payload must name route_id, recovery_kind, failure_cause, failure_ref, and binding_ref',
    });
  }
  if (entry.subject === 'recovery_route') {
    const recoverySelected = RecoveryRouteSelected.safeParse(entry.selected);
    if (recoverySelected.success) {
      const { binding_ref, failure_ref, touched_files_ref } = recoverySelected.data;

      if (!entry.input_refs.some((ref) => sameRef(ref, failure_ref))) {
        ctx.addIssue({
          code: 'custom',
          path: ['input_refs'],
          message: 'recovery_route input_refs must include selected.failure_ref',
        });
      }
      if (!entry.evidence_refs?.some((ref) => sameRef(ref, failure_ref))) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_refs'],
          message: 'recovery_route evidence_refs must include selected.failure_ref',
        });
      }
      if (touched_files_ref !== undefined) {
        if (!entry.evidence_refs?.some((ref) => sameRef(ref, touched_files_ref))) {
          ctx.addIssue({
            code: 'custom',
            path: ['evidence_refs'],
            message: 'recovery_route evidence_refs must include selected.touched_files_ref',
          });
        }
        if (touched_files_ref.run_id !== undefined && touched_files_ref.run_id !== entry.run_id) {
          ctx.addIssue({
            code: 'custom',
            path: ['selected', 'touched_files_ref', 'run_id'],
            message: 'recovery touched_files_ref run_id must match guidance run_id',
          });
        }
        if (
          touched_files_ref.flow_id !== undefined &&
          touched_files_ref.flow_id !== entry.scope.flow_id
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['selected', 'touched_files_ref', 'flow_id'],
            message: 'recovery touched_files_ref flow_id must match guidance scope.flow_id',
          });
        }
        if (
          touched_files_ref.step_id !== undefined &&
          touched_files_ref.step_id !== entry.scope.step_id
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['selected', 'touched_files_ref', 'step_id'],
            message: 'recovery touched_files_ref step_id must match guidance scope.step_id',
          });
        }
        if (
          touched_files_ref.attempt !== undefined &&
          touched_files_ref.attempt !== entry.scope.attempt
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['selected', 'touched_files_ref', 'attempt'],
            message: 'recovery touched_files_ref attempt must match guidance scope.attempt',
          });
        }
      }
      if (
        failure_ref.kind === 'trace' &&
        failure_ref.sequence !== undefined &&
        failure_ref.sequence >= entry.sequence
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['selected', 'failure_ref', 'sequence'],
          message: 'recovery trace failure_ref must point to an earlier trace entry',
        });
      }
      if (binding_ref.flow_id !== entry.scope.flow_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['selected', 'binding_ref', 'flow_id'],
          message: 'recovery binding_ref flow_id must match guidance scope.flow_id',
        });
      }
      if (failure_ref.run_id !== undefined && failure_ref.run_id !== entry.run_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['selected', 'failure_ref', 'run_id'],
          message: 'recovery failure_ref run_id must match guidance run_id',
        });
      }
      if (failure_ref.flow_id !== undefined && failure_ref.flow_id !== entry.scope.flow_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['selected', 'failure_ref', 'flow_id'],
          message: 'recovery failure_ref flow_id must match guidance scope.flow_id',
        });
      }
      if ((failure_ref.step_id === undefined) !== (failure_ref.attempt === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['selected', 'failure_ref', 'attempt'],
          message: 'recovery failure_ref must include step_id and attempt together',
        });
      }
      if (failure_ref.step_id !== undefined && failure_ref.step_id !== entry.scope.step_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['selected', 'failure_ref', 'step_id'],
          message: 'recovery failure_ref step_id must match guidance scope.step_id',
        });
      }
      if (failure_ref.attempt !== undefined && failure_ref.attempt !== entry.scope.attempt) {
        ctx.addIssue({
          code: 'custom',
          path: ['selected', 'failure_ref', 'attempt'],
          message: 'recovery failure_ref attempt must match guidance scope.attempt',
        });
      }
    }
  }
}

export const GuidanceDecisionTraceEntry = GuidanceDecisionTraceEntryBody.superRefine(
  refineGuidanceDecisionTraceEntry,
);
export type GuidanceDecisionTraceEntry = z.infer<typeof GuidanceDecisionTraceEntry>;
