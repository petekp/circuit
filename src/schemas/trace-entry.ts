import { z } from 'zod';
import { ChangeKindDeclaration } from './change-kind.js';
import {
  ProtectedFileDecision,
  SafeApplyAction,
  SafeApplyOutcome,
  SafeApplyReasonCode,
} from './change-packet.js';
import { RelayResolutionSource, ResolvedConnector } from './connector.js';
import { EngineProvenance } from './engine-provenance.js';
import { EquipmentEnforcement } from './equipment-scope.js';
import {
  GuidanceDecisionId,
  GuidanceDecisionTraceEntryBody,
  refineGuidanceDecisionTraceEntry,
} from './guidance-decision.js';
import { CompiledFlowId, InvocationId, RunId, SkillId, SkillSlotId, StepId } from './ids.js';
import { Power } from './power.js';
import { CompiledDepth } from './process.js';
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
  // Which engine bootstrapped this run. Stamped here as well as on the result
  // so a crash-healed record, which is rebuilt from this entry, reports the
  // engine that actually ran rather than the one that did the healing.
  // Optional for the same reason as `reduced_bindings`: prior fixtures and
  // resumed runs (which never re-bootstrap) stay valid, and an omitted field
  // makes no claim.
  engine: EngineProvenance.optional(),
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

