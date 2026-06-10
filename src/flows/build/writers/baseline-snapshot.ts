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
// When the gate is on, one command runs the shared git-state helper
// (src/shared/git-state.ts, invoked via src/shared/git-state-command.ts): git
// rev-parse + git status porcelain v1 -z --untracked-files=all +
// per-dirty-path `git hash-object` + git ls-files -v for assume-unchanged /
// skip-worktree detection, emitting a single JSON document.
//
// overall_status is always 'passed' — the snapshot records state, it does not
// gate routing. When the gate is on, git failures (git missing, not a repo)
// abort via the runner's error path because the helper exits non-zero.

import { readFileSync } from 'node:fs';
import { gitStateCommand, parseGitStateObservation } from '../../../shared/git-state-command.js';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { BuildBaselineSnapshot, BuildPlan } from '../reports.js';

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

export const buildBaselineSnapshotWriter: VerificationBuilder = {
  resultSchemaName: 'build.baseline-snapshot@v1',
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    // Opt-in: no declared area means no gate to back, so capture no git state.
    // The buildResult below then records the inert `captured: false` baseline.
    if (!planDeclaresTouchArea(context)) return [];
    return [gitStateCommand('build-baseline-snapshot-git-state')];
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
