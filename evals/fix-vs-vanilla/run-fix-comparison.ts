#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CIRCUIT_MODES,
  type CircuitMode,
  circuitModeArgs,
  isCircuitMode,
} from '../../scripts/evals/fix-vs-vanilla/circuit-mode.ts';
import {
  type TaskSummary as AggregateTaskSummary,
  type ArmScore,
  aggregate,
  decideClaim,
  parseCircuitClaim,
  parseVanillaEnvelopeClaim,
  scoreArm,
} from '../../scripts/evals/fix-vs-vanilla/scoring.ts';
import { readJson, safeSegment, writeJson } from '../../scripts/evals/shared/json.ts';
import { createResultRoot, repoMetadata } from '../../scripts/evals/shared/metadata.ts';
import {
  type RunCommandMetadata,
  commandOutput,
  findExecutable,
  runCommand,
  runSync,
} from '../../scripts/evals/shared/process.ts';
import {
  createClaudeCodeWrapper,
  vanillaClaudeArgs,
} from '../../scripts/evals/shared/providers.ts';
import {
  type PriceTable,
  buildArmUsageScore,
  groupRelaysByRole,
  loadPriceTable,
  parseVanillaEnvelope,
  readCircuitRunUsage,
} from '../../scripts/evals/shared/usage.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const MANIFEST_PATH = resolve(__dirname, 'manifest.json');
const DEFAULT_RESULTS_ROOT = resolve(__dirname, 'results');

// This harness walks arbitrary parsed JSON: task manifests, run summaries, per-arm aggregates.
// Those shapes are the eval data, not a contract we own. Narrowing to unknown costs 40-plus casts
// at the access sites and buys no safety over data we already trust enough to compare arms on.
// biome-ignore lint/suspicious/noExplicitAny: parsed eval JSON, shape owned by the data
type JsonRecord = Record<string, any>;
type TaskSet = 'discovery' | 'regression' | 'held-out';
type RequestedTaskSet = TaskSet | 'all';
type CheckDefinition = {
  id: string;
  argv: string[];
  // A hidden check's test code never ships in the repo the agent edits. Its
  // files live in the task's `objective/` directory and the harness overlays
  // them onto a throwaway copy of the repo at scoring time. This keeps the
  // objective checks out of the agent's reach so a symptom patch can be caught.
  hidden?: boolean;
};
export type FixManifest = {
  benchmark_id: string;
  default_provider: string;
  default_model: string;
  default_effort: string;
  default_timeout_ms: number;
  sets: Record<TaskSet, string[]>;
};
// Which arm(s) to run. `both` is the measurement default; the single-arm modes
// exist for calibration, where we run the vanilla arm alone, many times, to see
// how often it false-fixes a candidate trap.
export type FixArm = 'both' | 'circuit' | 'vanilla';
export type FixArgs = {
  set: RequestedTaskSet;
  taskId: string | undefined;
  provider: string;
  model: string;
  effort: string;
  timeoutMs: number;
  circuitMode: CircuitMode;
  // Power dial position for the Circuit arm. When set, the harness emits
  // `--power <value>` so the dial materializes its per-role model allocation
  // (researcher/implementer/reviewer). Undefined leaves the CLI default (the
  // dial's own default-on medium).
  circuitPower: 'low' | 'medium' | 'high' | undefined;
  // Force both arms onto a single model by overriding the wrapper. Pins the
  // Circuit arm so the dial cannot give it a stronger per-role stack — the only
  // way to run a true same-model structure comparison.
  pinModel: boolean;
  arm: FixArm;
  reps: number;
  outDir: string;
  skipBuild: boolean;
  dryRun: boolean;
};
type FixTask = JsonRecord & {
  id: string;
  split: string;
  prompt: string;
  checks: CheckDefinition[];
  allowed_changed_files: string[];
  task_root: string;
  repo_template: string;
  // Directory of hidden objective-check files, overlaid at scoring time. May not
  // exist for tasks whose checks all run in-repo.
  objective_template: string;
};
type CheckRun = JsonRecord & {
  id: string;
  argv: string[];
  passed: boolean;
};
type DiffState = {
  changed_files: string[];
  git_status_short: string;
  diff_path: string;
  status_path: string;
};
type TaskSummary = AggregateTaskSummary &
  JsonRecord & {
    task_id: string;
    arms: Record<string, ArmScore>;
  };
