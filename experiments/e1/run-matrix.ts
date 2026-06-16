// E1 matrix CLI — a {tasks × variants} grid in one command.
//
//   node experiments/e1/run-matrix.ts                       # fixture lane (zero budget)
//   node experiments/e1/run-matrix.ts --live --task a --task b   # live lane (spends budget)
//
// The default (fixture) lane renders the bundled recorded run folders through
// the same buildMatrix -> report pipeline the live lane uses, so the grid math
// is provable without spending a cent. The `--live` lane runs the canonical two
// grains (holistic `fix`, separated `build --depth high`) across every `--task`,
// each in an isolated worktree, clearing build's opening frame checkpoint with
// `circuit resume --checkpoint-choice continue`. Gated behind `--live` so an
// unattended invocation never spends budget by accident.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFixtureMatrix } from './matrix-fixture.ts';
import { renderMatrixJson, renderMatrixMarkdown } from './matrix-report.ts';
import type { ExperimentMatrix } from './matrix.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

interface CliOptions {
  readonly live: boolean;
  readonly taskIds: readonly string[];
  readonly power: string;
  readonly timeoutMs: number;
  readonly repeats: number;
  readonly outDir: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let live = false;
  const taskIds: string[] = [];
  let power = 'medium';
  let timeoutMs = 20 * 60 * 1000;
  let repeats = 1;
  let outDir: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--live':
        live = true;
        break;
      case '--task':
        i += 1;
        if (argv[i] !== undefined) taskIds.push(argv[i] as string);
        break;
      case '--power':
        i += 1;
        power = argv[i] ?? power;
        break;
      case '--timeout-ms':
        i += 1;
        timeoutMs = Number(argv[i] ?? timeoutMs) || timeoutMs;
        break;
      case '--repeats':
      case '-k': {
        i += 1;
        const parsed = Number(argv[i]);
        if (!Number.isInteger(parsed) || parsed < 1) {
          process.stderr.write(`--repeats needs a positive integer; got '${argv[i]}'\n`);
          printHelpAndExit(1);
        }
        repeats = parsed;
        break;
      }
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

  return { live, taskIds, power, timeoutMs, repeats, outDir };
}

function printHelpAndExit(code = 0): never {
  process.stdout.write(
    [
      'E1 matrix — {tasks × variants}, measured',
      '',
      'Usage:',
      '  node experiments/e1/run-matrix.ts [--live] [--task <id> ...] [options]',
      '',
      'Lanes:',
      '  (default)    Render the bundled fixture matrix. Spends ZERO budget.',
      '  --live       Run holistic (fix) and separated (build --depth high)',
      '               across every --task. SPENDS MODEL BUDGET.',
      '',
      'Options:',
      '  --task <id>        Eval task id; repeatable (live only)',
      '  --power <tier>     low | medium | high (default: medium, live only)',
      '  --repeats, -k <n>  Times to run every task (default: 1, live only).',
      '                     Run order interleaves: every task once per pass, so',
      '                     repeats spread across wall-time instead of back-to-back.',
      '  --timeout-ms <n>   Per-variant timeout in ms (default: 1200000, live only)',
      '  --out <dir>        Also write matrix.json + matrix.md there',
      '  --help             Show this help',
      '',
    ].join('\n'),
  );
  process.exit(code);
}

async function buildMatrixForCli(options: CliOptions): Promise<ExperimentMatrix> {
  if (!options.live) {
    return renderFixtureMatrix(new Date().toISOString());
  }

  if (options.taskIds.length === 0) {
    process.stderr.write('--live needs at least one --task <id>\n');
    process.exit(1);
  }

  // Import the budget-spending runner lazily so the fixture lane never loads the
  // engine worktree machinery.
  const { runLiveMatrix } = await import('./matrix-runner.ts');
  const workRoot = join(REPO_ROOT, 'experiments', 'e1', '.runs', `matrix-${stamp()}`);
  mkdirSync(workRoot, { recursive: true });

  const totalRuns = options.taskIds.length * options.repeats * 2;
  process.stderr.write(
    [
      '',
      '  ⚠️  LIVE MATRIX — this spends model budget.',
      `      tasks:   ${options.taskIds.join(', ')}`,
      `      power:   ${options.power}`,
      `      repeats: ${options.repeats} (interleaved across tasks)`,
      `      runs:    ${totalRuns} (tasks × repeats × 2 grains)`,
      `      work:    ${workRoot}`,
      '      Running fix + build --depth high per task, then stopping.',
      '',
    ].join('\n'),
  );

  return runLiveMatrix({
    taskIds: options.taskIds,
    tasksRoot: join(REPO_ROOT, 'evals', 'fix-vs-vanilla', 'tasks'),
    repoRoot: REPO_ROOT,
    workRoot,
    power: options.power,
    timeoutMs: options.timeoutMs,
    repeats: options.repeats,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    log: (message) => process.stderr.write(`  ${message}\n`),
  });
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const matrix = await buildMatrixForCli(options);

  const markdown = renderMatrixMarkdown(matrix);
  process.stdout.write(`${markdown}\n`);

  if (options.outDir !== null) {
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(join(options.outDir, 'matrix.json'), renderMatrixJson(matrix));
    writeFileSync(join(options.outDir, 'matrix.md'), markdown);
    process.stderr.write(`\n  wrote matrix.json + matrix.md to ${options.outDir}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`E1 run-matrix failed: ${message}\n`);
  process.exit(1);
});
