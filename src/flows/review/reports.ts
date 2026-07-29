import { z } from 'zod';

export const ReviewFindingSeverity = z.enum(['critical', 'high', 'medium', 'low']);
export type ReviewFindingSeverity = z.infer<typeof ReviewFindingSeverity>;

export const ReviewResultVerdict = z.enum(['CLEAN', 'ISSUES_FOUND']);
export type ReviewResultVerdict = z.infer<typeof ReviewResultVerdict>;

export const ReviewRelayVerdict = z.enum(['NO_ISSUES_FOUND', 'ISSUES_FOUND']);
export type ReviewRelayVerdict = z.infer<typeof ReviewRelayVerdict>;

export const ReviewEvidenceWarningKind = z.enum([
  'binary_content_not_inspected',
  'diff_truncated',
  'git_command_failed',
  'target_unavailable',
  'untracked_file_skipped',
  'untracked_file_content_omitted',
  'untracked_files_truncated',
  'submodule_content_not_inspected',
  'evidence_unavailable',
  'scope_empty',
  'target_assumed',
  'target_scoped',
  'scope_not_applied',
  'snapshot_fallback',
  'snapshot_truncated',
  'snapshot_file_skipped',
  // The operator asked for the code as it stands but named nowhere to look, so
  // the run reviewed changes instead. Said out loud, because "no findings"
  // answers a different question than the one asked.
  'snapshot_not_applied',
  // Nobody named a target, so one was read out of the goal text by phrase
  // matching. Distinct from `target_assumed`, which reports the case where the
  // matching found nothing and the working tree was assumed. This one reports
  // the opposite and more dangerous case: a pattern DID match, so the run looks
  // definite, and nothing until now distinguished that from a target the caller
  // actually asked for. Only one of the two ever fires.
  'target_inferred',
]);
export type ReviewEvidenceWarningKind = z.infer<typeof ReviewEvidenceWarningKind>;

export const ReviewEvidenceWarning = z
  .object({
    kind: ReviewEvidenceWarningKind,
    message: z.string().min(1),
    path: z.string().min(1).optional(),
  })
  .strict();
export type ReviewEvidenceWarning = z.infer<typeof ReviewEvidenceWarning>;

