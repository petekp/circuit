#!/usr/bin/env node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSync } from './shared/process.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function runStep(
  label: string,
  command: string,
  argv: string[],
  options: Parameters<typeof runSync>[2] = {},
): void {
  process.stderr.write(`\n[check-evals] ${label}\n`);
  const result = runSync(command, argv, { cwd: REPO_ROOT, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${label} failed`);
  }
}

function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'circuit-check-evals-'));
  runStep('registry', 'node', ['scripts/evals/validate-registry.ts']);
  runStep('fix manifest', 'node', ['scripts/evals/validate-fix-manifest.ts']);
  runStep('result hygiene', 'node', ['scripts/evals/validate-result-hygiene.ts']);
  runStep('ledger', 'node', ['scripts/evals/validate-ledger.ts']);
  runStep('fix held-out dry-run', 'node', [
    'evals/fix-vs-vanilla/run-fix-comparison.ts',
    '--set',
    'held-out',
    '--dry-run',
    '--out-dir',
    resolve(tempRoot, 'fix'),
  ]);
  runStep('fix matrix dry-run', 'node', [
    'scripts/evals/fix-matrix.ts',
    '--dry-run',
    '--out-dir',
    resolve(tempRoot, 'matrix'),
  ]);

  const promptPath = resolve(tempRoot, 'comparison-prompt.md');
  writeFileSync(promptPath, 'Comparison runner dry-run prompt fixture.\n');
  runStep('circuit-vs-vanilla dry-run', 'node', [
    'evals/circuit-vs-vanilla/run-comparison.ts',
    '--task-id',
    'dry-run-test',
    '--prompt-file',
    promptPath,
    '--out-dir',
    resolve(tempRoot, 'comparison'),
    '--dry-run',
    '--skip-build',
    '--provider',
    'claude-code',
    '--flow',
    'review',
    '--model',
    'claude-haiku-4-5-20251001',
    '--effort',
    'low',
  ]);
}

try {
  main();
  process.stdout.write('\nEval checks OK\n');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`check-evals failed: ${message}\n`);
  process.exit(1);
}
