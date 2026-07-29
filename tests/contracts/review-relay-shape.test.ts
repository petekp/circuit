import { describe, expect, it } from 'vitest';

import { ReviewUnitVerdict } from '../../src/flows/review/reports.js';
import { FanoutStep } from '../../src/schemas/step.js';

// Review's audit step is a fan-out over units: one reviewer per unit, each
// handed its own slice and nothing else. Most targets are a single unit, so
// most runs still relay exactly one reviewer. The literals below are the
// contract that keeps that true — the branch has to be a reviewer relay, it has
// to take its evidence from its own item, it has to report under the unit id it
// was given, and it must not inherit the step's evidence (which holds every
// unit and would undo the split).
const REVIEW_ANALYZE_DISPATCH_STEP = {
  id: 'audit-step',
  title: 'Independent Audit',
  protocol: 'review-audit@v1',
  reads: ['reports/review-intake.json'],
  routes: { pass: 'verdict-step' },
  executor: 'orchestrator',
  kind: 'fanout',
  branches: {
    kind: 'dynamic',
    source_report: 'reports/review-intake.json',
    items_path: 'units',
    template: {
      branch_id: '$item.unit_id',
      execution: {
        kind: 'relay',
        role: 'reviewer',
        goal: '$item.goal',
        report_schema: 'review.unit-verdict@v1',
        item_evidence_field: 'contents',
        inherit_step_reads: false,
        provenance_field: 'unit_id',
        max_attempts: 2,
      },
    },
    max_branches: 24,
  },
  concurrency: { kind: 'bounded', max: 4 },
  on_child_failure: 'continue-others',
  writes: {
    branches_dir: 'reports/review-units',
    aggregate: {
      path: 'reports/review-audit-aggregate.json',
      schema: 'review.audit-aggregate@v1',
    },
  },
  check: {
    kind: 'fanout_aggregate',
    source: { kind: 'fanout_results', ref: 'aggregate' },
    join: { policy: 'aggregate-any' },
    verdicts: { admit: ['NO_ISSUES_FOUND', 'ISSUES_FOUND'] },
  },
} as const;

function assertReviewAnalyzeRelayShape(step: typeof REVIEW_ANALYZE_DISPATCH_STEP) {
  const execution = step.branches.template.execution;
  expect(step.kind).toBe('fanout');
  expect(execution.kind).toBe('relay');
  expect(execution.role).toBe('reviewer');
  expect(execution.report_schema).toBe('review.unit-verdict@v1');
  // The reviewer is sealed from the repository, so its unit's own text is the
  // only evidence it can get.
  expect(execution.item_evidence_field).toBe('contents');
  expect(execution.inherit_step_reads).toBe(false);
  // A reviewer cannot report on a unit it was not given.
  expect(execution.provenance_field).toBe('unit_id');
  expect(step.branches.source_report).toBe('reports/review-intake.json');
  expect(step.branches.items_path).toBe('units');
  expect(step.reads).toEqual(['reports/review-intake.json']);
  expect(step.check.source.kind).toBe('fanout_results');
  expect(step.check.source.ref).toBe('aggregate');
  // One unit failing must not throw away the units that answered.
  expect(step.check.join.policy).toBe('aggregate-any');
  expect(step.check.verdicts.admit).toEqual(['NO_ISSUES_FOUND', 'ISSUES_FOUND']);
}

