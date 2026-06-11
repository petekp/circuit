import { z } from 'zod';
import { PowerRecommendation } from '../../schemas/power.js';
import { RuntimeGitStateEntry, RuntimeHiddenIndexFlag } from '../../schemas/runtime-evidence.js';
import {
  VerificationCommand,
  VerificationCommandResult,
  VerificationResult,
} from '../../schemas/verification.js';
import { resultReportPointer } from '../report-schema-kit.js';

const BUILD_RESULT_SCHEMA_BY_ARTIFACT_ID = {
  'build.brief': 'build.brief@v1',
  'build.plan': 'build.plan@v1',
  'build.implementation': 'build.implementation@v1',
  'build.verification': 'build.verification@v1',
  'build.review': 'build.review@v1',
} as const;

const NonEmptyStringArray = z.array(z.string().min(1)).min(1);

// Negative-space intent carried context -> plan. non_goals are things the
// change must NOT do (operator-stated boundaries, ~scope.out); invariants are
// properties the change must preserve (~constraints/safeguards). Both default
// empty so a change with no declared boundaries carries no ceremony tax.
export const BuildGuardrails = z
  .object({
    non_goals: z
      .array(z.string().min(1))
      .default([])
      .describe('things the change must not do, drawn from operator-stated boundaries'),
    invariants: z
      .array(z.string().min(1))
      .default([])
      .describe('properties the change must preserve, grounded in the codebase read'),
  })
  .strict();
export type BuildGuardrails = z.infer<typeof BuildGuardrails>;

// The allowed touch area: where the change is permitted to edit files, proposed
// by the researcher from its codebase read and carried context -> plan. Each
// entry is either a directory subtree (ends in '/', e.g. "src/flows/build/")
// matched on segment boundaries, or an exact repo-relative file path. The
// touch-area gate compares the git-proven set of files the implementer actually
// changed against these prefixes; anything outside is overreach. Defaults empty,
// which makes the gate opt-in: with no declared area the gate stays inert and
// the build behaves exactly as before. The researcher proposes the area, never
// the operator (asking an operator to enumerate off-limits files would be a
// hostile product); a different role (the implementer) is then held to it, so
// this is a drift check across roles, not the model granting itself permission.
export const AllowedTouchArea = z
  .array(
    z
      .string()
      .min(1)
      .describe(
        'a directory subtree ending in "/" (segment-aware, e.g. "src/flows/build/") or an exact repo-relative file path',
      ),
  )
  .default([])
  .describe(
    'paths the change is allowed to touch, proposed by the researcher from the codebase read; empty leaves the touch-area gate inert (opt-in)',
  );
export type AllowedTouchArea = z.infer<typeof AllowedTouchArea>;

// One ordered unit of implementation work. The researcher decomposes the
// change into these during analyze; under deep depth the engine implements
// and verifies them one at a time. See docs/ideas/build-slice-decomposition.md.
export const BuildSlice = z
  .object({
    id: z.string().min(1).describe('stable slice id, e.g. "slice-1"'),
    intent: z
      .string()
      .min(1)
      .describe('one concrete, independently-verifiable unit of implementation work'),
    anticipated_file_extensions: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'file extensions this slice is predicted to touch, e.g. ".ts"; empty when no confident prediction',
      ),
  })
  .strict();
export type BuildSlice = z.infer<typeof BuildSlice>;

