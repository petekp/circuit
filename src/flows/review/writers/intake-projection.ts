import { ReviewIntake, reviewEvidenceWarningLabel } from '../reports.js';
import type {
  ReviewEvidence,
  ReviewEvidenceWarning,
  ReviewIntakeUnit,
  ReviewPathScope,
  ReviewResolvedTarget,
  ReviewTargetProvenance,
  ReviewUnitCoverage,
} from '../reports.js';
import { containsOpaqueSubmoduleChange, opaqueBinaryChangePaths } from './evidence-completeness.js';
import { packReviewUnits } from './units.js';

export type ReviewIntakeProjectorInputs = {
  readonly scope: string;
  readonly target: ReviewResolvedTarget;
  readonly targetProvenance: ReviewTargetProvenance;
  readonly evidence: ReviewEvidence;
  readonly maxUntrackedFiles: number;
  readonly assumedTarget?: boolean;
  readonly scopeNotApplied?: readonly string[];
  // The change target the operator named turned out to be empty at those
  // paths, so Review read the current contents instead. Named out loud,
  // because "no findings" means something different for each.
  readonly snapshotFallbackFrom?: string;
  // The operator asked for the code as it stands with nowhere named to look.
  readonly snapshotNotApplied?: boolean;
  // A target too large for one reviewer, already split. Absent for every target
  // that fits in one prompt, which is most of them.
  readonly units?: readonly ReviewIntakeUnit[];
  readonly unitCoverage?: ReviewUnitCoverage;
};

/**
 * Named assumption text for D1: an unrecognised goal reviews the working tree
 * rather than refusing, and says so out loud.
 */
export const ASSUMED_WORKING_TREE_WARNING =
  'Assumed target: the current working tree. Name a commit, a range, staged, or unstaged to review something else.';

/**
 * Nobody named a target, so one was read out of the goal text. The wording has
 * to carry two things at once: what Review decided, and the fact that deciding
 * it was Review's doing rather than the operator's. "Matched" is the honest
 * verb — phrase matching is what happened, and it is right about most goals and
 * silently wrong about the rest.
 */
export const TARGET_INFERRED_WARNING =
  'No target was named, so Review matched one out of the goal text. It is reviewing what that matched, which may not be what you meant. Pass --target to say it outright, such as --target main...HEAD, --target staged, or --target commit:abc1234.';

/**
 * The snapshot phrasing was understood and not honoured. The reason is the
 * missing bound, so the fix is to supply one, and the message says which.
 */
export const SNAPSHOT_NOT_APPLIED_WARNING =
  'You asked about the code as it stands, and Review read changes instead. Reading files rather than a diff needs a path to bound it. Name one, such as "review src/auth as it stands".';

/** Plain-language rendering of a path scope, for operator-facing messages. */
export function reviewPathScopeLabel(scope: ReviewPathScope): string {
  return [
    ...(scope.include.length > 0 ? [`limited to ${scope.include.join(', ')}`] : []),
    ...(scope.exclude.length > 0 ? [`excluding ${scope.exclude.join(', ')}`] : []),
  ].join(' and ');
}

/**
 * The same scope written as a bare path list, for sentences that already supply
 * their own verb. `reviewPathScopeLabel` starts with "limited to", which reads
 * wrong in the middle of a sentence.
 */
export function reviewPathScopePaths(scope: ReviewPathScope): string {
  const included = scope.include.length > 0 ? scope.include.join(', ') : 'the repository';
  return scope.exclude.length > 0 ? `${included} excluding ${scope.exclude.join(', ')}` : included;
}

function pathScopeOf(evidence: ReviewEvidence): ReviewPathScope | undefined {
  if (
    evidence.kind === 'git-working-tree' ||
    evidence.kind === 'git-target' ||
    evidence.kind === 'git-snapshot'
  ) {
    return evidence.path_scope;
  }
  return undefined;
}

/**
 * Two scope warnings, and they say opposite things on purpose. `target_scoped`
 * reports a narrowing that *was* applied, so a reader knows the review covers
 * less than the target name suggests. `scope_not_applied` reports one that was
 * asked for and could not be, so a wider review is never mistaken for the
 * requested one.
 */
