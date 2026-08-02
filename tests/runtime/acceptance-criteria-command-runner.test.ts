import { describe, expect, it, vi } from 'vitest';

import { evaluateAcceptanceCriteria } from '../../src/runtime/acceptance-criteria.js';
import type { AcceptanceCriteria } from '../../src/schemas/acceptance-criteria.js';
import { VerificationCommand } from '../../src/schemas/verification.js';

describe('acceptance criteria command proof runner', () => {
  it('uses the injected proof runner instead of spawning directly', async () => {
    const runProofCommand = vi.fn(async (command) => ({
      command,
      exit_code: 0,
      status: 'passed' as const,
      duration_ms: 1,
      stdout_summary: 'sandboxed proof\n',
      stderr_summary: '',
      timed_out: false,
    }));
    const criteria: AcceptanceCriteria = {
      checks: [
        {
          kind: 'command',
          id: 'sandboxed-command',
          expected_status: 'passed',
          command: VerificationCommand.parse({
            id: 'must-not-spawn-directly',
            cwd: '.',
            argv: ['/definitely/not/a/real/executable'],
            env: {},
            timeout_ms: 1_000,
            max_output_bytes: 1_000,
          }),
        },
      ],
      on_failure: { mode: 'hard-fail' },
    };

    await expect(
      evaluateAcceptanceCriteria({
        stepId: 'relay-step',
        criteria,
        resultBody: '{}',
        projectRoot: '/trusted/workspace',
        runProofCommand,
      }),
    ).resolves.toMatchObject({ kind: 'pass' });
    expect(runProofCommand).toHaveBeenCalledOnce();
  });
});
