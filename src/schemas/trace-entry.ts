import { z } from 'zod';
import { ChangeKindDeclaration } from './change-kind.js';
import {
  ProtectedFileDecision,
  SafeApplyAction,
  SafeApplyOutcome,
  SafeApplyReasonCode,
} from './change-packet.js';
import { RelayResolutionSource, ResolvedConnector } from './connector.js';
import { CompiledDepth } from './depth.js';
import {
  GuidanceDecisionId,
  GuidanceDecisionTraceEntryBody,
  refineGuidanceDecisionTraceEntry,
} from './guidance-decision.js';
import { CompiledFlowId, InvocationId, RunId, SkillId, SkillSlotId, StepId } from './ids.js';
import { Power } from './power.js';
import { ProofAssessmentId, ProofStatus } from './proof-assessment.js';
import { Ref, Sha256 } from './ref.js';
import { RuntimeTouchedFilesEvidenceRef } from './runtime-evidence.js';
import { ResolvedSelection } from './selection-policy.js';
import { RunSkillHookEvent } from './skill-hook.js';
import { FanoutFailurePolicy, RelayRole } from './step.js';

const TraceEntryBase = z.object({
  schema_version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  recorded_at: z.iso.datetime(),
  run_id: RunId,
});

// SHA-256 over raw bytes, 64-char lowercase hex. Reuses the canonical
// `Sha256` scalar (src/schemas/ref.ts) so durable transcript hashes are
// shape-compatible with every other content hash at audit time.
const ContentHash = Sha256;

// Bindings the runtime resolves from a flow's compiled manifest at run start:
// the edit-file surface table, the depth/slice/terminal-outcome engine flags,
// and the primary-result surface. Originally each came from a by-id catalog
// package, so a composed or published custom flow with no package lost them all
// silently; the migration moved them onto the manifest and M4 deleted the
// package. `run.bootstrapped` records any binding a flow still cannot resolve so
// the degradation is legible in the trace and receipt instead of invisible. See
// docs/architecture/first-class-composition-optimal-path.md. This enum stays the
// single source of truth for their names.
export const CatalogSourcedBinding = z.enum([
  'edit_file_surfaces',
  'depth_binding',
  'slice_loop',
  'terminal_outcome_binding',
  'primary_result_surface',
]);
export type CatalogSourcedBinding = z.infer<typeof CatalogSourcedBinding>;

export const RunBootstrappedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.bootstrapped'),
  flow_id: CompiledFlowId,
  invocation_id: InvocationId.optional(),
  depth: CompiledDepth,
  goal: z.string().min(1),
  change_kind: ChangeKindDeclaration,
  manifest_hash: z.string().min(1),
  // First-class composition: make any capability reduction legible.
  // `reduced_bindings` names the catalog-sourced bindings a flow cannot resolve.
  // It is empty for every built-in (the manifest is the sole authority post-M4)
  // and omitted entirely when nothing was reduced; a composed flow with a needs
  // model (M9) can populate it. Optional so prior fixtures and resumed runs
  // (which never re-bootstrap) stay valid — an omitted field makes no claim.
  reduced_bindings: z.array(CatalogSourcedBinding).optional(),
}).strict();
export type RunBootstrappedTraceEntry = z.infer<typeof RunBootstrappedTraceEntry>;

// Present only on loop-body steps during an active slice loop (deep-depth
// Build). Absent on single-pass runs. See docs/ideas/build-slice-decomposition.md.
const SliceIndex = z.number().int().nonnegative();