function scopeWarnings(input: {
  readonly evidence: ReviewEvidence;
  readonly scopeNotApplied?: readonly string[];
  readonly snapshotFallbackFrom?: string;
}): ReviewEvidenceWarning[] {
  const warnings: ReviewEvidenceWarning[] = [];
  if (input.snapshotFallbackFrom !== undefined) {
    warnings.push({
      kind: 'snapshot_fallback',
      message: `Nothing has changed in ${input.snapshotFallbackFrom}, so Review read the code as it stands instead of a diff. The findings are about the current state, not about a change.`,
    });
  }
  const scope = pathScopeOf(input.evidence);
  if (scope !== undefined) {
    warnings.push({
      kind: 'target_scoped',
      message:
        input.evidence.kind === 'git-snapshot'
          ? `Review read the current contents of ${reviewPathScopePaths(scope)}. Nothing outside those paths was read.`
          : `Review was ${reviewPathScopeLabel(scope)}. Changes outside those paths were not read.`,
    });
  }
  for (const phrase of input.scopeNotApplied ?? []) {
    warnings.push({
      kind: 'scope_not_applied',
      message: `Review could not narrow the target to "${phrase}", so it reviewed the whole target instead.`,
    });
  }
  return warnings;
}

function gitCommandFailed(text: string): boolean {
  return /^git\s+.+\s+failed:/.test(text);
}

function targetUnavailable(text: string): boolean {
  return gitCommandFailed(text) || text.startsWith('Target unavailable:');
}

function hasUsableTargetDiff(diff: { readonly text: string } | undefined): boolean {
  return diff !== undefined && diff.text.length > 0 && !targetUnavailable(diff.text);
}

function appendOpaqueBinaryWarnings(
  warnings: ReviewEvidenceWarning[],
  diffs: ReadonlyArray<{ readonly text: string } | undefined>,
): void {
  const paths = new Set(diffs.flatMap((diff) => opaqueBinaryChangePaths(diff)));
  for (const path of paths) {
    warnings.push({
      kind: 'binary_content_not_inspected',
      path,
      message: `binary file content was not inspected: ${path}`,
    });
  }
}