export const BuildCheckpointPacketChoice = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
    route: z
      .object({
        key: z.string().min(1),
        target: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type BuildCheckpointPacketChoice = z.infer<typeof BuildCheckpointPacketChoice>;

export const BuildCheckpointPacket = z
  .object({
    kind: z.literal('build.checkpoint_packet@v1'),
    salience: z
      .object({
        summary: z.string().min(1),
        why_now: NonEmptyStringArray,
        hidden_routine_work: NonEmptyStringArray,
      })
      .strict(),
    decision: z
      .object({
        question: z.string().min(1),
        operator_judgment: z.string().min(1),
      })
      .strict(),
    recommendation: z
      .object({
        choice_id: z.string().min(1),
        label: z.string().min(1),
        rationale: z.string().min(1),
      })
      .strict(),
    artifact: z
      .object({
        title: z.string().min(1),
        preview: z.string().min(1),
        scope: z.string().min(1),
        success_criteria: NonEmptyStringArray,
      })
      .strict(),
    proof: z
      .object({
        status: z.enum(['planned', 'collected', 'missing']),
        summary: z.string().min(1),
        commands: z.array(VerificationCommand).min(1),
        evidence: NonEmptyStringArray,
      })
      .strict(),
    risk: z
      .object({
        summary: z.string().min(1),
        tradeoffs: NonEmptyStringArray,
      })
      .strict(),
    choices: z.array(BuildCheckpointPacketChoice).min(1),
    internal: z
      .object({
        request_path: z.string().min(1),
        response_path: z.string().min(1),
        report_path: z.string().min(1),
        raw_evidence: NonEmptyStringArray,
      })
      .strict(),
  })
  .strict()
  .superRefine((packet, ctx) => {
    const choiceIds = new Set(packet.choices.map((choice) => choice.id));
    if (!choiceIds.has(packet.recommendation.choice_id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendation', 'choice_id'],
        message: 'recommendation.choice_id must reference a declared checkpoint choice',
      });
    }
  });
export type BuildCheckpointPacket = z.infer<typeof BuildCheckpointPacket>;

const BuildCheckpointPointer = z
  .object({
    request_path: z.string().min(1),
    response_path: z.string().min(1).optional(),
    allowed_choices: NonEmptyStringArray,
  })
  .strict();

export const BuildBrief = z
  .object({
    objective: z.string().min(1),
    scope: z.string().min(1),
    success_criteria: NonEmptyStringArray,
    verification_command_candidates: z.array(VerificationCommand).min(1),
    checkpoint: BuildCheckpointPointer,
    checkpoint_packet: BuildCheckpointPacket.optional(),
  })
  .strict();
export type BuildBrief = z.infer<typeof BuildBrief>;

export const BuildContextSource = z
  .object({
    kind: z.enum(['file', 'command', 'log', 'operator-note', 'reference']),
    ref: z
      .string()
      .min(1)
      .describe('project-relative path, command id, log line, note id, or external reference'),
    summary: z.string().min(1).describe('one-line summary of what this source contributed'),
  })
  .strict();
export type BuildContextSource = z.infer<typeof BuildContextSource>;

export const BuildContext = z
  .object({
    verdict: z.literal('accept'),
    sources: z.array(BuildContextSource).min(1),
    observations: z.array(z.string().min(1).describe('observation grounded in the sources')).min(1),
    open_questions: z.array(
      z.string().min(1).describe('question still unresolved after gathering context'),
    ),
    anticipated_file_extensions: z
      .array(
        z
          .string()
          .min(1)
          .describe(
            'file extension the implementation is expected to touch, e.g. ".ts" or ".test.ts"',
          ),
      )
      .default([])
      .describe(
        'file extensions the implementation is predicted to touch, inferred from the codebase read; empty when no confident prediction',
      ),
    slices: z
      .array(BuildSlice)
      .default([])
      .describe(
        'ordered units of implementation work the change decomposes into, inferred from the codebase read; empty when the change is a single indivisible unit (the plan then runs one pass)',
      ),
    guardrails: BuildGuardrails.default({ non_goals: [], invariants: [] }).describe(
      'negative space: operator-stated non_goals extracted from the goal and code-grounded invariants the change must preserve; empty when none apply',
    ),
    allowed_touch_area: AllowedTouchArea,
    recommended_power: PowerRecommendation.optional().describe(
      'ONLY when the relay context states the power dial is auto: the tier the downstream work needs, judged from the codebase read. Omit this key entirely otherwise',
    ),
  })
  .strict();
export type BuildContext = z.infer<typeof BuildContext>;

export const BuildPlan = z
  .object({
    objective: z.string().min(1),
    approach: z.string().min(1),
    slices: z
      .array(BuildSlice)
      .min(1)
      .describe(
        'ordered units of implementation work, carried from build.context@v1; always at least one (a single-slice plan runs one implement+verify pass). Under deep depth the engine implements and verifies these one at a time',
      ),
    anticipated_file_extensions: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'file extensions the implementation is predicted to touch, surfaced from build.context@v1; empty when grounding made no confident prediction',
      ),
    guardrails: BuildGuardrails.default({ non_goals: [], invariants: [] }).describe(
      'negative space carried from build.context@v1: non_goals the change must not do and invariants it must preserve; empty when none apply',
    ),
    allowed_touch_area: AllowedTouchArea.describe(
      'paths the change is allowed to touch, carried from build.context@v1; empty leaves the touch-area gate inert (opt-in)',
    ),
    verification: z
      .object({
        commands: z.array(VerificationCommand).min(1),
      })
      .strict(),
  })
  .strict();