export const StepEnteredTraceEntry = TraceEntryBase.extend({
  kind: z.literal('step.entered'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  slice_index: SliceIndex.optional(),
}).strict();
export type StepEnteredTraceEntry = z.infer<typeof StepEnteredTraceEntry>;

export const StepReportWrittenTraceEntry = TraceEntryBase.extend({
  kind: z.literal('step.report_written'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  report_path: z.string().min(1),
  report_schema: z.string().min(1),
}).strict();
export type StepReportWrittenTraceEntry = z.infer<typeof StepReportWrittenTraceEntry>;

export const CheckEvaluatedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('check.evaluated'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  check_kind: z.enum([
    'schema_sections',
    'checkpoint_selection',
    'result_verdict',
    'fanout_aggregate',
    'acceptance_criteria',
  ]),
  outcome: z.enum(['pass', 'fail']),
  criterion_id: z.string().min(1).optional(),
  criterion_kind: z.enum(['command', 'report_field']).optional(),
  exit_code: z.number().int().nonnegative().optional(),
  status: z.enum(['passed', 'failed']).optional(),
  stdout_summary: z.string().optional(),
  stderr_summary: z.string().optional(),
  missing_sections: z.array(z.string()).optional(),
  reason: z.string().optional(),
  slice_index: SliceIndex.optional(),
}).strict();
export type CheckEvaluatedTraceEntry = z.infer<typeof CheckEvaluatedTraceEntry>;

export const VerificationCommandEvaluatedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('verification.command_evaluated'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  command_id: z.string().min(1),
  cwd: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
  exit_code: z.number().int().nonnegative(),
  status: z.enum(['passed', 'failed']),
  duration_ms: z.number().int().nonnegative(),
  stdout_summary: z.string(),
  stderr_summary: z.string(),
  slice_index: SliceIndex.optional(),
}).strict();
export type VerificationCommandEvaluatedTraceEntry = z.infer<
  typeof VerificationCommandEvaluatedTraceEntry
>;

const ProofAssessmentRef = Ref.refine((ref) => ref.kind === 'evidence' || ref.kind === 'report', {
  message: 'proof assessment refs must use evidence or report refs',
});

const ChangePacketRef = Ref.refine((ref) => ref.kind === 'change_packet', {
  message: 'change packet refs must use kind change_packet',
});

const SafeApplyBaseRef = Ref.refine((ref) => ref.kind === 'command', {
  message: 'safe apply base refs must use command refs',
});

const SafeApplyResultRef = Ref.refine((ref) => ref.kind === 'safe_apply', {
  message: 'safe apply result refs must use kind safe_apply',
});

const SafeApplyFinalVerificationRef = Ref.refine((ref) => ref.kind === 'command', {
  message: 'safe apply final verification refs must use command refs',
});

const CheckpointBoundaryRef = Ref.refine((ref) => ref.kind === 'work_contract', {
  message: 'checkpoint boundary refs must use kind work_contract',
});

const ProofScope = z
  .object({
    run_id: RunId,
    flow_id: CompiledFlowId,
    step_id: StepId.optional(),
    attempt: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((scope, ctx) => {
    if ((scope.step_id === undefined) !== (scope.attempt === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['attempt'],
        message: 'proof assessment scope must include step_id and attempt together',
      });
    }
  });

export const ProofAssessedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('proof.assessed'),
  assessment_id: ProofAssessmentId,
  scope: ProofScope,
  proof_policy_decision_id: GuidanceDecisionId,
  assessment_ref: ProofAssessmentRef,
  overall_status: ProofStatus,
  close_allowed: z.boolean(),
}).strict();
export type ProofAssessedTraceEntry = z.infer<typeof ProofAssessedTraceEntry>;