export function reviewEvidenceWarnings(input: {
  readonly evidence: ReviewEvidence;
  readonly maxUntrackedFiles: number;
  readonly targetProvenance?: ReviewTargetProvenance;
  readonly assumedTarget?: boolean;
  readonly scopeNotApplied?: readonly string[];
  readonly snapshotFallbackFrom?: string;
  readonly snapshotNotApplied?: boolean;
}): ReviewEvidenceWarning[] {
  const targetDisclosed = input.assumedTarget === true;
  // Supplied material is the third way a target gets settled, and it is not an
  // inference at all: the operator pasted the thing to review, so the goal text
  // IS the subject rather than a description of one somewhere in Git. The
  // intake writer already records that case as named, so this is a guard rather
  // than a live branch — but this function is exported and takes its provenance
  // as an argument, and the message it suppresses would be an outright false
  // statement about what Review did.
  const suppliedMaterial = input.evidence.kind === 'goal';
  const assumption: readonly ReviewEvidenceWarning[] = [
    ...(input.assumedTarget === true
      ? [{ kind: 'target_assumed' as const, message: ASSUMED_WORKING_TREE_WARNING }]
      : []),
    // Third member of the same family, and the one that covers the case the
    // other two miss: a phrase matched, so the target looks chosen. Suppressed
    // when either of the above fired, because both already say the target was
    // not the operator's, and saying it twice reads as two separate problems.
    ...(input.targetProvenance === 'inferred' && !targetDisclosed && !suppliedMaterial
      ? [{ kind: 'target_inferred' as const, message: TARGET_INFERRED_WARNING }]
      : []),
    // Independent of the above: a goal can name the repository and also ask for
    // the code as it stands, and both go unmet for different reasons.
    ...(input.snapshotNotApplied === true
      ? [{ kind: 'snapshot_not_applied' as const, message: SNAPSHOT_NOT_APPLIED_WARNING }]
      : []),
    ...scopeWarnings({
      evidence: input.evidence,
      ...(input.scopeNotApplied === undefined ? {} : { scopeNotApplied: input.scopeNotApplied }),
      ...(input.snapshotFallbackFrom === undefined
        ? {}
        : { snapshotFallbackFrom: input.snapshotFallbackFrom }),
    }),
  ];
  if (input.evidence.kind === 'goal') return [...assumption];
  if (input.evidence.kind === 'unavailable') {
    return [
      ...assumption,
      {
        kind: 'evidence_unavailable',
        message: input.evidence.reason,
      },
    ];
  }

  if (input.evidence.kind === 'git-target') {
    const evidence = input.evidence;
    const warnings: ReviewEvidenceWarning[] = [...assumption];
    if (evidence.target_diff.truncated) {
      warnings.push({
        kind: 'diff_truncated',
        message: `${evidence.target_ref} diff was truncated before relay`,
      });
    }
    if (!hasUsableTargetDiff(evidence.target_diff)) {
      warnings.push({
        kind: 'target_unavailable',
        message:
          evidence.target_diff.text.length > 0
            ? evidence.target_diff.text
            : `Target unavailable: ${evidence.target_ref} produced an empty diff.`,
      });
    }
    if (targetUnavailable(evidence.target_diff_stat)) {
      warnings.push({
        kind: 'target_unavailable',
        message: evidence.target_diff_stat,
      });
    }
    if (containsOpaqueSubmoduleChange(evidence.target_diff)) {
      warnings.push({
        kind: 'submodule_content_not_inspected',
        message: 'nested submodule source content was not inspected',
      });
    }
    appendOpaqueBinaryWarnings(warnings, [evidence.target_diff]);
    return warnings;
  }

  if (input.evidence.kind === 'git-snapshot') {
    const evidence = input.evidence;
    const warnings: ReviewEvidenceWarning[] = [...assumption];
    if (evidence.files_truncated || evidence.matched_file_count > evidence.files.length) {
      warnings.push({
        kind: 'snapshot_truncated',
        // Naming the ordering matters as much as the count. Without it a
        // reader who sees source in the evidence and none of the docs would
        // conclude the tree has no docs, when what happened is that the budget
        // was spent on source first on purpose.
        message: `${reviewPathScopePaths(evidence.path_scope)} matched ${evidence.matched_file_count} files. Review read ${evidence.files.length} of them, ordered by review value so source comes before prose and before generated output, and did not inspect the rest.`,
      });
    }
    for (const file of evidence.files) {
      if (file.content?.truncated === true) {
        warnings.push({
          kind: 'diff_truncated',
          path: file.path,
          message: `file content was truncated before relay: ${file.path}`,
        });
      }
      if (file.skipped_reason !== undefined) {
        warnings.push({
          kind: 'snapshot_file_skipped',
          path: file.path,
          message: `${file.path} was not inspected: ${file.skipped_reason}`,
        });
      }
    }
    if (!evidence.files.some((file) => (file.content?.text.length ?? 0) > 0)) {
      warnings.push({
        kind: 'scope_empty',
        message: `Review found no readable file contents at ${reviewPathScopePaths(evidence.path_scope)}.`,
      });
    }
    return warnings;
  }

  const warnings: ReviewEvidenceWarning[] = [...assumption];
  const evidence = input.evidence;
  for (const path of evidence.submodule_paths ?? []) {
    warnings.push({
      kind: 'submodule_content_not_inspected',
      path,
      message: 'nested submodule source content was not inspected',
    });
  }
  const hasUntrackedContent = evidence.untracked_files.some((file) => file.content !== undefined);
  const workingTreeMode = evidence.target_mode;
  const selectedDiffs =
    workingTreeMode === 'staged'
      ? [evidence.staged_diff]
      : workingTreeMode === 'unstaged'
        ? [evidence.unstaged_diff]
        : [evidence.staged_diff, evidence.unstaged_diff];
  if (
    !warnings.some((warning) => warning.kind === 'submodule_content_not_inspected') &&
    selectedDiffs.some(containsOpaqueSubmoduleChange)
  ) {
    warnings.push({
      kind: 'submodule_content_not_inspected',
      message: 'nested submodule source content was not inspected',
    });
  }
  appendOpaqueBinaryWarnings(warnings, selectedDiffs);
  const hasSelectedTrackedDiff =
    workingTreeMode === 'staged'
      ? evidence.staged_diff.text.length > 0
      : workingTreeMode === 'unstaged'
        ? evidence.unstaged_diff.text.length > 0
        : evidence.staged_diff.text.length > 0 || evidence.unstaged_diff.text.length > 0;
  const hasSelectedUntrackedContent = workingTreeMode === 'all' && hasUntrackedContent;
  if (
    !hasSelectedTrackedDiff &&
    !hasSelectedUntrackedContent &&
    !gitCommandFailed(evidence.staged_diff.text) &&
    !gitCommandFailed(evidence.unstaged_diff.text)
  ) {
    warnings.push({
      kind: 'scope_empty',
      message:
        'review scoped to uncommitted changes only; HEAD~1 differences not examined. The reviewer had no source content to inspect: staged/unstaged diffs were empty and no untracked file content was relayed.',
    });
  }
  if (workingTreeMode !== 'unstaged' && evidence.staged_diff.truncated) {
    warnings.push({
      kind: 'diff_truncated',
      message: 'staged diff was truncated before relay',
    });
  }
  if (workingTreeMode !== 'staged' && evidence.unstaged_diff.truncated) {
    warnings.push({
      kind: 'diff_truncated',
      message: 'unstaged diff was truncated before relay',
    });
  }
  if (gitCommandFailed(evidence.staged_diff.text)) {
    warnings.push({
      kind: 'git_command_failed',
      message: evidence.staged_diff.text,
    });
  }
  if (gitCommandFailed(evidence.unstaged_diff.text)) {
    warnings.push({
      kind: 'git_command_failed',
      message: evidence.unstaged_diff.text,
    });
  }
  if (gitCommandFailed(evidence.diff_stat)) {
    warnings.push({
      kind: 'git_command_failed',
      message: evidence.diff_stat,
    });
  }
  if (workingTreeMode === 'all' && evidence.untracked_files_truncated) {
    warnings.push({
      kind: 'untracked_files_truncated',
      message: `untracked file evidence was limited to ${input.maxUntrackedFiles} files`,
    });
  }
  if (evidence.untracked_content_policy === 'metadata-only' && evidence.untracked_file_count > 0) {
    warnings.push({
      kind: 'untracked_file_content_omitted',
      message:
        'untracked file contents were not included; pass --include-untracked-content only when those files are safe to relay',
    });
  }
  for (const file of workingTreeMode === 'all' ? evidence.untracked_files : []) {
    if (file.content?.truncated === true) {
      warnings.push({
        kind: 'diff_truncated',
        path: file.path,
        message: `untracked file content was truncated before relay: ${file.path}`,
      });
    }
    if (file.skipped_reason !== undefined) {
      warnings.push({
        kind: 'untracked_file_skipped',
        path: file.path,
        message: file.skipped_reason,
      });
    }
  }
  return warnings;
}