export type BuildPlan = z.infer<typeof BuildPlan>;

export const BuildImplementation = z
  .object({
    verdict: z.literal('accept'),
    summary: z.string().min(1),
    changed_files: z.array(z.string().min(1)),
    evidence: NonEmptyStringArray,
  })
  .strict();
export type BuildImplementation = z.infer<typeof BuildImplementation>;

export const BuildVerificationCommand = VerificationCommand;
export type BuildVerificationCommand = z.infer<typeof BuildVerificationCommand>;

export const BuildVerification = VerificationResult;
export type BuildVerification = z.infer<typeof BuildVerification>;

export const BuildVerificationCommandResult = VerificationCommandResult;
export type BuildVerificationCommandResult = z.infer<typeof BuildVerificationCommandResult>;

export const BuildReviewVerdict = z.enum(['accept', 'accept-with-fixes', 'reject']);
export type BuildReviewVerdict = z.infer<typeof BuildReviewVerdict>;

export const BuildReviewFinding = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    text: z.string().min(1),
    file_refs: z.array(z.string().min(1)),
  })
  .strict();
export type BuildReviewFinding = z.infer<typeof BuildReviewFinding>;

// Per-declared-non-goal judgment: did the change respect the stated boundary?
const BuildAlignmentNonGoal = z
  .object({
    statement: z.string().min(1).describe('the declared non-goal, echoed from the plan'),
    status: z.enum(['respected', 'violated', 'not_applicable']),
    evidence: z.string().min(1).describe('what in the change supports this judgment'),
  })
  .strict();

// Per-declared-invariant judgment: did the change preserve the property?
const BuildAlignmentInvariant = z
  .object({
    statement: z.string().min(1).describe('the declared invariant, echoed from the plan'),
    status: z.enum(['preserved', 'violated', 'not_applicable']),
    evidence: z.string().min(1).describe('what in the change supports this judgment'),
  })
  .strict();

// The reviewer's assessment of the change against the captured intent.
// scope_adherence is the always-present spine: it is assessable against the
// always-present brief even when no guardrails were declared, so the gate is
// never inert. non_goals/invariants carry one entry per declared guardrail.
export const BuildReviewAlignment = z
  .object({
    scope_adherence: z.enum(['within_scope', 'exceeds_scope']),
    non_goals: z.array(BuildAlignmentNonGoal).default([]),
    invariants: z.array(BuildAlignmentInvariant).default([]),
  })
  .strict();
export type BuildReviewAlignment = z.infer<typeof BuildReviewAlignment>;

