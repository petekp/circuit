// E1 CLI — "one task, two shapes, measured".
//
// Two lanes, one entry point:
//
//   node experiments/e1/run-comparison.ts            # fixture lane (zero budget)
//   node experiments/e1/run-comparison.ts --live     # live lane (spends budget)
//
// The default (fixture) lane renders the bundled recorded run folders through
// the exact same extract -> compare -> report pipeline the live lane uses, so
// the measurement loop is provable without spending a cent. The `--live` lane
// runs the holistic (`fix`) and separated (`build --process high`) variants for
// real, each in an isolated worktree, and is the single ready-to-run command
// the brief asks for. It is gated behind `--live` precisely so an unattended
// invocation can never spend budget by accident.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFixtureComparison } from './fixture.ts';
import { renderJson, renderMarkdown } from './report.ts';
import type { ExperimentComparison } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

interface CliOptions {
  readonly live: boolean;
  readonly taskId: string;
  readonly power: string;
  readonly timeoutMs: number;
  readonly outDir: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let live = false;
  let taskId = 'heldout-wrap-index';
  let power = 'medium';
  let timeoutMs = 20 * 60 * 1000;
  let outDir: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--live':
        live = true;
        break;
      case '--task':
        i += 1;
        taskId = argv[i] ?? taskId;
        break;
      case '--power':
        i += 1;
        power = argv[i] ?? power;
        break;
      case '--timeout-ms':
        i += 1;
        timeoutMs = Number(argv[i] ?? timeoutMs) || timeoutMs;
        break;
      case '--out':
        i += 1;
        outDir = argv[i] ?? null;
        break;
      case '--help':
      case '-h':
        return printHelpAndExit();
      default:
        if (arg?.startsWith('--')) {
          process.stderr.write(`unknown flag: ${arg}\n`);
          printHelpAndExit(1);
        }
    }
  }

  return { live, taskId, power, timeoutMs, outDir };
}

function printHelpAndExit(code = 0): never {
  process.stdout.write(
    [
      'E1 — one task, two shapes, measured',
      '',
      'Usage:',
      '  node experiments/e1/run-comparison.ts [--live] [options]',
      '',
      'Lanes:',
      '  (default)    Render the bundled fixture comparison. Spends ZERO budget.',
      '  --live       Run the holistic (fix) and separated (build --process high)',
      '               variants for real. SPENDS MODEL BUDGET. One fix run + one',
      '               build run, each in an isolated worktree, then stop.',
      '',
      'Options:',
      '  --task <id>        Eval task id (default: heldout-wrap-index)',
      '  --power <tier>     low | medium | high (default: medium, live only)',
      '  --timeout-ms <n>   Per-variant timeout in ms (default: 1200000, live only)',
      '  --out <dir>        Also write comparison.json + comparison.md there',
      '  --help             Show this help',
      '',
    ].join('\n'),
  );
  process.exit(code);
}

async function buildComparison(options: CliOptions): Promise<ExperimentComparison> {
  if (!options.live) {
    return renderFixtureComparison(new Date().toISOString());
  }

  // Live lane: import the budget-spending runner lazily so the fixture lane
  // never even loads the engine worktree machinery.
  const { runLiveComparison } = await import('./runner.ts');
  const workRoot = join(REPO_ROOT, 'experiments', 'e1', '.runs', `${stamp()}-${options.taskId}`);
  mkdirSync(workRoot, { recursive: true });

  process.stderr.write(
    [
      '',
      '  ⚠️  LIVE RUN — this spends model budget.',
      `      task:   ${options.taskId}`,
      `      power:  ${options.power}`,
      `      work:   ${workRoot}`,
      '      Running one `fix` and one `build --process high`, then stopping.',
      '',
    ].join('\n'),
  );

  return runLiveComparison({
    taskId: options.taskId,
    tasksRoot: join(REPO_ROOT, 'evals', 'fix-vs-vanilla', 'tasks'),
    repoRoot: REPO_ROOT,
    workRoot,
    power: options.power,
    timeoutMs: options.timeoutMs,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    log: (message) => process.stderr.write(`  ${message}\n`),
  });
}

function stamp(): string {
  // Filesystem-safe timestamp for the work folder name.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const comparison = await buildComparison(options);

  const markdown = renderMarkdown(comparison);
  process.stdout.write(`${markdown}\n`);

  if (options.outDir !== null) {
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(join(options.outDir, 'comparison.json'), renderJson(comparison));
    writeFileSync(join(options.outDir, 'comparison.md'), markdown);
    process.stderr.write(`\n  wrote comparison.json + comparison.md to ${options.outDir}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`E1 run-comparison failed: ${message}\n`);
  process.exit(1);
});
