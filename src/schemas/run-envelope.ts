import { z } from 'zod';
import { CompiledFlowId, RunId, StepId } from './ids.js';
import { Ref } from './ref.js';
import { RunClosedOutcome } from './trace-entry.js';

const REQUIRED_GATE_PASSES = 2;

export const RunEnvelopeOutcome = z.enum([
  'complete',
  'needs_attention',
  'blocked',
  'failed',
  'handoff',
]);
export type RunEnvelopeOutcome = z.infer<typeof RunEnvelopeOutcome>;

export const RunEvidenceSource = z.enum([
  'child_result',
  'operator_summary',
  'process_report',
  'process_evidence',
  'memory',
  'operator_input',
]);
export type RunEvidenceSource = z.infer<typeof RunEvidenceSource>;

const EvidenceSourceRefKind: Record<RunEvidenceSource, readonly string[]> = {
  child_result: ['report'],
  operator_summary: ['report'],
  process_report: ['report'],
  process_evidence: ['evidence'],
  memory: ['memory'],
  operator_input: ['operator_input'],
};

export const RunEvidenceRef = z
  .object({
    source: RunEvidenceSource,
    ref: Ref,
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const allowed = EvidenceSourceRefKind[evidence.source];
    if (!allowed.includes(evidence.ref.kind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ref', 'kind'],
        message: `${evidence.source} evidence cannot use ${evidence.ref.kind} refs`,
      });
    }
  });
export type RunEvidenceRef = z.infer<typeof RunEvidenceRef>;

export const RunRequiredEvidenceKind = z.enum([
  'command',
  'report',
  'review',
  'source',
  'checkpoint',
]);
export type RunRequiredEvidenceKind = z.infer<typeof RunRequiredEvidenceKind>;

const RunRequiredEvidence = z
  .object({
    kind: RunRequiredEvidenceKind,
    description: z.string().min(1),
    required: z.boolean(),
  })
  .strict();
export type RunRequiredEvidence = z.infer<typeof RunRequiredEvidence>;

const RunDoneClaim = z
  .object({
    id: z.string().min(1),
    claim: z.string().min(1),
    required_evidence: z.array(RunRequiredEvidence).min(1),
  })
  .strict()
  .superRefine((claim, ctx) => {
    if (!claim.required_evidence.some((evidence) => evidence.required)) {
      ctx.addIssue({
        code: 'custom',
        path: ['required_evidence'],
        message: 'each done_when item must include at least one required evidence entry',
      });
    }
  });
export type RunDoneClaim = z.infer<typeof RunDoneClaim>;

