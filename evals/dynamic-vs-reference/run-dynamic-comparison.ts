#!/usr/bin/env node
// Dynamic-vs-reference live experiment harness.
//
// Pre-registered in docs/ideas/dynamic-vs-reference-experiment-brief.md. Both
// arms are Circuit runs, pinned to one model, on the same held-out fixture:
//   - reference: the hand-authored built-in (fix|build) under generated/flows.
//   - generated: the flow `circuit create` instantiates from the task text,
//     published into a throwaway home and run under its custom slug through the
//     trust gate, in its DEFAULT mode only (avoids the per-mode trust gap).
//
// Scoring reuses the fix-vs-vanilla instrument unchanged (scoreArm + the
// per-relay cost capture + the committed price table). The only experiment-
// specific code is (a) a flow-aware claim adapter that locates each run's
// result file from the compiled flow's runtime_surface.primary_result and
// reads it with the right family semantics, (b) a thin per-family roll-up that
// reuses rate/mean/percentile, and (c) the section-5 decision rule. No new
// scorer and no new cost instrument.
//
// The build family parks at the frame-step human checkpoint; the checkpoint-
// resume drive below is the e1 pattern (experiments/e1/checkpoint.ts +
// runner.ts) inlined so evals/ stays self-contained. fix never parks, so the
// loop is a no-op there.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mean, rate } from '../../scripts/evals/shared/aggregation.ts';
import { readJson, safeSegment, writeJson } from '../../scripts/evals/shared/json.ts';
import {
  LEDGER_SCHEMA_VERSION,
  type LedgerEntry,
  validateLedgerEntry,
} from '../../scripts/evals/shared/ledger.ts';
import { createResultRoot, repoMetadata } from '../../scripts/evals/shared/metadata.ts';
import {
  commandOutput,
  findExecutable,
  runCommand,
  runSync,
} from '../../scripts/evals/shared/process.ts';
import { createClaudeCodeWrapper } from '../../scripts/evals/shared/providers.ts';
import {
  parseCircuitResult,
  scoreArm,
  type ArmScore,
} from '../../scripts/evals/fix-vs-vanilla/scoring.ts';
import {
  buildArmUsageScore,
  groupRelaysByRole,
  loadPriceTable,
  type PriceTable,
  readCircuitRunUsage,
} from '../../scripts/evals/shared/usage.ts';
import {
  type ComposeDeps,
  FIX_LINEAR_FULL,
  loadComposeDepsFromDist,
  publishComposedFlowWith,
} from './composed-fix-shapes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const MANIFEST_PATH = resolve(__dirname, 'manifest.json');
const DEFAULT_RESULTS_ROOT = resolve(__dirname, 'results');
const GENERATED_FLOWS_ROOT = resolve(REPO_ROOT, 'generated', 'flows');
const PRICES_DIR = resolve(REPO_ROOT, 'evals/ledger/prices');
const LEDGER_DIR = resolve(REPO_ROOT, 'evals/ledger/dynamic-vs-reference');
const BIN_CIRCUIT = resolve(REPO_ROOT, 'bin/circuit');
const CHECK_TIMEOUT_MS = 120_000;
const MAX_CHECKPOINT_RESUMES = 4;
const PREFERRED_CHECKPOINT_CHOICE = 'continue';
// Margin and the build fold-cost tasks are locked by the brief (section 5).
const QUALITY_MARGIN = 0.1;
const HONESTY_MARGIN = 0.1;

type JsonRecord = Record<string, any>;
type Family = 'fix' | 'build';
// 'composed' is the opt-in third arm (--with-composed): a fix flow genuinely
// composed block by block, not instantiated from a family template. It runs only
// for fix tasks (build-family composition is unproven). The locked reference-vs-
// generated decision rule never sees it.
type ArmId = 'reference' | 'generated' | 'composed';

type CheckDefinition = { id: string; argv: string[]; hidden?: boolean };

export type DynManifest = {
  benchmark_id: string;
  default_provider: string;
  default_model: string;
  default_effort: string;
  default_timeout_ms: number;
  reps_per_task: number;
  families: Record<Family, string[]>;
  expected_grain: Record<string, string>;
  fold_cost_tasks: string[];
};

type DynTask = JsonRecord & {
  id: string;
  family: Family;
  split: string;
  create_description: string;
  prompt: string;
  checks: CheckDefinition[];
  allowed_changed_files: string[];
  task_root: string;
  repo_template: string;
  objective_template: string;
};

export type DynArgs = {
  taskId: string | undefined;
  family: Family | undefined;
  provider: string;
  model: string;
  effort: string;
  timeoutMs: number;
  reps: number;
  pinModel: boolean;
  outDir: string;
  skipBuild: boolean;
  dryRun: boolean;
  withComposed: boolean;
};

type CheckRun = JsonRecord & { id: string; argv: string[]; passed: boolean };
type DiffState = { changed_files: string[]; git_status_short: string; diff_path: string };

// What a single arm run produced: the reused ArmScore plus the experiment's own
// pipeline-integrity bookkeeping and the generated-flow shape markers.
type ArmRunRecord = {
  arm_id: ArmId;
  score: ArmScore;
  pipeline_status: string;
  pipeline_detail?: string;
  generated_slug?: string;
  generated_step_count?: number | null;
};

type TaskSummary = JsonRecord & {
  task_id: string;
  family: Family;
  rep: number;
  baseline_failed_as_expected: boolean;
  arms: Partial<Record<ArmId, ArmRunRecord>>;
};

// ---------------------------------------------------------------------------
// Arg parsing (pure; manifest injects defaults so it is unit-testable).

