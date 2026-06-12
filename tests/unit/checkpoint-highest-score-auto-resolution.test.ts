import { describe, expect, it } from 'vitest';

import {
  type RubricDimInput,
  THREE_AXIS_RUBRIC_TIE_BREAK_ORDER,
  combineRubricResult,
} from '../../src/policy/rubric.js';
import { resolveHighestScoreAutoResolution } from '../../src/shared/checkpoint-auto-resolution.js';

const PASS = {
  runtime_signal: 'met',
  model_judgment: 'pass',
} as const;

const CONCERN = {
  runtime_signal: 'met',
  model_judgment: 'concern',
} as const;

function rubric(overrides: Record<string, RubricDimInput> = {}) {
  const dims = Object.fromEntries(THREE_AXIS_RUBRIC_TIE_BREAK_ORDER.map((dim) => [dim, PASS]));
  return combineRubricResult({
    dims: { ...dims, ...overrides },
    orderedDims: THREE_AXIS_RUBRIC_TIE_BREAK_ORDER,
  });
}

describe('resolveHighestScoreAutoResolution', () => {
  it('selects the highest aggregate score and records score provenance', () => {
    const resolution = resolveHighestScoreAutoResolution({
      checkpointId: 'tradeoff-checkpoint-step',
      checkpointLabel: 'Decision - tradeoff checkpoint',
      choices: ['option-1', 'option-2'],
      resolvedAt: '2026-05-19T12:00:00.000Z',
      branches: [
        { branch_id: 'option-1', rubric_result: rubric({ evidence_rigor: CONCERN }) },
        { branch_id: 'option-2', rubric_result: rubric() },
      ],
      idPath: 'branch_id',
      rubricResultPath: 'rubric_result',
    });

    expect(resolution.selection).toBe('option-2');
    expect(resolution.record).toMatchObject({
      checkpoint_id: 'tradeoff-checkpoint-step',
      checkpoint_label: 'Decision - tradeoff checkpoint',
      policy: 'highest-score',
      resolved_value: 'option-2',
      alternatives_available: ['option-1'],
      winning_score: 1,
      runner_up_score: 0.938,
      margin: 0.062,
      tie_break: 'aggregate_score',
      resolved_at: '2026-05-19T12:00:00.000Z',
    });
    expect(resolution.record.scores).toEqual({
      'option-1': { aggregate_score: 0.938, runtime_veto_count: 0 },
      'option-2': { aggregate_score: 1, runtime_veto_count: 0 },
    });
    const rubricResults = resolution.record.rubric_results;
    expect(rubricResults).toBeDefined();
    if (rubricResults === undefined) throw new Error('expected rubric results');
    expect(rubricResults['option-2']?.aggregate_score).toBe(1);
  });

  it('uses the fixed dim tie-break order before original strand ordinal', () => {
    const byDim = resolveHighestScoreAutoResolution({
      checkpointId: 'tradeoff-checkpoint-step',
      choices: ['option-1', 'option-2'],
      resolvedAt: '2026-05-19T12:00:00.000Z',
      branches: [
        {
          branch_id: 'option-1',
          rubric_result: rubric({ evidence_rigor: CONCERN, actionability: PASS }),
        },
        {
          branch_id: 'option-2',
          rubric_result: rubric({ evidence_rigor: PASS, actionability: CONCERN }),
        },
      ],
      idPath: 'branch_id',
      rubricResultPath: 'rubric_result',
    });

    expect(byDim.selection).toBe('option-2');
    expect(byDim.record.tie_break).toBe('dim_score:evidence_rigor');

    const byOrdinal = resolveHighestScoreAutoResolution({
      checkpointId: 'tradeoff-checkpoint-step',
      choices: ['option-1', 'option-2'],
      resolvedAt: '2026-05-19T12:00:00.000Z',
      branches: [
        { branch_id: 'option-1', rubric_result: rubric() },
        { branch_id: 'option-2', rubric_result: rubric() },
      ],
      idPath: 'branch_id',
      rubricResultPath: 'rubric_result',
    });

    expect(byOrdinal.selection).toBe('option-1');
    expect(byOrdinal.record.tie_break).toBe('original_ordinal');
  });

  it('fails when checkpoint choices and rubric rows do not match', () => {
    expect(() =>
      resolveHighestScoreAutoResolution({
        checkpointId: 'tradeoff-checkpoint-step',
        choices: ['option-1', 'option-2'],
        resolvedAt: '2026-05-19T12:00:00.000Z',
        branches: [{ branch_id: 'option-1', rubric_result: rubric() }],
        idPath: 'branch_id',
        rubricResultPath: 'rubric_result',
      }),
    ).toThrow(/missing rubric rows for choices: option-2/);
  });

  it('ranks only allowed checkpoint choices when aggregate evidence has extra rubric rows', () => {
    const resolution = resolveHighestScoreAutoResolution({
      checkpointId: 'tradeoff-checkpoint-step',
      choices: ['option-1', 'option-2'],
      resolvedAt: '2026-05-19T12:00:00.000Z',
      branches: [
        { branch_id: 'option-1', rubric_result: rubric({ evidence_rigor: CONCERN }) },
        { branch_id: 'option-2', rubric_result: rubric() },
        { branch_id: 'option-3', rubric_result: rubric() },
      ],
      idPath: 'branch_id',
      rubricResultPath: 'rubric_result',
    });

    expect(resolution.selection).toBe('option-2');
    const scores = resolution.record.scores;
    expect(scores).toBeDefined();
    if (scores === undefined) throw new Error('expected scores');
    expect(Object.keys(scores)).toEqual(['option-2', 'option-1']);
  });

  it('summarizes runtime-veto effects', () => {
    const result = resolveHighestScoreAutoResolution({
      checkpointId: 'tradeoff-checkpoint-step',
      choices: ['option-1', 'option-2'],
      resolvedAt: '2026-05-19T12:00:00.000Z',
      branches: [
        {
          branch_id: 'option-1',
          rubric_result: rubric({
            evidence_rigor: { runtime_signal: 'missing', model_judgment: 'pass' },
          }),
        },
        { branch_id: 'option-2', rubric_result: rubric() },
      ],
      idPath: 'branch_id',
      rubricResultPath: 'rubric_result',
    });

    expect(result.record.runtime_veto_effect).toBe(
      'option-1 evidence_rigor runtime_signal=missing forced final_score=fail and dim_score=0',
    );
  });
});