export const RunGoalContract = z
  .object({
    schema: z.literal('run.goal-contract@v0'),
    objective: z.string().min(1),
    scope: z
      .object({
        in: z.array(z.string().min(1)),
        out: z.array(z.string().min(1)),
        assumptions: z.array(z.string().min(1)),
      })
      .strict(),
    constraints: z.array(z.string().min(1)),
    done_when: z.array(RunDoneClaim).min(1),
    recovery_policy: z
      .object({
        max_process_attempts: z.number().int().positive().max(10),
        allowed_routes: z
          .array(
            z.enum([
              'retry-process',
              'run-fix',
              'run-review',
              'run-explore',
              'split-to-pursue',
              'checkpoint',
              'handoff',
              'blocked',
            ]),
          )
          .min(1),
      })
      .strict(),
    stop_conditions: z.array(z.string().min(1)),
    completion_gate: z
      .object({
        required_passes: z.literal(REQUIRED_GATE_PASSES),
        blocking_severities: z.array(z.enum(['critical', 'high', 'medium'])).min(1),
        reset_on_blocking_finding: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type RunGoalContract = z.infer<typeof RunGoalContract>;

export const RunProcessPlan = z
  .object({
    schema: z.literal('run.process-plan@v0'),
    selection_source: z.enum([
      'explicit_operator_request',
      'router',
      'goal_contract',
      'completion_followup',
      'recovery',
    ]),
    rationale: z.string().min(1),
    planned_attempts: z
      .array(
        z
          .object({
            attempt_id: z.string().min(1),
            process_id: CompiledFlowId,
            goal: z.string().min(1),
            expected_evidence: z.array(z.string().min(1)),
            depends_on_attempt_ids: z.array(z.string().min(1)),
            followup_for: z
              .object({
                claim_id: z.string().min(1),
                prior_attempt_id: z.string().min(1),
                missing_evidence: z.array(z.string().min(1)).min(1),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type RunProcessPlan = z.infer<typeof RunProcessPlan>;

export const RunProcessAttempt = z
  .object({
    schema: z.literal('run.process-attempt@v0'),
    attempt_id: z.string().min(1),
    process_id: CompiledFlowId,
    goal: z.string().min(1),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime().optional(),
    outcome: z.enum([
      'complete',
      'needs_attention',
      'blocked',
      'failed',
      'handoff',
      'checkpoint_waiting',
    ]),
    child_run: z
      .object({
        run_id: RunId,
        run_folder: z.string().min(1),
        result_ref: RunEvidenceRef.optional(),
        trace_entries_observed: z.number().int().nonnegative(),
        manifest_hash: z.string().min(1).optional(),
      })
      .strict(),
    checkpoint: z
      .object({
        step_id: StepId,
        request_ref: Ref,
        allowed_choices: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .optional(),
    evidence_refs: z.array(RunEvidenceRef),
    summary: z.string().min(1),
    blocked_reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.outcome === 'checkpoint_waiting') {
      if (attempt.checkpoint === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['checkpoint'],
          message: 'checkpoint_waiting attempts require checkpoint metadata',
        });
      }
      if (attempt.child_run.result_ref !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['child_run', 'result_ref'],
          message: 'checkpoint_waiting attempts must not have a child result ref',
        });
      }
    }
  });
export type RunProcessAttempt = z.infer<typeof RunProcessAttempt>;

const RunGatePass = z
  .object({
    pass_id: z.string().min(1),
    attack_lens: z.string().min(1),
    evidence_checked: z.array(RunEvidenceRef),
    verdict: z.enum(['gate-pass', 'blocking-finding']),
  })
  .strict();
export type RunGatePass = z.infer<typeof RunGatePass>;

export const RunCompletionGate = z
  .object({
    schema: z.literal('run.completion-gate@v0'),
    verdict: z.enum(['complete', 'needs_followup', 'blocked', 'failed', 'handoff']),
    claim_results: z.array(
      z
        .object({
          claim_id: z.string().min(1),
          status: z.enum(['proved', 'missing', 'contradicted', 'blocked']),
          evidence: z.array(RunEvidenceRef),
          gap: z.string().min(1).optional(),
        })
        .strict(),
    ),
    gate_passes: z.array(RunGatePass),
    clean_streak: z.number().int().nonnegative(),
    required_passes: z.literal(REQUIRED_GATE_PASSES),
    next_action: z.enum([
      'close',
      'plan-followup-process',
      'ask-operator',
      'blocked',
      'handoff',
      'failed',
    ]),
  })
  .strict()
  .superRefine((gate, ctx) => {
    const lenses = new Set(gate.gate_passes.map((pass) => pass.attack_lens));
    if (lenses.size !== gate.gate_passes.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['gate_passes'],
        message: 'gate passes must use distinct attack lenses',
      });
    }

    const allClaimsProved = gate.claim_results.every((claim) => claim.status === 'proved');
    if (gate.verdict === 'complete') {
      if (!allClaimsProved) {
        ctx.addIssue({
          code: 'custom',
          path: ['claim_results'],
          message: 'complete gate verdict requires every claim result to be proved',
        });
      }
      if (
        gate.clean_streak < gate.required_passes ||
        gate.gate_passes.filter((pass) => pass.verdict === 'gate-pass').length <
          gate.required_passes
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['gate_passes'],
          message: 'complete gate verdict requires two clean gate passes',
        });
      }
      if (gate.next_action !== 'close') {
        ctx.addIssue({
          code: 'custom',
          path: ['next_action'],
          message: 'complete gate verdict requires close next_action',
        });
      }
    }
  });
export type RunCompletionGate = z.infer<typeof RunCompletionGate>;

export const RunDecisionPacket = z
  .object({
    schema: z.literal('run.decision-packet@v0'),
    decision_id: z.string().min(1),
    reason: z.enum([
      'process-checkpoint',
      'missing-evidence',
      'strict-skill-unavailable',
      'operator-judgment',
    ]),
    prompt: z.string().min(1),
    choices: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
            effect: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    resume_target: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('run-envelope'),
          run_id: RunId,
        })
        .strict(),
      z
        .object({
          kind: z.literal('process-checkpoint'),
          run_id: RunId,
          step_id: StepId,
          request_ref: Ref,
        })
        .strict(),
    ]),
    artifact_refs: z.array(Ref),
    html_projection: z
      .object({
        kind: z.literal('optional'),
        projector: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RunDecisionPacket = z.infer<typeof RunDecisionPacket>;

// Slice 5 (D3): the produce-side freshness of the cited source at write time,
// mirroring the memory-input layer's `MemoryStaleness` shape (status + a
// non-empty reason-code set + a checked_at stamp) without importing it — the
// run-envelope module stays decoupled from the memory-input module, and a
// reason-code consistency refine pins the same `unknown -> memory_unverified` /
// `stale -> memory_stale` invariants the memory layer enforces. Optional, so
// every existing (empty `memory_update_events`) history is unaffected.
const RunMemoryUpdateReasonCode = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const RunMemoryUpdateStaleness = z
  .object({
    status: z.enum(['fresh', 'stale', 'unknown']),
    checked_at: z.string().datetime(),
    reason_codes: z.array(RunMemoryUpdateReasonCode).min(1),
  })
  .strict()
  .superRefine((staleness, ctx) => {
    if (staleness.status === 'unknown' && !staleness.reason_codes.includes('memory_unverified')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason_codes'],
        message: 'unknown memory-update staleness requires memory_unverified reason code',
      });
    }
    if (staleness.status === 'stale' && !staleness.reason_codes.includes('memory_stale')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason_codes'],
        message: 'stale memory-update staleness requires memory_stale reason code',
      });
    }
  });