export const BuildReview = z
  .object({
    verdict: BuildReviewVerdict,
    summary: z.string().min(1),
    findings: z.array(BuildReviewFinding),
    alignment: BuildReviewAlignment,
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.verdict !== 'accept' && review.findings.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message: `findings must be non-empty when verdict is '${review.verdict}'`,
      });
    }
    // Exceeding the stated scope is itself a reviewable problem: it must be
    // recorded as at least one finding the operator can act on.
    if (review.alignment.scope_adherence === 'exceeds_scope' && review.findings.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message: "findings must be non-empty when scope_adherence is 'exceeds_scope'",
      });
    }
    // A violated guardrail blocks a clean accept and must be backed by a
    // finding. This is the structural teeth: scope creep the reviewer detected
    // cannot be silently accepted.
    const hasViolation =
      review.alignment.non_goals.some((entry) => entry.status === 'violated') ||
      review.alignment.invariants.some((entry) => entry.status === 'violated');
    if (hasViolation) {
      if (review.verdict === 'accept') {
        ctx.addIssue({
          code: 'custom',
          path: ['verdict'],
          message: "verdict may not be 'accept' when a declared guardrail is violated",
        });
      }
      if (review.findings.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['findings'],
          message: 'findings must be non-empty when a declared guardrail is violated',
        });
      }
    }
  });
export type BuildReview = z.infer<typeof BuildReview>;

export const BuildBaselineSnapshotEntry = RuntimeGitStateEntry;
export type BuildBaselineSnapshotEntry = z.infer<typeof BuildBaselineSnapshotEntry>;

export const BuildHiddenIndexFlag = RuntimeHiddenIndexFlag;
export type BuildHiddenIndexFlag = z.infer<typeof BuildHiddenIndexFlag>;

// Runtime-owned pre-act snapshot of git state. Captured once before the
// implementer touches the working tree (and, under deep depth, before the first
// slice), it is the baseline the post-verify touch-area step diffs against to
// recover the git-proven set of files the implementer actually changed. Mirrors
// fix.baseline-snapshot@v1's captured shape; overall_status is always 'passed'
// (the snapshot records state, it does not gate routing).
//
// Discriminated on `captured`. The touch-area gate is opt-in: when the plan
// declares no allowed_touch_area there is nothing to enforce, so the baseline
// step skips git entirely and records the inert `captured: false` shape. This
// keeps a Build run that never opted into the gate free of any git dependency,
// exactly as before the gate existed. Only when an area is declared does the
// step shell out to git and record the full `captured: true` snapshot.
export const BuildBaselineCaptured = z
  .object({
    overall_status: z.literal('passed'),
    captured: z.literal(true),
    head_sha: z.string().min(1),
    entries: z.array(BuildBaselineSnapshotEntry),
    hidden_index_flags: z.array(BuildHiddenIndexFlag),
  })
  .strict();
export type BuildBaselineCaptured = z.infer<typeof BuildBaselineCaptured>;

export const BuildBaselineInert = z
  .object({
    overall_status: z.literal('passed'),
    captured: z.literal(false),
  })
  .strict();
export type BuildBaselineInert = z.infer<typeof BuildBaselineInert>;

export const BuildBaselineSnapshot = z.discriminatedUnion('captured', [
  BuildBaselineCaptured,
  BuildBaselineInert,
]);
export type BuildBaselineSnapshot = z.infer<typeof BuildBaselineSnapshot>;

export const BuildTouchAreaEnforcement = z.enum(['enforced', 'not_enforced']);
export type BuildTouchAreaEnforcement = z.infer<typeof BuildTouchAreaEnforcement>;

// within        — every changed path is inside the allowed area (or the gate is
//                 not enforced because no area was declared).
// out_of_bounds — at least one git-proven changed path is outside the area.
// undetermined  — containment cannot be proven: HEAD moved (the implementer
//                 committed mid-run, so changes cannot be attributed) or a path
//                 is hidden from git status (assume-unchanged / skip-worktree).
//                 Treated as fail-closed at close.
export const BuildTouchAreaContainment = z.enum(['within', 'out_of_bounds', 'undetermined']);
export type BuildTouchAreaContainment = z.infer<typeof BuildTouchAreaContainment>;