export const ReviewEvidenceText = z
  .object({
    text: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type ReviewEvidenceText = z.infer<typeof ReviewEvidenceText>;

export const ReviewUntrackedContentPolicy = z.enum(['metadata-only', 'include-content']);
export type ReviewUntrackedContentPolicy = z.infer<typeof ReviewUntrackedContentPolicy>;

export const ReviewTargetKind = z.enum(['working_tree', 'commit', 'range', 'snapshot']);
export type ReviewTargetKind = z.infer<typeof ReviewTargetKind>;

// Which layers of the working tree a review covers. `all` is staged, unstaged
// and untracked; `tracked` is the same minus untracked, which is what an
// operator who wrote "except untracked files" asked for.
export const ReviewWorkingTreeMode = z.enum(['all', 'tracked', 'staged', 'unstaged']);
export type ReviewWorkingTreeMode = z.infer<typeof ReviewWorkingTreeMode>;

// A target narrowed to part of what it would otherwise cover. Present only when
// the operator asked for the narrowing, so an absent scope means "all of it"
// and no consumer has to distinguish empty from unset. Paths are repository
// relative and carry no pathspec magic; the readers add that when they build
// the Git arguments.
export const ReviewPathScope = z
  .object({
    include: z.array(z.string().min(1)),
    exclude: z.array(z.string().min(1)),
  })
  .strict()
  .refine(
    (scope) => scope.include.length > 0 || scope.exclude.length > 0,
    'A path scope must include or exclude at least one path.',
  );
export type ReviewPathScope = z.infer<typeof ReviewPathScope>;

export const ReviewUntrackedFileEvidence = z
  .object({
    path: z.string().min(1),
    byte_length: z.number().int().nonnegative(),
    content: ReviewEvidenceText.optional(),
    skipped_reason: z.string().min(1).optional(),
  })
  .strict();
export type ReviewUntrackedFileEvidence = z.infer<typeof ReviewUntrackedFileEvidence>;

// One file read whole rather than as a diff. The shape matches untracked
// evidence because the read is the same read: bounded contents, or a plain
// reason the contents are absent.
export const ReviewSnapshotFileEvidence = z
  .object({
    path: z.string().min(1),
    byte_length: z.number().int().nonnegative(),
    content: ReviewEvidenceText.optional(),
    skipped_reason: z.string().min(1).optional(),
  })
  .strict();
export type ReviewSnapshotFileEvidence = z.infer<typeof ReviewSnapshotFileEvidence>;

const ReviewGitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

function addRequiredEvidenceField(value: unknown, field: string, ctx: z.RefinementCtx): void {
  if (value !== undefined) return;
  ctx.addIssue({
    code: 'custom',
    path: [field],
    message: `${field} is required for this Review target`,
  });
}

function addForbiddenEvidenceField(value: unknown, field: string, ctx: z.RefinementCtx): void {
  if (value === undefined) return;
  ctx.addIssue({
    code: 'custom',
    path: [field],
    message: `${field} does not belong to this Review target`,
  });
}

function addObjectIdPrefixMismatch(
  ref: string,
  objectId: string | undefined,
  field: string,
  ctx: z.RefinementCtx,
): void {
  if (
    !/^[0-9a-f]{4,64}$/iu.test(ref) ||
    objectId === undefined ||
    objectId.toLowerCase().startsWith(ref.toLowerCase())
  ) {
    return;
  }
  ctx.addIssue({
    code: 'custom',
    path: [field],
    message: `${field} does not match the object id named by the Review target`,
  });
}

const ReviewGitTargetEvidence = z
  .object({
    kind: z.literal('git-target'),
    project_root: z.string().min(1),
    target_kind: z.enum(['commit', 'range']),
    target_ref: z.string().min(1),
    target_base_ref: z.string().min(1).optional(),
    target_head_ref: z.string().min(1).optional(),
    target_commit: ReviewGitObjectId.optional(),
    target_base_commit: ReviewGitObjectId.optional(),
    target_head_commit: ReviewGitObjectId.optional(),
    target_diff: ReviewEvidenceText,
    target_diff_stat: z.string(),
    path_scope: ReviewPathScope.optional(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.target_kind === 'commit') {
      addRequiredEvidenceField(evidence.target_commit, 'target_commit', ctx);
      addForbiddenEvidenceField(evidence.target_base_ref, 'target_base_ref', ctx);
      addForbiddenEvidenceField(evidence.target_head_ref, 'target_head_ref', ctx);
      addForbiddenEvidenceField(evidence.target_base_commit, 'target_base_commit', ctx);
      addForbiddenEvidenceField(evidence.target_head_commit, 'target_head_commit', ctx);
      addObjectIdPrefixMismatch(evidence.target_ref, evidence.target_commit, 'target_commit', ctx);
      return;
    }
    addRequiredEvidenceField(evidence.target_base_ref, 'target_base_ref', ctx);
    addRequiredEvidenceField(evidence.target_head_ref, 'target_head_ref', ctx);
    addRequiredEvidenceField(evidence.target_base_commit, 'target_base_commit', ctx);
    addRequiredEvidenceField(evidence.target_head_commit, 'target_head_commit', ctx);
    addForbiddenEvidenceField(evidence.target_commit, 'target_commit', ctx);
    if (evidence.target_base_ref !== undefined) {
      addObjectIdPrefixMismatch(
        evidence.target_base_ref,
        evidence.target_base_commit,
        'target_base_commit',
        ctx,
      );
    }
    if (evidence.target_head_ref !== undefined) {
      addObjectIdPrefixMismatch(
        evidence.target_head_ref,
        evidence.target_head_commit,
        'target_head_commit',
        ctx,
      );
    }
  });

export const ReviewEvidence = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('goal'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('git-working-tree'),
      project_root: z.string().min(1),
      status_short: z.string(),
      staged_diff: ReviewEvidenceText,
      unstaged_diff: ReviewEvidenceText,
      diff_stat: z.string(),
      // Working-tree evidence always names the working tree. Explicit commit
      // and range targets use the dedicated git-target variant below.
      target_kind: z.literal('working_tree'),
      target_mode: ReviewWorkingTreeMode,
      untracked_file_count: z.number().int().nonnegative(),
      untracked_files_truncated: z.boolean(),
      untracked_content_policy: ReviewUntrackedContentPolicy,
      untracked_files: z.array(ReviewUntrackedFileEvidence),
      submodule_paths: z.array(z.string().min(1)).optional(),
      path_scope: ReviewPathScope.optional(),
    })
    .strict(),
  ReviewGitTargetEvidence,
  // The current contents of the tracked files at a named path, with no diff
  // involved. This is what "review src/auth" asks for when nothing there has
  // changed. A snapshot always names a path scope: an unscoped snapshot would
  // be the whole repository, which is more than one relay can hold.
  z
    .object({
      kind: z.literal('git-snapshot'),
      project_root: z.string().min(1),
      target_kind: z.literal('snapshot'),
      files: z.array(ReviewSnapshotFileEvidence),
      // How many tracked files the scope matched before any bound applied, so
      // a reader can tell a complete snapshot from a sampled one.
      matched_file_count: z.number().int().nonnegative(),
      files_truncated: z.boolean(),
      path_scope: ReviewPathScope,
    })
    .strict(),
]);
export type ReviewEvidence = z.infer<typeof ReviewEvidence>;