export type RunMemoryUpdateStaleness = z.infer<typeof RunMemoryUpdateStaleness>;

export const RunMemoryUpdateEvent = z
  .object({
    schema: z.literal('run.memory-update-event@v0'),
    event_id: z.string().min(1),
    scope: z.enum(['project', 'flow']),
    flow_id: CompiledFlowId.optional(),
    action: z.enum(['proposed', 'recorded', 'skipped', 'rejected']),
    reason: z.string().min(1),
    summary: z.string().min(1),
    source_refs: z.array(Ref).min(1),
    authority: z.literal('hint_only'),
    operator_indicator: z.string().min(1).optional(),
    staleness: RunMemoryUpdateStaleness.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (
      (event.action === 'proposed' || event.action === 'recorded') &&
      event.operator_indicator === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['operator_indicator'],
        message: 'proposed and recorded memory updates require an operator indicator',
      });
    }
    if (event.scope === 'flow' && event.flow_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['flow_id'],
        message: 'flow-scoped memory updates require flow_id',
      });
    }
  });
export type RunMemoryUpdateEvent = z.infer<typeof RunMemoryUpdateEvent>;

export const RunSurfaceOutput = z
  .object({
    schema: z.literal('run.surface-output@v0'),
    status_text: z.string().min(1),
    outcome: RunEnvelopeOutcome,
    next_action: z.string().min(1).optional(),
    artifact_links: z.array(Ref).min(1),
    memory_indicator: z.string().min(1).optional(),
    decision_packet_ref: Ref.optional(),
  })
  .strict();
export type RunSurfaceOutput = z.infer<typeof RunSurfaceOutput>;

export const RunEnvelopeShadowRecord = z
  .object({
    schema: z.literal('run.envelope-shadow@v0'),
    mode: z.literal('shadow'),
    shadow_reason: z.literal('source-owned-run-not-active'),
    run_id: RunId,
    operator_intent: z.string().min(1),
    recorded_at: z.string().datetime(),
    selected_process: z
      .object({
        process_id: CompiledFlowId,
        routed_by: z.enum(['explicit', 'classifier']).optional(),
        router_reason: z.string().min(1),
        entry_mode: z.string().min(1).optional(),
      })
      .strict(),
    child_run: z
      .object({
        run_id: RunId,
        run_folder: z.string().min(1),
        flow_id: CompiledFlowId,
        outcome: z.union([RunClosedOutcome, z.literal('checkpoint_waiting')]),
        trace_entries_observed: z.number().int().nonnegative(),
        manifest_hash: z.string().min(1),
        result_ref: RunEvidenceRef.optional(),
        checkpoint: z
          .object({
            step_id: StepId,
            request_ref: Ref,
            allowed_choices: z.array(z.string().min(1)).min(1),
          })
          .strict()
          .optional(),
      })
      .strict(),
    artifact_links: z.array(Ref).min(1),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.child_run.outcome === 'checkpoint_waiting') {
      if (record.child_run.result_ref !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['child_run', 'result_ref'],
          message: 'checkpoint_waiting shadow records must not include a result ref',
        });
      }
      if (record.child_run.checkpoint === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['child_run', 'checkpoint'],
          message: 'checkpoint_waiting shadow records require checkpoint metadata',
        });
      }
      return;
    }
    if (record.child_run.result_ref === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['child_run', 'result_ref'],
        message: 'closed child runs require a result ref',
      });
    }
  });
export type RunEnvelopeShadowRecord = z.infer<typeof RunEnvelopeShadowRecord>;