const SafeApplyScope = z
  .object({
    run_id: RunId,
    flow_id: CompiledFlowId,
    step_id: StepId.optional(),
    attempt: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((scope, ctx) => {
    if ((scope.step_id === undefined) !== (scope.attempt === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['attempt'],
        message: 'safe apply scope must include step_id and attempt together',
      });
    }
  });

export const SafeApplyResultTraceEntry = TraceEntryBase.extend({
  kind: z.literal('safe_apply.result'),
  decision_id: GuidanceDecisionId,
  scope: SafeApplyScope,
  change_packet_ref: ChangePacketRef,
  base_ref: SafeApplyBaseRef,
  action: SafeApplyAction,
  outcome: SafeApplyOutcome,
  reason_codes: z.array(SafeApplyReasonCode).min(1),
  protected_file_decision: ProtectedFileDecision.optional(),
  final_verification_ref: SafeApplyFinalVerificationRef.optional(),
  touched_files_ref: RuntimeTouchedFilesEvidenceRef.optional(),
  result_ref: SafeApplyResultRef,
}).strict();
export type SafeApplyResultTraceEntry = z.infer<typeof SafeApplyResultTraceEntry>;

export const CheckpointRequestedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('checkpoint.requested'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  options: z.array(z.string()).min(1),
  request_path: z.string().min(1),
  request_report_hash: ContentHash,
  boundary_ref: CheckpointBoundaryRef,
  boundary_hash: ContentHash,
  auto_resolved: z.literal(false).optional(),
})
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.boundary_ref.sha256 !== entry.boundary_hash) {
      ctx.addIssue({
        code: 'custom',
        path: ['boundary_hash'],
        message: 'checkpoint boundary_hash must match boundary_ref.sha256',
      });
    }
    if (entry.boundary_ref.step_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['boundary_ref', 'step_id'],
        message: 'checkpoint boundary_ref.step_id is required',
      });
    } else if (entry.boundary_ref.step_id !== entry.step_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['boundary_ref', 'step_id'],
        message: 'checkpoint boundary_ref.step_id must match step_id',
      });
    }
  });
export type CheckpointRequestedTraceEntry = z.infer<typeof CheckpointRequestedTraceEntry>;

export const CheckpointResolvedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('checkpoint.resolved'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  selection: z.string().min(1),
  route_id: z.string().min(1),
  auto_resolved: z.boolean(),
  resolution_source: z.enum(['declared-default', 'operator', 'policy']),
  response_path: z.string().min(1),
}).strict();
export type CheckpointResolvedTraceEntry = z.infer<typeof CheckpointResolvedTraceEntry>;

// connector-I7: `resolved_from` is a `RelayResolutionSource` discriminated
// union that names the winning precedence category AND carries the
// disambiguator (`role` on role-match, `flow_id` on circuit-match).
// An audit reading this trace_entry can reconstruct the exact merged-config entry
// that chose the connector — closes the category-only-provenance gap that the
// flat-enum drafting left open.
//
// `connector: ResolvedConnector` (2-variant: built-in or
// custom descriptor). Named references are pre-resolution pointers and MUST
// NOT appear in the trace; the relayer dereferences them against the
// registry before emitting the trace_entry.
//
// The role ↔ resolved_from.role binding is enforced at the
// TraceEntry-union level, not here, because `z.discriminatedUnion` cannot admit
// ZodEffects variants (wrapped via superRefine). Mirrors the `Step` pattern.
export const RelayStartedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('relay.started'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  connector: ResolvedConnector,
  role: RelayRole,
  resolved_selection: ResolvedSelection,
  resolved_from: RelayResolutionSource,
}).strict();
export type RelayStartedTraceEntry = z.infer<typeof RelayStartedTraceEntry>;

