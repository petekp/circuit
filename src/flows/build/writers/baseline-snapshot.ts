// Build baseline-snapshot writer.
//
// Runs once before act-step (and, under deep rigor, before the first slice).
// Snapshots the working tree's git state so the post-verify touch-area step has
// a reference point: anything that becomes dirty between this snapshot and the
// touch-area step is owned by the implementer, which is what the touch-area gate
// checks against the declared allowed area.
//
// Opt-in: the snapshot only runs git when the plan declares an
// allowed_touch_area. With no declared area there is nothing to enforce, so the
// step records the inert `captured: false` baseline and shells out to nothing —
// a Build run that never opted into the gate carries no git dependency at all,
// exactly as before the gate existed.
//
// When the gate is on, one command runs the git-state helper (git rev-parse +
// git status porcelain v1 -z --untracked-files=all + per-dirty-path `git
// hash-object` + git ls-files -v for assume-unchanged / skip-worktree
// detection), emitting a single JSON document. The helper is a Build-local
// byte-identical copy of Fix's git-state.ts (the engine<->flow boundary forbids
// importing Fix's), held in lockstep by
// tests/contracts/build-git-state-drift.test.ts. Unify into src/shared/git-state/
// to drop the duplication (tracked follow-up).
//
// overall_status is always 'passed' — the snapshot records state, it does not
// gate routing. When the gate is on, git failures (git missing, not a repo)
// abort via the runner's error path because the helper exits non-zero.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RuntimeGitStateSnapshot } from '../../../schemas/runtime-evidence.js';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { BuildBaselineSnapshot, BuildPlan } from '../reports.js';

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_OUTPUT_BYTES = 5_000_000;

// Resolves to the Build-local git-state.ts sibling. The bundle flattens this to
// runtime/git-state.ts (shared with Fix's identical copy); the dist sidecar
// emits dist/flows/build/writers/git-state.ts for source-tree CLI runs.
const GIT_STATE_HELPER_PATH = fileURLToPath(new URL('./git-state.ts', import.meta.url));

const GitStateHelperOutput = RuntimeGitStateSnapshot;
export type GitStateHelperOutput = RuntimeGitStateSnapshot;

export function buildGitStateCommand(id: string): VerificationCommand {
  return {
    id,
    cwd: '.',
    argv: [process.execPath, GIT_STATE_HELPER_PATH],
    timeout_ms: GIT_TIMEOUT_MS,
    max_output_bytes: GIT_MAX_OUTPUT_BYTES,
    env: {},
  };
}

// The touch-area gate is opt-in: it only enforces when the plan declares an
// allowed_touch_area. Both the baseline and the touch-area steps read the plan
// to decide whether to run git at all, so a Build run that never opted into the
// gate carries no git dependency. Shared here so both writers gate identically.
export function planDeclaresTouchArea(context: VerificationBuildContext): boolean {
  const planPath = reportPathForSchemaInRuntimeFlow(context.flow, 'build.plan@v1');
  if (!context.step.reads.includes(planPath as never)) {
    throw new Error(`build touch-area gate requires step '${context.step.id}' to read ${planPath}`);
  }
  const plan = BuildPlan.parse(
    JSON.parse(readFileSync(resolveRunRelative(context.runFolder, planPath), 'utf8')),
  );
  return plan.allowed_touch_area.length > 0;
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

export const buildBaselineSnapshotWriter: VerificationBuilder = {
  resultSchemaName: 'build.baseline-snapshot@v1',
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    // Opt-in: no declared area means no gate to back, so capture no git state.
    // The buildResult below then records the inert `captured: false` baseline.
    if (!planDeclaresTouchArea(context)) return [];
    return [buildGitStateCommand('build-baseline-snapshot-git-state')];
  },
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    // No observations means loadCommands skipped git because the gate is off.
    if (observations.length === 0) {
      return BuildBaselineSnapshot.parse({ overall_status: 'passed', captured: false });
    }
    if (observations.length !== 1) {
      throw new Error(
        `build.baseline-snapshot@v1: expected 1 git-state observation, got ${observations.length}`,
      );
    }
    const observation = observations[0];
    if (observation === undefined) {
      throw new Error('build.baseline-snapshot@v1: git-state observation missing');
    }
    const state = parseGitStateObservation(observation, 'build.baseline-snapshot@v1');
    return BuildBaselineSnapshot.parse({
      overall_status: 'passed',
      captured: true,
      head_sha: state.head_sha,
      entries: state.entries,
      hidden_index_flags: state.hidden_index_flags,
    });
  },
};
