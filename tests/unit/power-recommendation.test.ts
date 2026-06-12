import { describe, expect, it } from 'vitest';

import { BuildContext } from '../../src/flows/build/reports.js';
import { FixDiagnosis } from '../../src/flows/fix/reports.js';
import { renderShapeSkeleton } from '../../src/flows/registries/shape-hints/from-zod.js';
import { PowerRecommendation } from '../../src/schemas/power.js';

const recommendation = { value: 'low', rationale: 'single-file doc fix, no logic change' };

const diagnosisBase = {
  verdict: 'accept',
  reproduction_status: 'reproduced',
  cause_summary: 'off-by-one in pager bounds',
  confidence: 'high',
  evidence: ['src/pager.ts:42 caps at length, not length - 1'],
  residual_uncertainty: [],
};

const contextBase = {
  verdict: 'accept',
  sources: [{ kind: 'file', ref: 'src/pager.ts', summary: 'the file the goal names' }],
  observations: ['the change is a one-line bounds fix'],
  open_questions: [],
  allowed_touch_area: [],
};

describe('PowerRecommendation fragment', () => {
  it('accepts a concrete tier with a short rationale', () => {
    expect(PowerRecommendation.parse(recommendation)).toEqual(recommendation);
  });

  it('rejects auto as a recommended tier', () => {
    expect(() => PowerRecommendation.parse({ ...recommendation, value: 'auto' })).toThrow();
  });

  it('rejects an empty or oversized rationale', () => {
    expect(() => PowerRecommendation.parse({ ...recommendation, rationale: '' })).toThrow();
    expect(() =>
      PowerRecommendation.parse({ ...recommendation, rationale: 'x'.repeat(281) }),
    ).toThrow();
  });

  it('rejects extra keys', () => {
    expect(() => PowerRecommendation.parse({ ...recommendation, why: 'no' })).toThrow();
  });
});

describe('researcher reports carry the optional recommendation', () => {
  it('fix.diagnosis accepts and omits recommended_power', () => {
    expect(() => FixDiagnosis.parse(diagnosisBase)).not.toThrow();
    const parsed = FixDiagnosis.parse({ ...diagnosisBase, recommended_power: recommendation });
    expect(parsed.recommended_power).toEqual(recommendation);
  });

  it('build.context accepts and omits recommended_power (build.plan is composed, not relay-emitted)', () => {
    expect(() => BuildContext.parse(contextBase)).not.toThrow();
    const parsed = BuildContext.parse({ ...contextBase, recommended_power: recommendation });
    expect(parsed.recommended_power).toEqual(recommendation);
  });

  it('renders into the worker-facing shape skeletons', () => {
    expect(renderShapeSkeleton(FixDiagnosis)).toContain('recommended_power');
    expect(renderShapeSkeleton(BuildContext)).toContain('recommended_power');
  });
});