export const LoadedSkillEvidence = z
  .object({
    id: SkillId,
    slot: SkillSlotId.optional(),
    path: z.string().min(1),
    sha256: ContentHash,
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type LoadedSkillEvidence = z.infer<typeof LoadedSkillEvidence>;

export const SkillsLoadedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('skills.loaded'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  skills: z.array(LoadedSkillEvidence).min(1),
}).strict();
export type SkillsLoadedTraceEntry = z.infer<typeof SkillsLoadedTraceEntry>;

// Token/cost usage the connector reported for one relay subprocess. Mirrors
// `RelayUsage` in src/shared/connector-relay.ts. Optional on the trace entry
// because not every connector emits usage (codex and custom connectors leave
// it absent) and a usage-less relay is still a valid relay. Per-role
// attribution is a reader-side join: `relay.started` carries the role on the
// same `(step_id, attempt)` key.
export const RelayUsageEvidence = z
  .object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    cache_read_tokens: z.number().nonnegative(),
    cache_creation_tokens: z.number().nonnegative(),
    cache_creation_5m_tokens: z.number().nonnegative(),
    cache_creation_1h_tokens: z.number().nonnegative(),
    total_cost_usd_reported: z.number().nonnegative().optional(),
    models: z
      .array(
        z
          .object({
            model: z.string().min(1),
            input_tokens: z.number().nonnegative(),
            output_tokens: z.number().nonnegative(),
            cache_read_tokens: z.number().nonnegative(),
            cache_creation_tokens: z.number().nonnegative(),
            cost_usd_reported: z.number().nonnegative().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type RelayUsageEvidence = z.infer<typeof RelayUsageEvidence>;

export const RelayCompletedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('relay.completed'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  verdict: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
  result_path: z.string().min(1),
  receipt_path: z.string().min(1),
  usage: RelayUsageEvidence.optional(),
}).strict();
export type RelayCompletedTraceEntry = z.infer<typeof RelayCompletedTraceEntry>;

// The durable relay transcript the connector round-trip test asserts
// on is a five-trace_entry sequence on a single `(step_id, attempt)` pair:
//
//   relay.started → relay.request → relay.receipt →
//   relay.result → relay.completed
//
// `relay.request` carries the SHA-256 of the request payload bytes
// submitted to the connector, before the connector replies. A mock connector
// cannot elide this trace_entry because the hash is observable independent of
// connector output.
export const RelayRequestTraceEntry = TraceEntryBase.extend({
  kind: z.literal('relay.request'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  request_payload_hash: ContentHash,
}).strict();
export type RelayRequestTraceEntry = z.infer<typeof RelayRequestTraceEntry>;

// Connector invocation failures are infrastructure failures, not model
// verdict failures. The trace_entry is additive to the existing relay audit
// trail: `relay.started` and `relay.request` still precede it, and
// this trace_entry repeats the relay provenance plus the pre-await request
// hash so the failed attempt is tied to the exact invocation payload.
export const RelayFailedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('relay.failed'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  connector: ResolvedConnector,
  role: RelayRole,
  resolved_selection: ResolvedSelection,
  resolved_from: RelayResolutionSource,
  request_payload_hash: ContentHash,
  reason: z.string().min(1),
}).strict();
export type RelayFailedTraceEntry = z.infer<typeof RelayFailedTraceEntry>;

// `relay.receipt` carries the connector-returned receipt id — an opaque
// identifier the connector assigns to the in-flight relay so audit
// tooling can reconstruct what receipt the connector handed back. Kept as
// `z.string().min(1)` (not a hash) because connectors choose their own
// receipt-id format (UUID, ULID, provider-side run id, etc.).
//
// Scoping note. The intra-log correlation between `relay.request`
// and `relay.result` is `(step_id,
// attempt, ordering)`, NOT `receipt_id`. `RelayResultTraceEntry` does not
// echo the receipt. The receipt id is identity-of-record for the
// connector-side relay (so an auditor can ask the connector "what
// happened to receipt X"), not a cryptographic binding between the
// in-log trace_entries. Hash-tightening of `receipt_id` is deferred until a
// real connector surfaces concrete receipt formats; `z.string().min(1)`
// + the whitespace-rejection test in
// `tests/contracts/relay-transcript-schema.test.ts` is the
// current boundary. A stricter format constraint authored now would
// over-specify without provider-shape evidence.
export const RelayReceiptTraceEntry = TraceEntryBase.extend({
  kind: z.literal('relay.receipt'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  cli_version: z.string().min(1),
  receipt_id: z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, {
      message: 'receipt_id must contain at least one non-whitespace character',
    }),
}).strict();
export type RelayReceiptTraceEntry = z.infer<typeof RelayReceiptTraceEntry>;

// `relay.result` carries the SHA-256 of the result report bytes
// returned by the connector, before the reducer projects and the result-
// writer persists. Hash is required so the close-criterion test can
// assert on content — not byte-shape — of a real connector's output.
export const RelayResultTraceEntry = TraceEntryBase.extend({
  kind: z.literal('relay.result'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  result_report_hash: ContentHash,
}).strict();
export type RelayResultTraceEntry = z.infer<typeof RelayResultTraceEntry>;

export const StepCompletedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('step.completed'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  route_taken: z.string().min(1),
  slice_index: SliceIndex.optional(),
}).strict();
export type StepCompletedTraceEntry = z.infer<typeof StepCompletedTraceEntry>;

export const StepAbortedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('step.aborted'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  reason: z.string().min(1),
}).strict();
export type StepAbortedTraceEntry = z.infer<typeof StepAbortedTraceEntry>;

export const RunClosedOutcome = z.enum(['complete', 'aborted', 'handoff', 'stopped', 'escalated']);
export type RunClosedOutcome = z.infer<typeof RunClosedOutcome>;

// Sub-run / fanout linkage trace entries. Every run (parent and child)
// gets its own RunId, and run_id-consistency forbids cross-run trace
// smuggling. Audit linkage therefore flows through dedicated trace
// entries at the parent step boundary — never by nesting child trace
// entries inside the parent log.
//
// `child_run_id` is the canonical handle. An auditor reading the parent
// log can locate the child's separate run directory, replay the child's
// trace.ndjson, and reconstruct the full execution graph.
export const SubRunStartedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('sub_run.started'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  child_run_id: RunId,
  child_flow_id: CompiledFlowId,
  child_entry_mode: z.string().regex(/^[a-z][a-z0-9-]*$/),
  child_depth: CompiledDepth,
}).strict();
export type SubRunStartedTraceEntry = z.infer<typeof SubRunStartedTraceEntry>;

export const SubRunCompletedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('sub_run.completed'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  child_run_id: RunId,
  child_outcome: RunClosedOutcome,
  // Verdict admitted from the child's terminal result body. NO_VERDICT_SENTINEL
  // when the child closed without a parseable result body — mirrors the
  // existing relay.completed sentinel pattern.
  verdict: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
  // Where the child's result.json was copied into the parent run-folder.
  result_path: z.string().min(1),
}).strict();
export type SubRunCompletedTraceEntry = z.infer<typeof SubRunCompletedTraceEntry>;

