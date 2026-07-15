// Fix baseline-snapshot writer.
//
// Runs immediately before fix-act. Snapshots the working tree's git state so
// the post-fix-act change-set step has a reference point. The snapshot is
// what counts as "before the fix" — anything that becomes dirty between this
// snapshot and the change-set step is owned by fix-act.
//
// One command runs: the shared git-state helper (src/shared/git-state.ts,
// invoked via src/shared/git-state-command.ts). The helper wraps git
// rev-parse + git status (porcelain v1 with -z and --untracked-files=all) +
// per-dirty-path `git hash-object` + `git ls-files -v` (for assume-unchanged
// / skip-worktree detection) and emits a single JSON document. We use a
// helper instead of letting the writer call git directly because the
// verification executor is limited to a fixed VerificationCommand list at
// loadCommands time, and we need a dynamic loop to fingerprint each dirty
// path.
//
// overall_status is always 'passed' — the snapshot's job is to record state,
// not to block routing. Failures (git missing, not a repo, etc.) abort via
// the runner's own error path because the helper exits non-zero.

import { gitStateCommand, parseGitStateObservation } from '../../../shared/git-state-command.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { FixBaselineSnapshot } from '../reports.js';

export const fixBaselineSnapshotWriter: VerificationBuilder = {
  resultSchemaName: 'fix.baseline-snapshot@v1',
  loadCommands(_context: VerificationBuildContext): readonly VerificationCommand[] {
    return [gitStateCommand('fix-baseline-snapshot-git-state')];
  },
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    if (observations.length !== 1) {
      throw new Error(
        `fix.baseline-snapshot@v1: expected 1 git-state observation, got ${observations.length}`,
      );
    }
    const observation = observations[0];
    if (observation === undefined) {
      throw new Error('fix.baseline-snapshot@v1: git-state observation missing');
    }
    const state = parseGitStateObservation(observation, 'fix.baseline-snapshot@v1');
    return FixBaselineSnapshot.parse({
      overall_status: 'passed',
      head_sha: state.head_sha,
      entries: state.entries,
      hidden_index_flags: state.hidden_index_flags,
    });
  },
};