type FixSummary = JsonRecord & {
  result_root: string;
  provider: string;
  model: string;
  effort: string;
  repo_commit: string;
  claim: { supported: boolean; reason: string };
  aggregates: Record<string, Record<string, JsonRecord>>;
  tasks: TaskSummary[];
};

function usage(): string {
  return `Usage:
  node evals/fix-vs-vanilla/run-fix-comparison.ts \\
    [--set discovery|regression|held-out|all] \\
    [--task-id <id>] \\
    [--provider claude-code] \\
    [--model <model-id>] \\
    [--effort low|medium|high|xhigh] \\
    [--timeout-ms 900000] \\
    [--circuit-mode default|low|medium|high|autonomous] \\
    [--circuit-power low|medium|high] \\
    [--pin-model] \\
    [--arm both|circuit|vanilla] \\
    [--reps N] \\
    [--out-dir evals/fix-vs-vanilla/results] \\
    [--skip-build] \\
    [--dry-run]

Runs isolated bug-fix tasks through Circuit Fix and a strong vanilla Claude Code
prompt. Primary scoring is false-fixed rate: claimed fixed while objective
checks still fail.

--arm runs a single arm (vanilla-only skips the Circuit build, for calibration).
--reps runs each task N times into per-rep subdirs; rates aggregate over task x rep.
`;
}

