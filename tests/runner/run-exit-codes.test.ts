import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  exitCodeForClosedOutcome,
  parseExecutionArgs,
  runExecutionCommand,
} from '../../src/cli/run.js';
import { RunClosedOutcome } from '../../src/schemas/trace-entry.js';
import { captureStreams, makeStubRelayer } from '../helpers/runtime-fixtures.js';

// First-run lab finding 1 (clean-room container battery): a run that closed
// with outcome "aborted" exited 0, so a script or agent wrapping the CLI read
// failure as success. The stdout JSON envelope is unchanged; the process exit
// code now mirrors the closed outcome: exit 0 means "the run closed complete
// or is parked at a checkpoint waiting for you"; every close short of complete
// (aborted, stopped, escalated, handoff) exits 1; usage errors stay 2. Like
// grep, a nonzero exit is not "the tool malfunctioned" — it is "you did not
// get the completed goal", so `circuit run ... && next-step` can never chain
// onto unfinished work. A checkpoint park is the command succeeding at
// bringing the run to its decision point, so waiting stays 0 (covered in
// cli-router).

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

  // The e2e cases above prove the wiring at the close seam; this pins the
  // mapping over the full closed-outcome vocabulary. stopped/escalated/handoff
  // closes are only reachable deep inside the goal and explainer flows (many
  // typed relays away), so the mapping function is exported for
  // characterization instead — the run-close.ts idiom.
  it('maps every closed outcome: complete exits 0, every close short of complete exits 1', () => {
    const expected: Record<RunClosedOutcome, number> = {
      complete: 0,
      aborted: 1,
      stopped: 1,
      escalated: 1,
      handoff: 1,
    };
    for (const outcome of RunClosedOutcome.options) {
      expect(exitCodeForClosedOutcome(outcome), `outcome '${outcome}'`).toBe(expected[outcome]);
    }
  });
});
