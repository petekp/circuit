import { describe, expect, it } from 'vitest';

import { checkCompiledFlowKindCanonicalPolicy } from '../../../src/flows/canonical-stage-policy.js';
import { checkReviewIdentitySeparationPolicy } from '../../../src/policy/flow-kind-policy-core.js';

type StepStub = Record<string, unknown>;

function reviewPolicyPayload(steps: StepStub[]): Record<string, unknown> {
  return {
    schema_version: '3',
    id: 'review',
    stages: [
      { title: 'Intake', canonical: 'frame', steps: ['intake-step'] },
      { title: 'Independent Audit', canonical: 'analyze', steps: ['audit-step'] },
      { title: 'Verdict', canonical: 'close', steps: ['verdict-step'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['plan', 'act', 'verify', 'review'],
      rationale: 'property payload for review identity separation policy.',
    },
    steps,
  };
}

function fillerStep(index: number): StepStub {
  return { id: `filler-${index}`, kind: 'compose', writes: { report: {} } };
}

function reviewResultReport() {
  return { path: 'reports/review-result.json', schema: 'review.result@v1' };
}

function validSteps(prefixCount: number, middleCount: number, suffixCount: number): StepStub[] {
  return [
    ...Array.from({ length: prefixCount }, (_, i) => fillerStep(i)),
    { id: 'intake-step', kind: 'compose', writes: { report: {} } },
    { id: 'audit-step', kind: 'relay', role: 'reviewer' },
    ...Array.from({ length: middleCount }, (_, i) => fillerStep(prefixCount + i)),
    { id: 'verdict-step', kind: 'compose', writes: { report: reviewResultReport() } },
    ...Array.from({ length: suffixCount }, (_, i) => fillerStep(prefixCount + middleCount + i)),
  ];
}

describe('REVIEW-I1 structural ordering property', () => {
  it('accepts only review payloads whose close report writer is preceded by an analyze reviewer relay', () => {
    for (let prefix = 0; prefix < 4; prefix++) {
      for (let middle = 0; middle < 4; middle++) {
        for (let suffix = 0; suffix < 4; suffix++) {
          const payload = reviewPolicyPayload(validSteps(prefix, middle, suffix));
          expect(checkReviewIdentitySeparationPolicy(payload).ok).toBe(true);
          expect(checkCompiledFlowKindCanonicalPolicy(payload).kind).toBe('green');
        }
      }
    }

    const closeBeforeReviewer = reviewPolicyPayload([
      { id: 'intake-step', kind: 'compose', writes: { report: {} } },
      {
        id: 'verdict-step',
        kind: 'compose',
        writes: { report: reviewResultReport() },
      },
      { id: 'audit-step', kind: 'relay', role: 'reviewer' },
    ]);
    expect(checkReviewIdentitySeparationPolicy(closeBeforeReviewer).ok).toBe(false);
    expect(checkCompiledFlowKindCanonicalPolicy(closeBeforeReviewer).kind).toBe('red');

    const wrongRole = reviewPolicyPayload([
      { id: 'intake-step', kind: 'compose', writes: { report: {} } },
      { id: 'audit-step', kind: 'relay', role: 'implementer' },
      {
        id: 'verdict-step',
        kind: 'compose',
        writes: { report: reviewResultReport() },
      },
    ]);
    expect(checkReviewIdentitySeparationPolicy(wrongRole).ok).toBe(false);
    expect(checkCompiledFlowKindCanonicalPolicy(wrongRole).kind).toBe('red');

    const wrongReport = reviewPolicyPayload([
      { id: 'intake-step', kind: 'compose', writes: { report: {} } },
      { id: 'audit-step', kind: 'relay', role: 'reviewer' },
      {
        id: 'verdict-step',
        kind: 'compose',
        writes: {
          report: { path: 'reports/not-review-result.json', schema: 'wrong.result@v1' },
        },
      },
    ]);
    expect(checkReviewIdentitySeparationPolicy(wrongReport).ok).toBe(false);
    expect(checkCompiledFlowKindCanonicalPolicy(wrongReport).kind).toBe('red');
  });
});