// A passed relay whose schema-tied report could NOT be materialized. Narrow
// seam: the result body parsed at check time and satisfied the schema, but the
// re-parse that feeds the report writer failed, so `writes.report.path` never
// appears on disk. The pass verdict stands — the check already ruled — but
// without this record every downstream reader sees "no report" with no
// explanation. The reason names the raw-result fallback and the remedy.
export const StepReportSkippedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('step.report_skipped'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  report_path: z.string().min(1),
  reason: z.string().min(1),
}).strict();
export type StepReportSkippedTraceEntry = z.infer<typeof StepReportSkippedTraceEntry>;

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
  // Whether the command was killed for hitting its verification budget
  // rather than exiting on its own. Defaults false so every trace entry
  // recorded before this field existed still parses.
  timed_out: z.boolean().default(false),
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
  // `response_path` remains the stable latest-response location for existing
  // readers. New runs also point at the immutable response for this attempt so
  // later visits to the same checkpoint cannot erase earlier review notes.
  response_attempt_path: z.string().min(1).optional(),
  response_report_hash: ContentHash.optional(),
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
// The equipment-scope enforcement decision recorded at relay start. `declared`
// preserves the author's intent; `effective` is the honest runtime state; they
// diverge only on the downgrade path. `enforced_tools` is the exact restricted
// surface and appears IFF the scope is effectively enforced — a trusted scope
// never carries a list (trusted is guidance, not a restriction). Cross-field
// consistency is enforced at the TraceEntry-union level (the variant stays a
// plain ZodObject so discrimination works), mirroring the role binding below.
// Present only on steps that declare a non-full equipment scope; absent
// otherwise, keeping today's traces byte-stable.
export const EquipmentEnforcementEvidence = z
  .object({
    declared: EquipmentEnforcement,
    effective: EquipmentEnforcement,
    downgraded: z.boolean(),
    enforced_tools: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type EquipmentEnforcementEvidence = z.infer<typeof EquipmentEnforcementEvidence>;

// Present only on relays whose flow asked for a prompt-only reviewer (no
// repository access). `applied: false` means the chosen connector could not
// honor that request and the relay ran with repository access anyway — the
// run is still honest, but the reviewer was not sealed, and every operator
// surface must say so.
export const RelayContextSeal = z
  .object({
    applied: z.boolean(),
    reason: z.string().min(1).optional(),
  })
  .strict();
export type RelayContextSeal = z.infer<typeof RelayContextSeal>;

export const RelayStartedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('relay.started'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  connector: ResolvedConnector,
  role: RelayRole,
  resolved_selection: ResolvedSelection,
  resolved_from: RelayResolutionSource,
  equipment: EquipmentEnforcementEvidence.optional(),
  context_seal: RelayContextSeal.optional(),
}).strict();
export type RelayStartedTraceEntry = z.infer<typeof RelayStartedTraceEntry>;

// Why this skill ended up loaded into a relay: an author-declared default
// selection, a config-bound slot, or a skill-hook auto-injection. The cause is
// stamped at load time so a hook-injected skill can never be read back as
// author-declared. `slot` is present exactly when `cause` is `binding` — a slot
// is the binding's identity, and selection/skill-hook loads have no slot.
export const LoadedSkillCause = z.enum(['selection', 'binding', 'skill-hook']);
export type LoadedSkillCause = z.infer<typeof LoadedSkillCause>;

export const LoadedSkillEvidence = z
  .object({
    id: SkillId,
    cause: LoadedSkillCause,
    slot: SkillSlotId.optional(),
    path: z.string().min(1),
    sha256: ContentHash,
    bytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((skill, ctx) => {
    const hasSlot = skill.slot !== undefined;
    const isBinding = skill.cause === 'binding';
    if (hasSlot && !isBinding) {
      ctx.addIssue({
        code: 'custom',
        path: ['slot'],
        message: `a loaded skill carries a slot only when its cause is 'binding' (cause was '${skill.cause}')`,
      });
    }
    if (isBinding && !hasSlot) {
      ctx.addIssue({
        code: 'custom',
        path: ['slot'],
        message: "a loaded skill with cause 'binding' must name the slot it was bound to",
      });
    }
  });
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
  // The model the connector actually spawned with, when it resolves one at
  // dispatch (codex records its cache-resolved default here). Optional and a
  // connector-dispatch fact, parallel to `cli_version`: a connector whose model
  // is already fixed by `resolved_selection` leaves it absent. Recording it
  // makes the receipt authoritative about the model even when the selection
  // layer pinned none.
  model: z.string().min(1).optional(),
  // Additive evidence that the connector observed and validated this many
  // completed web_search lifecycles. Absent on older and non-search receipts.
  web_search_count: z.number().int().nonnegative().optional(),
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

// 'evidence_invalid' is the completed-but-unproven close: a relay finished and
// produced work, but its typed report failed validation, so the run cannot
// prove the work. Distinct from 'aborted' so the operator knows there is real
// work worth inspecting before discarding anything.
export const RunClosedOutcome = z.enum([
  'complete',
  'aborted',
  'evidence_invalid',
  'handoff',
  'stopped',
  'escalated',
]);
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
  // Set only when this branch was admitted from a prior crashed run's finished
  // child instead of being re-run (a `--reuse-children-from` restart). Carries
  // the prior child's run id so the trace stays honest that the work was reused,
  // not freshly executed. Absent on a normally-run branch.
  reused_from: RunId.optional(),
}).strict();
export type FanoutBranchCompletedTraceEntry = z.infer<typeof FanoutBranchCompletedTraceEntry>;

export const FanoutJoinedTraceEntry = TraceEntryBase.extend({
  kind: z.literal('fanout.joined'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  // The join policy that ran; mirrors the FanoutAggregateCheck.join.policy
  // field but echoed into the trace_entry so the audit log is self-contained
  // (no need to cross-reference the schematic to interpret outcomes).
  policy: z.enum([
    'pick-winner',
    'disjoint-merge',
    'aggregate-only',
    'aggregate-any',
    'aggregate-survivors',
  ]),
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

// Auto-power inference is best-effort: a crash while resolving the dial must
// never break the run — it proceeds on the documented medium fallback. But the
// failure must not be invisible either, or "inference crashed" reads exactly
// like "the researcher never recommended a tier". When the inference seam
// throws, the graph-runner records this marker (the sibling of
// `run.skill-hook-error`) so the trace and the operator summary can say why
// the dial stayed at medium.
export const PowerInferenceErrorTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.power-inference-error'),
  step_id: StepId.optional(),
  message: z.string().min(1),
}).strict();
export type PowerInferenceErrorTraceEntry = z.infer<typeof PowerInferenceErrorTraceEntry>;

// Pull-then-retry context delivery is fail-safe: a crash anywhere in the
// delivery seam leaves the run on the starved outcome, exactly as if delivery
// were off. But without a record, "the seam broke" reads exactly like "the
// worker never asked for context". When the seam's outer guard catches, the
// graph-runner records this marker (the sibling of
// `run.power-inference-error`) so the trace and the operator summary can say
// delivery was attempted and failed.
export const ContextDeliveryErrorTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.context-delivery-error'),
  step_id: StepId,
  message: z.string().min(1),
}).strict();
export type ContextDeliveryErrorTraceEntry = z.infer<typeof ContextDeliveryErrorTraceEntry>;

