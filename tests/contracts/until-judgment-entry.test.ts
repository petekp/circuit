// Contract for the run.until-judgment trace entry — the durable per-iteration
// record of an until-loop's stop-judge disposition. The cross-field invariant
// mirrors disposeIteration (src/runtime/run/until-corridor.ts): a 'stop-clean'
// disposition is reachable only when BOTH the goal was proposed AND the evidence
// confirmed it. The union-level superRefine enforces that here so a tampered or
// hand-built entry that claims a clean stop on unconfirmed evidence is rejected.

import { describe, expect, it } from 'vitest';
import { RunUntilJudgmentTraceEntry, TraceEntry } from '../../src/schemas/trace-entry.js';

const BASE = {
  schema_version: 1 as const,
  sequence: 7,
  recorded_at: '2026-06-28T05:00:00.000Z',
  run_id: '0191d2f0-aaaa-7fff-8aaa-000000000000',
  kind: 'run.until-judgment' as const,
  step_id: 'loop-tail',
  iteration: 2,
  no_progress_count: 0,
  open_latch_count: 0,
};

describe('run.until-judgment trace entry', () => {
  it('accepts a valid stop-clean entry (goal proposed AND evidence confirmed)', () => {
    const ok = TraceEntry.safeParse({
      ...BASE,
      goal_proposed: true,
      evidence_confirmed: true,
      disposition: 'stop-clean',
      lesson: 'verify is green',
    });
    expect(ok.success).toBe(true);
  });

  it('also accepts the variant schema directly', () => {
    const ok = RunUntilJudgmentTraceEntry.safeParse({
      ...BASE,
      goal_proposed: true,
      evidence_confirmed: true,
      disposition: 'stop-clean',
    });
    expect(ok.success).toBe(true);
  });

  it('REJECTS a stop-clean entry whose evidence did not confirm (a laundered false-done)', () => {
    const bad = TraceEntry.safeParse({
      ...BASE,
      goal_proposed: true,
      evidence_confirmed: false,
      disposition: 'stop-clean',
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((issue) => issue.path.includes('evidence_confirmed'))).toBe(
        true,
      );
    }
  });

  it('REJECTS a stop-clean entry whose goal was not proposed', () => {
    const bad = TraceEntry.safeParse({
      ...BASE,
      goal_proposed: false,
      evidence_confirmed: true,
      disposition: 'stop-clean',
    });
    expect(bad.success).toBe(false);
  });

  it('accepts a reenter entry with both booleans false (the not-done pass)', () => {
    const ok = TraceEntry.safeParse({
      ...BASE,
      iteration: 0,
      goal_proposed: false,
      evidence_confirmed: false,
      disposition: 'reenter',
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a reenter entry that proposed the goal but the evidence rejected it', () => {
    const ok = TraceEntry.safeParse({
      ...BASE,
      iteration: 0,
      goal_proposed: true,
      evidence_confirmed: false,
      disposition: 'reenter',
      open_latch_count: 1,
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a needs-attention entry at the cap', () => {
    const ok = TraceEntry.safeParse({
      ...BASE,
      goal_proposed: false,
      evidence_confirmed: false,
      disposition: 'needs-attention',
      no_progress_count: 2,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an empty lesson string (a present field must carry content)', () => {
    const bad = RunUntilJudgmentTraceEntry.safeParse({
      ...BASE,
      goal_proposed: false,
      evidence_confirmed: false,
      disposition: 'reenter',
      lesson: '',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects an unknown field (the variant is strict)', () => {
    const bad = RunUntilJudgmentTraceEntry.safeParse({
      ...BASE,
      goal_proposed: false,
      evidence_confirmed: false,
      disposition: 'reenter',
      until_iteration_index: 3,
    });
    expect(bad.success).toBe(false);
  });
});
