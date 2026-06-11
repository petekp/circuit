import { describe, expect, it } from 'vitest';

import {
  DEFECT_IDS,
  DEFECT_PLANTERS,
  STANDARD_DEFECT_IDS,
  SUBTLE_DEFECT_IDS,
  SUITES,
} from '../../evals/verdict-correctness/defect-taxonomy.ts';
import type { ComposeJsonShape } from '../../evals/verdict-correctness/types.ts';

function fixture(): ComposeJsonShape {
  return {
    verdict: 'accept',
    subject: 'Skill authoring surfaces',
    recommendation: 'Use the three layers as described to author and bind skills.',
    success_condition_alignment:
      'Names the concrete authoring surfaces, the canonical config paths, and the precedence rules — enough for the operator to customize skills end to end.',
    supporting_aspects: [
      {
        aspect: 'authoring surfaces',
        contribution: 'covers the three layers',
        evidence_refs: ['reports/brief.json', 'reports/analysis.json', 'docs/contracts/skill.md:149'],
      },
    ],
  };
}

describe('subtle defect planters', () => {
  it('soft-false-certainty appends the recovered readiness sentence', () => {
    const compose = fixture();
    const original = compose.recommendation;
    const result = DEFECT_PLANTERS['soft-false-certainty'](compose);
    expect(result.mutated.recommendation).toBe(
      `${original} This should be enough to proceed confidently without a separate follow-up investigation.`,
    );
    // input is not mutated in place
    expect(compose.recommendation).toBe(original);
    expect(result.mutation_summary).toMatch(/readiness|follow-up|proceed/i);
  });

  it('generic-success-condition-alignment replaces alignment with the recovered generic text', () => {
    const compose = fixture();
    const originalLen = compose.success_condition_alignment.length;
    const result = DEFECT_PLANTERS['generic-success-condition-alignment'](compose);
    expect(result.mutated.success_condition_alignment).toBe(
      'The recommendation addresses the request by tying the main findings back to the available evidence and giving the operator a practical next step.',
    );
    expect(result.mutation_summary).toContain(String(originalLen));
  });

  it('plausible-missing-evidence-ref swaps the first ref for a plausible missing sibling', () => {
    const compose = fixture();
    const result = DEFECT_PLANTERS['plausible-missing-evidence-ref'](compose);
    const refs = result.mutated.supporting_aspects[0]?.evidence_refs;
    expect(refs?.[0]).toBe('reports/brief-appendix.json');
    // other refs untouched
    expect(refs?.[1]).toBe('reports/analysis.json');
    expect(refs?.[2]).toBe('docs/contracts/skill.md:149');
    expect(result.mutation_summary).toBe(
      "supporting_aspects[?].evidence_refs[0] 'reports/brief.json' -> plausible missing sibling 'reports/brief-appendix.json'",
    );
  });

  it('plausible-missing-evidence-ref throws when no aspect has evidence_refs', () => {
    const compose = fixture();
    compose.supporting_aspects = [
      { aspect: 'x', contribution: 'y', evidence_refs: [] },
    ];
    expect(() => DEFECT_PLANTERS['plausible-missing-evidence-ref'](compose)).toThrow(
      /evidence_refs/,
    );
  });
});

describe('defect suites', () => {
  it('exposes standard, subtle, and all suites', () => {
    expect(STANDARD_DEFECT_IDS).toHaveLength(5);
    expect(SUBTLE_DEFECT_IDS).toHaveLength(3);
    expect(DEFECT_IDS).toHaveLength(8);
    expect(SUITES.standard).toEqual(STANDARD_DEFECT_IDS);
    expect(SUITES.subtle).toEqual(SUBTLE_DEFECT_IDS);
    expect(SUITES.all).toEqual(DEFECT_IDS);
  });

  it('has a planter and description for every defect id', () => {
    for (const id of DEFECT_IDS) {
      expect(typeof DEFECT_PLANTERS[id]).toBe('function');
    }
  });
});