// Step 2 — the durable record of a live equipment-reshape decision: the first
// time the engine adapts a RUNNING flow. Written in the post-step seam when a
// relay surfaces an equipment discovery. `reshaped:true` means the discovery was
// confirmed, re-resolved, and re-validated through the compiled-flow gate, and
// the run continued on the re-equipped tail (`equipped_steps` lists the steps
// that gained skills). `reshaped:false` means it parked as a finding (Option B),
// the flow unchanged, and `reason` says why (unconfirmed, budget exhausted,
// cycle guard, a no-op, or a safety-floor rejection). The reshape is additive,
// so the step sequence never changes — there is no splice. Absent entirely on
// runs where no relay surfaces a discovery, keeping today's traces byte-stable.
export const RunEquipmentReshapeTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.equipment-reshape'),
  step_id: StepId,
  confirmed: z.boolean(),
  reshaped: z.boolean(),
  domain_tags: z.array(z.string()),
  equipped_steps: z.array(StepId).optional(),
  reason: z.string().min(1),
}).strict();
export type RunEquipmentReshapeTraceEntry = z.infer<typeof RunEquipmentReshapeTraceEntry>;

// On-demand context-pull — the durable record of one typed lookup a running
// step made against a parent's typed report. The sibling of equipment reshape:
// reshape adapts the remaining steps, this records a step asking a parent for
// one more named slice of context on demand. Written in the post-step seam for
// each query a relay surfaced in its `context_request`. `answered:true` means
// the named slice resolved and `bytes` is its serialized size; `answered:false`
// means it parked as a finding (an "everything" ask, an exhausted budget, an
// unknown parent, or an unanswerable path) and `reason` says which. Resolve-and-
// record only — no step gains the value back in this cut, so the run is never
// altered. Absent entirely on runs where no relay asks, keeping today's traces
// byte-stable.
export const RunContextPullTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.context-pull'),
  step_id: StepId,
  from_step: z.string(),
  field_path: z.string(),
  answered: z.boolean(),
  bytes: z.number().int().nonnegative().optional(),
  reason: z.string().min(1),
}).strict();
export type RunContextPullTraceEntry = z.infer<typeof RunContextPullTraceEntry>;

// Pull-then-retry context-delivery — the durable record of the value half of the
// typed-lookup channel. Where run.context-pull records that a slice was resolved,
// this records that the resolved slices were FOLDED into the starving step's
// envelope and the step was RE-RUN once on the enriched context. `delivered_slices`
// / `delivered_bytes` are what was folded in; `retried` is whether the re-run ran;
// `kept` says which outcome the run carried forward — `retry` when the enriched
// re-run produced a result, `original` when it fell back (the retry errored or its
// connector failed before producing a result, leaving the starved result intact).
// Written only when a step had at least one answered slice to deliver, so a run
// that delivers nothing — and any run with delivery off — carries no such entry.
export const RunContextDeliveryTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.context-delivery'),
  step_id: StepId,
  delivered_slices: z.number().int().nonnegative(),
  delivered_bytes: z.number().int().nonnegative(),
  retried: z.boolean(),
  kept: z.enum(['retry', 'original']),
  reason: z.string().min(1),
}).strict();
export type RunContextDeliveryTraceEntry = z.infer<typeof RunContextDeliveryTraceEntry>;

