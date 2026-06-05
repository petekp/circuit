// Fix baseline-snapshot writer.
//
// Runs immediately before fix-act. Snapshots the working tree's git state so
// the post-fix-verify change-set step has a reference point. The snapshot is
// what counts as "before the fix" — anything that becomes dirty between this
// snapshot and the change-set step is owned by fix-act.
//
// One command runs: `node src/flows/fix/writers/git-state.ts` from the
// project root. The helper wraps git rev-parse + git status (porcelain v1
// with -z and --untracked-files=all) + per-dirty-path `git hash-object` +
// `git ls-files -v` (for assume-unchanged / skip-worktree detection) and
// emits a single JSON document. We use a helper instead of letting the
// writer call git directly because the verification executor is limited to
// a fixed VerificationCommand list at loadCommands time, and we need a
// dynamic loop to fingerprint each dirty path.
//
// overall_status is always 'passed' — the snapshot's job is to record state,
// not to block routing. Failures (git missing, not a repo, etc.) abort via
// the runner's own error path because the helper exits non-zero.

import { fileURLToPath } from 'node:url';
import { RuntimeGitStateSnapshot } from '../../../schemas/runtime-evidence.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { FixBaselineSnapshot } from '../reports.js';

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_OUTPUT_BYTES = 5_000_000;

// Marketplace-safe by build-pipeline emission: git-state.ts runs as a
// child process, so it has to live as a real file on disk next to the
// bundled CLI. scripts/plugins/runtime-bundle.ts emits the helper as a
// sidecar to every bundle target (plugins/<host>/runtime/git-state.ts,
// dist/flows/fix/writers/git-state.ts) and --check mode fails if any
// sidecar is missing or drifts from src/. Sibling-of-bundle resolution
// is correct in every layout because the build pipeline puts a sibling
// there.
const GIT_STATE_HELPER_PATH = fileURLToPath(new URL('./git-state.ts', import.meta.url));

// Shape of the helper's stdout JSON. Validated before we trust it to build a
// FixBaselineSnapshot — a corrupt helper observation should fail fast with a
// clear message rather than silently passing incomplete state downstream.
const GitStateHelperOutput = RuntimeGitStateSnapshot;
export type GitStateHelperOutput = RuntimeGitStateSnapshot;

export function fixGitStateCommand(id: string): VerificationCommand {
  return {
    id,
    cwd: '.',
    argv: [process.execPath, GIT_STATE_HELPER_PATH],
    timeout_ms: GIT_TIMEOUT_MS,
    max_output_bytes: GIT_MAX_OUTPUT_BYTES,
    env: {},
  };
}

export function parseGitStateObservation(
  observation: VerificationCommandObservation,
  schemaName: string,
): GitStateHelperOutput {
  if (observation.status !== 'passed') {
    throw new Error(
      `${schemaName}: git-state helper failed (exit ${observation.exit_code}): ${observation.stderr_summary}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(observation.stdout_summary);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${schemaName}: git-state helper stdout was not valid JSON: ${reason}`);
  }
  return GitStateHelperOutput.parse(parsed);
}

export const fixBaselineSnapshotWriter: VerificationBuilder = {
  resultSchemaName: 'fix.baseline-snapshot@v1',
  loadCommands(_context: VerificationBuildContext): readonly VerificationCommand[] {
    return [fixGitStateCommand('fix-baseline-snapshot-git-state')];
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
