// E1 objective checks. Runs a task's checks against a variant's repo to decide
// the `done_when` verdict. Visible checks run in the repo (the agent saw the
// regression command and was asked to satisfy it). Hidden checks run against a
// throwaway overlay copy so their ground-truth test code never touches the
// agent's tree. Mirrors runAllChecks / runHiddenChecks in
// evals/fix-vs-vanilla/run-fix-comparison.ts.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { E1Check, E1Task } from './task.ts';
import type { ObjectiveCheckOutcome } from './types.ts';

const CHECK_TIMEOUT_MS = 120_000;

function runCheck(repoDir: string, check: E1Check): ObjectiveCheckOutcome {
  const [command, ...args] = check.argv;
  if (command === undefined) {
    throw new Error(`check ${check.id} has an empty argv`);
  }
  const result = spawnSync(command, args, {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
  });
  return {
    id: check.id,
    hidden: check.hidden,
    // A non-zero exit, a signal kill, or a spawn error all count as failure.
    passed: result.status === 0,
  };
}

function runVisibleChecks(repoDir: string, task: E1Task): ObjectiveCheckOutcome[] {
  return task.checks.filter((check) => !check.hidden).map((check) => runCheck(repoDir, check));
}

function runHiddenChecks(repoDir: string, task: E1Task): ObjectiveCheckOutcome[] {
  const hidden = task.checks.filter((check) => check.hidden);
  if (hidden.length === 0) return [];
  if (!existsSync(task.objective_dir)) {
    throw new Error(
      `task ${task.id} declares hidden checks but has no objective/ directory at ${task.objective_dir}`,
    );
  }
  const scoringDir = mkdtempSync(join(tmpdir(), `e1-hidden-${task.id}-`));
  try {
    cpSync(repoDir, scoringDir, { recursive: true });
    // Overlay objective/* onto the repo copy: objective/tests/x -> tests/x.
    cpSync(task.objective_dir, scoringDir, { recursive: true });
    return hidden.map((check) => runCheck(scoringDir, check));
  } finally {
    rmSync(scoringDir, { recursive: true, force: true });
  }
}

// Run every check (visible + hidden) against a post-run repo. `objective_passed`
// is "every check passed".
export function runObjectiveChecks(
  repoDir: string,
  task: E1Task,
): {
  post_checks: ObjectiveCheckOutcome[];
  objective_passed: boolean;
} {
  const post = [...runVisibleChecks(repoDir, task), ...runHiddenChecks(repoDir, task)];
  return { post_checks: post, objective_passed: post.every((check) => check.passed) };
}

// At baseline the bug must reproduce: at least one visible check fails before
// the agent touches anything. (Hidden checks are not run at baseline — the
// visible regression command is the reproduction signal the bug report names.)
export function baselineReproduced(repoDir: string, task: E1Task): boolean {
  const visible = runVisibleChecks(repoDir, task);
  return visible.some((check) => !check.passed);
}