// Pure arg parsing: the manifest (defaults) is injected so this can be unit
// tested without touching disk. main() loads the manifest and calls this.
export function parseFixArgs(argv: string[], manifest: FixManifest): FixArgs {
  const args: FixArgs = {
    set: 'held-out',
    taskId: undefined,
    provider: manifest.default_provider,
    model: manifest.default_model,
    effort: manifest.default_effort,
    timeoutMs: manifest.default_timeout_ms,
    circuitMode: 'default',
    circuitPower: undefined,
    pinModel: false,
    arm: 'both',
    reps: 1,
    outDir: DEFAULT_RESULTS_ROOT,
    skipBuild: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--set') {
      args.set = requireValue(argv, i, arg) as RequestedTaskSet;
      i += 1;
    } else if (arg === '--task-id') {
      args.taskId = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--provider') {
      args.provider = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--model') {
      args.model = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--effort') {
      args.effort = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--circuit-mode') {
      args.circuitMode = requireValue(argv, i, arg) as CircuitMode;
      i += 1;
    } else if (arg === '--circuit-power') {
      args.circuitPower = requireValue(argv, i, arg) as 'low' | 'medium' | 'high';
      i += 1;
    } else if (arg === '--pin-model') {
      args.pinModel = true;
    } else if (arg === '--arm') {
      args.arm = requireValue(argv, i, arg) as FixArm;
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
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  if (!['discovery', 'regression', 'held-out', 'all'].includes(args.set)) {
    throw new Error('--set must be one of discovery, regression, held-out, or all');
  }
  if (args.provider !== 'claude-code') {
    throw new Error('this bug-fix pilot currently supports --provider claude-code only');
  }
  if (!['low', 'medium', 'high', 'xhigh'].includes(args.effort)) {
    throw new Error('--effort must be one of low, medium, high, or xhigh');
  }
  if (!isCircuitMode(args.circuitMode)) {
    throw new Error(`--circuit-mode must be one of ${CIRCUIT_MODES.join(', ')}`);
  }
  if (args.circuitPower !== undefined && !['low', 'medium', 'high'].includes(args.circuitPower)) {
    throw new Error('--circuit-power must be one of low, medium, or high');
  }
  if (!['both', 'circuit', 'vanilla'].includes(args.arm)) {
    throw new Error('--arm must be one of both, circuit, or vanilla');
  }
  if (!Number.isInteger(args.reps) || args.reps <= 0) {
    throw new Error('--reps must be a positive integer');
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }

  return args;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function selectedTaskIds(manifest: FixManifest, args: FixArgs): string[] {
  const allIds = [
    ...manifest.sets.discovery,
    ...manifest.sets.regression,
    ...manifest.sets['held-out'],
  ];
  if (args.taskId !== undefined) {
    if (!allIds.includes(args.taskId)) throw new Error(`unknown task id: ${args.taskId}`);
    return [args.taskId];
  }
  if (args.set === 'all') return allIds;
  return manifest.sets[args.set];
}

function loadTask(taskId: string): FixTask {
  const taskRoot = resolve(__dirname, 'tasks', taskId);
  const taskPath = resolve(taskRoot, 'task.json');
  if (!existsSync(taskPath)) throw new Error(`task file not found: ${taskPath}`);
  const task = readJson<JsonRecord>(taskPath);
  return {
    ...(task as FixTask),
    task_root: taskRoot,
    repo_template: resolve(taskRoot, 'repo'),
    objective_template: resolve(taskRoot, 'objective'),
  };
}

function initFixtureRepo(repoDir: string): string {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fix Benchmark',
    GIT_AUTHOR_EMAIL: 'fix-benchmark@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Fix Benchmark',
    GIT_COMMITTER_EMAIL: 'fix-benchmark@example.invalid',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const steps: Array<[string, string[]]> = [
    ['git', ['init', '--quiet']],
    ['git', ['config', 'commit.gpgsign', 'false']],
    ['git', ['config', 'user.name', 'Fix Benchmark']],
    ['git', ['config', 'user.email', 'fix-benchmark@example.invalid']],
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
  if (head.status !== 0) return 'unavailable';
  return head.stdout.trim() || 'unavailable';
}

function copyFixtureRepo(task: FixTask, dest: string): string {
  mkdirSync(dest, { recursive: true });
  cpSync(task.repo_template, dest, { recursive: true });
  return initFixtureRepo(dest);
}

function taskGoal(task: FixTask): string {
  // The goal names only the regression command the bug report references. The
  // harness's other checks are private ground truth. Revealing them would tell
  // the agent exactly what to satisfy, so no agent would ever false-fix, and the
  // eval could not separate a thorough fix from a symptom patch. Both arms get
  // this identical, check-blind goal — the comparison is which process leaves
  // the hidden checks passing more often.
  return `${task.prompt}

Acceptance:
- First confirm the regression by running the regression command before the fix.
- Make only the focused fix needed for this task.
- Rerun the regression command after the fix and leave it passing.
- Fix the underlying cause, not just the one symptom the regression command shows.

Allowed changed files:
${task.allowed_changed_files.map((file) => `- ${file}`).join('\n')}`;
}

function vanillaPrompt(task: FixTask): string {
  return `You are the vanilla coding-agent arm in a fair Circuit Fix benchmark.

Use the same repo and tools as the Circuit arm, but do not invoke Circuit, /circuit commands, bin/circuit, or any Circuit runtime.

Strong process:
1. Inspect the relevant files before editing.
2. Run the regression command before the fix and confirm it fails for the reported bug.
3. Make the smallest focused code change you can.
4. Rerun the same regression command after the fix.
5. Do not claim the bug is fixed unless the regression failed before the fix, passes after the fix, and you have verified the fix addresses the root cause rather than only the one symptom the regression command exercises.
6. Keep changed files inside the allowed list unless the task truly requires otherwise. If you go outside the list, say so.

${taskGoal(task)}

End your final answer with a fenced JSON object using this exact shape:

\`\`\`json
{
  "claimed_fixed": true,
  "changed_files": ["src/example.ts"],
  "commands_run": [
    {"command": "npm test", "status": "failed-before"},
    {"command": "npm test", "status": "passed-after"}
  ],
  "regression_proof": {
    "command": "npm test",
    "failed_before": true,
    "passed_after": true
  },
  "residual_risks": []
}
\`\`\``;
}

function runChecks(
  repoDir: string,
  checks: readonly CheckDefinition[],
  outputDir: string,
  phase: string,
): CheckRun[] {
  mkdirSync(outputDir, { recursive: true });
  return checks.map((check) => {
    const command = check.argv[0];
    if (command === undefined) throw new Error(`check ${check.id} has an empty argv`);
    const result = runSync(command, check.argv.slice(1), {
      cwd: repoDir,
      timeoutMs: 120_000,
    });
    const base = resolve(outputDir, `${phase}-${safeSegment(check.id)}`);
    writeFileSync(`${base}.stdout.txt`, result.stdout);
    writeFileSync(`${base}.stderr.txt`, result.stderr);
    return {
      id: check.id,
      argv: check.argv,
      exit_code: result.status,
      signal: result.signal,
      passed: result.status === 0,
      stdout_path: `${base}.stdout.txt`,
      stderr_path: `${base}.stderr.txt`,
      error: result.error,
    };
  });
}

// Run a task's hidden objective checks without ever exposing their test code to
// the agent. The agent's repo (`baseRepoDir`) is copied to a throwaway dir, the
// task's `objective/` files are overlaid on top, and the hidden checks run there
// against whatever the agent left in `src/`. The copy is discarded afterward.
function runHiddenChecks(
  baseRepoDir: string,
  task: FixTask,
  hidden: readonly CheckDefinition[],
  outputDir: string,
  phase: string,
): CheckRun[] {
  if (!existsSync(task.objective_template)) {
    throw new Error(
      `task ${task.id} declares hidden checks but has no objective/ directory at ${task.objective_template}`,
    );
  }
  const scoringDir = mkdtempSync(resolve(tmpdir(), `fix-hidden-${safeSegment(task.id)}-`));
  try {
    cpSync(baseRepoDir, scoringDir, { recursive: true });
    cpSync(task.objective_template, scoringDir, { recursive: true });
    return runChecks(scoringDir, hidden, outputDir, `${phase}-hidden`);
  } finally {
    rmSync(scoringDir, { recursive: true, force: true });
  }
}

// All of a task's checks, scored as one set. Visible checks run in the agent's
// repo (the agent saw and was asked to satisfy the regression). Hidden checks
// run against an overlay copy so their test code stays out of the agent's tree.
// The combined result feeds scoreArm unchanged: objective_fixed stays "every
// check passed".
function runAllChecks(
  repoDir: string,
  task: FixTask,
  outputDir: string,
  phase: string,
): CheckRun[] {
  const visible = task.checks.filter((check) => check.hidden !== true);
  const hidden = task.checks.filter((check) => check.hidden === true);
  const results = runChecks(repoDir, visible, outputDir, phase);
  if (hidden.length > 0) {
    results.push(...runHiddenChecks(repoDir, task, hidden, outputDir, phase));
  }
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
  return {
    changed_files: changedFiles,
    git_status_short: status.stdout,
    diff_path: resolve(outputDir, 'diff.txt'),
    status_path: resolve(outputDir, 'git-status.txt'),
  };
}

function fixRunMetadata(
  metadataBase: RunCommandMetadata,
): Omit<RunCommandMetadata, 'stdout_path' | 'stderr_path'> {
  const { stdout_path: _stdoutPath, stderr_path: _stderrPath, ...metadata } = metadataBase;
  return metadata;
}

async function runTask({
  task,
  args,
  wrapper,
  taskDir,
  rep,
  priceTable,
}: {
  task: FixTask;
  args: FixArgs;
  wrapper: { env: NodeJS.ProcessEnv };
  taskDir: string;
  rep: number;
  priceTable: PriceTable | undefined;
}): Promise<TaskSummary> {
  // `both` runs each side; the single-arm modes let calibration runs drive the
  // vanilla arm alone (no Circuit build, no Circuit repo).
  const runCircuit = args.arm !== 'vanilla';
  const runVanilla = args.arm !== 'circuit';
  mkdirSync(taskDir, { recursive: true });
  writeJson(resolve(taskDir, 'task.json'), task);
  writeFileSync(resolve(taskDir, 'goal.md'), `${taskGoal(task)}\n`);
  if (runVanilla) {
    writeFileSync(resolve(taskDir, 'vanilla-prompt.md'), `${vanillaPrompt(task)}\n`);
  }

  const arms: Record<string, ArmScore> = {};
  const baseline: Record<string, CheckRun[]> = {};
  const fixtureCommits: string[] = [];

  if (runCircuit) {
    const circuitDir = resolve(taskDir, 'circuit-claude-code');
    const circuitRepo = resolve(circuitDir, 'repo');
    const circuitRunFolder = resolve(circuitDir, 'circuit-run');
    const circuitFlowRoot = resolve(circuitDir, 'generated-flows');
    const circuitCommit = copyFixtureRepo(task, circuitRepo);
    cpSync(resolve(REPO_ROOT, 'generated', 'flows'), circuitFlowRoot, { recursive: true });
    const baselineCircuit = runAllChecks(circuitRepo, task, circuitDir, 'baseline');
    const circuitArgs = [
      resolve(REPO_ROOT, 'bin/circuit'),
      'run',
      'fix',
      '--goal',
      taskGoal(task),
      ...circuitModeArgs(args.circuitMode),
      ...(args.circuitPower ? ['--power', args.circuitPower] : []),
      '--run-folder',
      circuitRunFolder,
      '--flow-root',
      circuitFlowRoot,
      '--progress',
      'jsonl',
    ];
    const circuitRun = await runCommand({
      label: `${task.id}:circuit`,
      command: 'node',
      argv: circuitArgs,
      cwd: circuitRepo,
      env: {
        ...wrapper.env,
        CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: circuitFlowRoot,
      },
      timeoutMs: args.timeoutMs,
      outputDir: circuitDir,
      metadataBuilder: fixRunMetadata,
    });
    const circuitPostChecks = runAllChecks(circuitRepo, task, circuitDir, 'post');
    const circuitDiff = diffState(circuitRepo, circuitDir);
    // Per-relay usage from the run trace; each relay attempt counts, so
    // verdict-check retries are included in the arm's cost.
    const circuitUsage = readCircuitRunUsage(circuitRunFolder);
    arms['circuit-claude-code'] = scoreArm({
      task,
      armId: 'circuit-claude-code',
      run: circuitRun,
      checks: circuitPostChecks,
      diff: circuitDiff,
      claim: parseCircuitClaim(circuitRunFolder),
      usage: buildArmUsageScore({
        envelopes: circuitUsage?.relays.map((relay) => relay.usage) ?? [],
        table: priceTable,
        ...(circuitUsage === undefined
          ? {}
          : {
              byRole: groupRelaysByRole(circuitUsage.relays),
              relayCount: circuitUsage.relay_count,
              relaysMissingUsage: circuitUsage.relays_missing_usage,
              relaysFailed: circuitUsage.relays_failed,
            }),
      }),
    });
    baseline['circuit-claude-code'] = baselineCircuit;
    fixtureCommits.push(circuitCommit);
  }

  if (runVanilla) {
    const vanillaDir = resolve(taskDir, 'vanilla-claude-code');
    const vanillaRepo = resolve(vanillaDir, 'repo');
    const vanillaCommit = copyFixtureRepo(task, vanillaRepo);
    const baselineVanilla = runAllChecks(vanillaRepo, task, vanillaDir, 'baseline');
    const vanillaRun = await runCommand({
      label: `${task.id}:vanilla`,
      command: 'claude',
      argv: vanillaClaudeArgs(vanillaPrompt(task), { jsonEnvelope: true }),
      cwd: vanillaRepo,
      env: wrapper.env,
      timeoutMs: args.timeoutMs,
      outputDir: vanillaDir,
      metadataBuilder: fixRunMetadata,
    });
    const vanillaPostChecks = runAllChecks(vanillaRepo, task, vanillaDir, 'post');
    const vanillaDiff = diffState(vanillaRepo, vanillaDir);
    // The envelope must be unwrapped before claim parsing: the last-JSON-object
    // claim parser would otherwise parse the envelope itself and report
    // claimed_fixed false for every vanilla run. When the envelope cannot be
    // parsed at all (timeout, truncation) the claim is recorded as unparsed
    // rather than guessed from raw stdout, which would re-open the same
    // shadowing hole; usage is recorded as absent.
    const vanillaEnvelope = parseVanillaEnvelope(vanillaRun.stdout);
    arms['vanilla-claude-code'] = scoreArm({
      task,
      armId: 'vanilla-claude-code',
      run: vanillaRun,
      checks: vanillaPostChecks,
      diff: vanillaDiff,
      claim: parseVanillaEnvelopeClaim(vanillaEnvelope),
      usage: buildArmUsageScore({
        envelopes: vanillaEnvelope === undefined ? [] : [vanillaEnvelope.usage],
        table: priceTable,
      }),
    });
    baseline['vanilla-claude-code'] = baselineVanilla;
    fixtureCommits.push(vanillaCommit);
  }

  // The fixture is identical per arm, so a single failing baseline proves the
  // bug reproduced. With both arms we require both; with one, just that one.
  const baselineChecks = Object.values(baseline);
  const taskSummary = {
    task_id: task.id,
    split: task.split,
    rep,
    arm: args.arm,
    fixture_commits_match: new Set(fixtureCommits).size <= 1,
    fixture_commit: fixtureCommits[0] ?? 'unavailable',
    baseline_failed_as_expected:
      baselineChecks.length > 0 &&
      baselineChecks.every((checks) => checks.some((check) => !check.passed)),
    baseline,
    arms,
  };
  writeJson(resolve(taskDir, 'summary.json'), taskSummary);
  return taskSummary;
}

export function renderReport(summary: FixSummary): string {
  const heldOut = summary.aggregates['held-out'] ?? {};
  const circuit = heldOut['circuit-claude-code'] ?? {};
  const vanilla = heldOut['vanilla-claude-code'] ?? {};
  return `# Fix-vs-Vanilla Report

Run: ${summary.result_root}

Provider: ${summary.provider}
Model: ${summary.model}
Effort: ${summary.effort}
Repo commit: ${summary.repo_commit}

## Claim

${summary.claim.supported ? 'Supported' : 'Not supported'}: ${summary.claim.reason}

Circuit only gets a product claim from held-out tasks. Discovery and regression
tasks are not counted as measurement wins.

## Held-Out Metrics

| Arm | False-fixed | Fixed | Proof quality | Verification | Changed files | Wallclock | Cost (computed) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Circuit Fix | ${formatRate(circuit.false_fixed_rate)} | ${formatRate(circuit.objective_fixed_rate)} | ${formatNumber(circuit.mean_proof_quality)} | ${formatRate(circuit.verification_pass_rate)} | ${formatNumber(circuit.mean_changed_file_count)} | ${formatMs(circuit.mean_wallclock_ms)} | ${formatUsd(circuit.total_cost_usd_computed)} |
| Vanilla strong prompt | ${formatRate(vanilla.false_fixed_rate)} | ${formatRate(vanilla.objective_fixed_rate)} | ${formatNumber(vanilla.mean_proof_quality)} | ${formatRate(vanilla.verification_pass_rate)} | ${formatNumber(vanilla.mean_changed_file_count)} | ${formatMs(vanilla.mean_wallclock_ms)} | ${formatUsd(vanilla.total_cost_usd_computed)} |

Per-task computed cost: Circuit median ${formatUsd(circuit.median_cost_usd_computed)} / p90 ${formatUsd(circuit.p90_cost_usd_computed)}; vanilla median ${formatUsd(vanilla.median_cost_usd_computed)} / p90 ${formatUsd(vanilla.p90_cost_usd_computed)}.

Cost bookkeeping: ${costBookkeepingLine(circuit)} (Circuit); ${costBookkeepingLine(vanilla)} (vanilla).

## Tasks

${summary.tasks
  .map(
    (task) =>
      `- ${task.task_id} (${task.split}): Circuit ${formatTaskScore(task.arms['circuit-claude-code'])}; vanilla ${formatTaskScore(task.arms['vanilla-claude-code'])}`,
  )
  .join('\n')}
`;
}

function formatTaskScore(score: JsonRecord | undefined): string {
  // A single-arm run leaves the other arm absent; say so instead of crashing.
  if (score?.claim === undefined) return 'not run';
  const review =
    score.claim.review_status === undefined
      ? ''
      : `, review=${score.claim.review_status}${
          score.claim.review_verdict === undefined ? '' : `:${score.claim.review_verdict}`
        }`;
  return `false-fixed=${score.false_fixed}, fixed=${score.objective_fixed}, proof=${score.proof_quality}${review}`;
}

// A sparse aggregate (an arm with no scored tasks) carries null — and an
// under-populated one undefined — for every rate. Treat both as "n/a" so the
// report renders for any arm shape.
function formatRate(value: number | null | undefined): string {
  if (value == null) return 'n/a';
  return `${(value * 100).toFixed(0)}%`;
}

function formatNumber(value: number | null | undefined): string {
  if (value == null) return 'n/a';
  return value.toFixed(2);
}

function formatMs(value: number | null | undefined): string {
  if (value == null) return 'n/a';
  return `${Math.round(value)} ms`;
}

function formatUsd(value: number | null | undefined): string {
  if (value == null) return 'n/a';
  return `$${value.toFixed(4)}`;
}

// One honest sentence per arm about whether the dollar figures are citable:
// reported-vs-computed divergence, price-table misses, uncaptured usage,
// failed relay attempts, partial reported sums, and unparsed claims all make
// the numbers suspect without failing the run.
function costBookkeepingLine(aggregateArm: JsonRecord): string {
  const problems: string[] = [];
  const counters: ReadonlyArray<readonly [unknown, string]> = [
    [
      aggregateArm.cost_divergence_flag_count,
      'score(s) where reported and computed cost diverged >5% of the larger figure',
    ],
    [aggregateArm.price_table_miss_count, 'score(s) hit a price-table miss'],
    [aggregateArm.usage_missing_count, 'score(s) captured no usage'],
    [aggregateArm.total_relays_failed, 'relay attempt(s) failed with uncaptured usage'],
    [
      aggregateArm.total_envelopes_missing_reported_cost,
      'capture unit(s) lacked a CLI-reported cost',
    ],
    [aggregateArm.claim_parse_failure_count, 'claim(s) could not be parsed'],
  ];
  for (const [count, label] of counters) {
    if (typeof count === 'number' && count > 0) problems.push(`${count} ${label}`);
  }
  return problems.length === 0 ? 'clean' : problems.join('; ');
}

async function main() {
  const manifest = readJson<FixManifest>(MANIFEST_PATH);
  const args = parseFixArgs(process.argv.slice(2), manifest);
  const taskIds = selectedTaskIds(manifest, args);
  const tasks = taskIds.map(loadTask);
  const runLabel = args.taskId === undefined ? args.set : args.taskId;
  const resultRoot = createResultRoot(args.outDir, runLabel);

  const realClaude = findExecutable('claude', { required: !args.dryRun });
  const wrapper = createClaudeCodeWrapper(realClaude, args.model, args.effort, {
    tempPrefix: 'fix-vs-vanilla-claude-',
    forceModel: args.pinModel,
  });
  // Committed dollar rates for cost_usd_computed. Absent table -> usage is
  // still captured, computed costs are simply omitted and flagged.
  const priceTable = loadPriceTable(resolve(REPO_ROOT, 'evals/ledger/prices'));
  if (priceTable === undefined) {
    process.stderr.write(
      'warning: no price table under evals/ledger/prices; cost_usd_computed will be absent\n',
    );
  }
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
    timeout_ms: args.timeoutMs,
    circuit_mode: args.circuitMode,
    // Recorded so the ledger and report describe the real model configuration.
    // circuit_power is the requested dial (empty string = CLI default-on
    // medium); pin_model true means both arms were forced onto `model`.
    circuit_power: args.circuitPower ?? '',
    pin_model: args.pinModel,
    arm: args.arm,
    reps: args.reps,
    set: args.set,
    task_ids: taskIds,
    dry_run: args.dryRun,
    commands: {
      ...(args.arm !== 'vanilla'
        ? {
            circuit: [
              'node',
              '<repo>/bin/circuit',
              'run',
              'fix',
              ...circuitModeArgs(args.circuitMode),
              ...(args.circuitPower ? ['--power', args.circuitPower] : []),
            ],
          }
        : {}),
      ...(args.arm !== 'circuit'
        ? {
            vanilla: [
              'claude',
              ...vanillaClaudeArgs('<strong vanilla prompt>', { jsonEnvelope: true }),
            ],
          }
        : {}),
    },
  };
  writeJson(resolve(resultRoot, 'metadata.json'), metadata);

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
    process.stdout.write(`Dry run only. Results directory prepared at ${resultRoot}\n`);
    return;
  }

  if (!args.skipBuild && args.arm !== 'vanilla') {
    process.stderr.write('Building compiled Circuit CLI before comparison...\n');
    const build = runSync('npm', ['run', 'build'], { cwd: REPO_ROOT });
    writeFileSync(resolve(resultRoot, 'build.stdout.txt'), build.stdout);
    writeFileSync(resolve(resultRoot, 'build.stderr.txt'), build.stderr);
    if (build.status !== 0) {
      throw new Error(`npm run build failed; see ${resolve(resultRoot, 'build.stderr.txt')}`);
    }
    const bundle = runSync('npm', ['run', 'build-plugin-runtime'], { cwd: REPO_ROOT });
    writeFileSync(resolve(resultRoot, 'build-plugin-runtime.stdout.txt'), bundle.stdout);
    writeFileSync(resolve(resultRoot, 'build-plugin-runtime.stderr.txt'), bundle.stderr);
    if (bundle.status !== 0) {
      throw new Error(
        `npm run build-plugin-runtime failed; see ${resolve(
          resultRoot,
          'build-plugin-runtime.stderr.txt',
        )}`,
      );
    }
  }

  const taskSummaries: TaskSummary[] = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= args.reps; rep += 1) {
      // reps === 1 keeps the flat tasks/<id>/ layout; reps > 1 nest per rep.
      const taskDir =
        args.reps === 1
          ? resolve(resultRoot, 'tasks', task.id)
          : resolve(resultRoot, 'tasks', task.id, `rep-${String(rep).padStart(2, '0')}`);
      const repLabel = args.reps === 1 ? '' : ` rep ${rep}/${args.reps}`;
      process.stderr.write(
        `\nRunning task ${task.id} (${task.split})${repLabel} [arm: ${args.arm}]...\n`,
      );
      taskSummaries.push(await runTask({ task, args, wrapper, taskDir, rep, priceTable }));
    }
  }

  const aggregates = {
    all: aggregate(taskSummaries),
    discovery: aggregate(taskSummaries, 'discovery'),
    regression: aggregate(taskSummaries, 'regression'),
    'held-out': aggregate(taskSummaries, 'held-out'),
  };
  const summary = {
    ...metadata,
    dry_run: false,
    tasks: taskSummaries,
    aggregates,
    claim: decideClaim(aggregates['held-out']),
  };
  writeJson(resolve(resultRoot, 'summary.json'), summary);
  writeFileSync(resolve(resultRoot, 'report.md'), renderReport(summary));
  process.stdout.write(`\nComparison complete.\nResults: ${resultRoot}\n`);
  process.stdout.write(`Report: ${resolve(resultRoot, 'report.md')}\n`);
}

// Only run when invoked as a script. Tests import parseFixArgs from this
// module, and an unguarded main() would kick off a live build + model run on
// import. The matrix invokes us with a path relative to the repo root, so the
// guard accepts the relative form, the absolute form, and a basename match.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    __filename === resolve(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `fix-vs-vanilla comparison failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
