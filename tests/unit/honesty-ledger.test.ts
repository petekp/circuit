import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HonestyLedger, honestyLatchGap } from '../../src/runtime/run/honesty-ledger.js';
import { closeRun } from '../../src/runtime/run/run-close.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

let ledgerDir: string;

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'circuit-honesty-ledger-'));
});

afterEach(() => {
  rmSync(ledgerDir, { recursive: true, force: true });
});

describe('HonestyLedger latch lifecycle', () => {
  it('starts with no open latches', () => {
    const ledger = new HonestyLedger();
    expect(ledger.hasOpenLatches()).toBe(false);
    expect(ledger.openLatches()).toEqual([]);
    expect(ledger.openLatchSummary()).toBeUndefined();
  });

  it('opens a latch for an overclaiming step and reports it open', () => {
    const ledger = new HonestyLedger();
    ledger.latchOverclaim({
      stepId: 'work-step',
      iterationIndex: 0,
      reason: "report claimed 'src/a.ts' with no change on disk",
    });
    expect(ledger.hasOpenLatches()).toBe(true);
    expect(ledger.openLatches()).toEqual([
      {
        stepId: 'work-step',
        iterationIndex: 0,
        reason: "report claimed 'src/a.ts' with no change on disk",
      },
    ]);
  });

  it('keys latches by step id: a later overclaim on the same step refreshes, not duplicates', () => {
    const ledger = new HonestyLedger();
    ledger.latchOverclaim({ stepId: 'work-step', iterationIndex: 0, reason: 'first' });
    ledger.latchOverclaim({ stepId: 'work-step', iterationIndex: 2, reason: 'second' });
    expect(ledger.openLatches()).toEqual([
      { stepId: 'work-step', iterationIndex: 2, reason: 'second' },
    ]);
  });

  it('clears a latch when the step later runs clean', () => {
    const ledger = new HonestyLedger();
    ledger.latchOverclaim({ stepId: 'work-step', iterationIndex: 0, reason: 'overclaim' });
    ledger.clearLatch('work-step');
    expect(ledger.hasOpenLatches()).toBe(false);
  });

  it('clearing a step with no open latch is a no-op', () => {
    const ledger = new HonestyLedger();
    ledger.clearLatch('never-latched');
    expect(ledger.hasOpenLatches()).toBe(false);
  });

  it('summarizes the open latches as a one-line reason', () => {
    const ledger = new HonestyLedger();
    ledger.latchOverclaim({ stepId: 'a-step', iterationIndex: 1, reason: 'x' });
    ledger.latchOverclaim({ stepId: 'b-step', iterationIndex: 1, reason: 'y' });
    const summary = ledger.openLatchSummary();
    expect(summary).toBeDefined();
    expect(summary).toContain('a-step');
    expect(summary).toContain('b-step');
  });
});

describe('HonestyLedger durability', () => {
  it('persists open latches atomically to its run-folder path', () => {
    const path = join(ledgerDir, 'honesty-ledger.json');
    const ledger = new HonestyLedger({ path });
    ledger.latchOverclaim({ stepId: 'work-step', iterationIndex: 0, reason: 'overclaim' });

    // The durable file is a complete JSON document (atomic write, never torn),
    // so a crash mid-loop leaves the open-latch set inspectable after the fact.
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.open_overclaims).toEqual([
      { stepId: 'work-step', iterationIndex: 0, reason: 'overclaim' },
    ]);
  });

  it('rewrites the durable file when a latch clears', () => {
    const path = join(ledgerDir, 'honesty-ledger.json');
    const ledger = new HonestyLedger({ path });
    ledger.latchOverclaim({ stepId: 'work-step', iterationIndex: 0, reason: 'overclaim' });
    ledger.clearLatch('work-step');

    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.open_overclaims).toEqual([]);
  });

  it('is a no-op on disk when constructed without a path (in-memory only)', () => {
    const ledger = new HonestyLedger();
    // No throw, no file: a default run carries no ledger file.
    expect(() =>
      ledger.latchOverclaim({ stepId: 'work-step', iterationIndex: 0, reason: 'overclaim' }),
    ).not.toThrow();
  });
});

describe('honestyLatchGap (the finalize chokepoint)', () => {
  it('returns undefined when no latch is open: a clean complete is allowed', () => {
    const ledger = new HonestyLedger();
    expect(honestyLatchGap(ledger)).toBeUndefined();
  });

  it('returns undefined when there is no ledger at all', () => {
    expect(honestyLatchGap(undefined)).toBeUndefined();
  });

  it('returns the open-latch summary when a latch is open: complete is blocked', () => {
    const ledger = new HonestyLedger();
    ledger.latchOverclaim({ stepId: 'work-step', iterationIndex: 0, reason: 'overclaim' });
    expect(honestyLatchGap(ledger)).toContain('work-step');
  });
});

// The chokepoint wired into the real close path: a run that reaches closeRun
// with outcome 'complete' is downgraded to 'stopped' when the ledger still
// holds an open latch, and the run result records why. Proven here in isolation
// (a hand-built context) so a regression in the closeRun wiring is caught
// without driving a whole graph run; the end-to-end path is proven separately.
describe('closeRun finalize chokepoint', () => {
  function closeContext(ledger: HonestyLedger | undefined): {
    context: RunContext;
    written: { path: string; value: unknown }[];
  } {
    const written: { path: string; value: unknown }[] = [];
    const context = {
      flow: { id: 'converge-proof' },
      runId: '70000000-0000-0000-0000-0000000000c1',
      goal: 'prove the finalize chokepoint downgrades a latched complete',
      manifestHash: 'h'.repeat(64),
      now: deterministicNow(Date.UTC(2026, 5, 27, 18, 0, 0)),
      trace: { getAll: () => [], append: async () => undefined },
      files: {
        writeJson: async (path: string, value: unknown) => {
          written.push({ path, value });
          return path;
        },
      },
      ...(ledger === undefined ? {} : { honestyLedger: ledger }),
    } as unknown as RunContext;
    return { context, written };
  }

  it('downgrades a complete close to stopped while a latch is open', async () => {
    const ledger = new HonestyLedger();
    ledger.latchOverclaim({ stepId: 'work-step', iterationIndex: 1, reason: 'overclaim' });
    const { context } = closeContext(ledger);

    const closed = await closeRun(context, 'complete', '@complete');

    expect(closed.result.outcome).toBe('stopped');
    expect(closed.result.reason).toContain('work-step');
  });

  it('honors a complete close once the latch has cleared', async () => {
    const ledger = new HonestyLedger();
    ledger.latchOverclaim({ stepId: 'work-step', iterationIndex: 1, reason: 'overclaim' });
    ledger.clearLatch('work-step');
    const { context } = closeContext(ledger);

    const closed = await closeRun(context, 'complete', '@complete');

    expect(closed.result.outcome).toBe('complete');
  });

  it('is inert when the run carries no ledger (default close path unchanged)', async () => {
    const { context } = closeContext(undefined);
    const closed = await closeRun(context, 'complete', '@complete');
    expect(closed.result.outcome).toBe('complete');
  });
});
