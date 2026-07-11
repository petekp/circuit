// Path A: the power dial derives process (run) thoroughness when --process is
// absent, clamped to the target flow's supported set. This file covers the
// derivation mapping (power word -> process word), the per-flow clamp shapes
// (full ladder / floor / pin), an explicit --process beating the derivation,
// and that an explicit --process outside the flow's set still fails closed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureStreams, deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { main } from '../../src/cli/circuit.js';
import { clampDerivedDepthToFlow, deriveProcessFromPower } from '../../src/cli/run.js';
import type { PowerDialResolution } from '../../src/selection/power-tiers.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

describe('deriveProcessFromPower', () => {
  it('maps a fixed dial word to the same process word', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const setting: PowerDialResolution = { kind: 'fixed', value: tier };
      expect(deriveProcessFromPower(setting)).toBe(tier);
    }
  });

  it('derives medium for auto regardless of its bounds', () => {
    const setting: PowerDialResolution = { kind: 'auto', floor: 'low', ceiling: 'high' };
    expect(deriveProcessFromPower(setting)).toBe('medium');
  });
});

describe('clampDerivedDepthToFlow', () => {
  it('is a no-op on the full ladder (Build/Explore/Fix)', () => {
    const fullLadder = ['low', 'medium', 'high'] as const;
    expect(clampDerivedDepthToFlow('low', fullLadder)).toBe('low');
    expect(clampDerivedDepthToFlow('medium', fullLadder)).toBe('medium');
    expect(clampDerivedDepthToFlow('high', fullLadder)).toBe('high');
  });

  it('floors below the lowest allowed value (Prototype)', () => {
    const floored = ['medium', 'high'] as const;
    expect(clampDerivedDepthToFlow('low', floored)).toBe('medium');
    expect(clampDerivedDepthToFlow('medium', floored)).toBe('medium');
    expect(clampDerivedDepthToFlow('high', floored)).toBe('high');
  });

  it('pins to the single allowed value (Review/Pursue)', () => {
    const pinned = ['medium'] as const;
    expect(clampDerivedDepthToFlow('low', pinned)).toBe('medium');
    expect(clampDerivedDepthToFlow('medium', pinned)).toBe('medium');
    expect(clampDerivedDepthToFlow('high', pinned)).toBe('medium');
  });
});

// Integration coverage: the same behavior end to end through `circuit run`,
// proving the wiring (power flag -> config layer -> derivation -> flow
// clamp -> runtime axes) and not just the isolated pure functions above.
let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-process-derivation-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