function usage(): string {
  return `Usage:
  node evals/dynamic-vs-reference/run-dynamic-comparison.ts \\
    [--task-id <id>] [--family fix|build] \\
    [--model <model-id>] [--pin-model <model-id>] [--no-pin-model] \\
    [--effort low|medium|high|xhigh] [--timeout-ms 900000] \\
    [--reps N] [--out-dir evals/dynamic-vs-reference/results] \\
    [--skip-build] [--dry-run] [--with-composed]

Compares a hand-authored reference flow against the flow circuit create
instantiates from the task text, both pinned to one model, on fix and build.
The generated arm runs its DEFAULT mode only.

--with-composed adds a third arm on FIX tasks only: a fix flow genuinely
composed block by block (FIX_LINEAR_FULL), published in process and run through
the same trust gate, scorer, and subprocess as the other arms. Build tasks skip
it (build-family composition is unproven). The reference-vs-generated decision
rule is unchanged.
`;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseDynArgs(argv: string[], manifest: DynManifest): DynArgs {
  const args: DynArgs = {
    taskId: undefined,
    family: undefined,
    provider: manifest.default_provider,
    model: manifest.default_model,
    effort: manifest.default_effort,
    timeoutMs: manifest.default_timeout_ms,
    reps: manifest.reps_per_task,
    // The experiment mandates a single pinned model on both arms. Pin is on by
    // default and uses the manifest model unless --no-pin-model is passed.
    pinModel: true,
    outDir: DEFAULT_RESULTS_ROOT,
    skipBuild: false,
    dryRun: false,
    withComposed: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg === '--task-id') {
      args.taskId = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--family') {
      args.family = requireValue(argv, i, arg) as Family;
      i += 1;
    } else if (arg === '--model') {
      args.model = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--pin-model') {
      // Accepts the model id to pin (sets the model and keeps pin on).
      args.model = requireValue(argv, i, arg);
      args.pinModel = true;
      i += 1;
    } else if (arg === '--no-pin-model') {
      args.pinModel = false;
    } else if (arg === '--effort') {
      args.effort = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--reps') {
      args.reps = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--out-dir') {
      args.outDir = resolve(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--skip-build') {
      args.skipBuild = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--with-composed') {
      args.withComposed = true;
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }
  if (args.provider !== 'claude-code') {
    throw new Error('this experiment currently supports --provider claude-code only');
  }
  if (args.family !== undefined && args.family !== 'fix' && args.family !== 'build') {
    throw new Error('--family must be fix or build');
  }
  if (!['low', 'medium', 'high', 'xhigh'].includes(args.effort)) {
    throw new Error('--effort must be one of low, medium, high, or xhigh');
  }
  if (!Number.isInteger(args.reps) || args.reps <= 0) throw new Error('--reps must be a positive integer');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }
  return args;
}

function selectedTaskIds(manifest: DynManifest, args: DynArgs): string[] {
  const all = [...manifest.families.fix, ...manifest.families.build];
  if (args.taskId !== undefined) {
    if (!all.includes(args.taskId)) throw new Error(`unknown task id: ${args.taskId}`);
    return [args.taskId];
  }
  if (args.family !== undefined) return manifest.families[args.family];
  return all;
}

function loadTask(taskId: string): DynTask {
  const taskRoot = resolve(__dirname, 'tasks', taskId);
  const taskPath = resolve(taskRoot, 'task.json');
  if (!existsSync(taskPath)) throw new Error(`task file not found: ${taskPath}`);
  const task = readJson<JsonRecord>(taskPath);
  return {
    ...(task as DynTask),
    split: typeof task.split === 'string' ? task.split : String(task.family),
    task_root: taskRoot,
    repo_template: resolve(taskRoot, 'repo'),
    objective_template: resolve(taskRoot, 'objective'),
  };
}

// ---------------------------------------------------------------------------
// Goal + fixture + checks (mirrors the fix-vs-vanilla harness so both arms see
// the identical, check-blind goal — the comparison is flow shape, not prompt).

function taskGoal(task: DynTask): string {
  const verb = task.family === 'build' ? 'Make only the focused change' : 'Make only the focused fix';
  return `${task.prompt}

Acceptance:
- First confirm the regression by running the regression command before the work.
- ${verb} needed for this task.
- Rerun the regression command afterward and leave it passing.
- Address the underlying requirement, not just the one symptom the regression command shows.

Allowed changed files:
${task.allowed_changed_files.map((file) => `- ${file}`).join('\n')}`;
}

function initFixtureRepo(repoDir: string): string {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Dyn Benchmark',
    GIT_AUTHOR_EMAIL: 'dyn-benchmark@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Dyn Benchmark',
    GIT_COMMITTER_EMAIL: 'dyn-benchmark@example.invalid',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const steps: Array<[string, string[]]> = [
    ['git', ['init', '--quiet']],
    ['git', ['config', 'commit.gpgsign', 'false']],
    ['git', ['config', 'user.name', 'Dyn Benchmark']],
    ['git', ['config', 'user.email', 'dyn-benchmark@example.invalid']],
    ['git', ['add', '-A']],
    ['git', ['commit', '-m', 'initial fixture', '--quiet']],
  ];
  for (const [command, argv] of steps) {
    const result = runSync(command, argv, { cwd: repoDir, env: gitEnv });
    if (result.status !== 0) {
      throw new Error(`fixture git setup failed: ${command} ${argv.join(' ')}\n${result.stderr}`);
    }
  }
  const head = runSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
  return head.status === 0 ? head.stdout.trim() || 'unavailable' : 'unavailable';
}

function copyFixtureRepo(task: DynTask, dest: string): string {
  mkdirSync(dest, { recursive: true });
  cpSync(task.repo_template, dest, { recursive: true });
  return initFixtureRepo(dest);
}

function runChecks(repoDir: string, checks: readonly CheckDefinition[], outputDir: string, phase: string): CheckRun[] {
  mkdirSync(outputDir, { recursive: true });
  return checks.map((check) => {
    const command = check.argv[0];
    if (command === undefined) throw new Error(`check ${check.id} has an empty argv`);
    const result = runSync(command, check.argv.slice(1), { cwd: repoDir, timeoutMs: CHECK_TIMEOUT_MS });
    const base = resolve(outputDir, `${phase}-${safeSegment(check.id)}`);
    writeFileSync(`${base}.stdout.txt`, result.stdout);
    writeFileSync(`${base}.stderr.txt`, result.stderr);
    return {
      id: check.id,
      argv: check.argv,
      exit_code: result.status,
      passed: result.status === 0,
      stdout_path: `${base}.stdout.txt`,
      stderr_path: `${base}.stderr.txt`,
    };
  });
}

// Hidden objective checks run against an overlay copy so their test code never
// ships in the agent's repo (identical contract to the fix-vs-vanilla harness).
function runHiddenChecks(baseRepoDir: string, task: DynTask, hidden: readonly CheckDefinition[], outputDir: string, phase: string): CheckRun[] {
  if (!existsSync(task.objective_template)) {
    throw new Error(`task ${task.id} declares hidden checks but has no objective/ directory at ${task.objective_template}`);
  }
  const scoringDir = mkdtempSync(resolve(tmpdir(), `dyn-hidden-${safeSegment(task.id)}-`));
  try {
    cpSync(baseRepoDir, scoringDir, { recursive: true });
    cpSync(task.objective_template, scoringDir, { recursive: true });
    return runChecks(scoringDir, hidden, outputDir, `${phase}-hidden`);
  } finally {
    rmSync(scoringDir, { recursive: true, force: true });
  }
}

function runAllChecks(repoDir: string, task: DynTask, outputDir: string, phase: string): CheckRun[] {
  const visible = task.checks.filter((check) => check.hidden !== true);
  const hidden = task.checks.filter((check) => check.hidden === true);
  const results = runChecks(repoDir, visible, outputDir, phase);
  if (hidden.length > 0) results.push(...runHiddenChecks(repoDir, task, hidden, outputDir, phase));
  return results;
}

function diffState(repoDir: string, outputDir: string): DiffState {
  const nameOnly = runSync('git', ['diff', '--name-only'], { cwd: repoDir });
  const diff = runSync('git', ['diff', '--'], { cwd: repoDir });
  const status = runSync('git', ['status', '--short'], { cwd: repoDir });
  writeFileSync(resolve(outputDir, 'diff.txt'), diff.stdout);
  writeFileSync(resolve(outputDir, 'git-status.txt'), status.stdout);
  const changedFiles = nameOnly.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return { changed_files: changedFiles, git_status_short: status.stdout, diff_path: resolve(outputDir, 'diff.txt') };
}

// ---------------------------------------------------------------------------
// Checkpoint-resume drive (e1 pattern, inlined). build parks at frame-step;
// fix never parks so this is a no-op there.

type CheckpointState = { waiting: false } | { waiting: true; stepId: string; choice: string };

function readCheckpointState(runFolder: string): CheckpointState {
  const path = join(runFolder, 'reports', 'process-evidence.json');
  if (!existsSync(path)) return { waiting: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { waiting: false };
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as JsonRecord).outcome !== 'checkpoint_waiting') {
    return { waiting: false };
  }
  const checkpoint = (parsed as JsonRecord).checkpoint;
  const stepId = typeof checkpoint?.step_id === 'string' ? checkpoint.step_id : 'unknown';
  const allowed: string[] = Array.isArray(checkpoint?.allowed_choices)
    ? checkpoint.allowed_choices.filter((c: unknown): c is string => typeof c === 'string')
    : [];
  const choice = allowed.includes(PREFERRED_CHECKPOINT_CHOICE)
    ? PREFERRED_CHECKPOINT_CHOICE
    : (allowed[0] ?? PREFERRED_CHECKPOINT_CHOICE);
  return { waiting: true, stepId, choice };
}