export const ReviewEvidenceSummary = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('goal'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('git-working-tree'),
      untracked_content_policy: ReviewUntrackedContentPolicy,
      untracked_file_count: z.number().int().nonnegative(),
      untracked_files_sampled: z.number().int().nonnegative(),
      untracked_files_truncated: z.boolean(),
      target_kind: z.literal('working_tree'),
      target_mode: ReviewWorkingTreeMode,
      target_diff_included: z.boolean(),
      path_scope: ReviewPathScope.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('git-target'),
      target_kind: z.enum(['commit', 'range']),
      target_ref: z.string().min(1),
      target_diff_included: z.boolean(),
      target_diff_truncated: z.boolean(),
      path_scope: ReviewPathScope.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('git-snapshot'),
      target_kind: z.literal('snapshot'),
      matched_file_count: z.number().int().nonnegative(),
      files_sampled: z.number().int().nonnegative(),
      files_truncated: z.boolean(),
      path_scope: ReviewPathScope,
    })
    .strict(),
]);
export type ReviewEvidenceSummary = z.infer<typeof ReviewEvidenceSummary>;

/**
 * The Review target resolved from the operator's goal, persisted so every
 * downstream projection reads the same decision instead of re-parsing the
 * goal text. Re-parsing after the relay ran could refuse a Review that was
 * already paid for.
 */
export const ReviewResolvedTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('goal') }).strict(),
  z
    .object({
      kind: z.literal('working_tree'),
      mode: ReviewWorkingTreeMode,
      // False when Circuit assumed the working tree because the goal named no
      // target. The assumption is reported to the operator as a warning.
      explicit: z.boolean(),
      paths: ReviewPathScope.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('commit'),
      ref: z.string().min(1),
      paths: ReviewPathScope.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('range'),
      base: z.string().min(1),
      head: z.string().min(1),
      dots: z.enum(['..', '...']),
      paths: ReviewPathScope.optional(),
    })
    .strict(),
  // Code as it stands rather than a change to it. The paths are required for
  // the same reason the evidence requires them: a snapshot of everything is
  // more than one review can hold.
  z
    .object({
      kind: z.literal('snapshot'),
      paths: ReviewPathScope,
    })
    .strict(),
]);
export type ReviewResolvedTarget = z.infer<typeof ReviewResolvedTarget>;

/**
 * Where the resolved target came from. `named` means the caller said it, on the
 * command line or through the host. `inferred` means it was recovered from the
 * goal prose by phrase matching.
 *
 * Required, not optional, and deliberately: every intake has a provenance, and
 * an absent field would read as "named" to anyone skimming. The distinction is
 * the point. A guess and a fact are equally definite once resolved, so without
 * this the report cannot tell the operator which one it is holding.
 */
export const ReviewTargetProvenance = z.enum(['named', 'inferred']);
export type ReviewTargetProvenance = z.infer<typeof ReviewTargetProvenance>;

/**
 * One reviewable unit: the whole of what a single reviewer is shown.
 *
 * Review's reviewer is sealed from the repository, so a unit is not a pointer
 * to code — it carries the code. Most targets are one unit, because a diff or a
 * handful of files fits in one prompt. A whole codebase does not, so it becomes
 * several, and the audit step runs one reviewer per unit.
 *
 * `unit_id` doubles as the fan-out branch id, which is why it is a slug rather
 * than free text.
 */
