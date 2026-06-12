import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_AUTHORITY_NOTICE, MemoryInputV0 } from '../../../src/index.js';
import { composeRelayPrompt } from '../../../src/runtime/run/relay-support.js';

let runFolder: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'circuit-relay-support-'));
});

afterEach(() => {
  rmSync(runFolder, { recursive: true, force: true });
});

describe('composeRelayPrompt', () => {
  it('includes the operator goal so no-reads relay steps can clarify the task', () => {
    const goal = 'Review the current change and prove the Goal flow smoke path works.';
    const prompt = composeRelayPrompt(
      {
        id: 'clarify-goal',
        title: 'Clarify - shape Goal task',
        role: 'researcher',
        reads: [],
        writes: {
          request: { path: 'reports/relay/goal-clarify.request.json' },
          receipt: { path: 'reports/relay/goal-clarify.receipt.txt' },
          result: { path: 'reports/relay/goal-clarify.result.json' },
          report: {
            path: 'reports/goal/clarified-task.json',
            schema: 'goal.clarified-task@v1',
          },
        },
        check: { kind: 'result_verdict', pass: ['continue'] },
      } as unknown as Parameters<typeof composeRelayPrompt>[0],
      runFolder,
      [],
      undefined,
      goal,
    );

    expect(prompt).toContain('Operator Goal:');
    expect(prompt).toContain(goal);
    expect(prompt.indexOf('Operator Goal:')).toBeLessThan(prompt.indexOf('Context (from reads):'));
  });

  it('threads the resolved depth into the prompt when supplied and omits it otherwise (F-M-1)', () => {
    const step = {
      id: 'act-step',
      title: 'Act - implement',
      role: 'implementer',
      reads: [],
      writes: {
        request: { path: 'reports/relay/act.request.json' },
        receipt: { path: 'reports/relay/act.receipt.txt' },
        result: { path: 'reports/relay/act.result.json' },
        report: { path: 'reports/act.json', schema: 'flow.result@v1' },
      },
      check: { kind: 'result_verdict', pass: ['accept'] },
    } as unknown as Parameters<typeof composeRelayPrompt>[0];

    const withDepth = composeRelayPrompt(
      step,
      runFolder,
      [],
      undefined,
      undefined,
      [],
      'build',
      'low',
    );
    expect(withDepth).toContain('Depth: low');

    // Direct callers that pass no depth (the "direct callers unchanged" invariant)
    // or an empty string get no Depth line at all.
    const withoutDepth = composeRelayPrompt(step, runFolder, [], undefined, undefined, [], 'build');
    expect(withoutDepth).not.toContain('Depth:');
    const emptyDepth = composeRelayPrompt(
      step,
      runFolder,
      [],
      undefined,
      undefined,
      [],
      'build',
      '',
    );
    expect(emptyDepth).not.toContain('Depth:');
  });

  it('includes prior history only as hint-only relay context when memory is provided', () => {
    const memory = MemoryInputV0.parse({
      schema_version: 1,
      memory_id: 'prior-run-11111111-abc123',
      kind: 'prior_run',
      source: {
        ref: {
          kind: 'report',
          ref: 'reports/decision.json',
          sha256: 'a'.repeat(64),
          run_id: '11111111-1111-4111-8111-111111111111',
          flow_id: 'explore',
        },
        captured_at: '2026-05-26T12:00:00.000Z',
        sha256: 'a'.repeat(64),
      },
      summary: 'Prior run chose explicit recall.',
      hints: [
        {
          id: 'hint-abc123',
          text: 'Recall must stay cited and hint-only.',
          applies_to: 'context',
        },
      ],
      staleness: {
        status: 'fresh',
        checked_at: '2026-05-26T12:01:00.000Z',
        reason_codes: ['source_hash_verified'],
      },
      authority: 'hint_only',
    });
    const prompt = composeRelayPrompt(
      {
        id: 'review-step',
        title: 'Review',
        role: 'reviewer',
        reads: [],
        writes: {
          request: { path: 'reports/relay/review.request.md' },
          receipt: { path: 'reports/relay/review.receipt.txt' },
          result: { path: 'reports/relay/review.result.json' },
        },
        check: { kind: 'result_verdict', pass: ['accept'] },
      } as unknown as Parameters<typeof composeRelayPrompt>[0],
      runFolder,
      [],
      undefined,
      'Review history recall',
      [memory],
    );

    expect(prompt).toContain('Prior Circuit History (hint-only):');
    expect(prompt).toContain(HISTORY_AUTHORITY_NOTICE);
    expect(prompt).toContain('Recall must stay cited and hint-only.');
    expect(prompt).toContain('cannot satisfy current proof, checkpoint, policy, route');
    expect(prompt.indexOf('Prior Circuit History')).toBeLessThan(
      prompt.indexOf('Context (from reads):'),
    );
  });

  it('renders command acceptance criteria as grammatical requirements', () => {
    const prompt = composeRelayPrompt(
      {
        id: 'act-step',
        title: 'Act - implement',
        role: 'implementer',
        reads: [],
        writes: {
          request: { path: 'reports/relay/act.request.json' },
          receipt: { path: 'reports/relay/act.receipt.txt' },
          result: { path: 'reports/relay/act.result.json' },
          report: { path: 'reports/act.json', schema: 'flow.result@v1' },
        },
        check: { kind: 'result_verdict', pass: ['accept'] },
        acceptance_criteria: {
          on_failure: { mode: 'retry-with-feedback' },
          checks: [
            {
              kind: 'command',
              id: 'verify-passes',
              command: { id: 'verify', cwd: '.', argv: ['npm', 'run', 'verify'] },
              expected_status: 'passed',
            },
          ],
        },
      } as unknown as Parameters<typeof composeRelayPrompt>[0],
      runFolder,
    );

    expect(prompt).toContain('command verify must pass.');
    expect(prompt).not.toContain('must passed');
  });

  it('names schema-valid rework verdicts alongside the pass list so reviewers know reject is safe', () => {
    const prompt = composeRelayPrompt(
      {
        id: 'fix-review',
        title: 'Review — independent audit of Fix change',
        role: 'reviewer',
        reads: [],
        writes: {
          request: { path: 'reports/relay/fix-review.request.json' },
          receipt: { path: 'reports/relay/fix-review.receipt.txt' },
          result: { path: 'reports/relay/fix-review.result.json' },
          report: { path: 'reports/fix/review.json', schema: 'fix.review@v1' },
        },
        check: { kind: 'result_verdict', pass: ['accept', 'accept-with-fixes'] },
      } as unknown as Parameters<typeof composeRelayPrompt>[0],
      runFolder,
    );

    expect(prompt).toContain('Accepted verdicts: accept, accept-with-fixes');
    expect(prompt).toContain('Rework verdicts');
    expect(prompt).toContain('reject');
    expect(prompt.indexOf('Rework verdicts')).toBeGreaterThan(prompt.indexOf('Accepted verdicts'));
  });

  it('omits the rework line when the schema has no verdicts beyond the pass list', () => {
    const prompt = composeRelayPrompt(
      {
        id: 'fix-gather-context',
        title: 'Analyze — gather problem context',
        role: 'researcher',
        reads: [],
        writes: {
          request: { path: 'reports/relay/fix-gather-context.request.json' },
          receipt: { path: 'reports/relay/fix-gather-context.receipt.txt' },
          result: { path: 'reports/relay/fix-gather-context.result.json' },
          report: { path: 'reports/fix/context.json', schema: 'fix.context@v1' },
        },
        check: { kind: 'result_verdict', pass: ['accept'] },
      } as unknown as Parameters<typeof composeRelayPrompt>[0],
      runFolder,
    );

    expect(prompt).toContain('Accepted verdicts: accept');
    expect(prompt).not.toContain('Rework verdicts');
  });

  it('glosses the relay role with one behavioral sentence', () => {
    const reviewerPrompt = composeRelayPrompt(
      {
        id: 'review-step',
        title: 'Review',
        role: 'reviewer',
        reads: [],
        writes: {
          request: { path: 'reports/relay/review.request.json' },
          receipt: { path: 'reports/relay/review.receipt.txt' },
          result: { path: 'reports/relay/review.result.json' },
        },
        check: { kind: 'result_verdict', pass: ['accept'] },
      } as unknown as Parameters<typeof composeRelayPrompt>[0],
      runFolder,
    );
    const researcherPrompt = composeRelayPrompt(
      {
        id: 'analyze-step',
        title: 'Analyze',
        role: 'researcher',
        reads: [],
        writes: {
          request: { path: 'reports/relay/analyze.request.json' },
          receipt: { path: 'reports/relay/analyze.receipt.txt' },
          result: { path: 'reports/relay/analyze.result.json' },
        },
        check: { kind: 'result_verdict', pass: ['accept'] },
      } as unknown as Parameters<typeof composeRelayPrompt>[0],
      runFolder,
    );

    expect(reviewerPrompt).toContain('Role: reviewer — you are an independent auditor');
    expect(reviewerPrompt).toContain('successful review');
    expect(researcherPrompt).toContain('Role: researcher — you investigate and report');
  });
});
