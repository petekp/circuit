#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import { createResultRoot, repoMetadata } from './shared/metadata.ts';
import { runSync } from './shared/process.ts';
import { readJson, writeJson } from './shared/json.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const MATRIX_PATH = resolve(REPO_ROOT, 'evals/fix-vs-vanilla/matrix.json');
const DEFAULT_OUT_DIR = resolve(REPO_ROOT, 'evals/fix-vs-vanilla/results/matrix');

type MatrixArgs = {
  set: string;
  row: string | undefined;
  outDir: string;
  skipBuild: boolean;
  dryRun: boolean;
};
type MatrixRow = {
  id: string;
  enabled: boolean;
  provider: string;
  model: string;
  effort: string;
  [key: string]: unknown;
};
type FixMatrix = {
  matrix_id: string;
  benchmark_id: string;
  rows: MatrixRow[];
};

function usage(): string {
  return `Usage:
  node scripts/evals/fix-matrix.ts \\
    [--set regression|held-out|discovery|all] \\
    [--row <id>] \\
    [--out-dir <path>] \\
    [--skip-build] \\
    [--dry-run]
`;
}

function parseArgs(argv: readonly string[]): MatrixArgs {
  const program = new Command('fix-matrix')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .option('--set <set>')
    .option('--row <id>')
    .option('--out-dir <path>')
    .option('--skip-build')
    .option('--dry-run');
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError && err.code === 'commander.helpDisplayed') process.exit(0);
    if (err instanceof CommanderError) throw new Error(err.message.replace(/^error: /, ''));
    throw err;
  }
  if (program.args.length > 0) throw new Error(`unexpected argument: ${program.args[0]}`);

  const opts = program.opts<{
    set?: string;
    row?: string;
    outDir?: string;
    skipBuild?: boolean;
    dryRun?: boolean;
  }>();
  const set = opts.set ?? 'held-out';
  if (!['discovery', 'regression', 'held-out', 'all'].includes(set)) {
    throw new Error('--set must be discovery, regression, held-out, or all');
  }
  return {
    set,
    row: opts.row,
    outDir: opts.outDir === undefined ? DEFAULT_OUT_DIR : resolve(opts.outDir),
    skipBuild: opts.skipBuild === true,
    dryRun: opts.dryRun === true,
  };
}

function selectedRows(matrix: FixMatrix, rowId: string | undefined): MatrixRow[] {
  if (rowId !== undefined) {
    const row = matrix.rows.find((candidate) => candidate.id === rowId);
    if (row === undefined) throw new Error(`unknown matrix row: ${rowId}`);
    return [row];
  }
  return matrix.rows.filter((row) => row.enabled === true);
}

function rowCommand(row: MatrixRow, args: MatrixArgs, rowOutDir: string): string[] {
  return [
    'evals/fix-vs-vanilla/run-fix-comparison.ts',
    '--set',
    args.set,
    '--provider',
    row.provider,
    '--model',
    row.model,
    '--effort',
    row.effort,
    '--out-dir',
    rowOutDir,
    '--skip-build',
    // Pin the Circuit arm's model so an objective-rate difference cannot be
    // confounded by a mid-run model escalation. Without this the matrix pins
    // nothing and the two arms can silently run different stacks.
    '--pin-model',
  ];
}

function assertRunnableRow(row: MatrixRow): void {
  if (row.provider === 'configure-before-use' || row.model === 'configure-before-use') {
    throw new Error(`${row.id}: row must be configured before a real run`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrix = readJson<FixMatrix>(MATRIX_PATH);
  const rows = selectedRows(matrix, args.row);
  const resultRoot = createResultRoot(args.outDir, `fix-matrix-${args.set}`);
  const rowMetas = rows.map((row) => {
    const rowOutDir = resolve(resultRoot, 'rows', row.id);
    return {
      ...row,
      out_dir: rowOutDir,
      command: ['node', ...rowCommand(row, args, rowOutDir)],
      will_run: !args.dryRun,
    };
  });
  const metadata = {
    schema_version: 1,
    matrix_id: matrix.matrix_id,
    benchmark_id: matrix.benchmark_id,
    result_root: resultRoot,
    repo_root: REPO_ROOT,
    ...repoMetadata(REPO_ROOT),
    set: args.set,
    dry_run: args.dryRun,
    skip_build: args.skipBuild,
    rows: rowMetas,
    claim_eligible: false,
    claim_eligibility_reason: 'Matrix claims require at least two actually-run enabled provider/model rows.',
  };
  writeJson(resolve(resultRoot, 'metadata.json'), metadata);

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
    process.stdout.write(`Dry run only. Matrix results directory prepared at ${resultRoot}\n`);
    return;
  }

  for (const row of rows) assertRunnableRow(row);

  if (!args.skipBuild) {
    process.stderr.write('Building compiled Circuit CLI once before matrix rows...\n');
    const build = runSync('npm', ['run', 'build'], { cwd: REPO_ROOT });
    writeFileSync(resolve(resultRoot, 'build.stdout.txt'), build.stdout);
    writeFileSync(resolve(resultRoot, 'build.stderr.txt'), build.stderr);
    if (build.status !== 0) throw new Error(`npm run build failed; see ${resultRoot}/build.stderr.txt`);
    const bundle = runSync('npm', ['run', 'build-plugin-runtime'], { cwd: REPO_ROOT });
    writeFileSync(resolve(resultRoot, 'build-plugin-runtime.stdout.txt'), bundle.stdout);
    writeFileSync(resolve(resultRoot, 'build-plugin-runtime.stderr.txt'), bundle.stderr);
    if (bundle.status !== 0) {
      throw new Error(`npm run build-plugin-runtime failed; see ${resultRoot}/build-plugin-runtime.stderr.txt`);
    }
  }

  const rowResults = [];
  for (const row of rows) {
    const rowOutDir = resolve(resultRoot, 'rows', row.id);
    mkdirSync(rowOutDir, { recursive: true });
    const command = rowCommand(row, args, rowOutDir);
    process.stderr.write(`Running Fix matrix row ${row.id}...\n`);
    const result = runSync('node', command, { cwd: REPO_ROOT });
    writeFileSync(resolve(rowOutDir, 'stdout.txt'), result.stdout);
    writeFileSync(resolve(rowOutDir, 'stderr.txt'), result.stderr);
    rowResults.push({
      row_id: row.id,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      status: result.status,
      stdout_path: resolve(rowOutDir, 'stdout.txt'),
      stderr_path: resolve(rowOutDir, 'stderr.txt'),
    });
    if (result.status !== 0) {
      throw new Error(`matrix row ${row.id} failed; see ${resolve(rowOutDir, 'stderr.txt')}`);
    }
  }

  const summary = {
    ...metadata,
    dry_run: false,
    rows: rowResults,
    claim_eligible: rowResults.length >= 2,
    claim_eligibility_reason:
      rowResults.length >= 2
        ? 'At least two provider/model rows were actually run.'
        : 'Matrix claims require at least two actually-run enabled provider/model rows.',
  };
  writeJson(resolve(resultRoot, 'summary.json'), summary);
  process.stdout.write(`Fix matrix complete.\nResults: ${resultRoot}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fix matrix failed: ${message}\n`);
  process.exit(1);
});