/** How a single-unit target describes itself in the unit list. */
function singleUnitLabel(target: ReviewResolvedTarget): string {
  if (target.kind === 'goal') return 'the material in the goal';
  if (target.kind === 'commit') return `commit ${target.ref}`;
  if (target.kind === 'range') return `range ${target.base}${target.dots}${target.head}`;
  if (target.kind === 'snapshot') return reviewPathScopeLabel(target.paths);
  return target.mode === 'all' ? 'the working tree' : `${target.mode} changes`;
}

/**
 * File counts behind the coverage line.
 *
 * Only a snapshot reviews a file set, so only a snapshot can leave files out.
 * A diff target reports zero of both: the question "how many files did you
 * cover" is not one a change review answers, and reporting a made-up number
 * would be worse than reporting none.
 */
function singleUnitCoverage(evidence: ReviewEvidence): {
  matched_file_count: number;
  reviewed_file_count: number;
  truncated: boolean;
} {
  if (evidence.kind !== 'git-snapshot') {
    return { matched_file_count: 0, reviewed_file_count: 0, truncated: false };
  }
  return {
    matched_file_count: evidence.matched_file_count,
    reviewed_file_count: evidence.files.length,
    truncated: evidence.files_truncated,
  };
}

/**
 * What one reviewer is asked to hold.
 *
 * The bound is the reviewer's prompt, not the repository: 60k characters of
 * source is a large but readable slice, and a dozen files is about as many as
 * one review can speak to specifically. A tree bigger than one unit becomes
 * more units rather than a bigger prompt.
 */
