#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregate,
  decideClaim,
  parseCircuitClaim,
  parseVanillaClaim,
  scoreArm,
  type ArmScore,
  type TaskSummary as AggregateTaskSummary,
} from '../../scripts/evals/fix-vs-vanilla/scoring.ts';
import { createResultRoot, repoMetadata } from '../../scripts/evals/shared/metadata.ts';
import {
  commandOutput,
  findExecutable,
  promptCommand,
  runCommand,
  runSync,
  type RunCommandMetadata,
} from '../../scripts/evals/shared/process.ts';
import { createClaudeCodeWrapper, vanillaClaudeArgs } from '../../scripts/evals/shared/providers.ts';
import { readJson, safeSegment, writeJson } from '../../scripts/evals/shared/json.ts';
import {
  CIRCUIT_MODES,
  type CircuitMode,
  circuitModeArgs,
  isCircuitMode,
} from '../../scripts/evals/fix-vs-vanilla/circuit-mode.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const MANIFEST_PATH = resolve(__dirname, 'manifest.json');
const DEFAULT_RESULTS_ROOT = resolve(__dirname, 'results');

type JsonRecord = Record<string, any>;
type TaskSet = 'discovery' | 'regression' | 'held-out';
type RequestedTaskSet = TaskSet | 'all';
type CheckDefinition = {
  id: string;
  argv: string[];
};
type FixManifest = {
  benchmark_id: string;
  default_provider: string;
  default_model: string;
  default_effort: string;
  default_timeout_ms: number;
  sets: Record<TaskSet, string[]>;
};
type FixArgs = {
  set: RequestedTaskSet;
  taskId: string | undefined;
  provider: string;
  model: string;
  effort: string;
  timeoutMs: number;
  circuitMode: CircuitMode;
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
    [--out-dir evals/fix-vs-vanilla/results] \\
    [--skip-build] \\
    [--dry-run]

Runs isolated bug-fix tasks through Circuit Fix and a strong vanilla Claude Code
prompt. Primary scoring is false-fixed rate: claimed fixed while objective
checks still fail.
`;
}

function parseArgs(argv: string[]): { args: FixArgs; manifest: FixManifest } {
  const manifest = readJson<FixManifest>(MANIFEST_PATH);
  const args: FixArgs = {
    set: 'held-out',
    taskId: undefined,
    provider: manifest.default_provider,
    model: manifest.default_model,
    effort: manifest.default_effort,
    timeoutMs: manifest.default_timeout_ms,
    circuitMode: 'default',
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
    throw new Error("--set must be one of discovery, regression, held-out, or all");
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
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }

  return { args, manifest };
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
  const checks = task.checks.map((check) => `- ${promptCommand(check.argv)}`).join('\n');
  return `${task.prompt}

Acceptance:
- First confirm the regression by running the listed command before the fix.
- Make only the focused fix needed for this task.
- Rerun the same command after the fix.
- Leave the repo with the objective checks passing.

Objective check commands:
${checks}

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
5. Do not claim the bug is fixed unless the regression failed before the fix, passes after the fix, and the objective checks pass.
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
  resultRoot,
}: {
  task: FixTask;
  args: FixArgs;
  wrapper: { env: NodeJS.ProcessEnv };
  resultRoot: string;
}): Promise<TaskSummary> {
  const taskDir = resolve(resultRoot, 'tasks', task.id);
  const circuitDir = resolve(taskDir, 'circuit-claude-code');
  const vanillaDir = resolve(taskDir, 'vanilla-claude-code');
  const circuitRepo = resolve(circuitDir, 'repo');
  const vanillaRepo = resolve(vanillaDir, 'repo');
  const circuitRunFolder = resolve(circuitDir, 'circuit-run');
  const circuitFlowRoot = resolve(circuitDir, 'generated-flows');
  mkdirSync(taskDir, { recursive: true });
  writeJson(resolve(taskDir, 'task.json'), task);
  writeFileSync(resolve(taskDir, 'goal.md'), `${taskGoal(task)}\n`);
  writeFileSync(resolve(taskDir, 'vanilla-prompt.md'), `${vanillaPrompt(task)}\n`);

  const circuitCommit = copyFixtureRepo(task, circuitRepo);
  const vanillaCommit = copyFixtureRepo(task, vanillaRepo);
  cpSync(resolve(REPO_ROOT, 'generated', 'flows'), circuitFlowRoot, { recursive: true });
  const baselineCircuit = runChecks(circuitRepo, task.checks, circuitDir, 'baseline');
  const baselineVanilla = runChecks(vanillaRepo, task.checks, vanillaDir, 'baseline');

  const circuitArgs = [
    resolve(REPO_ROOT, 'bin/circuit'),
    'run',
    'fix',
    '--goal',
    taskGoal(task),
    ...circuitModeArgs(args.circuitMode),
    '--run-folder',
    circuitRunFolder,
    '--flow-root',
    circuitFlowRoot,
    '--progress',
    'jsonl',
  ];
  const vanillaArgs = vanillaClaudeArgs(vanillaPrompt(task));

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
  const circuitPostChecks = runChecks(circuitRepo, task.checks, circuitDir, 'post');
  const circuitDiff = diffState(circuitRepo, circuitDir);
  const circuitScore = scoreArm({
    task,
    armId: 'circuit-claude-code',
    run: circuitRun,
    checks: circuitPostChecks,
    diff: circuitDiff,
    claim: parseCircuitClaim(circuitRunFolder),
  });

  const vanillaRun = await runCommand({
    label: `${task.id}:vanilla`,
    command: 'claude',
    argv: vanillaArgs,
    cwd: vanillaRepo,
    env: wrapper.env,
    timeoutMs: args.timeoutMs,
    outputDir: vanillaDir,
    metadataBuilder: fixRunMetadata,
  });
  const vanillaPostChecks = runChecks(vanillaRepo, task.checks, vanillaDir, 'post');
  const vanillaDiff = diffState(vanillaRepo, vanillaDir);
  const vanillaScore = scoreArm({
    task,
    armId: 'vanilla-claude-code',
    run: vanillaRun,
    checks: vanillaPostChecks,
    diff: vanillaDiff,
    claim: parseVanillaClaim(vanillaRun.stdout),
  });

  const taskSummary = {
    task_id: task.id,
    split: task.split,
    fixture_commits_match: circuitCommit === vanillaCommit,
    fixture_commit: circuitCommit,
    baseline_failed_as_expected:
      baselineCircuit.some((check) => !check.passed) && baselineVanilla.some((check) => !check.passed),
    baseline: {
      'circuit-claude-code': baselineCircuit,
      'vanilla-claude-code': baselineVanilla,
    },
    arms: {
      'circuit-claude-code': circuitScore,
      'vanilla-claude-code': vanillaScore,
    },
  };
  writeJson(resolve(taskDir, 'summary.json'), taskSummary);
  return taskSummary;
}

