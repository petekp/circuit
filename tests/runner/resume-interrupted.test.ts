import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseExecutionArgs, runResumeCommand } from '../../src/cli/run.js';
import { CompiledFlowId, RunId } from '../../src/schemas/ids.js';
import { writeManifestSnapshot } from '../../src/shared/manifest-snapshot.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

// An interrupted run is a run folder whose process died mid-execution: the trace
// has a runtime bootstrap and some step entries, but it never reached a
// checkpoint (nothing to resume) and never wrote run.closed (never finished).
// `circuit resume` cannot resume it, but the operator standing at a terminal
// after a crash still points resume at it. The old behavior surfaced the
// internal rejection verbatim ("runtime checkpoint resume rejected: run has no
// unresolved checkpoint request"), which is project-internal jargon and gives
// the operator no next step. The front-door fix answers honestly: name that the
// run was interrupted, and point at the inspection command. This is the deferred
// half of the F14 finding (the safe half — the composite missing-flag error —
// shipped in c7830edf; see resume-args.test.ts).

const tempRoots: string[] = [];
const RECORDED_AT = '2026-04-30T12:00:00.000Z';
const FIX_FLOW_BYTES = readFileSync(resolve('generated/flows/fix/circuit.json'));
const RUN_ID = '55555555-5555-5555-5555-555555555501';

const change_kind = {
  change_kind: 'discovery' as const,
  failure_mode: 'interrupted-resume test fixture',
  acceptance_evidence: 'resume names the interrupted run and points at runs show',
  alternate_framing: 'hand-authored interrupted run folder',
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A run interrupted mid-step: bootstrap + step.entered, then nothing. No
// checkpoint.requested, no run.closed. This projects as engine_state 'open'
// (reason 'active_or_unknown') — the interrupted / still-running shape.
function makeInterruptedFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'circuit-resume-interrupted-'));
  tempRoots.push(root);
  const runFolder = join(root, 'runs', 'run-interrupted');
  mkdirSync(runFolder, { recursive: true });
  const manifest = writeManifestSnapshot(runFolder, {
    run_id: RunId.parse(RUN_ID),
    flow_id: CompiledFlowId.parse('fix'),
    captured_at: RECORDED_AT,
    bytes: FIX_FLOW_BYTES,
  });
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${[
      {
        schema_version: 1,
        sequence: 0,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'run.bootstrapped',
        flow_id: 'fix',
        depth: 'medium',
        goal: 'Interrupted run that never reached a checkpoint',
        change_kind,
        manifest_hash: manifest.hash,
      },
      {
        schema_version: 1,
        sequence: 1,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'step.entered',
        step_id: 'fix-gather-context',
        attempt: 1,
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`,
  );
  return runFolder;
}

describe('resume against an interrupted run', () => {
  it('answers honestly and points at inspection instead of leaking internal jargon', async () => {
    const runFolder = makeInterruptedFolder();
    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runFolder,
      '--checkpoint-choice',
      'option-1',
    ]);

    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    // Non-resumable folders exit 2 (same code as the not-a-runtime-folder path).
    expect(result).toBe(2);
    // Honest, operator-facing framing: it was interrupted / has no checkpoint.
    expect(stderr.toLowerCase()).toMatch(/interrupted|no checkpoint/);
    // Actionable: point at the inspection front door.
    expect(stderr).toContain('circuit runs show');
    expect(stderr).toContain(runFolder);
    // No project-internal vocabulary leaks to the operator.
    expect(stderr).not.toContain('runtime checkpoint resume rejected');
  });
});