// Runtime-owned touch-area verdict. After the slice loop completes, the runtime
// snapshots git again, diffs against the baseline to recover the git-proven set
// of changed paths, and checks each against the plan's allowed_touch_area. This
// is the hard half of intent enforcement: the reviewer's alignment is a model
// judgment, but containment here is a deterministic git fact the implementer
// cannot talk around.
//
// overall_status is always 'passed' when the observation itself succeeds, so the
// verification step routes 'continue' and the gate lands at close (consistent
// with the scope gate; a mid-flow re-route would collapse to failed_check ->
// act-step, the same boundary constraint documented for the scope gate). If the
// git observation fails, the writer throws and the runner takes its error path.
//
// Known boundaries (what "git-proven" does NOT cover). The gate reasons about
// the git-tracked working tree, so a few paths are invisible to it by design,
// and it fails closed rather than guess:
//   - A rename moves two paths; git reports only the destination as the entry
//     path. The source is carried on the touched-file's `from` and checked too,
//     so `git mv out-of-area in-area` cannot hide the source (see
//     projectBuildTouchArea).
//   - Files matched by .gitignore are never tracked and never appear in
//     `git status`, so a write to an ignored path outside the area is not seen.
//     Such a path cannot be committed without an explicit `git add -f` (which
//     makes it visible), so it is outside the gate's "tracked change" scope.
//   - A working-tree blob that `git hash-object` cannot read is fingerprinted
//     with a sentinel; if a baseline-dirty path is unreadable both before and
//     after, an in-place mutation of it can go unobserved. This requires a path
//     already dirty before the build and persistently unhashable - pathological,
//     and noted here rather than papered over.
// Cases the gate CAN observe but cannot attribute (HEAD moved, assume-unchanged
// / skip-worktree) resolve to `undetermined`, which blocks close.
export const BuildTouchArea = z
  .object({
    overall_status: z.literal('passed'),
    enforcement: BuildTouchAreaEnforcement,
    containment: BuildTouchAreaContainment,
    allowed_area: z.array(z.string().min(1)),
    observed_paths: z.array(z.string().min(1)),
    out_of_bounds_paths: z.array(z.string().min(1)),
    // The two git SHAs are present only when git actually ran (an area was
    // declared). When the gate is not enforced the step skips git, so they are
    // absent; the superRefine below requires them exactly when enforced.
    baseline_head_sha: z.string().min(1).optional(),
    head_sha: z.string().min(1).optional(),
    head_diverged: z.boolean(),
    hidden_index_flags: z.array(BuildHiddenIndexFlag),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((touchArea, ctx) => {
    const enforced = touchArea.enforcement === 'enforced';
    // When enforced, git ran, so both SHAs must be recorded — the containment
    // verdict is only trustworthy when backed by a real before/after snapshot.
    if (
      enforced &&
      (touchArea.baseline_head_sha === undefined || touchArea.head_sha === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseline_head_sha'],
        message: 'baseline_head_sha and head_sha are required when enforcement is "enforced"',
      });
    }
    if (enforced === (touchArea.allowed_area.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['enforcement'],
        message:
          "enforcement must be 'enforced' exactly when allowed_area is non-empty (and 'not_enforced' when empty)",
      });
    }
    // When the gate is not enforced (no declared area) it is fully inert:
    // containment is 'within' and nothing is out of bounds, regardless of where
    // the change landed or whether HEAD moved. An opt-out build is never gated.
    if (!enforced && touchArea.containment !== 'within') {
      ctx.addIssue({
        code: 'custom',
        path: ['containment'],
        message: "containment must be 'within' when enforcement is 'not_enforced'",
      });
    }
    if (!enforced && touchArea.out_of_bounds_paths.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['out_of_bounds_paths'],
        message: 'out_of_bounds_paths must be empty when enforcement is "not_enforced"',
      });
    }
    // out_of_bounds requires named paths; named paths require the out_of_bounds
    // verdict. The two move together so the verdict can never disagree with the
    // evidence behind it.
    if (touchArea.containment === 'out_of_bounds' && touchArea.out_of_bounds_paths.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['out_of_bounds_paths'],
        message: "out_of_bounds_paths must be non-empty when containment is 'out_of_bounds'",
      });
    }
    if (touchArea.containment !== 'out_of_bounds' && touchArea.out_of_bounds_paths.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['containment'],
        message: "containment must be 'out_of_bounds' when out_of_bounds_paths is non-empty",
      });
    }
    // undetermined is the fail-closed verdict: it holds exactly when containment
    // could not be proven because HEAD moved or a path was hidden from git.
    const cannotProve = touchArea.head_diverged || touchArea.hidden_index_flags.length > 0;
    if (enforced && cannotProve && touchArea.containment !== 'undetermined') {
      ctx.addIssue({
        code: 'custom',
        path: ['containment'],
        message:
          "containment must be 'undetermined' when HEAD moved or a hidden index flag is present (enforced)",
      });
    }
    if (touchArea.containment === 'undetermined' && !cannotProve) {
      ctx.addIssue({
        code: 'custom',
        path: ['containment'],
        message:
          "containment may be 'undetermined' only when HEAD moved or a hidden index flag is present",
      });
    }
  });
