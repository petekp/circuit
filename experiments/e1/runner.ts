// E1 live runner — the budget-spending lane. Given one task, it runs the
// holistic (`fix`) and separated (`build --process high`) variants, each in its
// own isolated git worktree at a shared base commit, then normalizes both into
// a comparison record.
//
// This is the ONLY E1 module that spends model budget. It reuses the engine's
// own worktree runner (src/runtime/fanout/worktree.ts) for isolation rather
// than inventing a mechanism, and shells out to bin/circuit exactly as the
// fix-vs-vanilla eval harness does. Everything downstream (extract, compare,
// report) is the same pure code the fixture lane proves.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitWorktreeRunner } from '../../src/runtime/fanout/worktree.ts';
import { readCheckpointState } from './checkpoint.ts';
import { compareVariants } from './compare.ts';
import { extractVariantRecord } from './extract.ts';
import { baselineReproduced, runObjectiveChecks } from './objective.ts';
import { type E1Task, buildGoal, loadTask } from './task.ts';
import type { ExperimentComparison, VariantId, VariantRecord } from './types.ts';

// The two arrangements E1 contrasts. Holistic is the near-default `fix` flow;
// separated is `build` at deep depth, which is the only setting that engages
// build's act/verify slice loop (src/flows/build/data.ts gates
// iterates_slice_loop at depth >= high).
interface VariantSpec {
  readonly variantId: VariantId;
  readonly flowId: string;
  readonly extraArgs: readonly string[];
}

// Both arms run their flow's natural mode; the only independent variable is the
// grain. The separated arm needs no `--autonomous`: that flag would change the
// run's whole autonomy behavior (a bounded continuation loop) and confound the
// grain comparison. Instead the harness answers `build`'s opening `frame-step`
// human checkpoint the way a human confirming the brief would — with an explicit
// `--checkpoint-choice continue` on `circuit resume` (see runVariant). That
// clears the interactive gate without altering how the slice loop runs. Holistic
// `fix` has no blocking checkpoint and needs no resume.
const VARIANT_SPECS: readonly VariantSpec[] = [
  { variantId: 'holistic', flowId: 'fix', extraArgs: [] },
  { variantId: 'separated', flowId: 'build', extraArgs: ['--process', 'high'] },
];

// Defensive bound on the resume loop. `build` has exactly one checkpoint today
// (frame-step), so one resume suffices; the loop tolerates a flow that grows
// more without ever spinning unbounded.
const MAX_CHECKPOINT_RESUMES = 4;

export interface LiveRunOptions {
  readonly taskId: string;
  readonly tasksRoot: string;
  // The circuit checkout that holds bin/circuit + generated/flows.
  readonly repoRoot: string;
  // Scratch root for the base repo, the per-variant worktrees, and run folders.
  readonly workRoot: string;
  readonly power: string;
  readonly timeoutMs: number;
  // Injected so the pure record stays the same shape the fixtures prove; the
  // CLI passes Date.now-based values.
  readonly now: () => number;
  readonly nowIso: () => string;
  readonly log: (message: string) => void;
}

const DETERMINISTIC_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'E1 Harness',
  GIT_AUTHOR_EMAIL: 'e1-harness@example.invalid',
  GIT_COMMITTER_NAME: 'E1 Harness',
  GIT_COMMITTER_EMAIL: 'e1-harness@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...DETERMINISTIC_GIT_ENV },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${result.status ?? 'null'}): ${result.stderr ?? ''}`,
    );
  }
  return (result.stdout ?? '').trim();
}

// Stand up the shared base: copy the task's repo template, git-init it, commit,
// and return the base commit every variant worktree branches from.
function provisionBaseRepo(task: E1Task, baseRepoDir: string): string {
  mkdirSync(baseRepoDir, { recursive: true });
  cpSync(task.repo_template, baseRepoDir, { recursive: true });
  git(['init', '--quiet'], baseRepoDir);
  git(['config', 'commit.gpgsign', 'false'], baseRepoDir);
  git(['add', '-A'], baseRepoDir);
  git(['commit', '-m', 'e1 base fixture', '--quiet'], baseRepoDir);
  return git(['rev-parse', 'HEAD'], baseRepoDir);
}

