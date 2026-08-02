// The regression baseline decides what counts as proof that a bug was real.
// Two things have to stay true no matter how the command was chosen:
//
//   1. A command that fails before the fix is proof, whoever named it.
//   2. A command that PASSES before the fix means opposite things depending on
//      who named it. A brief that declared a repro and was wrong is a defect
//      worth re-framing. The project's own suite passing is the ordinary case
//      for a bug the suite never covered, and must not send the run to
//      recovery for doing nothing wrong.

import { describe, expect, it } from 'vitest';
import type { FixBrief } from '../../src/flows/fix/reports.js';
import {
  FixBrief as FixBriefSchema,
  FixRegressionProof as FixRegressionProofSchema,
} from '../../src/flows/fix/reports.js';
import { regressionProofCommand } from '../../src/flows/fix/writers/regression-command.js';
import {
  projectFixRegressionBaseline,
  projectFixRegressionRerun,
} from '../../src/flows/fix/writers/regression-projection.js';
import type { VerificationCommandObservation } from '../../src/flows/registries/verification-writers/types.js';
import { VerificationCommand } from '../../src/schemas/verification.js';

const REPRO_ARGV = ['npm', 'test', '--', 'pagination'];
const PROJECT_ARGV = ['npm', 'run', 'verify'];

function command(id: string, argv: readonly string[]) {
  return VerificationCommand.parse({
    id,
    cwd: '.',
    argv: [...argv],
    timeout_ms: 30_000,
    max_output_bytes: 200_000,
    env: {},
  });
}

function observation(
  argv: readonly string[],
  status: 'passed' | 'failed',
): VerificationCommandObservation {
  return {
    command: command('probe', argv),
    exit_code: status === 'passed' ? 0 : 1,
    status,
    duration_ms: 1,
    stdout_summary: '',
    stderr_summary: '',
    timed_out: false,
  };
}

function brief(input: {
  readonly declaredRepro?: boolean;
  readonly candidates?: readonly (readonly string[])[];
}): FixBrief {
  const candidates = input.candidates ?? [PROJECT_ARGV];
  return FixBriefSchema.parse({
    problem_statement: 'pagination drops the last row',
    expected_behavior: 'the last row is listed',
    observed_behavior: 'the last row is missing',
    scope: 'src/pagination.ts',
    regression_contract: {
      expected_behavior: 'the last row is listed',
      actual_behavior: 'the last row is missing',
      repro: { kind: 'not-reproducible', deferred_reason: 'read-only frame step' },
      regression_test:
        input.declaredRepro === true
          ? { status: 'failing-before-fix', command: command('fix-regression', REPRO_ARGV) }
          : { status: 'deferred', deferred_reason: 'read-only frame step' },
    },
    success_criteria: ['the last row is listed'],
    verification_command_candidates: candidates.map((argv, index) =>
      command(`candidate-${index}`, argv),
    ),
  });
}

describe('regressionProofCommand', () => {
  it('prefers a repro the brief declared', () => {
    const selected = regressionProofCommand(brief({ declaredRepro: true }));
    expect(selected?.source).toBe('declared');
    expect(selected?.command.argv).toEqual(REPRO_ARGV);
  });

  it("adopts the project's own resolved check when the brief deferred", () => {
    const selected = regressionProofCommand(brief({}));
    expect(selected?.source).toBe('adopted-verification');
    expect(selected?.command.argv).toEqual(PROJECT_ARGV);
  });

  it('takes the first candidate, the same one fix-verify runs', () => {
    const selected = regressionProofCommand(
      brief({ candidates: [PROJECT_ARGV, ['npm', 'run', 'lint']] }),
    );
    expect(selected?.command.argv).toEqual(PROJECT_ARGV);
  });

  // A valid brief always carries at least one candidate, so after adoption the
  // baseline always has something to run. That is the whole point: 'deferred'
  // stops being the default answer for any goal that did not name a repro.
  it('always finds a command, because a valid brief must carry a candidate', () => {
    expect(() => brief({ candidates: [] })).toThrow(/verification_command_candidates/);
    expect(regressionProofCommand(brief({}))).toBeDefined();
  });
});

describe('projectFixRegressionBaseline', () => {
  it('proves the bug when an adopted check fails before the fix', () => {
    const proof = projectFixRegressionBaseline(
      [observation(PROJECT_ARGV, 'failed')],
      regressionProofCommand(brief({})),
    );
    expect(proof.status).toBe('proved');
    expect(proof.overall_status).toBe('passed');
    expect(proof.command_source).toBe('adopted-verification');
  });

  it('records not-captured, and does not fail, when an adopted check already passes', () => {
    const proof = projectFixRegressionBaseline(
      [observation(PROJECT_ARGV, 'passed')],
      regressionProofCommand(brief({})),
    );
    expect(proof.status).toBe('not-captured');
    // The route the executor takes hangs on this. 'failed' would send a run
    // that did nothing wrong back to fix-frame.
    expect(proof.overall_status).toBe('passed');
    expect(proof.reason).toMatch(/already passed before the fix/);
  });

  it('still fails a declared repro that passes before the fix', () => {
    const proof = projectFixRegressionBaseline(
      [observation(REPRO_ARGV, 'passed')],
      regressionProofCommand(brief({ declaredRepro: true })),
    );
    expect(proof.status).toBe('not-proved');
    expect(proof.overall_status).toBe('failed');
    expect(proof.command_source).toBe('declared');
  });

  it('defers when nothing was runnable', () => {
    const proof = projectFixRegressionBaseline([], undefined);
    expect(proof.status).toBe('deferred');
    expect(proof.baseline).toBeUndefined();
  });

  // The schema, not the projector, is the backstop: 'not-captured' must never
  // become a way to launder a declared repro the runtime disproved.
  it('refuses a not-captured proof that claims a declared source', () => {
    const result = FixRegressionProofSchema.safeParse({
      status: 'not-captured',
      overall_status: 'passed',
      command_source: 'declared',
      reason: 'the suite was already green',
      baseline: {
        command_id: 'fix-regression',
        cwd: '.',
        argv: REPRO_ARGV,
        timeout_ms: 30_000,
        max_output_bytes: 200_000,
        env: {},
        exit_code: 0,
        command_status: 'passed',
        duration_ms: 1,
        stdout_summary: '',
        stderr_summary: '',
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('projectFixRegressionRerun', () => {
  it('clears when the proved command passes after the fix', () => {
    const rerun = projectFixRegressionRerun(
      [observation(PROJECT_ARGV, 'passed')],
      'adopted-verification',
    );
    expect(rerun.status).toBe('cleared');
    expect(rerun.command_source).toBe('adopted-verification');
  });

  it('reports still-failing when the proved command fails after the fix', () => {
    const rerun = projectFixRegressionRerun([observation(REPRO_ARGV, 'failed')], 'declared');
    expect(rerun.status).toBe('still-failing');
    expect(rerun.overall_status).toBe('failed');
  });

  it('defers when the baseline captured no proof', () => {
    const rerun = projectFixRegressionRerun([], undefined);
    expect(rerun.status).toBe('deferred');
    expect(rerun.rerun).toBeUndefined();
  });
});