export const CODEBASE_UNIT_BUDGET = { maxFilesPerUnit: 12, maxCharsPerUnit: 60_000 } as const;

/**
 * How many units the audit step can actually review.
 *
 * This has to equal `max_branches` on the audit fan-out. The engine treats a
 * dynamic fan-out that expands past `max_branches` as a hard error and throws,
 * so a packer free to emit more units than the flow declares does not degrade —
 * it kills the run after the intake has already succeeded.
 *
 * Packing cannot be assumed to reach the budget. Units are flushed at directory
 * boundaries, so an ordinary tree of many small directories yields units well
 * under 12 files, and the count is set by how the tree is shaped rather than by
 * how much text it holds. Circuit's own `src/` packs to 35 units at 1.44M
 * characters, where perfect packing would be 24. Deriving the file and
 * character caps from 24 x the unit budget was arithmetic that only held for a
 * tree that packs perfectly, and no real one does.
 *
 * See `tests/unit/review-projections.test.ts` for the test that keeps this
 * equal to the schematic.
 */
export const MAX_REVIEW_UNITS = 24;

/**
 * Pack a snapshot's files into units, or return undefined for a target that is
 * not a file set.
 *
 * Each unit's contents is an intake body with the evidence narrowed to that
 * unit's files. Keeping the shape identical to the whole-target body is what
 * lets one reviewer prompt serve both cases: the reviewer reads the same
 * structure whether it holds the entire target or a twelfth of it.
 */
/**
 * Warnings as a reviewer should see them: a plain-English limitation and the
 * message, with the runtime `kind` tag left behind.
 *
 * A reviewer writes prose an operator reads, so anything in its prompt is
 * something it can quote. One of them quoted `diff_truncated` straight into a
 * finding. The typed kind stays on the intake for the writers that branch on
 * it; only the prompt copy is translated.
 */
function promptWarnings(
  warnings: readonly ReviewEvidenceWarning[],
): ReadonlyArray<Record<string, string>> {
  return warnings.map((warning) => ({
    limitation: reviewEvidenceWarningLabel(warning.kind),
    ...(warning.path === undefined ? {} : { path: warning.path }),
    message: warning.message,
  }));
}

function snapshotUnits(
  scope: string,
  evidence: ReviewEvidence,
  body: { readonly evidence_warnings: readonly ReviewEvidenceWarning[] } & Record<string, unknown>,
): { units: readonly ReviewIntakeUnit[]; coverage: ReviewUnitCoverage } | undefined {
  if (evidence.kind !== 'git-snapshot') return undefined;
  const allPacked = packReviewUnits(
    evidence.files.map((file) => ({ path: file.path, size: file.content?.text.length ?? 0 })),
    CODEBASE_UNIT_BUDGET,
  );
  if (allPacked.length === 0) return undefined;
  // More units than there are reviewers to run them. Keep what can actually be
  // reviewed and let the count of files it covers carry the rest: a short
  // review that says how far it got is worth having, and the alternative here
  // is the engine throwing on expansion and the operator getting nothing.
  const packed = allPacked.slice(0, MAX_REVIEW_UNITS);
  const reviewedPaths = new Set(packed.flatMap((unit) => unit.paths));
  const coverage = {
    matched_file_count: evidence.matched_file_count,
    reviewed_file_count: reviewedPaths.size,
    truncated: evidence.files_truncated || packed.length < allPacked.length,
  };
  const byPath = new Map(evidence.files.map((file) => [file.path, file]));
  const allWarnings = body.evidence_warnings;
  const units = packed.map((unit) => {
    const files = unit.paths
      .map((path) => byPath.get(path))
      .filter((file): file is (typeof evidence.files)[number] => file !== undefined);
    // A warning that names a file belongs only to the unit holding that file.
    // Handing every reviewer the whole target's warnings made them hedge their
    // verdicts over files they were never given, which is the opposite of what
    // the warnings are for. Warnings with no path describe the target as a
    // whole and stay on every unit. The intake keeps the full list either way,
    // so nothing is lost to the merge step or the operator report.
    const held = new Set(unit.paths);
    const warnings = allWarnings.filter(
      (warning) => warning.path === undefined || held.has(warning.path),
    );
    return {
      unit_id: unit.unit_id,
      label: unit.label,
      paths: [...unit.paths],
      // Tell the reviewer what it is holding and what it is not. A reviewer
      // that thinks a twelfth of a repository is the whole thing will write a
      // conclusion about the whole thing, which is the failure this split
      // exists to avoid.
      goal:
        packed.length === 1
          ? `${scope} (You are reviewing unit ${unit.unit_id}, ${unit.label}, which is the whole of this target. Report under unit_id "${unit.unit_id}".)`
          : `${scope} (You are reviewing unit ${unit.unit_id} of ${packed.length}: ${unit.label}, ${files.length} of the ${evidence.files.length} files in this target. Report under unit_id "${unit.unit_id}". The other units are being reviewed separately by other reviewers; you cannot see them, so review what is in this prompt and do not draw conclusions about the rest of the codebase.)`,
      contents: JSON.stringify(
        {
          ...body,
          evidence: { ...evidence, files },
          evidence_warnings: promptWarnings(warnings),
        },
        null,
        2,
      ),
    };
  });
  return { units, coverage };
}