describe('review analyze relay shape', () => {
  it('pins the reviewer fan-out branch, its evidence source, and the unit verdict shape', () => {
    assertReviewAnalyzeRelayShape(REVIEW_ANALYZE_DISPATCH_STEP);
    const parsedStep = FanoutStep.parse(REVIEW_ANALYZE_DISPATCH_STEP);

    if (parsedStep.branches.kind !== 'dynamic') throw new Error('expected a dynamic fan-out');
    const template = parsedStep.branches.template as {
      readonly execution: { readonly role: string; readonly report_schema: string };
    };
    expect(template.execution.role).toBe('reviewer');
    expect(template.execution.report_schema).toBe('review.unit-verdict@v1');
    expect(parsedStep.check.join.policy).toBe('aggregate-any');

    const parsedResult = ReviewUnitVerdict.parse({
      unit_id: 'unit-1',
      verdict: 'ISSUES_FOUND',
      findings: [
        {
          severity: 'high',
          id: 'finding-1',
          text: 'A concrete issue found during independent audit.',
          file_refs: ['src/example.ts'],
        },
      ],
      assessment: 'Reviewer inspected the staged diff and found one high-severity issue.',
      verification: ['Read src/example.ts', 'Replayed the staged diff'],
      confidence_limitations: [],
    });
    expect(typeof parsedResult.verdict).toBe('string');
    expect(parsedResult.verdict).toBe('ISSUES_FOUND');
    expect(Array.isArray(parsedResult.findings)).toBe(true);
    expect(parsedResult.findings[0]?.severity).toBe('high');
    expect(parsedResult.assessment.length).toBeGreaterThan(0);
    expect(parsedResult.verification.length).toBeGreaterThan(0);

    const cleanShape = {
      unit_id: 'unit-1',
      verdict: 'NO_ISSUES_FOUND',
      findings: [],
      assessment: 'Reviewer inspected the relayed evidence and found nothing actionable.',
      verification: ['Inspected the relayed intake report.'],
      confidence_limitations: ['HEAD~1 history was out of scope.'],
    };
    // A word outside the accepted vocabulary is still rejected.
    expect(ReviewUnitVerdict.safeParse({ ...cleanShape, verdict: 'CLEAN' }).success).toBe(false);
    // A verdict that contradicts the findings is corrected, not rejected. The
    // findings are the substance of the answer; the verdict is a label the
    // schema derives from them, so a mislabel cannot destroy a real review.
    expect(
      ReviewUnitVerdict.parse({
        ...cleanShape,
        verdict: 'NO_ISSUES_FOUND',
        findings: parsedResult.findings,
      }).verdict,
    ).toBe('ISSUES_FOUND');
    expect(
      ReviewUnitVerdict.parse({ ...cleanShape, verdict: 'ISSUES_FOUND', findings: [] }).verdict,
    ).toBe('NO_ISSUES_FOUND');
    // An answer with no unit named cannot be attributed to the slice it was
    // about, so it is not a usable answer.
    expect(ReviewUnitVerdict.safeParse({ ...cleanShape, unit_id: undefined }).success).toBe(false);
    // Bare {verdict, findings} relay payloads — the legacy shape — must now
    // be rejected. The reviewer prose fields (assessment, verification,
    // confidence_limitations) are required so a NO_ISSUES_FOUND verdict
    // cannot collapse to a bare count without explaining what was checked.
    expect(
      ReviewUnitVerdict.safeParse({ unit_id: 'unit-1', verdict: 'NO_ISSUES_FOUND', findings: [] })
        .success,
    ).toBe(false);
    expect(ReviewUnitVerdict.parse(cleanShape)).toEqual(cleanShape);
  });

  it('literal checks reject branch, source, and join drift even if the base schema later widens', () => {
    // A branch that reads the step's evidence sees every unit, which is the
    // split undone.
    expect(() =>
      assertReviewAnalyzeRelayShape({
        ...REVIEW_ANALYZE_DISPATCH_STEP,
        branches: {
          ...REVIEW_ANALYZE_DISPATCH_STEP.branches,
          template: {
            ...REVIEW_ANALYZE_DISPATCH_STEP.branches.template,
            execution: {
              ...REVIEW_ANALYZE_DISPATCH_STEP.branches.template.execution,
              inherit_step_reads: true,
            },
          },
        },
      } as unknown as typeof REVIEW_ANALYZE_DISPATCH_STEP),
    ).toThrow();

    // A branch with no provenance field lets a reviewer answer for a unit it
    // was never shown.
    expect(() =>
      assertReviewAnalyzeRelayShape({
        ...REVIEW_ANALYZE_DISPATCH_STEP,
        branches: {
          ...REVIEW_ANALYZE_DISPATCH_STEP.branches,
          template: {
            ...REVIEW_ANALYZE_DISPATCH_STEP.branches.template,
            execution: {
              ...REVIEW_ANALYZE_DISPATCH_STEP.branches.template.execution,
              provenance_field: undefined,
            },
          },
        },
      } as unknown as typeof REVIEW_ANALYZE_DISPATCH_STEP),
    ).toThrow();

    expect(() =>
      assertReviewAnalyzeRelayShape({
        ...REVIEW_ANALYZE_DISPATCH_STEP,
        check: {
          ...REVIEW_ANALYZE_DISPATCH_STEP.check,
          verdicts: { admit: ['CLEAN'] },
        },
      } as unknown as typeof REVIEW_ANALYZE_DISPATCH_STEP),
    ).toThrow();
  });
});