function renderReport(summary: FixSummary): string {
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

| Arm | False-fixed | Fixed | Proof quality | Verification | Changed files | Wallclock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Circuit Fix | ${formatRate(circuit.false_fixed_rate)} | ${formatRate(circuit.objective_fixed_rate)} | ${formatNumber(circuit.mean_proof_quality)} | ${formatRate(circuit.verification_pass_rate)} | ${formatNumber(circuit.mean_changed_file_count)} | ${formatMs(circuit.mean_wallclock_ms)} |
| Vanilla strong prompt | ${formatRate(vanilla.false_fixed_rate)} | ${formatRate(vanilla.objective_fixed_rate)} | ${formatNumber(vanilla.mean_proof_quality)} | ${formatRate(vanilla.verification_pass_rate)} | ${formatNumber(vanilla.mean_changed_file_count)} | ${formatMs(vanilla.mean_wallclock_ms)} |

## Tasks

${summary.tasks
  .map(
    (task) =>
      `- ${task.task_id} (${task.split}): Circuit ${formatTaskScore(task.arms['circuit-claude-code'] ?? {})}; vanilla ${formatTaskScore(task.arms['vanilla-claude-code'] ?? {})}`,
  )
  .join('\n')}
`;
}

function formatTaskScore(score: JsonRecord): string {
  const review =
    score.claim.review_status === undefined
      ? ''
      : `, review=${score.claim.review_status}${
          score.claim.review_verdict === undefined ? '' : `:${score.claim.review_verdict}`
        }`;
  return `false-fixed=${score.false_fixed}, fixed=${score.objective_fixed}, proof=${score.proof_quality}${review}`;
}

function formatRate(value: number | null): string {
  if (value === null) return 'n/a';
  return `${(value * 100).toFixed(0)}%`;
}

function formatNumber(value: number | null): string {
  if (value === null) return 'n/a';
  return value.toFixed(2);
}

function formatMs(value: number | null): string {
  if (value === null) return 'n/a';
  return `${Math.round(value)} ms`;
}

async function main() {
  const { args, manifest } = parseArgs(process.argv.slice(2));
  const taskIds = selectedTaskIds(manifest, args);
  const tasks = taskIds.map(loadTask);
  const runLabel = args.taskId === undefined ? args.set : args.taskId;
  const resultRoot = createResultRoot(args.outDir, runLabel);

  const realClaude = findExecutable('claude', { required: !args.dryRun });
  const wrapper = createClaudeCodeWrapper(realClaude, args.model, args.effort, {
    tempPrefix: 'fix-vs-vanilla-claude-',
  });
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
    set: args.set,
    task_ids: taskIds,
    dry_run: args.dryRun,
    commands: {
      circuit: ['node', '<repo>/bin/circuit', 'run', 'fix', ...circuitModeArgs(args.circuitMode)],
      vanilla: ['claude', ...vanillaClaudeArgs('<strong vanilla prompt>')],
    },
  };
  writeJson(resolve(resultRoot, 'metadata.json'), metadata);

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
    process.stdout.write(`Dry run only. Results directory prepared at ${resultRoot}\n`);
    return;
  }

  if (!args.skipBuild) {
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
    process.stderr.write(`\nRunning task ${task.id} (${task.split})...\n`);
    taskSummaries.push(await runTask({ task, args, wrapper, resultRoot }));
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

main().catch((error: unknown) => {
  process.stderr.write(
    `fix-vs-vanilla comparison failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
