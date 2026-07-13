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

describe('fresh-run launch required-input validation', () => {
  it('collects the missing flow name and --goal into one error on a bare run', () => {
    // A bare `circuit run` used to say only "--goal is required"; the flow-name
    // requirement surfaced on the rerun. One composite message, mirroring the
    // resume branch above, lets the operator fix the invocation in one step.
    const message = messageFrom(() => parseExecutionArgs('run', []));
    expect(message).toContain('a flow name');
    expect(message).toContain('--goal');
  });

  it('names only the flow name when --goal is already supplied', () => {
    const message = messageFrom(() => parseExecutionArgs('run', ['--goal', 'fix the bug']));
    expect(message).toContain('a flow name is required');
    expect(message).not.toContain('--goal');
  });

  it('names only --goal when the flow name is already supplied', () => {
    const message = messageFrom(() => parseExecutionArgs('run', ['fix']));
    expect(message).toContain('--goal is required');
    expect(message).not.toContain('flow name');
  });

  it('offers only host-visible flows in the missing-flow-name error', () => {
    // The offer derives from the catalog's visibility: an internal flow
    // (pursue) must never be advertised on the misuse surface, matching the
    // unknown-flow listing which already excludes it.
    const message = messageFrom(() => parseExecutionArgs('run', ['--goal', 'fix the bug']));
    for (const flow of ['build', 'explore', 'fix', 'prototype', 'review']) {
      expect(message).toContain(flow);
    }
    expect(message).not.toContain('pursue');
  });
});

describe('--process value validation', () => {
  it('rejects an unknown --process value with a one-liner naming the valid values', () => {
    // A bad --process value used to dump a raw schema-error JSON array. It must
    // answer like --power does: one line, valid values named.
    const message = messageFrom(() =>
      parseExecutionArgs('run', ['fix', '--goal', 'fix the bug', '--process', 'banana']),
    );
    expect(message).toBe('--process must be one of low, medium, high');
  });
});