// Drives `circuit run` then any frame-step resumes, accumulating wallclock and
// the last exit status. Resume reuses the saved run folder (no --goal/--flow-root).
async function driveCircuitRun(opts: {
  label: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  runFolder: string;
  outputDir: string;
  timeoutMs: number;
}): Promise<{ exit_code: number | null; timed_out: boolean; wallclock_ms: number; resume_count: number }> {
  const startedAt = performance.now();
  const run = await runCommand({
    label: opts.label,
    command: 'node',
    argv: opts.argv,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    outputDir: opts.outputDir,
  });
  let lastExit = run.exit_code;
  let timedOut = run.timed_out;
  let resumeCount = 0;
  for (; resumeCount < MAX_CHECKPOINT_RESUMES; ) {
    const state = readCheckpointState(opts.runFolder);
    if (!state.waiting) break;
    const resume = await runCommand({
      label: `${opts.label}:resume-${resumeCount + 1}`,
      command: 'node',
      argv: [BIN_CIRCUIT, 'resume', '--run-folder', opts.runFolder, '--checkpoint-choice', state.choice, '--progress', 'jsonl'],
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      // Each resume writes to its own subdir so its stdout/stderr survive
      // instead of clobbering the initial run's artifacts in the arm dir.
      outputDir: resolve(opts.outputDir, `resume-${resumeCount + 1}`),
    });
    resumeCount += 1;
    lastExit = resume.exit_code;
    timedOut = resume.timed_out;
    if (resume.exit_code !== 0) break;
  }
  return {
    exit_code: lastExit,
    timed_out: timedOut,
    wallclock_ms: performance.now() - startedAt,
    resume_count: resumeCount,
  };
}

// ---------------------------------------------------------------------------
// Flow-aware claim adapter: locate the result file from the compiled flow's
// declared primary_result, then read it with family semantics. Build folds cap
// at needs_attention, so claimed-done for build is outcome !== 'failed'.