// Fanout has a richer trace_entry surface because the parent must record per-
// branch lifecycle. The shape mirrors sub_run.* but with a branch_id added
// so the parent log captures which branch produced each outcome.
const FanoutConcurrencyLimit = z.union([z.number().int().positive(), z.literal('unbounded')]);

const FanoutExecutionPolicy = z
  .object({
    configured_concurrency: FanoutConcurrencyLimit,
    effective_concurrency: FanoutConcurrencyLimit,
    writable_relay_branches_serialized: z.boolean(),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.writable_relay_branches_serialized && policy.reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'serialized writable relay fanouts require a reason',
      });
    }
  });

export const FanoutStartedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('fanout.started'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  // Resolved branch list AT EXPANSION TIME. For static branches this
  // mirrors the schematic's authored list. For dynamic branches this is the
  // result of template expansion against the source report, so an
  // auditor can see exactly which N branches were spawned without
  // reconstructing the expansion themselves.
  branch_ids: z.array(z.string().min(1)).min(1),
  on_child_failure: FanoutFailurePolicy,
  execution_policy: FanoutExecutionPolicy.optional(),
}).strict();
export type FanoutStartedTraceEntry = z.infer<typeof FanoutStartedTraceEntry>;

export const FanoutBranchStartedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('fanout.branch_started'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  branch_id: z.string().min(1),
  branch_kind: z.enum(['relay', 'sub-run']),
  child_run_id: RunId,
  // Worktree path provisioned for this branch (relative to project root).
  // Records where the per-branch isolation lived for postmortem auditing.
  worktree_path: z.string().min(1),
}).strict();
export type FanoutBranchStartedTraceEntry = z.infer<typeof FanoutBranchStartedTraceEntry>;

export const FanoutBranchCompletedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('fanout.branch_completed'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  branch_id: z.string().min(1),
  branch_kind: z.enum(['relay', 'sub-run']),
  child_run_id: RunId,
  child_outcome: RunClosedOutcome,
  verdict: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
  result_path: z.string().min(1),
}).strict();
export type FanoutBranchCompletedTraceEntry = z.infer<typeof FanoutBranchCompletedTraceEntry>;