export type BuildTouchArea = z.infer<typeof BuildTouchArea>;

export const BuildResultReportId = z.enum([
  'build.brief',
  'build.plan',
  'build.implementation',
  'build.verification',
  'build.review',
]);
export type BuildResultReportId = z.infer<typeof BuildResultReportId>;

export const BuildResultReportPointer = resultReportPointer(
  BuildResultReportId,
  BUILD_RESULT_SCHEMA_BY_ARTIFACT_ID,
);
export type BuildResultReportPointer = z.infer<typeof BuildResultReportPointer>;

// Operator-facing scope summary, derived deterministically at close from the
// reviewer's alignment and the plan's declared guardrails. It makes the scope
// verdict visible in the result and lets the outcome reflect guardrails the
// reviewer violated or never assessed. Defaults to a clean, within-scope shape
// so a result synthesized without scope detail is permissive, not blocking.
export const BuildScope = z
  .object({
    adherence: z.enum(['within_scope', 'exceeds_scope']),
    violated_guardrails: z
      .array(z.string().min(1))
      .default([])
      .describe('declared guardrails the reviewer marked violated'),
    unassessed_guardrails: z
      .array(z.string().min(1))
      .default([])
      .describe('plan-declared guardrails the reviewer did not assess in alignment'),
  })
  .strict();
export type BuildScope = z.infer<typeof BuildScope>;

// Operator-facing touch-area summary, derived deterministically at close from
// build.touch-area@v1. It makes the git-proven containment verdict visible in
// the result and lets the outcome reflect overreach the implementer cannot
// self-report away. Defaults to a not-enforced, within shape so a result
// synthesized without touch-area detail is permissive, not blocking.
export const BuildTouchAreaSummary = z
  .object({
    enforcement: BuildTouchAreaEnforcement,
    containment: BuildTouchAreaContainment,
    out_of_bounds_paths: z
      .array(z.string().min(1))
      .default([])
      .describe('git-proven changed paths outside the allowed area'),
  })
  .strict();
export type BuildTouchAreaSummary = z.infer<typeof BuildTouchAreaSummary>;

