import type { GitStateHelperOutput } from '../../../shared/git-state-command.js';
import { projectRuntimeTouchedFiles } from '../../../shared/runtime-touched-files.js';
import {
  type FixBaselineSnapshot,
  type FixChange,
  FixChangeSet,
  type FixHiddenIndexFlag,
} from '../reports.js';

export type FixChangeSetProjectorInputs = {
  readonly baseline: FixBaselineSnapshot;
  readonly post: GitStateHelperOutput;
  readonly change: FixChange;
  readonly priorDeclaredPaths?: readonly string[];
  readonly ignoredPathPrefixes?: readonly string[];
};

function isIgnoredPath(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function projectFixChangeSet(inputs: FixChangeSetProjectorInputs): FixChangeSet {
  const ignoredPathPrefixes = inputs.ignoredPathPrefixes ?? [];
  // A review rework writes a fresh fix.change report containing the files from
  // that rework pass. Keep declarations from earlier accepted act attempts when
  // those paths still differ from the run baseline, while dropping paths a later
  // attempt intentionally restored. Latest-pass declarations remain unfiltered
  // so a fresh overclaim still fails as missing_declared.
  const observedBeforeClaims = projectRuntimeTouchedFiles({
    baseline: {
      head_sha: inputs.baseline.head_sha,
      entries: inputs.baseline.entries,
      hidden_index_flags: inputs.baseline.hidden_index_flags,
    },
    post: {
      head_sha: inputs.post.head_sha,
      entries: inputs.post.entries,
      hidden_index_flags: inputs.post.hidden_index_flags,
    },
    workerDeclaredPaths: [],
    ...(inputs.ignoredPathPrefixes === undefined
      ? {}
      : { ignoredPathPrefixes: inputs.ignoredPathPrefixes }),
  });
  const observedPaths = new Set(observedBeforeClaims.files.map((file) => file.path));
  const carriedDeclarations = (inputs.priorDeclaredPaths ?? []).filter((path) =>
    observedPaths.has(path),
  );
  const runtimeTouchedFiles = projectRuntimeTouchedFiles({
    baseline: {
      head_sha: inputs.baseline.head_sha,
      entries: inputs.baseline.entries,
      hidden_index_flags: inputs.baseline.hidden_index_flags,
    },
    post: {
      head_sha: inputs.post.head_sha,
      entries: inputs.post.entries,
      hidden_index_flags: inputs.post.hidden_index_flags,
    },
    workerDeclaredPaths: [...carriedDeclarations, ...inputs.change.changed_files],
    ...(inputs.ignoredPathPrefixes === undefined
      ? {}
      : { ignoredPathPrefixes: inputs.ignoredPathPrefixes }),
  });
  const postHiddenFlags = inputs.post.hidden_index_flags.filter(
    (flag) => !isIgnoredPath(flag.path, ignoredPathPrefixes),
  );
  const observed = runtimeTouchedFiles.files.map((file) => file.path);

  const headDiverged = runtimeTouchedFiles.head_diverged;
  const hiddenFlags: readonly FixHiddenIndexFlag[] = postHiddenFlags;
  const setsClean = runtimeTouchedFiles.worker_claim_matches_runtime;
  const status_: 'pass' | 'fail' =
    setsClean && !headDiverged && hiddenFlags.length === 0 ? 'pass' : 'fail';

  let reason: string | undefined;
  if (status_ === 'fail') {
    const parts: string[] = [];
    if (headDiverged) {
      parts.push(
        `HEAD moved during the fix run (baseline ${inputs.baseline.head_sha}, post ${inputs.post.head_sha}); the agent committed mid-run, which the change-set writer cannot reconcile against the declared file list.`,
      );
    }
    if (runtimeTouchedFiles.undeclared_worker_extras.length > 0) {
      parts.push(`undeclared extras: ${runtimeTouchedFiles.undeclared_worker_extras.join(', ')}`);
    }
    if (runtimeTouchedFiles.missing_worker_declared.length > 0) {
      parts.push(`missing declared: ${runtimeTouchedFiles.missing_worker_declared.join(', ')}`);
    }
    if (hiddenFlags.length > 0) {
      const labelled = hiddenFlags.map((flag) => `${flag.path} (${flag.tag})`).join(', ');
      parts.push(
        `hidden index flags present (assume-unchanged or skip-worktree paths can hide tracked edits from git status): ${labelled}`,
      );
    }
    reason = parts.join('; ');
  }

  return FixChangeSet.parse({
    status: status_,
    overall_status: status_ === 'pass' ? 'passed' : 'failed',
    ...(reason === undefined ? {} : { reason }),
    baseline_head_sha: runtimeTouchedFiles.baseline_head_sha,
    head_sha: runtimeTouchedFiles.head_sha,
    declared: runtimeTouchedFiles.worker_declared,
    observed,
    undeclared_extras: runtimeTouchedFiles.undeclared_worker_extras,
    missing_declared: runtimeTouchedFiles.missing_worker_declared,
    baseline_dirty_mutated: runtimeTouchedFiles.baseline_dirty_mutated,
    hidden_index_flags: [...hiddenFlags],
  });
}
