import { describe, expect, it } from 'vitest';

import { parseExecutionArgs } from '../../src/cli/run.js';

describe('--checkpoint-review parsing', () => {
  it('accepts the blocking local review mode as a resume input', () => {
    const parsed = parseExecutionArgs('resume', [
      '--run-folder',
      "/tmp/Circuit Pete's run",
      '--checkpoint-review',
    ]);

    expect(parsed.checkpointReview).toBe(true);
    expect(parsed.checkpointChoice).toBeUndefined();
    expect(parsed.checkpointResponse).toBeUndefined();
    expect(parsed.checkpointResponseFile).toBeUndefined();
  });

  it.each([
    ['--checkpoint-choice', 'continue'],
    ['--checkpoint-response', 'ckr1.invalid'],
    ['--checkpoint-response-file', '/tmp/review.json'],
  ])('rejects --checkpoint-review with %s', (flag, value) => {
    expect(() =>
      parseExecutionArgs('resume', [
        '--run-folder',
        '/tmp/run',
        '--checkpoint-review',
        flag,
        value,
      ]),
    ).toThrow(/use only one/i);
  });

  it('rejects review mode on a fresh run', () => {
    expect(() =>
      parseExecutionArgs('run', ['build', '--goal', 'Build the thing', '--checkpoint-review']),
    ).toThrow('checkpoint resume must use the `resume` subcommand');
  });
});
