import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// A fix-vs-vanilla task only carries measurement signal if it is a real trap:
// the naive fix (the one the *visible* `npm test` repro rewards) must leave an
// *objective* check failing, while the root-cause fix passes everything. This
// proves that gap deterministically, with no model, for every trap task — any
// task directory that ships a `fixtures/naive.mjs` and `fixtures/root-cause.mjs`
// next to its buggy `repo/`. Authoring a new trap (Phase B) auto-enrolls here.
//
// Objective checks marked `hidden` do NOT ship in `repo/` (the tree the agent
// edits). Their test files live in `objective/` and the harness overlays them
// onto a throwaway copy of the post-fix repo at scoring time. Live probes proved
// why this matters: when the hidden check's test file and npm script shipped in
// the repo, the agent simply read and ran them, so no trap could ever discriminate.

const TASKS_ROOT = resolve(import.meta.dirname, '../../evals/fix-vs-vanilla/tasks');

type Check = { id: string; argv: string[]; hidden?: boolean };
type TrapTask = {
  id: string;
  dir: string;
  objectiveDir: string;
  hasObjectiveDir: boolean;
  patchTarget: string;
  visible: Check;
  objectiveOnly: Check[];
  hiddenChecks: Check[];
  // Most traps hide a latent bug: the objective check fails at baseline too.
  // An adjacent-regression trap instead guards a neighbor that *works* at
  // baseline and breaks under the naive fix, so its objective check passes at
  // baseline. task.json sets `objective_passes_at_baseline: true` for those.
  objectivePassesAtBaseline: boolean;
};

// The .mjs file a hidden check invokes by path, e.g. "tests/x.export.test.mjs".
function hiddenCheckPath(check: Check): string {
  const file = check.argv.find((arg) => arg.endsWith('.mjs'));
  if (file === undefined) {
    throw new Error(`hidden check ${check.id} must invoke a .mjs file by path`);
  }
  return file;
}

function discoverTrapTasks(): TrapTask[] {
  const out: TrapTask[] = [];
  for (const entry of readdirSync(TASKS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(TASKS_ROOT, entry.name);
    const hasFixtures =
      existsSync(join(dir, 'fixtures', 'naive.mjs')) &&
      existsSync(join(dir, 'fixtures', 'root-cause.mjs'));
    if (!hasFixtures) continue;
    const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')) as {
      id: string;
      checks: Check[];
      allowed_changed_files: string[];
      objective_passes_at_baseline?: boolean;
    };
    const visible = task.checks.find((c) => c.argv.join(' ') === 'npm test');
    if (visible === undefined) {
      throw new Error(`${task.id}: a trap task must name "npm test" as the visible repro`);
    }
    const patchTarget = task.allowed_changed_files[0];
    if (patchTarget === undefined) {
      throw new Error(`${task.id}: a trap task must declare the file its fix patches`);
    }
    out.push({
      id: task.id,
      dir,
      objectiveDir: join(dir, 'objective'),
      hasObjectiveDir: existsSync(join(dir, 'objective')),
      patchTarget,
      visible,
      objectiveOnly: task.checks.filter((c) => c !== visible),
      hiddenChecks: task.checks.filter((c) => c.hidden === true),
      objectivePassesAtBaseline: task.objective_passes_at_baseline === true,
    });
  }
  return out;
}

// Mirror what the harness does: run the check's argv in the repo and read the
// exit code. Pass === exit 0.
function checkPasses(repoDir: string, argv: string[]): boolean {
  try {
    execFileSync(argv[0] as string, argv.slice(1), {
      cwd: repoDir,
      stdio: 'ignore',
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

function objectivePasses(repoDir: string, task: TrapTask): boolean {
  return task.objectiveOnly.every((check) => checkPasses(repoDir, check.argv));
}

const trapTasks = discoverTrapTasks();

let workDir: string;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('fix-vs-vanilla trap mechanic', () => {
  it('finds at least one trap task to prove', () => {
    expect(trapTasks.length).toBeGreaterThan(0);
  });

  for (const task of trapTasks) {
    it(
      `${task.id}: naive fix passes the visible repro but fails an objective check; root-cause passes both`,
      () => {
        workDir = mkdtempSync(join(tmpdir(), `trap-${task.id}-`));
        cpSync(join(task.dir, 'repo'), workDir, { recursive: true });
        // Overlay the hidden objective checks the way the harness does at scoring
        // time. They never ship in `repo/`, so without this the objective checks
        // cannot run at all.
        if (task.hasObjectiveDir) {
          cpSync(task.objectiveDir, workDir, { recursive: true });
        }
        const target = join(workDir, task.patchTarget);
        const applyFixture = (name: string) =>
          copyFileSync(join(task.dir, 'fixtures', name), target);

        // Buggy baseline: the visible repro always fails. The objective check
        // fails too for a latent-bug trap, but for an adjacent-regression trap it
        // guards a neighbor that still works at baseline, so it passes there.
        expect(checkPasses(workDir, task.visible.argv)).toBe(false);
        expect(objectivePasses(workDir, task)).toBe(task.objectivePassesAtBaseline);

        // Naive fix: the trap. Visible repro goes green, objective stays red.
        applyFixture('naive.mjs');
        expect(checkPasses(workDir, task.visible.argv)).toBe(true);
        expect(objectivePasses(workDir, task)).toBe(false);

        // Root-cause fix: everything passes.
        applyFixture('root-cause.mjs');
        expect(checkPasses(workDir, task.visible.argv)).toBe(true);
        expect(objectivePasses(workDir, task)).toBe(true);
      },
      120_000,
    );

    if (task.hiddenChecks.length > 0) {
      it(`${task.id}: hidden objective checks are absent from the agent's repo`, () => {
        for (const check of task.hiddenChecks) {
          const rel = hiddenCheckPath(check);
          // The answer key must not sit in the tree the agent reads and edits.
          expect(existsSync(join(task.dir, 'repo', rel))).toBe(false);
          // But it must be available for the harness to overlay at scoring time.
          expect(existsSync(join(task.objectiveDir, rel))).toBe(true);
        }
      });
    }
  }
});
