#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeJsonOrString, writeJson } from '../../scripts/evals/shared/json.ts';
import { createResultRoot, repoMetadata } from '../../scripts/evals/shared/metadata.ts';
import {
  commandOutput,
  findExecutable,
  redactedCommand,
  runCommand,
  runSync,
} from '../../scripts/evals/shared/process.ts';
import {
  createProviderWrapper,
  vanillaClaudeArgs,
  vanillaCodexArgs,
} from '../../scripts/evals/shared/providers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');

const SUPPORTED_PROVIDERS = ['codex', 'claude-code'] as const;
const DEFAULT_PROVIDER = 'codex';
const DEFAULT_MODEL_BY_PROVIDER: Record<Provider, string> = {
  codex: 'gpt-5.4-mini',
  'claude-code': 'claude-haiku-4-5-20251001',
};
const DEFAULT_EFFORT = 'low';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_RESULTS_ROOT = resolve(__dirname, 'results');

type Provider = 'codex' | 'claude-code';
type FlowId = 'auto' | 'explore' | 'review' | 'build' | 'fix';
type ComparisonArgs = {
  taskId: string;
  promptFile: string;
  flow: FlowId;
  provider: Provider;
  model: string;
  effort: string;
  timeoutMs: number;
  outDir: string;
  skipBuild: boolean;
  dryRun: boolean;
};
type ArmIds = {
  circuit: string;
  vanilla: string;
};
type RunMetadataSummary = {
  command: string;
  argv: string[];
  started_at: string;
  finished_at: string;
  wallclock_ms: number;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  error: string | undefined;
  stdout_path: string;
  stderr_path: string;
};

function isProvider(value: string): value is Provider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

function isFlowId(value: string): value is FlowId {
  return ['auto', 'explore', 'review', 'build', 'fix'].includes(value);
}

function usage(): string {
  return `Usage:
  node evals/circuit-vs-vanilla/run-comparison.ts \\
    --task-id <id> \\
    --prompt-file <path> \\
    [--provider codex|claude-code] \\
    [--flow auto|explore|review|build|fix] \\
    [--model <model-id>] \\
    [--effort low] \\
    [--timeout-ms 1200000] \\
    [--out-dir evals/circuit-vs-vanilla/results] \\
    [--skip-build] \\
    [--dry-run]

Runs two arms with the same prompt and same provider model:
  1. circuit-<provider>: node bin/circuit run ...
  2. vanilla-<provider>: <provider CLI> ...

Default provider is 'codex' for back-compatibility. With --provider claude-code,
both arms invoke Claude Code; the Circuit arm runs the configured flow and the
vanilla arm runs the prompt directly through 'claude -p' with the same model,
effort, and tool surface.

--dry-run prints the resolved metadata (including the exact arm commands) and
exits without invoking either model. Combine with --skip-build to skip the
TypeScript build as well.

Outputs are written to:
  evals/circuit-vs-vanilla/results/<timestamp>-<task-id>/
`;
}

