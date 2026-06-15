// E1 task loading. Reads a fix-vs-vanilla eval task (flow-agnostic by design:
// task.json carries no flow binding) and builds the single goal both variants
// receive verbatim. The goal names only the regression command the bug report
// references — never the hidden objective check — so neither arm can satisfy
// the ground truth by being told it. This mirrors `taskGoal` in
// evals/fix-vs-vanilla/run-fix-comparison.ts; E1 re-derives it rather than
// importing across the experiment boundary.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface E1Check {
  readonly id: string;
  readonly argv: readonly string[];
  readonly hidden: boolean;
}

export interface E1Task {
  readonly id: string;
  readonly prompt: string;
  readonly allowed_changed_files: readonly string[];
  readonly checks: readonly E1Check[];
  readonly repo_template: string;
  readonly objective_dir: string;
  // A human-readable summary of the success criterion for the comparison
  // record's `done_when` field.
  readonly done_when: string;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`task ${label} must be a non-empty string`);
  }
  return value;
}

export function loadTask(tasksRoot: string, taskId: string): E1Task {
  const taskDir = join(tasksRoot, taskId);
  const taskJsonPath = join(taskDir, 'task.json');
  if (!existsSync(taskJsonPath)) {
    throw new Error(`task not found: ${taskJsonPath}`);
  }
  const raw = JSON.parse(readFileSync(taskJsonPath, 'utf8')) as Record<string, unknown>;

  const prompt = asString(raw.prompt, 'prompt');
  const allowed = Array.isArray(raw.allowed_changed_files)
    ? raw.allowed_changed_files.filter((v): v is string => typeof v === 'string')
    : [];

  const checksRaw = Array.isArray(raw.checks) ? raw.checks : [];
  const checks: E1Check[] = checksRaw.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const argv = Array.isArray(record.argv)
      ? record.argv.filter((v): v is string => typeof v === 'string')
      : [];
    return {
      id: asString(record.id, 'check.id'),
      argv,
      hidden: record.hidden === true,
    };
  });
  if (checks.length === 0) {
    throw new Error(`task ${taskId} declares no checks`);
  }

  const visibleCommands = checks
    .filter((check) => !check.hidden)
    .map((check) => check.argv.join(' '))
    .filter((command) => command.length > 0);

  const doneWhen = `${prompt} Objective: the bug reproduces at baseline, then every check passes after the fix (visible: ${visibleCommands.join(', ') || 'none'}; plus ${checks.filter((c) => c.hidden).length} hidden ground-truth check(s) the agent never sees).`;

  return {
    id: asString(raw.id, 'id'),
    prompt,
    allowed_changed_files: allowed,
    checks,
    repo_template: join(taskDir, 'repo'),
    objective_dir: join(taskDir, 'objective'),
    done_when: doneWhen,
  };
}

// The single goal both variants receive. Check-blind on purpose (see file
// header). Byte-identical across arms, so the only difference between the runs
// is the flow's decomposition grain.
export function buildGoal(task: E1Task): string {
  return `${task.prompt}

Acceptance:
- First confirm the regression by running the regression command before the fix.
- Make only the focused fix needed for this task.
- Rerun the regression command after the fix and leave it passing.
- Fix the underlying cause, not just the one symptom the regression command shows.

Allowed changed files:
${task.allowed_changed_files.map((file) => `- ${file}`).join('\n')}`;
}
