import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  exitCodeForClosedOutcome,
  exitCodeForRun,
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
  // A reviewer that answers with the wrong shape closes `evidence_invalid`: the
  // relay ran, but its report never validated, so there is nothing to stand on.
  // What this test pins is the exit code, not the label — every close short of
  // complete exits 1.
  it('exits 1 when the run closes short of complete, with the envelope intact on stdout', async () => {
    const runFolder = join(mkdtempSync(join(tmpdir(), 'circuit-exit-codes-')), 'unproven-run');
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      'Review this supplied text: a malformed relay body must close with a nonzero exit code.',
      '--run-folder',
      runFolder,
    ]);
    const { result, stdout } = await captureStreams(() =>
      runExecutionCommand(args, { relayer: makeStubRelayer(() => MALFORMED_REVIEW_BODY) }),
    );

    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    expect(envelope.outcome).toBe('evidence_invalid');
    expect(result).toBe(1);
    // The failure signal is additive: the envelope still carries the receipts.
    expect(typeof envelope.result_path).toBe('string');
    const recorded = JSON.parse(readFileSync(envelope.result_path as string, 'utf8')) as {
      outcome?: string;
    };
    expect(recorded.outcome).toBe('evidence_invalid');
  });

  it('still exits 0 when the run closes complete', async () => {
    const runFolder = join(mkdtempSync(join(tmpdir(), 'circuit-exit-codes-')), 'complete-run');
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      'Review this supplied text: a clean close should keep exit code zero.',
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
      evidence_invalid: 1,
      stopped: 1,
      escalated: 1,
      handoff: 1,
    };
    for (const outcome of RunClosedOutcome.options) {
      expect(exitCodeForClosedOutcome(outcome), `outcome '${outcome}'`).toBe(expected[outcome]);
    }
  });
});

// M1: a `complete` close alone does not earn exit 0. Two independent signals can
// contradict it, and the CLI must never report success over the run's own honest
// verdict. (1) The run envelope re-derives `needs_attention` when a `complete`
// run is missing a declared evidence path, so the close says complete while the
// envelope does not. (2) When an autonomous continuation loop ran, the loop —
// not the primary attempt — owns the completion decision. exitCodeForRun folds
// both in on top of the closed-outcome mapping above.
describe('exit code honors the envelope verdict and the loop verdict (M1)', () => {
  it('drops a complete close to exit 1 when the envelope re-derived short of complete', () => {
    for (const envelopeOutcome of ['needs_attention', 'blocked', 'failed', 'handoff'] as const) {
      expect(
        exitCodeForRun({ outcome: 'complete', envelopeOutcome }),
        `envelope '${envelopeOutcome}'`,
      ).toBe(1);
    }
  });

  it('stays exit 0 when the close and the envelope both say complete', () => {
    expect(exitCodeForRun({ outcome: 'complete', envelopeOutcome: 'complete' })).toBe(0);
    // No envelope re-derivation in play leaves the closed-outcome mapping intact.
    expect(exitCodeForRun({ outcome: 'complete' })).toBe(0);
  });

  it('never lets an envelope rescue a close that already fell short of complete', () => {
    expect(exitCodeForRun({ outcome: 'aborted' })).toBe(1);
    expect(exitCodeForRun({ outcome: 'stopped', envelopeOutcome: 'complete' })).toBe(1);
  });

  it('gives an autonomous loop the final say over the primary close', () => {
    // The loop recovered a primary that closed needing attention: exit 0.
    expect(exitCodeForRun({ outcome: 'handoff', autonomousLoopOutcome: 'complete' })).toBe(0);
    // The loop exhausted itself over a primary that closed complete: exit 1,
    // overriding both the complete close and a complete envelope.
    expect(
      exitCodeForRun({
        outcome: 'complete',
        envelopeOutcome: 'complete',
        autonomousLoopOutcome: 'needs_attention',
      }),
    ).toBe(1);
    expect(exitCodeForRun({ outcome: 'complete', autonomousLoopOutcome: 'failed' })).toBe(1);
  });
});
