import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkCompiledFlowKindCanonicalPolicy } from '../../src/flows/canonical-stage-policy.js';
import { reviewCompiledFlowPackage } from '../../src/flows/review/index.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

const REVIEW_FIXTURE_PATH = join('generated', 'flows', 'review', 'circuit.json');

function loadReviewFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(REVIEW_FIXTURE_PATH, 'utf-8')) as Record<string, unknown>;
}

describe('review flow contract fixture', () => {
  it('parses the live review fixture under the base CompiledFlow schema', () => {
    const parsed = CompiledFlow.safeParse(loadReviewFixture());
    expect(parsed.success).toBe(true);
  });

  it('satisfies the review canonical stage policy and REVIEW-I1 ordering check', () => {
    const result = checkCompiledFlowKindCanonicalPolicy(loadReviewFixture());
    expect(result.kind).toBe('green');
    expect(result.detail).toMatch(/review: canonical set/);
    expect(result.detail).toMatch(/frame, analyze, close/);
  });

  // The audit is a fan-out over the intake's units: one reviewer relay per
  // unit, joined into one aggregate the close step reads.
  it('binds the analyze fan-out shape to one reviewer relay per unit', () => {
    const fixture = loadReviewFixture();
    const steps = fixture.steps as Array<Record<string, unknown>>;
    const auditStep = steps.find((step) => step.id === 'audit-step');
    expect(auditStep?.kind).toBe('fanout');
    expect(auditStep?.executor).toBe('orchestrator');

    const branches = auditStep?.branches as
      | { kind?: unknown; items_path?: unknown; template?: { execution?: Record<string, unknown> } }
      | undefined;
    expect(branches?.kind).toBe('dynamic');
    expect(branches?.items_path).toBe('units');
    expect(branches?.template?.execution?.kind).toBe('relay');
    expect(branches?.template?.execution?.role).toBe('reviewer');

    const writes = auditStep?.writes as Record<string, unknown> | undefined;
    expect(writes?.branches_dir).toBe('reports/review-units');
    expect((writes?.aggregate as { path?: unknown } | undefined)?.path).toBe(
      'reports/review-audit-aggregate.json',
    );
    const check = auditStep?.check as
      | { source?: { kind?: unknown; ref?: unknown }; verdicts?: { admit?: unknown } }
      | undefined;
    expect(check?.source?.kind).toBe('fanout_results');
    expect(check?.source?.ref).toBe('aggregate');
    expect(check?.verdicts?.admit).toEqual(['NO_ISSUES_FOUND', 'ISSUES_FOUND']);
  });

  it('binds the close step to the registered review.result report', () => {
    const fixture = loadReviewFixture();
    const steps = fixture.steps as Array<Record<string, unknown>>;
    const verdictStep = steps.find((step) => step.id === 'verdict-step');
    expect(verdictStep?.kind).toBe('compose');
    expect(verdictStep?.executor).toBe('orchestrator');

    const writes = verdictStep?.writes as
      | { report?: { path?: unknown; schema?: unknown } }
      | undefined;
    expect(writes?.report?.path).toBe('reports/review-result.json');
    expect(writes?.report?.schema).toBe('review.result@v1');
  });

  it('homes review.result in the Review flow package next to its contract', () => {
    expect(reviewCompiledFlowPackage.paths.contract).toBe('src/flows/review/contract.md');
    expect(
      reviewCompiledFlowPackage.reportSchemas?.some(
        (report) => report.schemaName === 'review.result@v1',
      ),
    ).toBe(true);
  });
});
