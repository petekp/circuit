import { describe, expect, it } from 'vitest';

import { renderReport } from '../../evals/fix-vs-vanilla/run-fix-comparison.ts';

// A single-arm run (--arm vanilla, used for calibration) produces task
// summaries where the other arm is simply absent. The report must render that
// without dereferencing a missing arm's claim. This pins the crash
// "Cannot read properties of undefined (reading 'review_status')".
function vanillaOnlySummary() {
  const vanillaScore = {
    false_fixed: false,
    objective_fixed: true,
    proof_quality: 3,
    claim: { claimed_fixed: true },
  };
  return {
    result_root: '/tmp/run',
    provider: 'claude-code',
    model: 'claude-haiku-4-5-20251001',
    effort: 'medium',
    repo_commit: 'abc',
    claim: { supported: false, reason: 'no held-out tasks were scored' },
    aggregates: {
      'held-out': {
        'circuit-claude-code': { task_count: 0 },
        'vanilla-claude-code': { task_count: 0 },
      },
    },
    tasks: [
      {
        task_id: 'discovery-clamp-percent',
        split: 'discovery',
        arms: { 'vanilla-claude-code': vanillaScore },
      },
    ],
  };
}

describe('renderReport with a single arm', () => {
  it('renders a vanilla-only run without throwing', () => {
    expect(() => renderReport(vanillaOnlySummary() as never)).not.toThrow();
  });

  it('marks the absent arm as not run', () => {
    const report = renderReport(vanillaOnlySummary() as never);
    expect(report).toContain('Circuit not run');
    expect(report).toContain('vanilla false-fixed=false');
  });
});
