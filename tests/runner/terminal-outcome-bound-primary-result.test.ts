import { describe, expect, it } from 'vitest';

import { terminalOutcomeBoundToPrimaryResult } from '../../src/runtime/run/run-close.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';

// Characterizes the close-time outcome binding for a flow that declares a
// primary result (goal, here). The function reads that result at close time to
// bind the run outcome; the contract under test is that the read FAILS OPEN — a
// missing or malformed primary result returns undefined so the caller keeps the
// proof-derived outcome instead of crashing the close path (the RCX-6b
// hardening).
//
// Which flows the bind applies to is not characterized here. That is a property
// of the whole catalog, and it lives in
// tests/runner/primary-result-honesty-floor.test.ts so every future flow is
// enrolled in it automatically.
//
// First-class composition (M3b-B + M4): goal's primary-result path rides its
// compiled manifest, so at runtime `fromCompiledFlow` translates it onto
// context.flow.runtimeSurface. The by-id catalog package is gone, so only
// context.files.readJson is stubbed.

function goalContextReading(readJson: (ref: string) => Promise<unknown>): RunContext {
  return {
    flow: {
      id: 'goal',
      runtimeSurface: {
        primaryResult: { schemaName: 'goal.result@v1', path: 'reports/goal-result.json' },
      },
    },
    files: { readJson },
  } as unknown as RunContext;
}

describe('terminalOutcomeBoundToPrimaryResult', () => {
  it('binds a needs_attention primary result to a stopped run outcome', async () => {
    const context = goalContextReading(async () => ({ outcome: 'needs_attention' }));
    const bound = await terminalOutcomeBoundToPrimaryResult(context, 'complete');
    expect(bound?.outcome).toBe('stopped');
    expect(bound?.reason).toContain("reported outcome 'needs_attention'");
  });

  it('fails open (no throw) when the primary result read throws — missing or malformed JSON', async () => {
    const missing = goalContextReading(async () => {
      throw new Error("ENOENT: no such file 'reports/goal-result.json'");
    });
    await expect(terminalOutcomeBoundToPrimaryResult(missing, 'complete')).resolves.toBeUndefined();

    const malformed = goalContextReading(async () => {
      throw new SyntaxError('Unexpected token } in JSON');
    });
    await expect(
      terminalOutcomeBoundToPrimaryResult(malformed, 'complete'),
    ).resolves.toBeUndefined();
  });

  it('does not bind when the primary result is not an object', async () => {
    const context = goalContextReading(async () => 'not-an-object');
    await expect(terminalOutcomeBoundToPrimaryResult(context, 'complete')).resolves.toBeUndefined();
  });

  it('does not bind when the primary result outcome field is not a string', async () => {
    const context = goalContextReading(async () => ({ outcome: 42 }));
    await expect(terminalOutcomeBoundToPrimaryResult(context, 'complete')).resolves.toBeUndefined();
  });

  it('does not bind when the primary result reports complete (proof-derived complete stands)', async () => {
    const context = goalContextReading(async () => ({ outcome: 'complete' }));
    await expect(terminalOutcomeBoundToPrimaryResult(context, 'complete')).resolves.toBeUndefined();
  });

  it('names an unassessed guardrail in the reason instead of the bare outcome word (F7)', async () => {
    const context = goalContextReading(async () => ({
      outcome: 'needs_attention',
      scope: { unassessed_guardrails: ["every 'circuit--v' literal must equal the release tag"] },
    }));
    const bound = await terminalOutcomeBoundToPrimaryResult(context, 'complete');
    expect(bound?.outcome).toBe('stopped');
    expect(bound?.reason).toContain(
      "unassessed guardrail 'every 'circuit--v' literal must equal the release tag'",
    );
  });

  it('names a violated guardrail, an accept-with-fixes review, and an out-of-bounds path', async () => {
    const context = goalContextReading(async () => ({
      outcome: 'needs_attention',
      scope: { violated_guardrails: ['must not touch generated/'] },
      review_verdict: 'accept-with-fixes',
      touch_area: { out_of_bounds_paths: ['src/outside-scope.ts'] },
    }));
    const bound = await terminalOutcomeBoundToPrimaryResult(context, 'complete');
    expect(bound?.reason).toContain("violated guardrail 'must not touch generated/'");
    expect(bound?.reason).toContain("review verdict 'accept-with-fixes'");
    expect(bound?.reason).toContain("out-of-bounds path 'src/outside-scope.ts'");
  });

  it('keeps the bare-outcome reason when the primary result carries none of the named causes', async () => {
    const context = goalContextReading(async () => ({ outcome: 'needs_attention' }));
    const bound = await terminalOutcomeBoundToPrimaryResult(context, 'complete');
    expect(bound?.reason).toBe(
      "primary result 'reports/goal-result.json' reported outcome 'needs_attention'",
    );
  });

  it('short-circuits before reading when the run did not close complete', async () => {
    let read = false;
    const context = goalContextReading(async () => {
      read = true;
      return { outcome: 'needs_attention' };
    });
    await expect(terminalOutcomeBoundToPrimaryResult(context, 'stopped')).resolves.toBeUndefined();
    expect(read).toBe(false);
  });
});