function createProofProject(name: string): string {
  const projectRoot = join(runFolderBase, name);
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { verify: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

function traceEntryLog(runFolder: string): Array<Record<string, unknown>> {
  return readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Build's frame-step is a checkpoint, but it only parks the run (waiting) at
// high/tournament depth; low/medium auto-continue past it via its declared
// safe default and reach the first real relay (analyze-step). Either way,
// `run.bootstrapped` is traced immediately at run start with the resolved
// depth, before any checkpoint or relay runs, so a relayer that refuses every
// call is enough to prove the derived depth without stubbing Build's full
// relay pipeline.
function refusingRelayer(): RelayFn {
  return makeStubRelayer(() => {
    throw new Error('unexpected relay call: only run.bootstrapped is under test');
  });
}

async function runMain(
  argv: readonly string[],
  relayer: RelayFn,
  configCwd: string,
): Promise<{ readonly exit: number; readonly stdout: string; readonly stderr: string }> {
  const {
    result: exit,
    stdout,
    stderr,
  } = await captureStreams(() =>
    main(argv, {
      relayer,
      now: deterministicNow(Date.UTC(2026, 6, 10, 12, 0, 0)),
      runId: '86000000-0000-4000-8000-000000000001',
      configHomeDir: join(runFolderBase, 'empty-home'),
      configCwd,
    }),
  );
  return { exit, stdout, stderr };
}

describe('power-derived process reaches the runtime (Build, full ladder)', () => {
  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['auto', 'medium'],
  ] as const)('--power %s derives process %s when --process is absent', async (power, expected) => {
    const runFolder = join(runFolderBase, `build-power-${power}`);
    const projectRoot = createProofProject(`build-power-${power}-project`);
    await runMain(
      [
        'run',
        'build',
        '--goal',
        'develop: add a small standard change',
        '--power',
        power,
        '--run-folder',
        runFolder,
      ],
      refusingRelayer(),
      projectRoot,
    );
    const bootstrap = traceEntryLog(runFolder).find(
      (traceEntry) => traceEntry.kind === 'run.bootstrapped',
    );
    expect(bootstrap).toMatchObject({ depth: expected });
  });

  it('an explicit --process beats the power-derived value', async () => {
    const runFolder = join(runFolderBase, 'build-explicit-beats-derived');
    const projectRoot = createProofProject('build-explicit-beats-derived-project');
    await runMain(
      [
        'run',
        'build',
        '--goal',
        'develop: add a small standard change',
        '--power',
        'high',
        '--process',
        'low',
        '--run-folder',
        runFolder,
      ],
      refusingRelayer(),
      projectRoot,
    );
    const bootstrap = traceEntryLog(runFolder).find(
      (traceEntry) => traceEntry.kind === 'run.bootstrapped',
    );
    expect(bootstrap).toMatchObject({ depth: 'low' });
  });
});

// The operator surface names a derived tier too: with only --power given, the
// stdout envelope carries entry_mode/entry_mode_source ('derived') when the
// derived tier lands off the flow default, and stays silent when it does not
// (bare-run parity). Locks the fix for the review finding that --power high
// lost the "Chose build with high thoroughness" confirmation.
describe('power-derived entry mode reaches the operator surface', () => {
  async function envelopeFor(
    flowName: string,
    power: string,
    name: string,
  ): Promise<Record<string, unknown>> {
    const runFolder = join(runFolderBase, name);
    const projectRoot = createProofProject(`${name}-project`);
    const { stdout } = await runMain(
      [
        'run',
        flowName,
        '--goal',
        'develop: add a small standard change',
        '--power',
        power,
        '--run-folder',
        runFolder,
      ],
      refusingRelayer(),
      projectRoot,
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  }

  it('names a derived high tier in the envelope', async () => {
    const envelope = await envelopeFor('build', 'high', 'entry-mode-derived-high');
    expect(envelope.entry_mode).toBe('high');
    expect(envelope.entry_mode_source).toBe('derived');
  });

  it('stays silent when the derived tier is the flow default', async () => {
    const envelope = await envelopeFor('build', 'medium', 'entry-mode-derived-default');
    expect(envelope.entry_mode).toBeUndefined();
    expect(envelope.entry_mode_source).toBeUndefined();
  });

  it('stays silent when the clamp lands the derived tier on the default (Review)', async () => {
    const envelope = await envelopeFor('review', 'high', 'entry-mode-derived-clamped');
    expect(envelope.entry_mode).toBeUndefined();
    expect(envelope.entry_mode_source).toBeUndefined();
  });
});

const REVIEW_RELAY_BODY = JSON.stringify({
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
  verification: ['Inspected the relayed intake report.'],
  confidence_limitations: [],
});

function reviewRelayer(): RelayFn {
  return makeStubRelayer(REVIEW_RELAY_BODY, { receipt_id: 'process-derivation-review-receipt' });
}

describe('power-derived process clamps to the flow (Review, pinned to medium)', () => {
  it.each(['low', 'high'] as const)(
    'clamps a derived %s process to the only allowed value',
    async (power) => {
      const runFolder = join(runFolderBase, `review-power-${power}`);
      const { exit, stdout, stderr } = await runMain(
        [
          'run',
          'review',
          '--goal',
          'review this patch for safety problems',
          '--power',
          power,
          '--run-folder',
          runFolder,
        ],
        reviewRelayer(),
        join(runFolderBase, 'empty-cwd'),
      );
      expect(exit, stderr).toBe(0);
      const output = JSON.parse(stdout) as { resolved_axes?: { depth?: string } };
      expect(output.resolved_axes?.depth).toBe('medium');
    },
  );

  it('rejects an explicit --process outside the flow set as a usage error', async () => {
    const runFolder = join(runFolderBase, 'review-explicit-process-rejected');
    const { exit, stderr } = await runMain(
      [
        'run',
        'review',
        '--goal',
        'review this patch for safety problems',
        '--process',
        'low',
        '--run-folder',
        runFolder,
      ],
      reviewRelayer(),
      join(runFolderBase, 'empty-cwd'),
    );
    expect(exit).toBe(2);
    expect(stderr).toContain("--process low is not supported by flow 'review'");
    expect(stderr).toContain('review allows depths: medium');
  });
});

describe('--depth retirement', () => {
  it('rejects --depth as a retired, unknown option', async () => {
    const runFolder = join(runFolderBase, 'depth-retired');
    const { exit, stderr } = await runMain(
      [
        'run',
        'review',
        '--goal',
        'review this patch for safety problems',
        '--depth',
        'medium',
        '--run-folder',
        runFolder,
      ],
      reviewRelayer(),
      join(runFolderBase, 'empty-cwd'),
    );
    expect(exit).toBe(2);
    expect(stderr).toMatch(/unknown option '--depth'/);
  });
});
