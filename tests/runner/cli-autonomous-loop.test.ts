import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureStreams, deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { main } from '../../src/cli/circuit.js';

// Build's autonomous run auto-resolves its checkpoint and accepts a uniform
// verdict body across steps. The bare body fails the typed step schemas, so
// the primary attempt closes aborted — deliberately: these tests pin the loop
// contract (it fires, records honestly, and leaves no artifacts on the default
// path) on a failing primary attempt, not run success.
const relayer = makeStubRelayer('{"verdict":"accept"}', {
  receipt_id: 'stub-receipt-autonomous-loop',
});

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'circuit-cli-autonomous-loop-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createProofProject(name: string): string {
  const projectRoot = join(tempDir, name);
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { verify: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

async function runMainJson(
  argv: readonly string[],
  configCwd: string,
): Promise<Record<string, unknown>> {
  const { result: exit, stdout } = await captureStreams(() =>
    main(argv, {
      relayer,
      now: deterministicNow(Date.UTC(2026, 4, 28, 5, 0, 0)),
      runId: '84000000-0000-0000-0000-000000000777',
      configHomeDir: join(tempDir, 'empty-home'),
      configCwd,
    }),
  );
  const output = JSON.parse(stdout) as Record<string, unknown>;
  // The CLI exit code mirrors the closed outcome: complete exits 0, every
  // close short of complete exits 1.
  expect(exit).toBe(output.outcome === 'complete' ? 0 : 1);
  return output;
}

describe('CLI autonomous continuation loop (S10)', () => {
  it('drives the loop live in autonomous mode and persists the loop result', async () => {
    const runFolder = join(tempDir, 'auto-run');
    const projectRoot = createProofProject('auto-project');
    const output = await runMainJson(
      [
        'run',
        'build',
        '--goal',
        'Add a tiny Build feature with autonomous checkpoints',
        '--autonomous',
        '--run-folder',
        runFolder,
      ],
      projectRoot,
    );

    // The loop fired live: it drove the primary attempt and surfaced a typed,
    // honest outcome (never silently claiming completion).
    const loopField = output.autonomous_loop as
      | { outcome: string; attempts: number; stop_reason: string }
      | undefined;
    expect(loopField).toBeDefined();
    expect(typeof loopField?.outcome).toBe('string');
    expect(['complete', 'needs_attention', 'blocked', 'failed', 'handoff']).toContain(
      loopField?.outcome,
    );
    expect(loopField?.attempts).toBeGreaterThanOrEqual(1);

    expect(existsSync(join(runFolder, 'reports/autonomous-loop.json'))).toBe(true);
    const loop = JSON.parse(
      readFileSync(join(runFolder, 'reports/autonomous-loop.json'), 'utf8'),
    ) as { outcome: string; attempts: Array<{ process_id: string }>; stopReason: string };
    expect(loop.attempts.length).toBeGreaterThanOrEqual(1);
    expect(loop.attempts[0]?.process_id).toBe('build'); // attempt 1 is the primary flow
    expect(typeof loop.stopReason).toBe('string');
  }, 30_000);

  it('does not run the loop when --autonomous is absent (default path unchanged)', async () => {
    const runFolder = join(tempDir, 'manual-run');
    const projectRoot = createProofProject('manual-project');
    const output = await runMainJson(
      ['run', 'build', '--goal', 'Add a tiny Build feature', '--run-folder', runFolder],
      projectRoot,
    );

    expect(output).not.toHaveProperty('autonomous_loop');
    expect(existsSync(join(runFolder, 'reports/autonomous-loop.json'))).toBe(false);
  }, 30_000);
});
