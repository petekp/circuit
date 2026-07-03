import { describe, expect, it } from 'vitest';
import { parseExecutionArgs } from '../../src/cli/run.js';

function messageFrom(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

describe('checkpoint resume required-flag validation', () => {
  it('names both missing required flags in one error instead of one at a time', () => {
    // `circuit resume` with neither flag used to surface --run-folder first, then
    // --checkpoint-choice only after the operator added the first flag and reran.
    // One composite message lets them supply both in a single correction — the
    // F14 resume front-door finding.
    const message = messageFrom(() => parseExecutionArgs('resume', []));
    expect(message).toContain('--run-folder');
    expect(message).toContain('--checkpoint-choice');
  });

  it('names only the still-missing flag when one required flag is already supplied', () => {
    const message = messageFrom(() =>
      parseExecutionArgs('resume', ['--checkpoint-choice', 'option-1']),
    );
    expect(message).toContain('--run-folder');
    expect(message).not.toContain('--checkpoint-choice');
  });

  it('accepts a resume invocation once both required flags are present', () => {
    const parsed = parseExecutionArgs('resume', [
      '--run-folder',
      '.circuit/runs/run-x',
      '--checkpoint-choice',
      'option-1',
    ]);
    expect(parsed.command).toBe('resume');
    expect(parsed.runFolder).toBe('.circuit/runs/run-x');
    expect(parsed.checkpointChoice).toBe('option-1');
  });
});