// The durable per-iteration record of an until-loop's stop-judge disposition —
// the Circuit analog of autoresearch's results.tsv. Written at the tail seam
// once per pass on a judge-gated until loop AFTER the disposition is final, so
// the operator can read what each pass proposed, whether the evidence floor
// confirmed it, and why a pass was discarded. `goal_proposed` is the judge's
// raw claim; `evidence_confirmed` is the floor's verdict; `disposition` is the
// engine's settled action. `no_progress_count` is the consecutive-stall count
// (0 on a stop-clean pass and whenever the flow declares no progress marker);
// `open_latch_count` is how many honesty-ledger latches were still open when the
// pass closed. `lesson` echoes the judge's carried lesson when present. Absent
// entirely on any non-until run and on count-driven until loops (no judgment to
// record), keeping today's traces byte-stable. The stop-clean ⟺ both-true
// invariant from disposeIteration is enforced at the union level below.
export const RunUntilJudgmentTraceEntry = TraceEntryBase.extend({
  kind: z.literal('run.until-judgment'),
  step_id: StepId,
  iteration: z.number().int().nonnegative(),
  goal_proposed: z.boolean(),
  evidence_confirmed: z.boolean(),
  disposition: z.enum(['stop-clean', 'reenter', 'needs-attention']),
  no_progress_count: z.number().int().nonnegative(),
  open_latch_count: z.number().int().nonnegative(),
  lesson: z.string().min(1).optional(),
}).strict();
export type RunUntilJudgmentTraceEntry = z.infer<typeof RunUntilJudgmentTraceEntry>;

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
    StepReportSkippedTraceEntry,
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
    PowerInferenceErrorTraceEntry,
    RunEquipmentReshapeTraceEntry,
    RunContextPullTraceEntry,
    RunContextDeliveryTraceEntry,
    ContextDeliveryErrorTraceEntry,
    RunUntilJudgmentTraceEntry,
    GuidanceDecisionTraceEntryBody,
  ])
  .superRefine((ev, ctx) => {
    if (ev.kind === 'guidance.decision') {
      refineGuidanceDecisionTraceEntry(ev, ctx);
      return;
    }
    if (ev.kind === 'run.until-judgment') {
      // disposeIteration reaches 'stop-clean' only when BOTH the goal was
      // proposed AND the evidence confirmed it (until-corridor.ts). A recorded
      // clean stop missing either is a laundered false-done — reject it on the
      // offending field so the trace can never claim a stop the engine could not.
      if (ev.disposition === 'stop-clean') {
        if (!ev.goal_proposed) {
          ctx.addIssue({
            code: 'custom',
            path: ['goal_proposed'],
            message: "a 'stop-clean' until judgment requires goal_proposed true",
          });
        }
        if (!ev.evidence_confirmed) {
          ctx.addIssue({
            code: 'custom',
            path: ['evidence_confirmed'],
            message: "a 'stop-clean' until judgment requires evidence_confirmed true",
          });
        }
      }
      return;
    }
    if (ev.kind === 'check.evaluated') {
      // Mirror the verification.command_evaluated invariant below: when a check
      // carries BOTH a command exit_code and a status, status must be 'passed'
      // exactly when exit_code is 0 (proof-plan.ts derives the observation
      // status that way). outcome is deliberately NOT constrained: a command
      // acceptance criterion may expect a nonzero exit (expected_status
      // 'failed'), so a passing outcome can honestly carry a failed status.
      // Both fields are optional here, so only constrain them when present.
      if (ev.exit_code !== undefined && ev.status !== undefined) {
        const expected = ev.exit_code === 0 ? 'passed' : 'failed';
        if (ev.status !== expected) {
          ctx.addIssue({
            code: 'custom',
            path: ['status'],
            message: `status must be '${expected}' when exit_code is ${ev.exit_code}`,
          });
        }
      }
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
    if (ev.kind === 'relay.started' && ev.equipment !== undefined) {
      const eq = ev.equipment;
      // enforced_tools appears IFF the scope is effectively enforced.
      if (eq.effective === 'enforced' && eq.enforced_tools === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['equipment', 'enforced_tools'],
          message: 'an effectively-enforced equipment scope must record its enforced_tools',
        });
      }
      if (eq.effective === 'trusted' && eq.enforced_tools !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['equipment', 'enforced_tools'],
          message:
            'a trusted equipment scope must not record enforced_tools — trusted is guidance, not a restriction',
        });
      }
      // A downgrade is precisely declared-enforced resolving to effective-trusted.
      if (eq.downgraded && !(eq.declared === 'enforced' && eq.effective === 'trusted')) {
        ctx.addIssue({
          code: 'custom',
          path: ['equipment', 'downgraded'],
          message: 'a downgraded equipment scope must be declared enforced and effective trusted',
        });
      }
      // Effective enforcement is only reachable from a declared-enforced scope.
      if (eq.effective === 'enforced' && eq.declared !== 'enforced') {
        ctx.addIssue({
          code: 'custom',
          path: ['equipment', 'effective'],
          message: 'an effectively-enforced equipment scope must be declared enforced',
        });
      }
    }
  });
export type TraceEntry = z.infer<typeof TraceEntry>;