export const ReviewIntakeUnit = z
  .object({
    unit_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
      message: 'unit_id must be a kebab-case slug',
    }),
    // What a person would call this unit, for the report and the operator view.
    label: z.string().min(1),
    // Repository-relative paths this unit covers. Empty when the unit is a
    // change rather than a set of files, which is the ordinary single-unit case.
    paths: z.array(z.string().min(1)),
    // What this unit's reviewer is asked to do. Carried per unit because a
    // codebase reviewer needs to be told which slice it holds and that other
    // slices exist.
    goal: z.string().min(1),
    // The evidence itself, verbatim. The engine writes this text into the
    // reviewer's branch folder and reads it back, so the reviewer sees this
    // unit and nothing else.
    contents: z.string().min(1),
  })
  .strict();
export type ReviewIntakeUnit = z.infer<typeof ReviewIntakeUnit>;

/**
 * How much of the target the units actually account for.
 *
 * A split review can be honest only if the close step can say what it covered.
 * Every target reports this, so nothing downstream has to infer coverage from
 * the shape of the evidence.
 */
export const ReviewUnitCoverage = z
  .object({
    // Files the target matched before any bound applied.
    matched_file_count: z.number().int().nonnegative(),
    // Files the units actually carry.
    reviewed_file_count: z.number().int().nonnegative(),
    // True when the target was larger than Review could pack into units, so
    // some of it was left out. A verdict over a truncated target may not claim
    // to have reviewed the whole thing.
    truncated: z.boolean(),
  })
  .strict();
export type ReviewUnitCoverage = z.infer<typeof ReviewUnitCoverage>;

export const ReviewIntake = z
  .object({
    scope: z.string().min(1),
    target: ReviewResolvedTarget,
    target_provenance: ReviewTargetProvenance,
    evidence: ReviewEvidence,
    evidence_warnings: z.array(ReviewEvidenceWarning).default([]),
    // Always present and never empty: an intake that framed a review but named
    // no unit would be an intake that captured nothing for the reviewer to read.
    units: z.array(ReviewIntakeUnit).min(1),
    unit_coverage: ReviewUnitCoverage,
  })
  .strict();
export type ReviewIntake = z.infer<typeof ReviewIntake>;

export const ReviewFinding = z
  .object({
    severity: ReviewFindingSeverity,
    id: z.string().min(1),
    text: z.string().min(1),
    file_refs: z.array(z.string().min(1)),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export function computeReviewVerdict(
  findings: readonly { readonly severity: ReviewFindingSeverity }[],
): ReviewResultVerdict {
  // critical/high/medium block; low is informational. Industry convention:
  // a CLEAN verdict means "nothing the operator should act on before
  // shipping," and medium-severity findings warrant action.
  return findings.some((finding) => finding.severity !== 'low') ? 'ISSUES_FOUND' : 'CLEAN';
}

export const ReviewResult = z
  .object({
    scope: z.string().min(1),
    findings: z.array(ReviewFinding),
    verdict: ReviewResultVerdict,
    // Terminal run outcome bound to the verdict (launch blocker fix). Review
    // arms engineFlags.bindsTerminalOutcomeToPrimaryResult, so the engine reads
    // this field at close time and maps it onto the run outcome: an honest
    // ISSUES_FOUND verdict must close `stopped`, never a green `complete` over a
    // known defect. CLEAN → complete, ISSUES_FOUND → stopped (see the
    // superRefine below, which forces the two to agree).
    outcome: z.enum(['complete', 'stopped']),
    // Plain-language paragraph from the reviewer: what was checked and what
    // they concluded. Required even on a CLEAN verdict so a no-findings result
    // does not collapse to "Findings: 0" without context. The operator-summary
    // renderer reads this when the projection has no findings to list.
    assessment: z.string().min(1),
    // Concrete verification steps the reviewer performed: files inspected,
    // commands run, evidence cross-referenced. Empty array is permitted but
    // discouraged — the prompt asks the reviewer to name at least one step.
    verification: z.array(z.string().min(1)),
    // Known gaps that limit certainty (out-of-scope files, untracked content
    // omitted, missing context). Empty array is permitted when the reviewer
    // had complete coverage; the operator-summary renderer surfaces non-empty
    // entries so a CLEAN verdict cannot quietly stand in for "high confidence".
    confidence_limitations: z.array(z.string().min(1)),
    evidence_summary: ReviewEvidenceSummary.optional(),
    evidence_warnings: z.array(ReviewEvidenceWarning).default([]),
  })
  .strict()
  .superRefine((report, ctx) => {
    const expected = computeReviewVerdict(report.findings);
    if (report.verdict !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['verdict'],
        message: `verdict must be ${expected} for the report findings (CLEAN iff every finding is severity low)`,
      });
    }
    // The terminal outcome must agree with the verdict so the engine's
    // primary-result bind cannot report a green run over a blocking finding.
    const expectedOutcome = report.verdict === 'CLEAN' ? 'complete' : 'stopped';
    if (report.outcome !== expectedOutcome) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: `outcome must be ${expectedOutcome} for verdict ${report.verdict} (CLEAN → complete, ISSUES_FOUND → stopped)`,
      });
    }
  });