function readPrimaryResultPath(compiledFlowPath: string): string | undefined {
  if (!existsSync(compiledFlowPath)) return undefined;
  let compiled: JsonRecord;
  try {
    compiled = readJson<JsonRecord>(compiledFlowPath);
  } catch {
    return undefined;
  }
  const primary = compiled.runtime_surface?.primary_result;
  const path = primary?.path;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function buildProofQuality(result: JsonRecord): number {
  if (result.outcome === 'complete') return 3;
  if (result.outcome === 'needs_attention' && result.verification_status === 'passed') return 2;
  if (result.verification_status === 'passed') return 1;
  return 0;
}

function parseFlowClaim(family: Family, compiledFlowPath: string, runFolder: string): { claim: JsonRecord; resultLocated: boolean } {
  const relativeResultPath = readPrimaryResultPath(compiledFlowPath);
  if (relativeResultPath === undefined) {
    return { claim: { claimed_fixed: false, parse_status: 'no-primary-result', proof_quality: 0 }, resultLocated: false };
  }
  const resultPath = resolve(runFolder, relativeResultPath);
  if (!existsSync(resultPath)) {
    return { claim: { claimed_fixed: false, parse_status: 'missing-result', result_path: resultPath, proof_quality: 0 }, resultLocated: false };
  }
  const result = readJson<JsonRecord>(resultPath);
  if (family === 'fix') {
    // Reuse the fix scorer's interpreter verbatim (claimed = outcome 'fixed').
    return { claim: parseCircuitResult(result, resultPath), resultLocated: true };
  }
  // Build: folded whole-grain caps at needs_attention, so done = not failed.
  return {
    claim: {
      claimed_fixed: typeof result.outcome === 'string' && result.outcome !== 'failed',
      parse_status: 'parsed',
      result_path: resultPath,
      build_outcome: result.outcome,
      verification_status: result.verification_status,
      review_status: result.review_status,
      review_verdict: result.review_verdict,
      proof_quality: buildProofQuality(result),
    },
    resultLocated: true,
  };
}

function readStepCount(compiledFlowPath: string): number | null {
  if (!existsSync(compiledFlowPath)) return null;
  try {
    const compiled = readJson<JsonRecord>(compiledFlowPath);
    return Array.isArray(compiled.steps) ? compiled.steps.length : null;
  } catch {
    return null;
  }
}

// Pipeline integrity for a run that reached scoring: 'ok' unless the flow
// declared no primary_result or no terminal result file appeared (a trust-gate
// reject or a crash leaves the run with no result the harness can read).
function pipelineStatusForRun(resultLocated: boolean, exitCode: number | null, claim: JsonRecord): { status: string; detail?: string } {
  if (claim.parse_status === 'no-primary-result') return { status: 'no-primary-result', detail: 'compiled flow declared no runtime_surface.primary_result' };
  if (!resultLocated) {
    return { status: 'no-terminal-result', detail: `run exited ${exitCode ?? 'null'} without a terminal result file (possible trust-gate reject or crash)` };
  }
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// Arm runners.

function scoreFromRun(opts: {
  task: DynTask;
  armId: ArmId;
  exitCode: number | null;
  timedOut: boolean;
  wallclockMs: number;
  checks: CheckRun[];
  diff: DiffState;
  claim: JsonRecord;
  priceTable: PriceTable | undefined;
  runFolder: string;
}): ArmScore {
  const usage = readCircuitRunUsage(opts.runFolder);
  return scoreArm({
    task: opts.task,
    armId: opts.armId,
    run: { exit_code: opts.exitCode, timed_out: opts.timedOut, wallclock_ms: opts.wallclockMs },
    checks: opts.checks,
    diff: opts.diff,
    claim: opts.claim,
    usage: buildArmUsageScore({
      envelopes: usage?.relays.map((relay) => relay.usage) ?? [],
      table: opts.priceTable,
      ...(usage === undefined
        ? {}
        : {
            byRole: groupRelaysByRole(usage.relays),
            relayCount: usage.relay_count,
            relaysMissingUsage: usage.relays_missing_usage,
            relaysFailed: usage.relays_failed,
          }),
    }),
  });
}

async function runReferenceArm(task: DynTask, args: DynArgs, wrapperEnv: NodeJS.ProcessEnv, taskDir: string, priceTable: PriceTable | undefined): Promise<{ record: ArmRunRecord; baseline: CheckRun[]; fixtureCommit: string }> {
  const dir = resolve(taskDir, 'reference');
  const repo = resolve(dir, 'repo');
  const runFolder = resolve(dir, 'circuit-run');
  const flowRoot = resolve(dir, 'generated-flows');
  const fixtureCommit = copyFixtureRepo(task, repo);
  cpSync(GENERATED_FLOWS_ROOT, flowRoot, { recursive: true });
  const baseline = runAllChecks(repo, task, dir, 'baseline');
  const argv = [
    BIN_CIRCUIT, 'run', task.family,
    '--goal', taskGoal(task),
    '--run-folder', runFolder,
    '--flow-root', flowRoot,
    '--progress', 'jsonl',
  ];
  const driven = await driveCircuitRun({
    label: `${task.id}:reference`,
    argv,
    cwd: repo,
    env: { ...wrapperEnv, CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: flowRoot },
    runFolder,
    outputDir: dir,
    timeoutMs: args.timeoutMs,
  });
  const post = runAllChecks(repo, task, dir, 'post');
  const diff = diffState(repo, dir);
  const compiledFlowPath = resolve(flowRoot, task.family, 'circuit.json');
  const { claim, resultLocated } = parseFlowClaim(task.family, compiledFlowPath, runFolder);
  const pipeline = pipelineStatusForRun(resultLocated, driven.exit_code, claim);
  const score = scoreFromRun({ task, armId: 'reference', exitCode: driven.exit_code, timedOut: driven.timed_out, wallclockMs: driven.wallclock_ms, checks: post, diff, claim, priceTable, runFolder });
  return {
    record: { arm_id: 'reference', score, pipeline_status: pipeline.status, ...(pipeline.detail ? { pipeline_detail: pipeline.detail } : {}), generated_step_count: readStepCount(compiledFlowPath) },
    baseline,
    fixtureCommit,
  };
}

async function runGeneratedArm(task: DynTask, args: DynArgs, wrapperEnv: NodeJS.ProcessEnv, taskDir: string, priceTable: PriceTable | undefined): Promise<{ record: ArmRunRecord; baseline: CheckRun[]; fixtureCommit: string }> {
  const dir = resolve(taskDir, 'generated');
  const repo = resolve(dir, 'repo');
  const home = resolve(dir, 'home');
  const runFolder = resolve(dir, 'circuit-run');
  const fixtureCommit = copyFixtureRepo(task, repo);
  const baseline = runAllChecks(repo, task, dir, 'baseline');
  mkdirSync(home, { recursive: true });

  // create is deterministic and offline ($0). Publish into the throwaway home;
  // the manifest's flow_paths bless the default circuit.json by construction.
  const create = await runCommand({
    label: `${task.id}:generated:create`,
    command: 'node',
    argv: [BIN_CIRCUIT, 'create', '--description', task.create_description, '--publish', '--home', home, '--yes'],
    cwd: repo,
    env: wrapperEnv,
    timeoutMs: CHECK_TIMEOUT_MS,
    // Own subdir: create's stdout (the publish JSON we parse) is kept distinct
    // from the run's stdout in the arm dir.
    outputDir: resolve(dir, 'create'),
  });
  const published = parseCreateOutput(create.stdout, home);
  if (create.exit_code !== 0 || published === undefined) {
    const claim = { claimed_fixed: false, parse_status: 'create-failed', proof_quality: 0 };
    const diff = diffState(repo, dir);
    const score = scoreFromRun({ task, armId: 'generated', exitCode: create.exit_code, timedOut: create.timed_out, wallclockMs: create.wallclock_ms, checks: runAllChecks(repo, task, dir, 'post'), diff, claim, priceTable, runFolder });
    return {
      record: { arm_id: 'generated', score, pipeline_status: 'create-failed', pipeline_detail: `circuit create exited ${create.exit_code ?? 'null'} or produced no publishable flow` },
      baseline,
      fixtureCommit,
    };
  }
  if (!existsSync(published.flowPath)) {
    const claim = { claimed_fixed: false, parse_status: 'publish-missing', proof_quality: 0 };
    const diff = diffState(repo, dir);
    const score = scoreFromRun({ task, armId: 'generated', exitCode: create.exit_code, timedOut: create.timed_out, wallclockMs: create.wallclock_ms, checks: runAllChecks(repo, task, dir, 'post'), diff, claim, priceTable, runFolder });
    return {
      record: { arm_id: 'generated', score, pipeline_status: 'publish-missing', pipeline_detail: `published flow not found at ${published.flowPath}`, generated_slug: published.slug },
      baseline,
      fixtureCommit,
    };
  }

  const flowRoot = resolve(home, 'flows');
  const argv = [
    BIN_CIRCUIT, 'run', published.slug,
    '--goal', taskGoal(task),
    '--run-folder', runFolder,
    '--flow-root', flowRoot,
    '--progress', 'jsonl',
  ];
  const driven = await driveCircuitRun({
    label: `${task.id}:generated`,
    argv,
    cwd: repo,
    // No mirror root: the published manifest blesses the custom flow's default mode.
    env: wrapperEnv,
    runFolder,
    outputDir: dir,
    timeoutMs: args.timeoutMs,
  });
  const post = runAllChecks(repo, task, dir, 'post');
  const diff = diffState(repo, dir);
  const { claim, resultLocated } = parseFlowClaim(task.family, published.flowPath, runFolder);
  const pipeline = pipelineStatusForRun(resultLocated, driven.exit_code, claim);
  const score = scoreFromRun({ task, armId: 'generated', exitCode: driven.exit_code, timedOut: driven.timed_out, wallclockMs: driven.wallclock_ms, checks: post, diff, claim, priceTable, runFolder });
  return {
    record: {
      arm_id: 'generated',
      score,
      pipeline_status: pipeline.status,
      ...(pipeline.detail ? { pipeline_detail: pipeline.detail } : {}),
      generated_slug: published.slug,
      generated_step_count: readStepCount(published.flowPath),
    },
    baseline,
    fixtureCommit,
  };
}

// Parse the create stdout JSON for slug + flow_path; fall back to the manifest
// (custom_flows[]) when stdout is noisy.
function parseCreateOutput(stdout: string, home: string): { slug: string; flowPath: string } | undefined {
  const fromStdout = scanLastJsonObject(stdout);
  if (fromStdout && typeof fromStdout.slug === 'string' && typeof fromStdout.flow_path === 'string') {
    return { slug: fromStdout.slug, flowPath: fromStdout.flow_path };
  }
  const manifestPath = resolve(home, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = readJson<JsonRecord>(manifestPath);
      const entry = Array.isArray(manifest.custom_flows) ? manifest.custom_flows[manifest.custom_flows.length - 1] : undefined;
      if (entry && typeof entry.id === 'string' && typeof entry.flow_path === 'string') {
        return { slug: entry.id, flowPath: entry.flow_path };
      }
    } catch {
      // fall through
    }
  }
  return undefined;
}

function scanLastJsonObject(text: string): JsonRecord | undefined {
  const trimmed = text.trim();
  const starts: number[] = [];
  for (let i = 0; i < trimmed.length; i += 1) if (trimmed[i] === '{') starts.push(i);
  for (const start of starts.reverse()) {
    try {
      return JSON.parse(trimmed.slice(start)) as JsonRecord;
    } catch {
      // try an earlier start
    }
  }
  return undefined;
}

// The composer's compile chain, bound from the built dist tree once and reused
// across tasks. Loaded lazily so a run without --with-composed never touches dist.
let composeDepsPromise: Promise<ComposeDeps> | undefined;
function getComposeDeps(): Promise<ComposeDeps> {
  if (composeDepsPromise === undefined) {
    composeDepsPromise = loadComposeDepsFromDist(REPO_ROOT);
  }
  return composeDepsPromise;
}

// The COMPOSED arm (opt-in, fix-only). A near-clone of runGeneratedArm: same
// fixture, same isolated repo/home, same subprocess run and same scorer. The ONLY
// difference is the flow-production step — instead of shelling out to `circuit
// create --publish` (which INSTANTIATES a family template), it composes a fix flow
// block by block in process and writes it to disk exactly as publish would, so the
// trust gate and loader accept it unchanged. Fix-only because build-family
// composition is unproven; runTask gates the call on task.family === 'fix'.
async function runComposedArm(task: DynTask, args: DynArgs, wrapperEnv: NodeJS.ProcessEnv, taskDir: string, priceTable: PriceTable | undefined): Promise<{ record: ArmRunRecord; baseline: CheckRun[]; fixtureCommit: string }> {
  const dir = resolve(taskDir, 'composed');
  const repo = resolve(dir, 'repo');
  const home = resolve(dir, 'home');
  const runFolder = resolve(dir, 'circuit-run');
  const fixtureCommit = copyFixtureRepo(task, repo);
  const baseline = runAllChecks(repo, task, dir, 'baseline');
  mkdirSync(home, { recursive: true });

  // Compose + publish in process ($0, deterministic). The compile chain comes from
  // the BUILT dist tree (the harness runs npm run build first); publishComposedFlowWith
  // asserts the spec is valid AND runnable before writing, so a broken role set throws
  // here rather than aborting mid-run. The proof that the written flow is trust-accepted
  // and loadable is tests/contracts/composed-arm-plumbing.test.ts.
  let published: { slug: string; flowPath: string };
  try {
    const deps = await getComposeDeps();
    published = publishComposedFlowWith(deps, {
      roleSet: FIX_LINEAR_FULL,
      home,
      description: task.create_description,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    const claim = { claimed_fixed: false, parse_status: 'compose-failed', proof_quality: 0 };
    const diff = diffState(repo, dir);
    const score = scoreFromRun({ task, armId: 'composed', exitCode: null, timedOut: false, wallclockMs: 0, checks: runAllChecks(repo, task, dir, 'post'), diff, claim, priceTable, runFolder });
    return {
      record: { arm_id: 'composed', score, pipeline_status: 'compose-failed', pipeline_detail: err instanceof Error ? err.message : String(err) },
      baseline,
      fixtureCommit,
    };
  }

  const flowRoot = resolve(home, 'flows');
  const argv = [
    BIN_CIRCUIT, 'run', published.slug,
    '--goal', taskGoal(task),
    '--run-folder', runFolder,
    '--flow-root', flowRoot,
    '--progress', 'jsonl',
  ];
  const driven = await driveCircuitRun({
    label: `${task.id}:composed`,
    argv,
    cwd: repo,
    // No mirror root: the in-process publish blesses the composed flow's default mode.
    env: wrapperEnv,
    runFolder,
    outputDir: dir,
    timeoutMs: args.timeoutMs,
  });
  const post = runAllChecks(repo, task, dir, 'post');
  const diff = diffState(repo, dir);
  const { claim, resultLocated } = parseFlowClaim(task.family, published.flowPath, runFolder);
  const pipeline = pipelineStatusForRun(resultLocated, driven.exit_code, claim);
  const score = scoreFromRun({ task, armId: 'composed', exitCode: driven.exit_code, timedOut: driven.timed_out, wallclockMs: driven.wallclock_ms, checks: post, diff, claim, priceTable, runFolder });
  return {
    record: {
      arm_id: 'composed',
      score,
      pipeline_status: pipeline.status,
      ...(pipeline.detail ? { pipeline_detail: pipeline.detail } : {}),
      generated_slug: published.slug,
      generated_step_count: readStepCount(published.flowPath),
    },
    baseline,
    fixtureCommit,
  };
}

async function runTask(task: DynTask, args: DynArgs, wrapperEnv: NodeJS.ProcessEnv, taskDir: string, rep: number, priceTable: PriceTable | undefined): Promise<TaskSummary> {
  mkdirSync(taskDir, { recursive: true });
  writeJson(resolve(taskDir, 'task.json'), task);
  writeFileSync(resolve(taskDir, 'goal.md'), `${taskGoal(task)}\n`);
  const reference = await runReferenceArm(task, args, wrapperEnv, taskDir, priceTable);
  const generated = await runGeneratedArm(task, args, wrapperEnv, taskDir, priceTable);
  // Opt-in third arm, fix-only. Build-family composition is unproven, so it is
  // skipped there (the reference-vs-generated comparison is unaffected either way).
  const composed =
    args.withComposed && task.family === 'fix'
      ? await runComposedArm(task, args, wrapperEnv, taskDir, priceTable)
      : undefined;
  const baselines = [reference.baseline, generated.baseline, ...(composed ? [composed.baseline] : [])];
  const fixtureCommits = [reference.fixtureCommit, generated.fixtureCommit, ...(composed ? [composed.fixtureCommit] : [])];
  const summary: TaskSummary = {
    task_id: task.id,
    family: task.family,
    split: task.split,
    rep,
    fixture_commits_match: new Set(fixtureCommits).size <= 1,
    baseline_failed_as_expected: baselines.length > 0 && baselines.every((checks) => checks.some((check) => !check.passed)),
    arms: { reference: reference.record, generated: generated.record, ...(composed ? { composed: composed.record } : {}) },
  };
  writeJson(resolve(taskDir, 'summary.json'), summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Per-family roll-up (reuses rate/mean + a local nearest-rank percentile).

export type FamilyArmAggregate = JsonRecord & {
  task_count: number;
  objective_fixed_rate: number | null;
  false_fixed_rate: number | null;
  verification_pass_rate: number | null;
  median_cost_usd_computed: number | null;
  pipeline_failure_count: number;
};

function percentileFinite(values: readonly unknown[], q: number): number | null {
  const usable = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (usable.length === 0) return null;
  const rank = Math.min(usable.length - 1, Math.max(0, Math.ceil(q * usable.length) - 1));
  return usable[rank] ?? null;
}

function aggregateArm(records: ArmRunRecord[]): FamilyArmAggregate {
  const scores = records.map((r) => r.score);
  const count = scores.length;
  const costs = scores.map((s) => s.cost_usd_computed);
  return {
    task_count: count,
    objective_fixed_rate: rate(scores.filter((s) => s.objective_fixed).length, count),
    objective_fixed_count: scores.filter((s) => s.objective_fixed).length,
    false_fixed_rate: rate(scores.filter((s) => s.false_fixed).length, count),
    false_fixed_count: scores.filter((s) => s.false_fixed).length,
    verification_pass_rate: rate(scores.filter((s) => s.verification_passed).length, count),
    mean_proof_quality: mean(scores.map((s) => s.proof_quality)),
    mean_wallclock_ms: mean(scores.map((s) => s.wallclock_ms)),
    mean_cost_usd_computed: mean(costs),
    median_cost_usd_computed: percentileFinite(costs, 0.5),
    p90_cost_usd_computed: percentileFinite(costs, 0.9),
    outside_allowed_change_count: scores.reduce((sum, s) => sum + (s.outside_allowed_changed_files?.length ?? 0), 0),
    usage_missing_count: scores.filter((s) => s.usage_present !== true).length,
    price_table_miss_count: scores.filter((s) => s.price_table_miss === true).length,
    cost_divergence_flag_count: scores.filter((s) => s.cost_divergence_flag === true).length,
    claim_parse_failure_count: scores.filter((s) => s.claim?.parse_status !== 'parsed').length,
    total_relays_failed: scores.reduce((sum, s) => sum + (typeof s.relays_failed === 'number' ? s.relays_failed : 0), 0),
    pipeline_failure_count: records.filter((r) => r.pipeline_status !== 'ok').length,
  };
}

// Median computed cost over a named subset of tasks, per arm (for the build
// fold-cost criterion on B1/B2).
function medianCostForTasks(summaries: TaskSummary[], armId: ArmId, taskIds: readonly string[]): number | null {
  const costs: unknown[] = [];
  for (const s of summaries) {
    if (!taskIds.includes(s.task_id)) continue;
    const rec = s.arms[armId];
    if (rec) costs.push(rec.score.cost_usd_computed);
  }
  return percentileFinite(costs, 0.5);
}

// ---------------------------------------------------------------------------
// Section-5 decision rule (locked before data).

export type DecisionInput = {
  fix: { reference: FamilyArmAggregate; generated: FamilyArmAggregate };
  build: { reference: FamilyArmAggregate; generated: FamilyArmAggregate; foldCostReference: number | null; foldCostGenerated: number | null };
};
export type Classification = {
  verdict: 'WORTH-INVESTING' | 'MIXED' | 'NOT-YET';
  reasons: string[];
  predicates: JsonRecord;
};

// Q_gen >= Q_ref - margin, with nulls treated as failing (no data cannot pass).
function withinMargin(gen: number | null, ref: number | null, margin: number): boolean {
  if (gen === null || ref === null) return false;
  return gen >= ref - margin;
}
function notWorse(gen: number | null, ref: number | null, margin: number): boolean {
  if (gen === null || ref === null) return false;
  return gen <= ref + margin;
}

export function classifyDynamicVsReference(input: DecisionInput): Classification {
  const reasons: string[] = [];
  const qFix = withinMargin(input.fix.generated.objective_fixed_rate, input.fix.reference.objective_fixed_rate, QUALITY_MARGIN);
  const qBuild = withinMargin(input.build.generated.objective_fixed_rate, input.build.reference.objective_fixed_rate, QUALITY_MARGIN);
  const ffFix = notWorse(input.fix.generated.false_fixed_rate, input.fix.reference.false_fixed_rate, HONESTY_MARGIN);
  const ffBuild = notWorse(input.build.generated.false_fixed_rate, input.build.reference.false_fixed_rate, HONESTY_MARGIN);
  const pipelineFix = input.fix.generated.pipeline_failure_count === 0;
  const pipelineBuild = input.build.generated.pipeline_failure_count === 0;
  const pipelineClean = pipelineFix && pipelineBuild;
  const foldCostPass =
    input.build.foldCostGenerated !== null &&
    input.build.foldCostReference !== null &&
    input.build.foldCostGenerated <= input.build.foldCostReference;

  const predicates = {
    quality_fix_within_margin: qFix,
    quality_build_within_margin: qBuild,
    honesty_fix_ok: ffFix,
    honesty_build_ok: ffBuild,
    pipeline_fix_clean: pipelineFix,
    pipeline_build_clean: pipelineBuild,
    build_fold_cost_pays_for_itself: foldCostPass,
  };

  // Pipeline-integrity override + the NOT-YET conditions from section 5.
  if (!pipelineClean) {
    reasons.push('Generated arm had unexplained pipeline failures (create/publish/trust/result) — pipeline-integrity override caps the verdict at NOT-YET.');
    return { verdict: 'NOT-YET', reasons, predicates };
  }
  if (!qFix || !qBuild) {
    reasons.push('Generated objective-fixed rate fell more than 10pp below reference on at least one family.');
    return { verdict: 'NOT-YET', reasons, predicates };
  }
  if (!ffFix || !ffBuild) {
    reasons.push('Generated false-fixed rate rose more than 10pp above reference on at least one family.');
    return { verdict: 'NOT-YET', reasons, predicates };
  }
  // Quality + honesty parity holds on both families and the pipeline is clean.
  if (foldCostPass) {
    reasons.push('Quality and honesty within margin on both families, build fold pays for itself on the small/low tasks, and the generated pipeline is clean.');
    return { verdict: 'WORTH-INVESTING', reasons, predicates };
  }
  reasons.push('Quality and honesty parity holds on both families, but the build fold costs more than the reference on the small/low tasks without a correctness gain.');
  return { verdict: 'MIXED', reasons, predicates };
}

// ---------------------------------------------------------------------------
// Composed-vs-reference decision rule (sibling, locked before data).
//
// Distinct from the section-5 rule above: that one asks whether the INSTANTIATED
// flow (circuit create) is worth investing in. This one asks a different question
// — does a GENUINELY COMPOSED fix flow, assembled block by block with no family
// template, reach the hand-authored reference on quality and honesty?
//
// Fix-only (composition for build is unproven). It reuses the SAME pre-registered
// margins as the locked rule, but drops the build fold-cost criterion (meaningless
// for a short composed fix topology) and adds a pipeline-integrity predicate that
// folds in the composer's failure modes: a compose wall, a runnability abort, or a
// missing result all show up as a non-'ok' pipeline_status and cap the verdict —
// efficacy cannot be judged when the composed flow never produced a clean run.
export type ComposedDecisionInput = {
  fix: { reference: FamilyArmAggregate; composed: FamilyArmAggregate };
};
export type ComposedClassification = {
  verdict: 'COMPOSITION-VIABLE' | 'BELOW-REFERENCE' | 'PIPELINE-BROKEN';
  reasons: string[];
  predicates: JsonRecord;
};

export function classifyComposedVsReference(input: ComposedDecisionInput): ComposedClassification {
  const reasons: string[] = [];
  const quality = withinMargin(
    input.fix.composed.objective_fixed_rate,
    input.fix.reference.objective_fixed_rate,
    QUALITY_MARGIN,
  );
  const honesty = notWorse(
    input.fix.composed.false_fixed_rate,
    input.fix.reference.false_fixed_rate,
    HONESTY_MARGIN,
  );
  const pipelineClean = input.fix.composed.pipeline_failure_count === 0;
  const predicates = {
    quality_fix_within_margin: quality,
    honesty_fix_ok: honesty,
    pipeline_fix_clean: pipelineClean,
  };

  if (!pipelineClean) {
    reasons.push(
      'Composed arm had pipeline failures on fix (compose wall, runnability abort, or missing result) — efficacy cannot be judged; PIPELINE-BROKEN.',
    );
    return { verdict: 'PIPELINE-BROKEN', reasons, predicates };
  }
  if (!quality) {
    reasons.push('Composed objective-fixed rate fell more than 10pp below the hand-authored reference on fix.');
    return { verdict: 'BELOW-REFERENCE', reasons, predicates };
  }
  if (!honesty) {
    reasons.push('Composed false-fixed rate rose more than 10pp above the hand-authored reference on fix.');
    return { verdict: 'BELOW-REFERENCE', reasons, predicates };
  }
  reasons.push(
    'On fix, the genuinely composed flow matches the hand-authored reference within margin on both objective-fixed and false-fixed rate, with a clean composed pipeline.',
  );
  return { verdict: 'COMPOSITION-VIABLE', reasons, predicates };
}

// ---------------------------------------------------------------------------
// Projected spend (dry-run only). Anchors are documented estimates, not
// measurements; the live run records the real cost.

// Derived from the 2026-06-12 fix-vs-vanilla held-out ledger (claude-haiku-4-5,
// default depth ~= $0.56/fix task). Reference build is the full 9-step flow;
// the generated build folds by grain (whole ~5 steps, decomposed ~9 steps).
const COST_ANCHOR_USD = {
  fix_reference: 0.56,
  fix_generated: 0.56,
  build_reference: 0.85,
  build_generated_whole: 0.6,
  build_generated_decomposed: 1.1,
};

function generatedBuildAnchor(expectedGrain: string): number {
  return /decompos/i.test(expectedGrain) ? COST_ANCHOR_USD.build_generated_decomposed : COST_ANCHOR_USD.build_generated_whole;
}

function projectSpend(manifest: DynManifest, taskIds: string[], reps: number, withComposed: boolean): { rows: Array<{ task: string; arm: string; runs: number; anchor: number; subtotal: number }>; expected: number; low: number; high: number } {
  const rows: Array<{ task: string; arm: string; runs: number; anchor: number; subtotal: number }> = [];
  let expected = 0;
  for (const id of taskIds) {
    const family: Family = manifest.families.fix.includes(id) ? 'fix' : 'build';
    const refAnchor = family === 'fix' ? COST_ANCHOR_USD.fix_reference : COST_ANCHOR_USD.build_reference;
    const genAnchor = family === 'fix' ? COST_ANCHOR_USD.fix_generated : generatedBuildAnchor(manifest.expected_grain[id] ?? '');
    const arms: Array<[string, number]> = [['reference', refAnchor], ['generated', genAnchor]];
    // The composed arm runs only on fix tasks; anchor it at the fix per-run cost.
    if (withComposed && family === 'fix') arms.push(['composed', COST_ANCHOR_USD.fix_generated]);
    for (const [arm, anchor] of arms) {
      const subtotal = anchor * reps;
      expected += subtotal;
      rows.push({ task: id, arm, runs: reps, anchor, subtotal });
    }
  }
  return { rows, expected, low: expected * 0.65, high: expected * 1.35 };
}

// ---------------------------------------------------------------------------
// Ledger (reuses the shared schema + validator; no shared-module edit).

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function buildDynamicVsReferenceLedgerEntry(summary: JsonRecord, options: { ranAt: string; repoCommit: string; model: string }): LedgerEntry {
  const fams = summary.aggregates as Record<Family, { reference: FamilyArmAggregate; generated: FamilyArmAggregate }>;
  const metrics: Record<string, number> = {};
  const put = (key: string, value: unknown) => {
    const n = num(value);
    if (n !== undefined) metrics[key] = n;
  };
  for (const family of ['fix', 'build'] as Family[]) {
    const f = fams[family];
    if (!f) continue;
    for (const arm of ['reference', 'generated'] as ArmId[]) {
      const a = f[arm];
      const p = `${family}_${arm}_`;
      put(`${p}task_count`, a.task_count);
      put(`${p}objective_fixed_rate`, a.objective_fixed_rate);
      put(`${p}false_fixed_rate`, a.false_fixed_rate);
      put(`${p}verification_pass_rate`, a.verification_pass_rate);
      put(`${p}median_cost_usd_computed`, a.median_cost_usd_computed);
      put(`${p}mean_wallclock_ms`, a.mean_wallclock_ms);
      put(`${p}pipeline_failure_count`, a.pipeline_failure_count);
      put(`${p}usage_missing_count`, a.usage_missing_count);
      put(`${p}price_table_miss_count`, a.price_table_miss_count);
      put(`${p}claim_parse_failure_count`, a.claim_parse_failure_count);
    }
  }
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    eval_id: 'dynamic-vs-reference',
    ran_at: options.ranAt,
    repo_commit: options.repoCommit,
    model: options.model,
    descriptors: {
      provider: typeof summary.provider === 'string' ? summary.provider : 'unknown',
      effort: typeof summary.effort === 'string' ? summary.effort : 'unknown',
      pin_model: String(summary.pin_model === true),
      verdict: typeof summary.classification?.verdict === 'string' ? summary.classification.verdict : 'unknown',
    },
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Report.

function fmtRate(value: number | null | undefined): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}
function fmtUsd(value: number | null | undefined): string {
  return value == null ? 'n/a' : `$${value.toFixed(4)}`;
}
function fmtMs(value: number | null | undefined): string {
  return value == null ? 'n/a' : `${Math.round(value)} ms`;
}

function renderFamilyTable(family: Family, agg: { reference: FamilyArmAggregate; generated: FamilyArmAggregate }): string {
  const r = agg.reference;
  const g = agg.generated;
  return `### ${family}

| Arm | Objective-fixed (Q) | False-fixed (FF) | Verification | Median cost | Wallclock | Pipeline failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| reference | ${fmtRate(r.objective_fixed_rate)} | ${fmtRate(r.false_fixed_rate)} | ${fmtRate(r.verification_pass_rate)} | ${fmtUsd(r.median_cost_usd_computed)} | ${fmtMs(r.mean_wallclock_ms)} | ${r.pipeline_failure_count} |
| generated | ${fmtRate(g.objective_fixed_rate)} | ${fmtRate(g.false_fixed_rate)} | ${fmtRate(g.verification_pass_rate)} | ${fmtUsd(g.median_cost_usd_computed)} | ${fmtMs(g.mean_wallclock_ms)} | ${g.pipeline_failure_count} |`;
}

function renderComposedSection(summary: JsonRecord): string {
  const cmp = summary.composed_vs_reference as
    | { fix: { reference: FamilyArmAggregate; composed: FamilyArmAggregate }; classification: ComposedClassification }
    | undefined;
  if (cmp === undefined) return '';
  const r = cmp.fix.reference;
  const c = cmp.fix.composed;
  return `
## Composed-vs-reference (fix, genuine block-level composition)

This arm runs a fix flow composed block by block (FIX_LINEAR_FULL), not
instantiated from a family template. It is scored by the same hidden objective
tests as the other arms. The verdict below uses the sibling composed rule, not
the section-5 rule.

**${cmp.classification.verdict}**

${cmp.classification.reasons.map((reason) => `- ${reason}`).join('\n')}

Predicates: ${JSON.stringify(cmp.classification.predicates)}

| Arm | Objective-fixed (Q) | False-fixed (FF) | Verification | Median cost | Wallclock | Pipeline failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| reference | ${fmtRate(r.objective_fixed_rate)} | ${fmtRate(r.false_fixed_rate)} | ${fmtRate(r.verification_pass_rate)} | ${fmtUsd(r.median_cost_usd_computed)} | ${fmtMs(r.mean_wallclock_ms)} | ${r.pipeline_failure_count} |
| composed | ${fmtRate(c.objective_fixed_rate)} | ${fmtRate(c.false_fixed_rate)} | ${fmtRate(c.verification_pass_rate)} | ${fmtUsd(c.median_cost_usd_computed)} | ${fmtMs(c.mean_wallclock_ms)} | ${c.pipeline_failure_count} |
`;
}

function renderReport(summary: JsonRecord): string {
  const aggregates = summary.aggregates as Record<Family, { reference: FamilyArmAggregate; generated: FamilyArmAggregate }>;
  const classification = summary.classification as Classification;
  const build = summary.build_fold_cost as { reference: number | null; generated: number | null };
  return `# Dynamic-vs-Reference Report

Run: ${summary.result_root}
Model: ${summary.model} (pinned: ${summary.pin_model})
Effort: ${summary.effort}
Repo commit: ${summary.repo_commit}

## Verdict (section-5 rule applied to the measured numbers)

**${classification.verdict}**

${classification.reasons.map((r) => `- ${r}`).join('\n')}

Predicates: ${JSON.stringify(classification.predicates)}

## Per-family metrics

${renderFamilyTable('fix', aggregates.fix)}

${renderFamilyTable('build', aggregates.build)}

Build fold cost (median per-task computed cost on B1/B2): reference ${fmtUsd(build.reference)} vs generated ${fmtUsd(build.generated)}.
${renderComposedSection(summary)}
## Tasks

${(summary.tasks as TaskSummary[])
  .map((t) => {
    const ref = t.arms.reference;
    const gen = t.arms.generated;
    const composed = t.arms.composed;
    const cell = (rec: ArmRunRecord | undefined) =>
      rec === undefined
        ? 'not run'
        : `fixed=${rec.score.objective_fixed}, false-fixed=${rec.score.false_fixed}, pipeline=${rec.pipeline_status}${rec.generated_step_count != null ? `, steps=${rec.generated_step_count}` : ''}`;
    const composedCell = composed ? `; composed [${cell(composed)}]` : '';
    return `- ${t.task_id} (${t.family}, rep ${t.rep}): reference [${cell(ref)}]; generated [${cell(gen)}]${composedCell}`;
  })
  .join('\n')}
`;
}

// ---------------------------------------------------------------------------
// Main.

async function main(): Promise<void> {
  const manifest = readJson<DynManifest>(MANIFEST_PATH);
  const args = parseDynArgs(process.argv.slice(2), manifest);
  const taskIds = selectedTaskIds(manifest, args);
  const tasks = taskIds.map(loadTask);
  const runLabel = args.taskId ?? args.family ?? 'all';
  const resultRoot = createResultRoot(args.outDir, runLabel);

  const projection = projectSpend(manifest, taskIds, args.reps, args.withComposed);
  const metadata = {
    schema_version: 1,
    benchmark_id: manifest.benchmark_id,
    result_root: resultRoot,
    repo_root: REPO_ROOT,
    repo_commit: repoMetadata(REPO_ROOT).repo_commit,
    git_status_short: commandOutput('git', ['status', '--short'], '', { cwd: REPO_ROOT }),
    provider: args.provider,
    model: args.model,
    effort: args.effort,
    pin_model: args.pinModel,
    timeout_ms: args.timeoutMs,
    reps: args.reps,
    generated_arm_mode: 'default-only',
    task_ids: taskIds,
    dry_run: args.dryRun,
    projected_spend_usd: { expected: projection.expected, low: projection.low, high: projection.high, total_live_runs: projection.rows.reduce((sum, r) => sum + r.runs, 0) },
  };
  writeJson(resolve(resultRoot, 'metadata.json'), metadata);

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
    process.stdout.write('\nProjected spend (anchors from the 2026-06-12 fix-vs-vanilla ledger; live run records the real cost):\n');
    for (const row of projection.rows) {
      process.stdout.write(`  ${row.task.padEnd(22)} ${row.arm.padEnd(10)} ${row.runs} run(s) x $${row.anchor.toFixed(2)} = $${row.subtotal.toFixed(2)}\n`);
    }
    process.stdout.write(`\n  Total live runs: ${projection.rows.reduce((sum, r) => sum + r.runs, 0)}\n`);
    process.stdout.write(`  Projected spend: ~$${projection.expected.toFixed(2)} (band $${projection.low.toFixed(2)}-$${projection.high.toFixed(2)})\n`);
    process.stdout.write(`  Model to pin: ${args.model} (pin_model=${args.pinModel})\n`);
    process.stdout.write(`\nDry run only. No model spend. Results directory prepared at ${resultRoot}\n`);
    return;
  }

  const realClaude = findExecutable('claude', { required: true });
  const wrapper = createClaudeCodeWrapper(realClaude, args.model, args.effort, {
    tempPrefix: 'dyn-vs-ref-claude-',
    forceModel: args.pinModel,
  });
  const priceTable = loadPriceTable(PRICES_DIR);
  if (priceTable === undefined) {
    process.stderr.write('warning: no price table under evals/ledger/prices; cost_usd_computed will be absent\n');
  }

  if (!args.skipBuild) {
    process.stderr.write('Building compiled Circuit CLI before comparison...\n');
    const build = runSync('npm', ['run', 'build'], { cwd: REPO_ROOT });
    writeFileSync(resolve(resultRoot, 'build.stdout.txt'), build.stdout);
    writeFileSync(resolve(resultRoot, 'build.stderr.txt'), build.stderr);
    if (build.status !== 0) throw new Error(`npm run build failed; see ${resolve(resultRoot, 'build.stderr.txt')}`);
    const bundle = runSync('npm', ['run', 'build-plugin-runtime'], { cwd: REPO_ROOT });
    writeFileSync(resolve(resultRoot, 'build-plugin-runtime.stdout.txt'), bundle.stdout);
    writeFileSync(resolve(resultRoot, 'build-plugin-runtime.stderr.txt'), bundle.stderr);
    if (bundle.status !== 0) throw new Error(`npm run build-plugin-runtime failed; see ${resolve(resultRoot, 'build-plugin-runtime.stderr.txt')}`);
  }

  const summaries: TaskSummary[] = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= args.reps; rep += 1) {
      const taskDir = args.reps === 1
        ? resolve(resultRoot, 'tasks', task.id)
        : resolve(resultRoot, 'tasks', task.id, `rep-${String(rep).padStart(2, '0')}`);
      process.stderr.write(`\nRunning ${task.id} (${task.family}) rep ${rep}/${args.reps}...\n`);
      summaries.push(await runTask(task, args, wrapper.env, taskDir, rep, priceTable));
    }
  }

  const byFamily = (family: Family) => {
    const fam = summaries.filter((s) => s.family === family);
    const refRecords = fam.map((s) => s.arms.reference).filter((r): r is ArmRunRecord => r !== undefined);
    const genRecords = fam.map((s) => s.arms.generated).filter((r): r is ArmRunRecord => r !== undefined);
    return { reference: aggregateArm(refRecords), generated: aggregateArm(genRecords) };
  };
  const aggregates = { fix: byFamily('fix'), build: byFamily('build') };
  const foldCostReference = medianCostForTasks(summaries, 'reference', manifest.fold_cost_tasks);
  const foldCostGenerated = medianCostForTasks(summaries, 'generated', manifest.fold_cost_tasks);
  const classification = classifyDynamicVsReference({
    fix: aggregates.fix,
    build: { ...aggregates.build, foldCostReference, foldCostGenerated },
  });

  // Opt-in composed-vs-reference comparison (fix-only). Additive: it never feeds
  // the section-5 verdict above. Present only when the composed arm actually ran.
  const composedFixRecords = summaries
    .filter((s) => s.family === 'fix')
    .map((s) => s.arms.composed)
    .filter((r): r is ArmRunRecord => r !== undefined);
  const composedComparison =
    composedFixRecords.length > 0
      ? (() => {
          const composed = aggregateArm(composedFixRecords);
          const fix = { reference: aggregates.fix.reference, composed };
          return { fix, classification: classifyComposedVsReference({ fix }) };
        })()
      : undefined;

  const summary = {
    ...metadata,
    dry_run: false,
    tasks: summaries,
    aggregates,
    build_fold_cost: { reference: foldCostReference, generated: foldCostGenerated, tasks: manifest.fold_cost_tasks },
    classification,
    ...(composedComparison ? { composed_vs_reference: composedComparison } : {}),
  };
  writeJson(resolve(resultRoot, 'summary.json'), summary);
  writeFileSync(resolve(resultRoot, 'report.md'), renderReport(summary));

  // Append the scrubbed ledger row (validated before write).
  const ranAt = new Date().toISOString();
  const ledgerEntry = buildDynamicVsReferenceLedgerEntry(summary, { ranAt, repoCommit: summary.repo_commit, model: args.model });
  const problems = validateLedgerEntry(ledgerEntry, 'dynamic-vs-reference ledger');
  if (problems.length > 0) {
    process.stderr.write(`warning: ledger entry not written (validation failed):\n${problems.join('\n')}\n`);
  } else {
    mkdirSync(LEDGER_DIR, { recursive: true });
    const fileName = `${ranAt.replace(/[:.]/g, '-')}-${safeSegment(args.model)}.json`;
    writeJson(resolve(LEDGER_DIR, fileName), ledgerEntry);
  }

  const composedLine = composedComparison
    ? `\nComposed-vs-reference verdict (fix): ${composedComparison.classification.verdict}`
    : '';
  process.stdout.write(`\nComparison complete. Verdict: ${classification.verdict}${composedLine}\nResults: ${resultRoot}\nReport: ${resolve(resultRoot, 'report.md')}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    __filename === resolve(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`dynamic-vs-reference comparison failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
