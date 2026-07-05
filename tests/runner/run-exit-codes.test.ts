import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseExecutionArgs, runExecutionCommand } from '../../src/cli/run.js';
import { captureStreams, makeStubRelayer } from '../helpers/runtime-fixtures.js';

// First-run lab finding 1 (clean-room container battery): a run that closed
// with outcome "aborted" exited 0, so a script or agent wrapping the CLI read
// failure as success. The stdout JSON envelope is unchanged; the process exit
// code now mirrors the closed outcome: complete -> 0, aborted -> 1, usage
// errors stay 2. A checkpoint park is the command succeeding at bringing the
// run to its decision point, so waiting stays 0 (covered in cli-router).
// handoff/stopped/escalated closes stay 0 pending a deliberate decision.

const MALFORMED_REVIEW_BODY = '{"verdict":"NO_ISSUES_FOUND","findings":"not-an-array"}';
const VALID_REVIEW_BODY = JSON.stringify({
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
  verification: ['Inspected the relayed intake report.'],
  confidence_limitations: [],
});

describe('run exit codes mirror the closed outcome', () => {
  it('exits 1 when the run closes aborted, with the envelope intact on stdout', async () => {
    const runFolder = join(mkdtempSync(join(tmpdir(), 'circuit-exit-codes-')), 'aborted-run');
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      'exit-code contract: malformed relay body must abort nonzero',
      '--run-folder',
      runFolder,
    ]);
    const { result, stdout } = await captureStreams(() =>
      runExecutionCommand(args, { relayer: makeStubRelayer(() => MALFORMED_REVIEW_BODY) }),
    );

    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    expect(envelope.outcome).toBe('aborted');
    expect(result).toBe(1);
    // The failure signal is additive: the envelope still carries the receipts.
    expect(typeof envelope.result_path).toBe('string');
    const recorded = JSON.parse(readFileSync(envelope.result_path as string, 'utf8')) as {
      outcome?: string;
    };
    expect(recorded.outcome).toBe('aborted');
  });

  it('still exits 0 when the run closes complete', async () => {
    const runFolder = join(mkdtempSync(join(tmpdir(), 'circuit-exit-codes-')), 'complete-run');
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      'exit-code contract: a clean close stays 0',
      '--run-folder',
      runFolder,
    ]);
    const { result, stdout } = await captureStreams(() =>
      runExecutionCommand(args, { relayer: makeStubRelayer(() => VALID_REVIEW_BODY) }),
    );

    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    expect(envelope.outcome).toBe('complete');
    expect(result).toBe(0);
  });
});
