#!/usr/bin/env node
// Test runner dispatch for `npm run test` and `npm run test:fast`.
//
// The MCP subprocess files time real process cleanup and flake when the fully
// parallel suite competes with them for CPU, so a no-argument run executes the
// parallel suite without them and then runs them serially.
// Callers that pass arguments (`npm run test -- <file> [flags]`, used by the
// CI workflows and docs) get exactly `vitest run <args>` with no second
// stage, so "run precisely this" keeps meaning that.
//
// The membership test is "does this file assert on real process timing", not
// "is it named proof-sandbox". nested-codex-subprocess spawns descendants that
// hold inherited pipes open and asserts the runner settles at an absolute
// bound; under parallel CPU contention that bound is reached late and the
// assertion fails, which is how it produced a red `verify` on an unrelated
// change. Passing alone and failing in the parallel stage is the signature.
import { spawnSync } from 'node:child_process';

const SERIAL_FILES = [
  'tests/mcp/proof-sandbox.test.ts',
  'tests/mcp/proof-sandbox-live.test.ts',
  'tests/mcp/nested-codex-subprocess.test.ts',
  // supervisor polls for a worker group to stop being signalled after its
  // leader exits, bounded by a wall-clock deadline. Same signature: 5s alone,
  // 81s and a timeout in the parallel stage.
  'tests/mcp/supervisor.test.ts',
  // spawns real git subprocesses through the MCP safe reader and bounds them by
  // a wall-clock timeout. Same signature again: 5s alone, 90s and a timeout in
  // the parallel stage.
  'tests/mcp/safe-git-reader-live.test.ts',
];
const FAST_EXCLUDES = ['tests/runner/cli-router.test.ts', 'tests/unit/emit-flows-drift.test.ts'];

function vitest(args) {
  const result = spawnSync('npx', ['vitest', 'run', ...args], { stdio: 'inherit' });
  return result.status ?? 1;
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--fast') {
  const excludes = [...SERIAL_FILES, ...FAST_EXCLUDES].flatMap((file) => ['--exclude', file]);
  const parallel = vitest(excludes);
  if (parallel !== 0) process.exit(parallel);
  process.exit(vitest(['--fileParallelism=false', ...SERIAL_FILES]));
}
if (args.length > 0) {
  process.exit(vitest(args));
}
const parallel = vitest(SERIAL_FILES.flatMap((file) => ['--exclude', file]));
if (parallel !== 0) process.exit(parallel);
process.exit(vitest(['--fileParallelism=false', ...SERIAL_FILES]));