export const RunEnvelopeRecord = z
  .object({
    schema: z.literal('run.envelope@v0'),
    run_id: RunId,
    operator_intent: z.string().min(1),
    explicit_constraints: z.array(z.string().min(1)),
    explicit_process_request: CompiledFlowId.optional(),
    memory_context: z
      .object({
        used: z.boolean(),
        memory_input_ids: z.array(z.string().min(1)),
        authority: z.literal('hint_only'),
      })
      .strict(),
    goal_contract: RunGoalContract,
    process_plan: RunProcessPlan,
    process_attempts: z.array(RunProcessAttempt),
    completion_gate: RunCompletionGate,
    decision_packets: z.array(RunDecisionPacket),
    // Slice 5 (D3): at most one memory update per run, so "fire on signal, not
    // on completion" is enforced by Zod rather than narrated. An empty array
    // (every run today) still satisfies `.max(1)`, so this breaks nothing.
    memory_update_events: z.array(RunMemoryUpdateEvent).max(1),
    surface_output: RunSurfaceOutput,
    outcome: RunEnvelopeOutcome,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.surface_output.outcome !== record.outcome) {
      ctx.addIssue({
        code: 'custom',
        path: ['surface_output', 'outcome'],
        message: 'surface output outcome must match record outcome',
      });
    }

    const claimResults = new Map(
      record.completion_gate.claim_results.map((claim) => [claim.claim_id, claim]),
    );
    const requiredClaimIds = record.goal_contract.done_when.map((claim) => claim.id);
    const requiredClaimsProved = requiredClaimIds.every(
      (claimId) => claimResults.get(claimId)?.status === 'proved',
    );

    if (record.outcome === 'complete' && record.completion_gate.verdict !== 'complete') {
      ctx.addIssue({
        code: 'custom',
        path: ['completion_gate', 'verdict'],
        message: 'complete record outcome requires complete gate verdict',
      });
    }
    if (record.outcome === 'complete' && !requiredClaimsProved) {
      ctx.addIssue({
        code: 'custom',
        path: ['completion_gate', 'claim_results'],
        message: 'complete record outcome requires all required claims to be proved',
      });
    }

    const executedAttemptIds = new Set(
      record.process_attempts.map((attempt) => attempt.attempt_id),
    );
    if (record.completion_gate.verdict === 'needs_followup') {
      const hasFollowupAttempt = record.process_plan.planned_attempts.some(
        (attempt) =>
          !executedAttemptIds.has(attempt.attempt_id) &&
          attempt.followup_for !== undefined &&
          executedAttemptIds.has(attempt.followup_for.prior_attempt_id) &&
          (attempt.depends_on_attempt_ids.includes(attempt.followup_for.prior_attempt_id) ||
            record.process_attempts.length === 0),
      );
      if (!hasFollowupAttempt && record.decision_packets.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['process_plan', 'planned_attempts'],
          message:
            'needs_followup requires a planned follow-up attempt with missing claim provenance or a decision packet',
        });
      }
      if (record.outcome === 'complete') {
        ctx.addIssue({
          code: 'custom',
          path: ['outcome'],
          message: 'needs_followup gate must not close the record complete',
        });
      }
    }

    const hasBlockedOrFailedAttempt = record.process_attempts.some(
      (attempt) => attempt.outcome === 'blocked' || attempt.outcome === 'failed',
    );
    if (record.outcome === 'blocked') {
      if (record.completion_gate.verdict !== 'blocked' && !hasBlockedOrFailedAttempt) {
        ctx.addIssue({
          code: 'custom',
          path: ['completion_gate', 'verdict'],
          message: 'blocked record outcome requires a blocked gate or blocked process attempt',
        });
      }
      if (record.surface_output.next_action === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['surface_output', 'next_action'],
          message: 'blocked record outcome requires a next operator action',
        });
      }
    }

    if (
      record.outcome !== 'complete' &&
      /\b(?:done|complete|completed)\b/i.test(record.surface_output.status_text)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['surface_output', 'status_text'],
        message: 'non-complete surface output must not claim completion',
      });
    }

    for (const packet of record.decision_packets) {
      const target = packet.resume_target;
      if (target.kind !== 'process-checkpoint') continue;
      const matchingAttempt = record.process_attempts.find(
        (attempt) =>
          attempt.outcome === 'checkpoint_waiting' &&
          attempt.child_run.run_id === target.run_id &&
          attempt.checkpoint !== undefined &&
          attempt.checkpoint.step_id === target.step_id &&
          attempt.checkpoint.request_ref.ref === target.request_ref.ref,
      );
      if (matchingAttempt === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['decision_packets'],
          message: 'process-checkpoint decision packets require a matching waiting attempt',
        });
      }
    }
  });
export type RunEnvelopeRecord = z.infer<typeof RunEnvelopeRecord>;