export const FanoutJoinedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('fanout.joined'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  // The join policy that ran; mirrors the FanoutAggregateCheck.join.policy
  // field but echoed into the trace_entry so the audit log is self-contained
  // (no need to cross-reference the schematic to interpret outcomes).
  policy: z.enum(['pick-winner', 'disjoint-merge', 'aggregate-only', 'aggregate-survivors']),
  // For pick-winner: the selected branch_id. Absent for the other policies.
  selected_branch_id: z.string().min(1).optional(),
  // Path to the runtime-built aggregate report.
  aggregate_path: z.string().min(1),
  // Count of branches that closed 'complete' vs other outcomes — quick
  // health summary readable without reconstructing per-branch trace_entries.
  branches_completed: z.number().int().nonnegative(),
  branches_failed: z.number().int().nonnegative(),
}).strict();
export type FanoutJoinedTraceEntry = z.infer<typeof FanoutJoinedTraceEntry>;

export const RunClosedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.closed'),
  outcome: RunClosedOutcome,
  reason: z.string().optional(),
}).strict();
export type RunClosedTraceEntry = z.infer<typeof RunClosedTraceEntry>;

// Report-only-and-up skill-hook dispatch record: the durable trace of "a hook
// fired here and this is the decision it made." Wraps the validated
// RunSkillHookEvent (which carries hook, detected_from, policy resolution,
// scope, and the skills it would trigger). Present only when a configured
// skill-hook policy matched; absent entirely on runs with no skill_hooks config.
export const RunSkillHookTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.skill-hook'),
  event: RunSkillHookEvent,
}).strict();
export type RunSkillHookTraceEntry = z.infer<typeof RunSkillHookTraceEntry>;

// Skill-hook dispatch is best-effort: a crash in the post-step dispatcher must
// never break a run, but it must not be invisible either. When the dispatcher
// throws, the graph-runner records this marker so the operator summary can
// surface a `skill_hook_dispatch_failed` warning instead of swallowing the
// failure whole (mirrors how an HTML render failure surfaces as a warning).
export const RunSkillHookErrorTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.skill-hook-error'),
  step_id: StepId.optional(),
  message: z.string().min(1),
}).strict();
export type RunSkillHookErrorTraceEntry = z.infer<typeof RunSkillHookErrorTraceEntry>;

// The run's one auto-power resolution: when the dial setting is `auto`, the
// first accepted researcher report carrying a recommended_power resolves the
// run's effective dial — clamped to the operator's power_auto bounds — and
// this entry is the durable record. Written at most once per run; resume
// reseeds the in-memory channel from this entry instead of re-inferring.
export const PowerInferenceResolvedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.power-inference'),
  step_id: StepId,
  // What the researcher recommended, verbatim.
  recommended: Power,
  rationale: z.string().min(1).max(280),
  // The operator bounds in force when the recommendation resolved.
  floor: Power,
  ceiling: Power,
  // The post-clamp tier the rest of the run materializes against.
  resolved: Power,
  clamped: z.boolean(),
}).strict();
export type PowerInferenceResolvedTraceEntry = z.infer<typeof PowerInferenceResolvedTraceEntry>;

