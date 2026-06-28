import { describe, expect, it, vi } from 'vitest';

import {
  type AttemptResult,
  runContinuationLoop,
} from '../../src/app/run-envelope/continuation-loop.js';
import { goalContract as contract } from './run-envelope-fixtures.js';

function scriptedRunner(results: readonly AttemptResult[]) {
  let index = 0;
  return vi.fn((_input: { processId: string; attemptNumber: number }) => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result as AttemptResult;
  });
}

describe('Run bounded in-process continuation loop (S7)', () => {
  it('closes complete when evidence is satisfied within budget', async () => {
    const runAttempt = scriptedRunner([
      { process_id: 'build', outcome: 'complete', unmetEvidence: [] },
    ]);
    const result = await runContinuationLoop({
      contract: contract(),
      primaryProcessId: 'build',
      runAttempt,
    });
    expect(result.outcome).toBe('complete');
    expect(result.attempts).toHaveLength(1);
    expect(runAttempt).toHaveBeenCalledTimes(1);
  });

  it('never closes complete by exhaustion; stops honestly at the attempt limit', async () => {
    const runAttempt = scriptedRunner([
      { process_id: 'build', outcome: 'needs_followup', unmetEvidence: ['a', 'b'] },
      { process_id: 'fix', outcome: 'needs_followup', unmetEvidence: ['a'] },
      { process_id: 'fix', outcome: 'needs_followup', unmetEvidence: ['a'] },
    ]);
    const result = await runContinuationLoop({
      contract: contract(),
      primaryProcessId: 'build',
      runAttempt,
    });
    expect(result.outcome).not.toBe('complete');
    expect(result.outcome).toBe('needs_attention');
    expect(result.attempts).toHaveLength(2); // max_process_attempts
    expect(result.stopReason).toMatch(/attempt limit|exhaust/i);
  });

  it('escalates a weak contract via the contract-quality lens before running any attempt', async () => {
    const weak = contract({
      objective: 'Implement the dashboard filter',
      done_when: [
        {
          id: 'process-evidence',
          claim: 'done',
          required_evidence: [{ kind: 'report', description: 'A report exists', required: true }],
        },
      ],
    });
    const runAttempt = scriptedRunner([
      { process_id: 'build', outcome: 'complete', unmetEvidence: [] },
    ]);
    const result = await runContinuationLoop({
      contract: weak,
      primaryProcessId: 'build',
      runAttempt,
    });
    expect(result.outcome).toBe('needs_attention');
    expect(result.stopReason).toMatch(/contract.quality/i);
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it('stops at a checkpoint without claiming completion', async () => {
    const runAttempt = scriptedRunner([
      { process_id: 'build', outcome: 'checkpoint', unmetEvidence: ['a'] },
    ]);
    const result = await runContinuationLoop({
      contract: contract(),
      primaryProcessId: 'build',
      runAttempt,
    });
    expect(result.outcome).toBe('needs_attention');
    expect(result.stopReason).toMatch(/checkpoint/i);
  });

  it('escalates on no-progress instead of using the full attempt budget', async () => {
    const runAttempt = scriptedRunner([
      { process_id: 'build', outcome: 'needs_followup', unmetEvidence: ['a'] },
      { process_id: 'fix', outcome: 'needs_followup', unmetEvidence: ['a'] },
    ]);
    const result = await runContinuationLoop({
      contract: contract({
        recovery_policy: {
          max_process_attempts: 5,
          allowed_routes: ['retry-process', 'run-review', 'checkpoint', 'handoff', 'blocked'],
        },
      }),
      primaryProcessId: 'build',
      runAttempt,
    });
    expect(result.outcome).toBe('needs_attention');
    expect(result.stopReason).toMatch(/no-progress/i);
    expect(result.attempts.length).toBeLessThan(5);
  });

  it('surfaces handoff when the attempt outcome is handoff', async () => {
    const runAttempt = scriptedRunner([
      { process_id: 'build', outcome: 'handoff', unmetEvidence: [] },
    ]);
    const result = await runContinuationLoop({
      contract: contract(),
      primaryProcessId: 'build',
      runAttempt,
    });
    expect(result.outcome).toBe('handoff');
    expect(result.attempts).toHaveLength(1);
  });

  it('surfaces failed when the attempt outcome is failed', async () => {
    const runAttempt = scriptedRunner([
      { process_id: 'build', outcome: 'failed', unmetEvidence: [] },
    ]);
    const result = await runContinuationLoop({
      contract: contract(),
      primaryProcessId: 'build',
      runAttempt,
    });
    expect(result.outcome).toBe('failed');
    expect(result.attempts).toHaveLength(1);
  });

  it('surfaces blocked when the attempt outcome is blocked', async () => {
    const runAttempt = scriptedRunner([
      { process_id: 'build', outcome: 'blocked', unmetEvidence: [] },
    ]);
    const result = await runContinuationLoop({
      contract: contract(),
      primaryProcessId: 'build',
      runAttempt,
    });
    expect(result.outcome).toBe('blocked');
    expect(result.attempts).toHaveLength(1);
  });

  it('routes to needs_attention checkpoint when recovery requires an operator checkpoint', async () => {
    const runAttempt = scriptedRunner([
      {
        process_id: 'build',
        outcome: 'needs_followup',
        unmetEvidence: ['a'],
        unmetKinds: ['checkpoint'],
      },
    ]);
    const result = await runContinuationLoop({
      contract: contract({
        recovery_policy: {
          max_process_attempts: 5,
          allowed_routes: ['retry-process', 'run-review', 'checkpoint', 'handoff', 'blocked'],
        },
      }),
      primaryProcessId: 'build',
      runAttempt,
    });
    expect(result.outcome).toBe('needs_attention');
    expect(result.stopReason).toMatch(/checkpoint/i);
  });
});