export const BuildResult = z
  .object({
    summary: z.string().min(1),
    outcome: z.enum(['complete', 'needs_attention', 'failed']),
    verification_status: z.enum(['passed', 'failed']),
    review_verdict: BuildReviewVerdict,
    scope: BuildScope.default({
      adherence: 'within_scope',
      violated_guardrails: [],
      unassessed_guardrails: [],
    }),
    touch_area: BuildTouchAreaSummary.default({
      enforcement: 'not_enforced',
      containment: 'within',
      out_of_bounds_paths: [],
    }),
    evidence_links: z.array(BuildResultReportPointer).length(5),
  })
  .strict()
  .superRefine((result, ctx) => {
    const seen = new Set<BuildResultReportId>();
    for (const [index, pointer] of result.evidence_links.entries()) {
      if (seen.has(pointer.report_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_links', index, 'report_id'],
          message: `duplicate report_id '${pointer.report_id}'`,
        });
      }
      seen.add(pointer.report_id);
    }
    for (const reportId of BuildResultReportId.options) {
      if (!seen.has(reportId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_links'],
          message: `missing report_id '${reportId}'`,
        });
      }
    }
    if (result.outcome === 'complete') {
      if (result.verification_status !== 'passed') {
        ctx.addIssue({
          code: 'custom',
          path: ['verification_status'],
          message: "verification_status must be 'passed' when outcome is 'complete'",
        });
      }
      if (result.review_verdict !== 'accept') {
        ctx.addIssue({
          code: 'custom',
          path: ['review_verdict'],
          message: "review_verdict must be 'accept' when outcome is 'complete'",
        });
      }
      // A complete build must have stayed in scope with no violated or
      // unassessed guardrail. This is the deterministic close-stage gate: a
      // reviewer cannot launder an out-of-scope change or a skipped guardrail
      // into a clean 'complete', because the close projector recomputes scope
      // from the plan's declared guardrails and the reviewer's alignment.
      if (result.scope.adherence !== 'within_scope') {
        ctx.addIssue({
          code: 'custom',
          path: ['scope', 'adherence'],
          message: "scope.adherence must be 'within_scope' when outcome is 'complete'",
        });
      }
      if (result.scope.violated_guardrails.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['scope', 'violated_guardrails'],
          message: "scope.violated_guardrails must be empty when outcome is 'complete'",
        });
      }
      if (result.scope.unassessed_guardrails.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['scope', 'unassessed_guardrails'],
          message: "scope.unassessed_guardrails must be empty when outcome is 'complete'",
        });
      }
      // The hard touch-area gate: a complete build must have stayed inside its
      // declared area, proven by git, not by the implementer's self-report. An
      // out-of-bounds change (a path the implementer touched outside the area)
      // or an undetermined verdict (HEAD moved or a path hidden from git, so
      // containment cannot be proven) blocks 'complete'. A not-enforced gate
      // (no area declared) always reports 'within', so opt-out builds pass.
      if (result.touch_area.containment !== 'within') {
        ctx.addIssue({
          code: 'custom',
          path: ['touch_area', 'containment'],
          message: "touch_area.containment must be 'within' when outcome is 'complete'",
        });
      }
      if (result.touch_area.out_of_bounds_paths.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['touch_area', 'out_of_bounds_paths'],
          message: "touch_area.out_of_bounds_paths must be empty when outcome is 'complete'",
        });
      }
    }
    if (result.outcome === 'needs_attention') {
      if (result.verification_status !== 'passed') {
        ctx.addIssue({
          code: 'custom',
          path: ['verification_status'],
          message: "verification_status must be 'passed' when outcome is 'needs_attention'",
        });
      }
      // needs_attention covers two cases: the reviewer asked for fixes
      // (accept-with-fixes), or the reviewer accepted but the scope gate
      // degraded the outcome (an exceeds-scope judgment or an unassessed
      // guardrail). It must therefore admit 'accept' and 'accept-with-fixes',
      // but never a 'reject' (which is a failed outcome).
      if (result.review_verdict === 'reject') {
        ctx.addIssue({
          code: 'custom',
          path: ['review_verdict'],
          message: "review_verdict may not be 'reject' when outcome is 'needs_attention'",
        });
      }
    }
  });
export type BuildResult = z.infer<typeof BuildResult>;