// Cross-variant superRefine enforces the
// `RelayStartedTraceEntry.role === resolved_from.role` binding when
// `resolved_from.source === 'role'`. Mirrors the Step pattern: keep each
// discriminated-union variant as a plain ZodObject (so discrimination works)
// and hoist cross-field refinements to the union level.
export const TraceEntry = z
  .discriminatedUnion('kind', [
    RunBootstrappedTraceEntry,
    StepEnteredTraceEntry,
    StepReportWrittenTraceEntry,
    CheckEvaluatedTraceEntry,
    VerificationCommandEvaluatedTraceEntry,
    ProofAssessedTraceEntry,
    SafeApplyResultTraceEntry,
    CheckpointRequestedTraceEntry,
    CheckpointResolvedTraceEntry,
    RelayStartedTraceEntry,
    SkillsLoadedTraceEntry,
    RelayRequestTraceEntry,
    RelayFailedTraceEntry,
    RelayReceiptTraceEntry,
    RelayResultTraceEntry,
    RelayCompletedTraceEntry,
    SubRunStartedTraceEntry,
    SubRunCompletedTraceEntry,
    FanoutStartedTraceEntry,
    FanoutBranchStartedTraceEntry,
    FanoutBranchCompletedTraceEntry,
    FanoutJoinedTraceEntry,
    StepCompletedTraceEntry,
    StepAbortedTraceEntry,
    RunClosedTraceEntry,
    RunSkillHookTraceEntry,
    RunSkillHookErrorTraceEntry,
    PowerInferenceResolvedTraceEntry,
    GuidanceDecisionTraceEntryBody,
  ])
  .superRefine((ev, ctx) => {
    if (ev.kind === 'guidance.decision') {
      refineGuidanceDecisionTraceEntry(ev, ctx);
      return;
    }
    if (ev.kind === 'verification.command_evaluated') {
      const expected = ev.exit_code === 0 ? 'passed' : 'failed';
      if (ev.status !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: `status must be '${expected}' when exit_code is ${ev.exit_code}`,
        });
      }
      return;
    }
    if (ev.kind === 'proof.assessed') {
      if (ev.scope.run_id !== ev.run_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['scope', 'run_id'],
          message: 'proof assessment scope.run_id must match run_id',
        });
      }
      if (ev.close_allowed && ev.overall_status !== 'proven') {
        ctx.addIssue({
          code: 'custom',
          path: ['close_allowed'],
          message: 'proof assessment close_allowed requires overall_status proven',
        });
      }
      return;
    }
    if (ev.kind === 'safe_apply.result') {
      if (ev.scope.run_id !== ev.run_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['scope', 'run_id'],
          message: 'safe apply scope.run_id must match run_id',
        });
      }
      for (const { label, path, ref } of [
        {
          label: 'safe apply change_packet_ref',
          path: ['change_packet_ref'],
          ref: ev.change_packet_ref,
        },
        { label: 'safe apply base_ref', path: ['base_ref'], ref: ev.base_ref },
        { label: 'safe apply result_ref', path: ['result_ref'], ref: ev.result_ref },
        ...(ev.final_verification_ref === undefined
          ? []
          : [
              {
                label: 'safe apply final_verification_ref',
                path: ['final_verification_ref'],
                ref: ev.final_verification_ref,
              },
            ]),
        ...(ev.touched_files_ref === undefined
          ? []
          : [
              {
                label: 'safe apply touched_files_ref',
                path: ['touched_files_ref'],
                ref: ev.touched_files_ref,
              },
            ]),
      ] as const) {
        if (ref.run_id !== ev.run_id) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'run_id'],
            message: `${label} run_id must match run_id`,
          });
        }
        if (ref.flow_id !== ev.scope.flow_id) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'flow_id'],
            message: `${label} flow_id must match scope.flow_id`,
          });
        }
        if (ref.step_id !== ev.scope.step_id) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'step_id'],
            message: `${label} step_id must match scope.step_id`,
          });
        }
        if (ref.attempt !== ev.scope.attempt) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'attempt'],
            message: `${label} attempt must match scope.attempt`,
          });
        }
      }
      if (ev.action === 'rejected' && ev.outcome !== 'fail') {
        ctx.addIssue({
          code: 'custom',
          path: ['outcome'],
          message: 'rejected safe apply trace results require fail outcome',
        });
      }
      if (ev.action === 'applied') {
        if (ev.outcome !== 'pass') {
          ctx.addIssue({
            code: 'custom',
            path: ['outcome'],
            message: 'applied safe apply trace results require pass outcome',
          });
        }
        if (ev.final_verification_ref === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['final_verification_ref'],
            message: 'applied safe apply trace results require final verification refs',
          });
        }
      }
      return;
    }
    if (ev.kind !== 'relay.started' && ev.kind !== 'relay.failed') return;
    if (ev.resolved_from.source === 'role' && ev.resolved_from.role !== ev.role) {
      ctx.addIssue({
        code: 'custom',
        path: ['resolved_from', 'role'],
        message: `resolved_from.role '${ev.resolved_from.role}' does not agree with trace_entry role '${ev.role}'`,
      });
    }
  });
export type TraceEntry = z.infer<typeof TraceEntry>;