export type ReviewResult = z.infer<typeof ReviewResult>;

const ReviewRelayResultShape = z
  .object({
    verdict: ReviewRelayVerdict,
    findings: z.array(ReviewFinding),
    // See ReviewResult.assessment — the reviewer's plain-language paragraph
    // describing what was checked and what they concluded. Required for both
    // NO_ISSUES_FOUND and ISSUES_FOUND verdicts: a clean output without an
    // assessment is the regression that motivated this addition (vanilla
    // Claude Code says what it checked even on a no-findings review; Circuit
    // used to collapse to "Findings: 0").
    assessment: z.string().min(1),
    // Concrete verification steps the reviewer performed (files, commands,
    // evidence). Required as an array; the relay prompt asks for at least
    // one entry.
    verification: z.array(z.string().min(1)),
    // Known gaps that limit certainty. Required as an array (may be empty
    // when coverage was complete).
    confidence_limitations: z.array(z.string().min(1)),
  })
  .strict();

// Derive the verdict from the findings rather than rejecting a reviewer that
// picked the wrong word for its own answer. The findings are the substance;
// the verdict is a one-word label over them, and `projectReviewResult`
// already recomputes the operator-facing verdict from the findings list.
// Rejecting instead would return failureKind 'schema' from the relay
// executor, which retries once and then closes the run `evidence_invalid` —
// a whole review of real defects thrown away over a mislabel.
function withDerivedRelayVerdict<T extends { readonly findings: readonly unknown[] }>(
  report: T,
): T & { verdict: z.infer<typeof ReviewRelayVerdict> } {
  return {
    ...report,
    verdict: report.findings.length === 0 ? 'NO_ISSUES_FOUND' : 'ISSUES_FOUND',
  };
}

export const ReviewRelayResult = ReviewRelayResultShape.transform(withDerivedRelayVerdict);
export type ReviewRelayResult = z.infer<typeof ReviewRelayResult>;

/**
 * One unit's reviewer response.
 *
 * Identical to a whole-target review except that it names the unit it was
 * assigned. The audit step checks that name against the branch it dispatched,
 * so a reviewer cannot report on a slice it was not given, and the close step
 * can attribute every finding to the unit it came from.
 */
export const ReviewUnitVerdict = ReviewRelayResultShape.extend({
  unit_id: z.string().min(1),
})
  .strict()
  .transform(withDerivedRelayVerdict);
export type ReviewUnitVerdict = z.infer<typeof ReviewUnitVerdict>;

/**
 * The fan-out aggregate the engine writes after joining the audit's branches.
 *
 * The close step reads this one file rather than each branch report: it carries
 * every unit's verdict body plus, for units whose reviewer never produced one,
 * the fact that it did not. That second half is what makes an honest partial
 * close possible.
 */
export const ReviewAuditAggregateBranch = z
  .object({
    branch_id: z.string().min(1),
    child_run_id: z.string().min(1),
    child_outcome: z.enum(['complete', 'aborted', 'handoff', 'stopped', 'escalated']),
    verdict: z.string().min(1),
    admitted: z.boolean(),
    result_path: z.string().min(1),
    duration_ms: z.number().nonnegative(),
    result_body: ReviewUnitVerdict.optional(),
  })
  .strict();
export type ReviewAuditAggregateBranch = z.infer<typeof ReviewAuditAggregateBranch>;

export const ReviewAuditAggregate = z
  .object({
    schema_version: z.literal(1),
    join_policy: z.literal('aggregate-any'),
    branch_count: z.number().int().positive(),
    branches: z.array(ReviewAuditAggregateBranch).min(1),
  })
  .strict()
  .superRefine((aggregate, ctx) => {
    if (aggregate.branch_count !== aggregate.branches.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['branch_count'],
        message: 'branch_count must match branches.length',
      });
    }
  });
export type ReviewAuditAggregate = z.infer<typeof ReviewAuditAggregate>;