function runVariant(
  spec: VariantSpec,
  task: E1Task,
  goal: string,
  baseRepoDir: string,
  baseRef: string,
  options: LiveRunOptions,
  flowRoot: string,
  binCircuit: string,
): VariantRecord {
  const variantDir = join(options.workRoot, spec.variantId);
  const worktreePath = join(variantDir, 'repo');
  const runFolder = join(variantDir, 'circuit-run');
  mkdirSync(variantDir, { recursive: true });

  // Provision the isolated worktree at the shared base. gitWorktreeRunner.add
  // resolves the repo from process.cwd(), so anchor cwd to the base repo for
  // this call only.
  const priorCwd = process.cwd();
  process.chdir(baseRepoDir);
  try {
    gitWorktreeRunner.add({
      worktreePath,
      baseRef,
      branchName: `e1/${task.id}/${spec.variantId}`,
    });
  } finally {
    process.chdir(priorCwd);
  }

  const baseline = baselineReproduced(worktreePath, task);
  options.log(
    `${spec.variantId} (${spec.flowId}): baseline ${baseline ? 'reproduced the bug' : 'did NOT reproduce (suspect)'}`,
  );

  const argv = [
    binCircuit,
    'run',
    spec.flowId,
    '--goal',
    goal,
    ...spec.extraArgs,
    '--power',
    options.power,
    '--run-folder',
    runFolder,
    '--flow-root',
    flowRoot,
    '--progress',
    'jsonl',
  ];

  options.log(
    `${spec.variantId}: running \`circuit run ${spec.flowId} ${spec.extraArgs.join(' ')}\` (live, spends budget)…`,
  );
  const startedAt = options.now();
  const run = spawnSync('node', argv, {
    cwd: worktreePath,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    env: { ...process.env, CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: flowRoot },
  });
  // Accumulate stdout/stderr across the opening run and any checkpoint resumes
  // so the evidence file holds the whole sequence, not just the first leg.
  const stdoutParts = [run.stdout ?? ''];
  const stderrParts = [run.stderr ?? ''];
  let lastStatus = run.status;
  let lastSignal = run.signal;

  // Checkpoint-aware drive. `build` opens at the frame-step checkpoint: the run
  // exits 0 without a terminal result.json, leaving process-evidence.json with
  // outcome 'checkpoint_waiting'. Answer it the way a human confirming the brief
  // would — `circuit resume --checkpoint-choice continue` (resume reuses the
  // saved manifest/goal/axes, so it takes neither --goal nor --process nor
  // --flow-root) — until the run reaches a terminal outcome or the defensive
  // bound trips. `fix` never parks here, so its first readCheckpointState
  // already reports not-waiting and this loop is a no-op.
  for (let resumeCount = 0; resumeCount < MAX_CHECKPOINT_RESUMES; resumeCount += 1) {
    const state = readCheckpointState(runFolder);
    if (!state.waiting) break;
    options.log(
      `${spec.variantId}: parked at checkpoint '${state.stepId}' — resuming with --checkpoint-choice ${state.choice}…`,
    );
    const resume = spawnSync(
      'node',
      [
        binCircuit,
        'resume',
        '--run-folder',
        runFolder,
        '--checkpoint-choice',
        state.choice,
        '--progress',
        'jsonl',
      ],
      {
        cwd: worktreePath,
        encoding: 'utf8',
        timeout: options.timeoutMs,
        env: { ...process.env, CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: flowRoot },
      },
    );
    stdoutParts.push(resume.stdout ?? '');
    stderrParts.push(resume.stderr ?? '');
    lastStatus = resume.status;
    lastSignal = resume.signal;
    if (resume.status !== 0) {
      options.log(
        `${spec.variantId}: resume exited ${resume.status ?? 'null'} — stopping the resume loop; the record will reflect whatever the run folder holds.`,
      );
      break;
    }
  }
  const wallMs = options.now() - startedAt;

  // Keep the raw run output beside the run folder for evidence.
  writeFileSync(join(variantDir, 'run-stdout.txt'), stdoutParts.join('\n'));
  writeFileSync(join(variantDir, 'run-stderr.txt'), stderrParts.join('\n'));
  if (lastStatus !== 0) {
    options.log(
      `${spec.variantId}: circuit exited ${lastStatus ?? 'null'}${lastSignal ? ` (signal ${lastSignal})` : ''} — the record will reflect whatever the run folder holds.`,
    );
  }

  const objective = runObjectiveChecks(worktreePath, task);
  options.log(
    `${spec.variantId}: objective ${objective.objective_passed ? 'PASSED' : 'FAILED'} (${objective.post_checks.filter((c) => c.passed).length}/${objective.post_checks.length} checks)`,
  );

  // Commit whatever the flow left so the diff vs base is the variant's change
  // set (changedFiles diffs <base>..HEAD).
  git(['add', '-A'], worktreePath);
  const status = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: worktreePath });
  if (status.status !== 0) {
    git(['commit', '-m', `e1 ${spec.variantId} result`, '--quiet'], worktreePath);
  }
  // changedFiles diffs <base>..HEAD. gitWorktreeRunner.changedFiles is typed as
  // possibly-async on the interface, so compute it directly through the same git
  // helper to keep the record synchronous.
  const changedFiles = git(['diff', '--name-only', `${baseRef}..HEAD`], worktreePath)
    .split('\n')
    .filter((line) => line.length > 0);

  return extractVariantRecord({
    runFolder,
    variantId: spec.variantId,
    flowId: spec.flowId,
    worktreePath,
    objective: {
      baseline_reproduced: baseline,
      post_checks: objective.post_checks,
      objective_passed: objective.objective_passed,
    },
    changedFiles,
    fallbackWallTimeMs: wallMs,
  });
}

export function runLiveComparison(options: LiveRunOptions): ExperimentComparison {
  const task = loadTask(options.tasksRoot, options.taskId);
  const goal = buildGoal(task);
  const binCircuit = join(options.repoRoot, 'bin', 'circuit');

  // Pin the compiled flows for the run (mirrors the eval harness): copy
  // generated/flows into the work tree and point --flow-root at the copy.
  const flowRoot = join(options.workRoot, 'generated-flows');
  cpSync(join(options.repoRoot, 'generated', 'flows'), flowRoot, { recursive: true });

  const baseRepoDir = join(options.workRoot, 'base-repo');
  const baseRef = provisionBaseRepo(task, baseRepoDir);
  options.log(`base repo at ${baseRef.slice(0, 12)} (${task.id})`);

  const records = VARIANT_SPECS.map((spec) =>
    runVariant(spec, task, goal, baseRepoDir, baseRef, options, flowRoot, binCircuit),
  );

  return compareVariants(records, {
    task_id: task.id,
    done_when: task.done_when,
    base_ref: baseRef,
    mode: 'live',
    generated_at: options.nowIso(),
  });
}