function parseArgs(argv: string[]): ComparisonArgs {
  const args: {
    taskId: string | undefined;
    promptFile: string | undefined;
    flow: string;
    provider: string;
    model: string | undefined;
    effort: string;
    timeoutMs: number;
    outDir: string;
    skipBuild: boolean;
    dryRun: boolean;
  } = {
    taskId: undefined,
    promptFile: undefined,
    flow: 'auto',
    provider: DEFAULT_PROVIDER,
    model: undefined,
    effort: DEFAULT_EFFORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
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
    if (arg === '--task-id') {
      args.taskId = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--prompt-file') {
      args.promptFile = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--flow') {
      args.flow = requireValue(argv, i, arg);
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

  if (args.promptFile === undefined) throw new Error('--prompt-file is required');
  if (args.taskId === undefined) {
    args.taskId = basename(args.promptFile).replace(/\.[^.]+$/, '');
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }
  if (!isFlowId(args.flow)) {
    throw new Error(`unsupported --flow '${args.flow}'`);
  }
  if (!isProvider(args.provider)) {
    throw new Error(
      `unsupported --provider '${args.provider}'; supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
    );
  }
  const model = args.model ?? DEFAULT_MODEL_BY_PROVIDER[args.provider];
  return {
    ...args,
    taskId: args.taskId,
    promptFile: args.promptFile,
    flow: args.flow,
    provider: args.provider,
    model,
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function extractCircuitFinalMarkdown(_circuitDir: string, stdout: string): string {
  try {
    const parsed = JSON.parse(stdout);
    const summaryPath = parsed.operator_summary_markdown_path;
    if (typeof summaryPath === 'string' && existsSync(summaryPath)) {
      return readFileSync(summaryPath, 'utf8');
    }
  } catch {
    // Fall back to stdout below.
  }
  return stdout.trim();
}

function writeBlindReviewPackets(
  root: string,
  prompt: string,
  armIds: ArmIds,
  circuitFinal: string,
  vanillaFinal: string,
): void {
  const rubric = [
    '- Task completion',
    '- Groundedness',
    '- Usefulness',
    '- Unnecessary effort',
    '- Risk and safety handling',
  ].join('\n');

  const packet = (
    firstLabel: string,
    firstText: string,
    secondLabel: string,
    secondText: string,
  ): string => `# Blind Review Packet

Do not use runtime, cost, or arm identity when judging output quality.

## Prompt

${prompt}

## Rubric

${rubric}

## Output ${firstLabel}

${firstText.trim() || '_No output captured._'}

## Output ${secondLabel}

${secondText.trim() || '_No output captured._'}
`;

  writeFileSync(
    resolve(root, 'blind-review-A-then-B.md'),
    packet('A', circuitFinal, 'B', vanillaFinal),
  );
  writeFileSync(
    resolve(root, 'blind-review-B-then-A.md'),
    packet('A', vanillaFinal, 'B', circuitFinal),
  );
  writeJson(resolve(root, 'blind-mapping.json'), {
    'blind-review-A-then-B.md': { A: armIds.circuit, B: armIds.vanilla },
    'blind-review-B-then-A.md': { A: armIds.vanilla, B: armIds.circuit },
  });
}

function comparisonRunMetadata(armId: string) {
  return (metadataBase: RunMetadataSummary) => ({
    arm_id: armId,
    command: redactedCommand(metadataBase.command, metadataBase.argv, {
      limit: 400,
      replacement: '<prompt from prompt.md>',
    }),
    started_at: metadataBase.started_at,
    finished_at: metadataBase.finished_at,
    wallclock_ms: metadataBase.wallclock_ms,
    exit_code: metadataBase.exit_code,
    signal: metadataBase.signal,
    timed_out: metadataBase.timed_out,
    error: metadataBase.error,
    stdout_path: metadataBase.stdout_path,
    stderr_path: metadataBase.stderr_path,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const promptPath = resolve(args.promptFile);
  if (!existsSync(promptPath)) throw new Error(`prompt file not found: ${promptPath}`);
  const prompt = readFileSync(promptPath, 'utf8').trim();
  if (prompt.length === 0) throw new Error(`prompt file is empty: ${promptPath}`);

  const providerExecutable = args.provider === 'codex' ? 'codex' : 'claude';
  const realProviderPath = findExecutable(providerExecutable, { required: !args.dryRun });
  const wrapper = createProviderWrapper(args.provider, realProviderPath, args.model, args.effort);
  const resultRoot = createResultRoot(args.outDir, args.taskId);
  const armIds = {
    circuit: `circuit-${args.provider}`,
    vanilla: `vanilla-${args.provider}`,
  };
  const circuitDir = resolve(resultRoot, armIds.circuit);
  const vanillaDir = resolve(resultRoot, armIds.vanilla);
  const circuitRunFolder = resolve(circuitDir, 'run');
  mkdirSync(circuitDir, { recursive: true });
  mkdirSync(vanillaDir, { recursive: true });

  const repo = repoMetadata(REPO_ROOT);
  const providerVersion = commandOutput(realProviderPath, ['--version']);
  const circuitVersion = commandOutput(
    'node',
    ['bin/circuit', 'version', '--json'],
    'unavailable',
    {
      cwd: REPO_ROOT,
    },
  );

  const circuitArgs = [
    'bin/circuit',
    'run',
    ...(args.flow === 'auto' ? [] : [args.flow]),
    '--goal',
    prompt,
    '--run-folder',
    circuitRunFolder,
    '--progress',
    'jsonl',
  ];
  const vanillaCommand = providerExecutable;
  const vanillaArgs =
    args.provider === 'codex' ? vanillaCodexArgs(prompt) : vanillaClaudeArgs(prompt);

  const metadata = {
    schema_version: 1,
    task_id: args.taskId,
    prompt_file: promptPath,
    prompt_path: resolve(resultRoot, 'prompt.md'),
    repo_root: REPO_ROOT,
    repo_commit: repo.repo_commit,
    dirty_worktree: repo.dirty_worktree,
    git_status_short: repo.git_status_short,
    provider: args.provider,
    model: args.model,
    effort: args.effort,
    timeout_ms: args.timeoutMs,
    flow: args.flow,
    provider_version: providerVersion,
    circuit_version: safeJsonOrString(circuitVersion),
    result_root: resultRoot,
    arms: {
      [armIds.circuit]: {
        command: redactedCommand('node', circuitArgs, {
          limit: 400,
          replacement: '<prompt from prompt.md>',
        }),
        run_folder: circuitRunFolder,
      },
      [armIds.vanilla]: {
        command: redactedCommand(vanillaCommand, vanillaArgs, {
          limit: 400,
          replacement: '<prompt from prompt.md>',
        }),
      },
    },
  };

  mkdirSync(resultRoot, { recursive: true });
  writeFileSync(resolve(resultRoot, 'prompt.md'), `${prompt}\n`);
  writeJson(resolve(resultRoot, 'metadata.json'), metadata);

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
    process.stdout.write(`Dry run only. Results directory prepared at ${resultRoot}\n`);
    return;
  }

  if (!args.skipBuild) {
    process.stderr.write('Building compiled CLI before comparison...\n');
    const build = runSync('npm', ['run', 'build'], { cwd: REPO_ROOT });
    writeFileSync(resolve(resultRoot, 'build.stdout.txt'), build.stdout);
    writeFileSync(resolve(resultRoot, 'build.stderr.txt'), build.stderr);
    if (build.status !== 0) {
      throw new Error(`npm run build failed; see ${resolve(resultRoot, 'build.stderr.txt')}`);
    }
  }

  process.stderr.write(`Results: ${resultRoot}\n`);
  process.stderr.write(
    `Provider: ${args.provider}; model: ${args.model}; effort: ${args.effort}\n`,
  );

  const circuit = await runCommand({
    label: armIds.circuit,
    command: 'node',
    argv: circuitArgs,
    cwd: REPO_ROOT,
    env: wrapper.env,
    timeoutMs: args.timeoutMs,
    outputDir: circuitDir,
    metadataFilename: 'metadata.json',
    metadataBuilder: comparisonRunMetadata(armIds.circuit),
  });

  const vanilla = await runCommand({
    label: armIds.vanilla,
    command: vanillaCommand,
    argv: vanillaArgs,
    cwd: REPO_ROOT,
    env: wrapper.env,
    timeoutMs: args.timeoutMs,
    outputDir: vanillaDir,
    metadataFilename: 'metadata.json',
    metadataBuilder: comparisonRunMetadata(armIds.vanilla),
  });

  const circuitFinal = extractCircuitFinalMarkdown(circuitDir, circuit.stdout);
  const vanillaFinal = vanilla.stdout.trim();
  writeFileSync(resolve(circuitDir, 'final.md'), `${circuitFinal.trim()}\n`);
  writeFileSync(resolve(vanillaDir, 'final.md'), `${vanillaFinal}\n`);
  writeBlindReviewPackets(resultRoot, prompt, armIds, circuitFinal, vanillaFinal);

  writeJson(resolve(resultRoot, 'summary.json'), {
    schema_version: 1,
    task_id: args.taskId,
    result_root: resultRoot,
    provider: args.provider,
    model: args.model,
    effort: args.effort,
    repo_commit: repo.repo_commit,
    dirty_worktree: repo.dirty_worktree,
    arms: {
      [armIds.circuit]: {
        exit_code: circuit.exit_code,
        timed_out: circuit.timed_out,
        wallclock_ms: circuit.wallclock_ms,
        final_path: resolve(circuitDir, 'final.md'),
        run_folder: circuitRunFolder,
      },
      [armIds.vanilla]: {
        exit_code: vanilla.exit_code,
        timed_out: vanilla.timed_out,
        wallclock_ms: vanilla.wallclock_ms,
        final_path: resolve(vanillaDir, 'final.md'),
      },
    },
    blind_review_packets: [
      resolve(resultRoot, 'blind-review-A-then-B.md'),
      resolve(resultRoot, 'blind-review-B-then-A.md'),
    ],
  });

  process.stdout.write(`\nComparison complete.\nResults: ${resultRoot}\n`);
  process.stdout.write(`Circuit final: ${resolve(circuitDir, 'final.md')}\n`);
  process.stdout.write(`Vanilla final: ${resolve(vanillaDir, 'final.md')}\n`);
  process.stdout.write(`Blind review: ${resolve(resultRoot, 'blind-review-A-then-B.md')}\n`);
}

main().catch((err) => {
  process.stderr.write(`comparison failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
