import { describe, expect, it } from 'vitest';

import { OperatorAutoResolution, OperatorBriefSlots } from '../../src/schemas/operator-summary.js';

function baseAutoResolutionRecord(policy: string) {
  return {
    checkpoint_id: 'tradeoff-checkpoint-step',
    checkpoint_label: 'Decision - tradeoff checkpoint',
    policy,
    resolved_value: 'option-2',
    alternatives_available: ['option-1'],
    resolved_at: '2026-05-19T12:00:00.000Z',
  };
}

function fullHighestScoreRecord(): Record<string, unknown> {
  return {
    ...baseAutoResolutionRecord('highest-score'),
    scores: {
      'option-1': { aggregate_score: 0.875, runtime_veto_count: 1 },
      'option-2': { aggregate_score: 1, runtime_veto_count: 0 },
    },
    rubric_results: {
      'option-2': {
        dims: {
          evidence_rigor: {
            runtime_signal: 'met',
            model_judgment: 'pass',
            final_score: 'pass',
            dim_score: 1,
            runtime_vetoed: false,
          },
        },
        aggregate_score: 1,
        runtime_veto_count: 0,
        tie_break: {
          ordered_dims: ['evidence_rigor'],
          final_reason: 'not-ranked',
        },
      },
    },
    winning_score: 1,
    runner_up_score: 0.875,
    margin: 0.125,
    tie_break: 'aggregate_score',
    runtime_veto_effect: 'option-1 evidence_rigor runtime_signal=missing',
  };
}

describe('OperatorSummary schema', () => {
  it('accepts the five-slot digest brief and rejects the old dormant slot shape', () => {
    expect(
      OperatorBriefSlots.safeParse({
        headline: 'Circuit · Review: Clean',
        assessment: 'Reviewer found nothing actionable.',
        key_points: ['Checked the staged diff'],
        caveats: ['Untracked files were metadata only.'],
        next_action: 'nothing required.',
      }).success,
    ).toBe(true);

    expect(
      OperatorBriefSlots.safeParse({
        headline: 'Circuit · Review: Clean',
        primary: {
          label: 'Verdict',
          text: 'Clean',
        },
        cautions: [],
      }).success,
    ).toBe(false);
  });

  it('accepts highest-score auto-resolution records', () => {
    expect(OperatorAutoResolution.safeParse(fullHighestScoreRecord()).success).toBe(true);
  });

  it('rejects old checkpoint resolver names as auto-resolution records', () => {
    for (const policy of ['accept-as-is', 'first-acceptable', 'refuse'] as const) {
      expect(
        OperatorAutoResolution.safeParse(baseAutoResolutionRecord(policy)).success,
        policy,
      ).toBe(false);
    }
  });

  it('rejects the old runtime_or_model switch entirely', () => {
    expect(
      OperatorAutoResolution.safeParse({
        ...baseAutoResolutionRecord('highest-score'),
        runtime_or_model: 'runtime',
      }).success,
    ).toBe(false);
  });

  it('rejects highest-score records without runtime score provenance', () => {
    for (const field of [
      'scores',
      'rubric_results',
      'winning_score',
      'margin',
      'tie_break',
      'runtime_veto_effect',
    ] as const) {
      const record = fullHighestScoreRecord();
      delete record[field];
      expect(OperatorAutoResolution.safeParse(record).success, field).toBe(false);
    }
  });
});
