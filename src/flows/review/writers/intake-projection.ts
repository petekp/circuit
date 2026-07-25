import { ReviewIntake } from '../reports.js';
import type {
  ReviewEvidence,
  ReviewEvidenceWarning,
  ReviewPathScope,
  ReviewResolvedTarget,
} from '../reports.js';
import { containsOpaqueSubmoduleChange, opaqueBinaryChangePaths } from './evidence-completeness.js';

export type ReviewIntakeProjectorInputs = {
  readonly scope: string;
  readonly target: ReviewResolvedTarget;
  readonly evidence: ReviewEvidence;
  readonly maxUntrackedFiles: number;
  readonly assumedTarget?: boolean;
  readonly scopeNotApplied?: readonly string[];
  // The change target the operator named turned out to be empty at those
  // paths, so Review read the current contents instead. Named out loud,
  // because "no findings" means something different for each.
  readonly snapshotFallbackFrom?: string;
  // The operator asked about the repository as a whole. Review covered the
  // changes in it, which is less than that, so the difference is reported.
  readonly wholeRepository?: boolean;
  // The operator asked for the code as it stands with nowhere named to look.
  readonly snapshotNotApplied?: boolean;
};

/**
 * Named assumption text for D1: an unrecognised goal reviews the working tree
 * rather than refusing, and says so out loud.
 */
export const ASSUMED_WORKING_TREE_WARNING =
  'Assumed target: the current working tree. Name a commit, a range, staged, or unstaged to review something else.';

/**
 * The operator named the repository as the subject and Review covered the
 * changes in it instead. Says what was covered, says what was not, and names
 * the one thing that does read code rather than a diff, because otherwise the
 * only way to learn that is to find out afterwards.
 */
export const WHOLE_REPOSITORY_NARROWED_WARNING =
  'You asked about the whole repository. Review covered the changes in it, not every file: reading a whole codebase in one pass is not something it can do yet. Name a path to review the code there as it stands, such as "review src/auth as it stands".';

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
  readonly assumedTarget?: boolean;
  readonly scopeNotApplied?: readonly string[];
  readonly snapshotFallbackFrom?: string;
  readonly wholeRepository?: boolean;
  readonly snapshotNotApplied?: boolean;
}): ReviewEvidenceWarning[] {
  const assumption: readonly ReviewEvidenceWarning[] = [
    // These two describe the same working tree and must never both appear. One
    // says the operator named no target, the other says they named one Review
    // cannot fully cover, and only one of those can be true of a given goal.
    ...(input.wholeRepository === true
      ? [
          {
            kind: 'whole_repository_narrowed' as const,
            message: WHOLE_REPOSITORY_NARROWED_WARNING,
          },
        ]
      : input.assumedTarget === true
        ? [{ kind: 'target_assumed' as const, message: ASSUMED_WORKING_TREE_WARNING }]
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
        message: `${reviewPathScopePaths(evidence.path_scope)} matched ${evidence.matched_file_count} files. Review read ${evidence.files.length} of them and did not inspect the rest.`,
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

export function projectReviewIntake(input: ReviewIntakeProjectorInputs): ReviewIntake {
  return ReviewIntake.parse({
    scope: input.scope,
    target: input.target,
    evidence: input.evidence,
    evidence_warnings: reviewEvidenceWarnings({
      evidence: input.evidence,
      maxUntrackedFiles: input.maxUntrackedFiles,
      ...(input.assumedTarget === true ? { assumedTarget: true } : {}),
      ...(input.scopeNotApplied === undefined ? {} : { scopeNotApplied: input.scopeNotApplied }),
      ...(input.snapshotFallbackFrom === undefined
        ? {}
        : { snapshotFallbackFrom: input.snapshotFallbackFrom }),
      ...(input.wholeRepository === true ? { wholeRepository: true } : {}),
      ...(input.snapshotNotApplied === true ? { snapshotNotApplied: true } : {}),
    }),
  });
}