export function projectReviewIntake(input: ReviewIntakeProjectorInputs): ReviewIntake {
  const body: {
    scope: string;
    target: ReviewIntakeProjectorInputs['target'];
    target_provenance: ReviewIntakeProjectorInputs['targetProvenance'];
    evidence: ReviewEvidence;
    evidence_warnings: readonly ReviewEvidenceWarning[];
  } = {
    scope: input.scope,
    target: input.target,
    target_provenance: input.targetProvenance,
    evidence: input.evidence,
    evidence_warnings: reviewEvidenceWarnings({
      evidence: input.evidence,
      maxUntrackedFiles: input.maxUntrackedFiles,
      targetProvenance: input.targetProvenance,
      ...(input.assumedTarget === true ? { assumedTarget: true } : {}),
      ...(input.scopeNotApplied === undefined ? {} : { scopeNotApplied: input.scopeNotApplied }),
      ...(input.snapshotFallbackFrom === undefined
        ? {}
        : { snapshotFallbackFrom: input.snapshotFallbackFrom }),
      ...(input.snapshotNotApplied === true ? { snapshotNotApplied: true } : {}),
    }),
  };
  // A snapshot is the one target that can outgrow a single prompt: it carries
  // whole files rather than a diff, and "review this codebase" is a snapshot of
  // everything. So a snapshot is packed into units and reviewed a unit at a
  // time. Every other target is one unit, carrying exactly the evidence bundle
  // a whole-target reviewer was always handed.
  const packedSnapshot =
    input.units === undefined ? snapshotUnits(input.scope, input.evidence, body) : undefined;
  const units = input.units ??
    packedSnapshot?.units ?? [
      {
        unit_id: 'unit-1',
        label: singleUnitLabel(input.target),
        paths: [],
        // The unit id travels in the goal because the goal is what the reviewer
        // is told to do, and it has to report under the id it was given. Saying
        // this unit is the whole target is what stops a reviewer from hedging
        // about parts it cannot see when there are none.
        goal: `${input.scope} (You are reviewing unit unit-1, ${singleUnitLabel(input.target)}, which is the whole of this target. Report under unit_id "unit-1".)`,
        contents: JSON.stringify(
          { ...body, evidence_warnings: promptWarnings(body.evidence_warnings) },
          null,
          2,
        ),
      },
    ];
  return ReviewIntake.parse({
    ...body,
    units,
    // A snapshot that packed past the reviewer count reports the files its
    // units actually carry, not everything the snapshot matched, so dropping
    // units cannot read as full coverage.
    unit_coverage:
      input.unitCoverage ?? packedSnapshot?.coverage ?? singleUnitCoverage(input.evidence),
  });
}
