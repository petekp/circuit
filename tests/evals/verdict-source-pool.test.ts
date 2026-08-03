import { describe, expect, it } from 'vitest';
import {
  summarizeCaseSourcePool,
  summarizeSourcePool,
} from '../../evals/verdict-correctness/reporting.ts';
import type { EvalCaseResult } from '../../evals/verdict-correctness/types.ts';

describe('verdict-correctness source pool reporting', () => {
  it('counts source runs separately from repeated cases', () => {
    const summary = summarizeCaseSourcePool([
      { source_run_id: 'run-a', source_subject: ' Explore prompt tuning  ' },
      { source_run_id: 'run-a', source_subject: 'Explore prompt tuning' },
      { source_run_id: 'run-b', source_subject: 'Release proof review' },
      { source_run_id: 'run-c' },
    ]);

    expect(summary).toEqual({
      source_count: 3,
      distinct_subjects: 2,
      subjects: ['Explore prompt tuning', 'Release proof review'],
    });
  });

  it('can summarize old and new result records', () => {
    const results: EvalCaseResult[] = [
      {
        case: {
          source_run_id: 'run-a',
          source_request_path: '.circuit/runs/run-a/reports/relay/review.request.json',
          source_subject: 'Explore prompt tuning',
          defect_id: 'control',
          prompt: 'prompt',
          mutation_summary: 'control',
        },
        outcome: { kind: 'connector_error', message: 'not run' },
        score: { kind: 'skipped', reason: 'not run' },
      },
      {
        case: {
          source_run_id: 'run-b',
          source_request_path: '.circuit/runs/run-b/reports/relay/review.request.json',
          defect_id: 'control',
          prompt: 'prompt',
          mutation_summary: 'old result without source subject',
        },
        outcome: { kind: 'connector_error', message: 'not run' },
        score: { kind: 'skipped', reason: 'not run' },
      },
    ];

    expect(summarizeSourcePool(results)).toEqual({
      source_count: 2,
      distinct_subjects: 1,
      subjects: ['Explore prompt tuning'],
    });
  });
});
