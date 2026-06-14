import { describe, expect, it } from 'vitest';

import { terminalOutcomeBoundToPrimaryResult } from '../../src/runtime/run/run-close.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';

// Characterizes the close-time outcome binding for flows that declare
// bindsTerminalOutcomeToPrimaryResult (only `goal` today). The function reads
// the primary result at close time to bind the run outcome; the contract under
// test is that this read FAILS OPEN — a missing or malformed primary result
// returns undefined so the caller keeps the proof-derived outcome instead of
// crashing the close path (the RCX-6b hardening).
//
// First-class composition (M3b-B + M4): both goal's engine flag AND its
// primary-result path ride its compiled manifest, so at runtime `fromCompiledFlow`
// translates them onto context.flow.engineFlags and context.flow.runtimeSurface.
// The stub carries both; the by-id catalog package is gone, so only
// context.files.readJson is stubbed.

function goalContextReading(readJson: (ref: string) => Promise<unknown>): RunContext {
  return {
    flow: {
      id: 'goal',
      engineFlags: { bindsTerminalOutcomeToPrimaryResult: true },
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
