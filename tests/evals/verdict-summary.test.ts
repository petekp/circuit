import { describe, expect, it } from 'vitest';

import { summarize } from '../../evals/verdict-correctness/summary.ts';
import type { EvalCaseResult } from '../../evals/verdict-correctness/types.ts';

// summarize() only reads duration_ms off a successful result, so the
// verdict body can be a thin stub cast to the result shape.
type SuccessResult = Extract<EvalCaseResult['outcome'], { kind: 'success' }>['result'];

function success(
  defectId: EvalCaseResult['case']['defect_id'],
  score: EvalCaseResult['score'],
): EvalCaseResult {
  // summarize() reads duration_ms off every successful result and, for
  // controls, the verdict body to bucket the distribution. In real data the
  // control's body verdict equals score.original_verdict, so mirror that here
  // for control scores; everything else stubs an 'accept' body.
  const bodyVerdict = score.kind === 'control' ? score.original_verdict : 'accept';
  const result = {
    verdict: { verdict: bodyVerdict },
    raw_response: '{}',
    duration_ms: 1000,
    cli_version: 'test',
  } as unknown as SuccessResult;
  return {
    case: {
      source_run_id: 'run-aaaaaaaa',
      source_request_path: '/runs/run-aaaaaaaa/reports/relay/review.request.json',
      defect_id: defectId,
      prompt: 'prompt',
      mutation_summary: defectId === 'control' ? 'unmodified original request' : 'planted a defect',
    },
    outcome: { kind: 'success', result },
    score,
  };
}

function protocolFailure(kind: 'connector_error' | 'parse_error' | 'schema_error'): EvalCaseResult {
  return {
    case: {
      source_run_id: 'run-bbbbbbbb',
      source_request_path: '/runs/run-bbbbbbbb/reports/relay/review.request.json',
      defect_id: 'fabricated-evidence-ref',
      prompt: 'prompt',
      mutation_summary: 'planted a defect',
    },
    outcome:
      kind === 'connector_error'
        ? { kind, message: 'boom' }
        : { kind, message: 'bad output', raw_response: 'garbage' },
    score: { kind: 'skipped', reason: kind },
  };
}

function protocolControl(kind: 'connector_error' | 'parse_error' | 'schema_error'): EvalCaseResult {
  // A control case that produced no valid verdict — counted in controls.errors,
  // not in any verdict bucket.
  return {
    case: {
      source_run_id: 'run-dddddddd',
      source_request_path: '/runs/run-dddddddd/reports/relay/review.request.json',
      defect_id: 'control',
      prompt: 'prompt',
      mutation_summary: 'unmodified original request',
    },
    outcome:
      kind === 'connector_error'
        ? { kind, message: 'boom' }
        : { kind, message: 'bad output', raw_response: 'garbage' },
    score: { kind: 'skipped', reason: kind },
  };
}

function harnessSkip(): EvalCaseResult {
  // The planter could not apply; runCase never invoked the judge. The
  // canonical marker is mutation_summary starting with "SKIPPED".
  return {
    case: {
      source_run_id: 'run-cccccccc',
      source_request_path: '/runs/run-cccccccc/reports/relay/review.request.json',
      defect_id: 'fabricated-evidence-ref',
      prompt: 'prompt',
      mutation_summary: 'SKIPPED: no aspect has evidence_refs',
    },
    outcome: { kind: 'connector_error', message: 'SKIPPED: no aspect has evidence_refs' },
    score: { kind: 'skipped', reason: 'SKIPPED: no aspect has evidence_refs' },
  };
}

describe('verdict-correctness summarize protocol-failure accounting', () => {
  it('reports protocol_failure_rate over attempted (non-harness-skipped) cases', () => {
    const results: EvalCaseResult[] = [
      success('fabricated-evidence-ref', { kind: 'caught', matched_signal: 'x' }),
      success('fabricated-evidence-ref', { kind: 'caught', matched_signal: 'x' }),
      success('wrong-subject', { kind: 'caught', matched_signal: 'x' }),
      success('wrong-subject', { kind: 'caught', matched_signal: 'x' }),
      success('internal-contradiction', { kind: 'missed' }),
      protocolFailure('schema_error'),
      protocolFailure('parse_error'),
      protocolFailure('connector_error'),
      harnessSkip(),
      success('control', { kind: 'control', original_verdict: 'accept' }),
      success('control', { kind: 'control', original_verdict: 'accept' }),
    ];

    const summary = summarize(
      results,
      5000,
      'claude-code',
      'claude-haiku-4-5-20251001',
      'standard',
    );
    const o = summary.overall;

    expect(summary.suite).toBe('standard');
    expect(o.cases).toBe(11);
    expect(o.harness_skipped).toBe(1);
    // attempted = 11 total - 1 harness skip = 10 (judge actually invoked)
    expect(o.attempted).toBe(10);
    // errors are the three real protocol failures, NOT the harness skip,
    // even though the harness skip carries a connector_error outcome.
    expect(o.errors).toBe(3);
    expect(o.error_kinds).toEqual({ connector_error: 1, parse_error: 1, schema_error: 1 });
    expect(o.protocol_failure_rate).toBeCloseTo(3 / 10, 10);
    // catch_rate semantics unchanged: over scored cases only (4 caught / 5 scored)
    expect(o.catches).toBe(4);
    expect(o.misses).toBe(1);
    expect(o.catch_rate).toBeCloseTo(0.8, 10);
    // successful_calls = 4 caught + 1 missed + 2 control
    expect(o.successful_calls).toBe(7);
  });

  it('buckets the control verdict distribution and surfaces the false-positive signal', () => {
    const results: EvalCaseResult[] = [
      success('control', { kind: 'control', original_verdict: 'accept' }),
      success('control', { kind: 'control', original_verdict: 'accept' }),
      success('control', { kind: 'control', original_verdict: 'accept-with-fold-ins' }),
      success('control', { kind: 'control', original_verdict: 'reject' }),
      success('control', { kind: 'control', original_verdict: 'reject' }),
      protocolControl('connector_error'),
    ];

    const summary = summarize(results, 1000, 'claude-code', 'claude-haiku-4-5-20251001', 'subtle');

    // accept-with-fold-ins and reject are the reviewer rejecting a compose
    // with no planted defect — the false-positive signal the old
    // {passes, fails} shape collapsed into "passes".
    expect(summary.controls).toEqual({
      cases: 6,
      accept: 2,
      accept_with_fold_ins: 1,
      reject: 2,
      errors: 1,
    });
    // Controls still count toward attempted and their errors toward the
    // protocol-failure denominator, unchanged by the distribution change.
    expect(summary.overall.attempted).toBe(6);
    expect(summary.overall.errors).toBe(1);
  });

  it('reports zero rates and no attempts for an empty result set', () => {
    const summary = summarize([], 0, 'codex', null, 'subtle');
    expect(summary.suite).toBe('subtle');
    expect(summary.overall.cases).toBe(0);
    expect(summary.overall.attempted).toBe(0);
    expect(summary.overall.harness_skipped).toBe(0);
    expect(summary.overall.errors).toBe(0);
    expect(summary.overall.protocol_failure_rate).toBe(0);
    expect(summary.overall.catch_rate).toBe(0);
    expect(summary.overall.error_kinds).toEqual({
      connector_error: 0,
      parse_error: 0,
      schema_error: 0,
    });
  });
});
