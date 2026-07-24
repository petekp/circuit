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
};

/**
 * Named assumption text for D1: an unrecognised goal reviews the working tree
 * rather than refusing, and says so out loud.
 */
export const ASSUMED_WORKING_TREE_WARNING =
  'Assumed target: the current working tree. Name a commit, a range, staged, or unstaged to review something else.';

/** Plain-language rendering of a path scope, for operator-facing messages. */
export function reviewPathScopeLabel(scope: ReviewPathScope): string {
  return [
    ...(scope.include.length > 0 ? [`limited to ${scope.include.join(', ')}`] : []),
    ...(scope.exclude.length > 0 ? [`excluding ${scope.exclude.join(', ')}`] : []),
  ].join(' and ');
}

function pathScopeOf(evidence: ReviewEvidence): ReviewPathScope | undefined {
  if (evidence.kind === 'git-working-tree' || evidence.kind === 'git-target') {
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
}): ReviewEvidenceWarning[] {
  const warnings: ReviewEvidenceWarning[] = [];
  const scope = pathScopeOf(input.evidence);
  if (scope !== undefined) {
    warnings.push({
      kind: 'target_scoped',
      message: `Review was ${reviewPathScopeLabel(scope)}. Changes outside those paths were not read.`,
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
}): ReviewEvidenceWarning[] {
  const assumption: readonly ReviewEvidenceWarning[] = [
    ...(input.assumedTarget === true
      ? [{ kind: 'target_assumed' as const, message: ASSUMED_WORKING_TREE_WARNING }]
      : []),
    ...scopeWarnings(input),
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
    }),
  });
}
