import { describe, expect, it } from 'vitest';

import { projectSummary } from '../../../../src/shared/operator-summary/projections.js';

describe('operator-summary Prototype projection', () => {
  it('summarizes Prototype model-comparison results with selected variant and evidence counts', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'prototype',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        mode: 'model-comparison',
        summary: 'Prototype model comparison verified and kept Variant B.',
        outcome: 'kept',
        verification_status: 'passed',
        checkpoint_selection: 'variant-b',
        prototype_root: '.circuit/runs/model-comparison/prototype-files',
        entry_points: [
          '.circuit/runs/model-comparison/prototype-files/variants/variant-b/index.html',
        ],
        selected_variant_id: 'variant-b',
        selected_variant_label: 'Variant B',
        selected_variant_root: '.circuit/runs/model-comparison/prototype-files/variants/variant-b',
        admitted_variant_count: 2,
        captured_provider_evidence_count: 2,
        model_evidence_status: 'captured',
        next_step: 'Inspect the chosen local prototype.',
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Prototype model comparison verified and kept Variant B.',
    );
    expect(projection.details).toContain('Selected variant: Variant B (variant-b).');
    expect(projection.details).toContain('Admitted variants: 2.');
    expect(projection.details).toContain('Captured relay selection evidence: 2.');
  });
});

describe('operator-summary Build projection', () => {
  const baseResult = (overrides: Record<string, unknown>) => ({
    runFolder: '/tmp/circuit-run',
    flowId: 'build',
    runOutcome: 'complete',
    resultSummary: 'Circuit run complete.',
    flowReport: {
      schema: 'build.result@v1',
      summary: 'Build result: add a small feature',
      verification_status: 'passed',
      ...overrides,
    },
  });

  it('renders a clean complete build with no scope deviation lines', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'complete',
        review_verdict: 'accept',
        scope: { adherence: 'within_scope', violated_guardrails: [], unassessed_guardrails: [] },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build complete. Change implemented, verification passed, review accepted.',
    );
    expect(projection.details.some((d) => d.startsWith('Scope:'))).toBe(false);
    expect(projection.details.some((d) => d.startsWith('Guardrails'))).toBe(false);
  });

  it('names guardrails the reviewer left unassessed and frames the cause as scope follow-up', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept',
        scope: {
          adherence: 'within_scope',
          violated_guardrails: [],
          unassessed_guardrails: ['Do not change the public API', 'Keep the cache write-through'],
        },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but the change needs a scope follow-up.',
    );
    expect(projection.details).toContain(
      'Guardrails the reviewer did not assess: Do not change the public API; Keep the cache write-through.',
    );
  });

  it('surfaces an exceeds-scope judgment as a scope line', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept',
        scope: { adherence: 'exceeds_scope', violated_guardrails: [], unassessed_guardrails: [] },
      }),
    );
    expect(projection.details).toContain(
      'Scope: reviewer judged the change exceeds the stated scope.',
    );
  });

  it('names both causes when accept-with-fixes rides alongside a violated guardrail', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept-with-fixes',
        scope: {
          adherence: 'within_scope',
          violated_guardrails: ['Keep the cache write-through'],
          unassessed_guardrails: [],
        },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but review requested fixes and the change needs a scope follow-up.',
    );
    expect(projection.details).toContain('Guardrails violated: Keep the cache write-through.');
  });

  it('frames a pure accept-with-fixes (clean scope) as review fixes only', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept-with-fixes',
        scope: { adherence: 'within_scope', violated_guardrails: [], unassessed_guardrails: [] },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but review requested fixes.',
    );
    expect(projection.details.some((d) => d.startsWith('Scope:'))).toBe(false);
    expect(projection.details.some((d) => d.startsWith('Guardrails'))).toBe(false);
  });

  it('names the scope cause when accept-with-fixes coincides with an exceeds-scope judgment', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept-with-fixes',
        scope: { adherence: 'exceeds_scope', violated_guardrails: [], unassessed_guardrails: [] },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but review requested fixes and the change needs a scope follow-up.',
    );
    expect(projection.details).toContain(
      'Scope: reviewer judged the change exceeds the stated scope.',
    );
  });

  it('names the scope cause when accept-with-fixes coincides with an unassessed guardrail', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept-with-fixes',
        scope: {
          adherence: 'within_scope',
          violated_guardrails: [],
          unassessed_guardrails: ['Do not change the public API'],
        },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but review requested fixes and the change needs a scope follow-up.',
    );
    expect(projection.details).toContain(
      'Guardrails the reviewer did not assess: Do not change the public API.',
    );
  });
});

describe('operator-summary Goal projection', () => {
  it('renders Goal results as a compact proof packet instead of a generic run summary', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'goal',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        schema: 'goal.result@v1',
        outcome: 'complete',
        summary: 'Goal complete: fix the flaky login test',
        proven_claims: ['objective-proved'],
        missing_or_weak_claims: [],
        recovery_history: [],
        residual_risks: [],
        rerun_commands: ['./bin/circuit run goal --goal "fix the flaky login test"'],
        evidence_links: [
          {
            report_id: 'goal.contract',
            path: 'reports/goal/contract.json',
            schema: 'goal.contract@v1',
          },
          {
            report_id: 'goal.gate',
            path: 'reports/goal/gate.json',
            schema: 'goal.gate@v1',
          },
        ],
        gate: {
          clean_streak: 2,
          required_passes: 2,
          final_verdict: 'gate-pass',
        },
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Goal complete. Evidence satisfied and safety review passed 2/2.',
    );
    expect(projection.headline).not.toBe('Circuit run complete.');
    expect(projection.details).toContain('Proven: objective-proved.');
    expect(projection.details).toContain('Still weak or missing: none.');
    expect(projection.details).toContain(
      'Checks: goal.contract -> reports/goal/contract.json; goal.gate -> reports/goal/gate.json.',
    );
    expect(projection.details).toContain('Safety review: 2/2 passes; final verdict gate-pass.');
  });

  it('does not present non-complete Goal claims as final proof', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'goal',
      runOutcome: 'stopped',
      resultSummary: 'Circuit run stopped.',
      flowReport: {
        schema: 'goal.result@v1',
        outcome: 'needs_attention',
        summary: 'Goal needs_attention: safety review did not pass',
        proven_claims: ['objective-proved'],
        missing_or_weak_claims: [],
        recovery_history: ['The child result could not prove the contract without judgment.'],
        residual_risks: [],
        rerun_commands: ['./bin/circuit run goal --goal "verify the fixture"'],
        evidence_links: [],
        gate: {
          clean_streak: 0,
          required_passes: 2,
          final_verdict: 'blocked',
        },
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Goal finished with outcome needs_attention. Safety review passed 0/2.',
    );
    expect(projection.details).toContain('Marked before final safety review: objective-proved.');
    expect(projection.details).toContain('Weak or missing before final safety review: none.');
    expect(projection.details).not.toContain('Proven: objective-proved.');
  });
});
