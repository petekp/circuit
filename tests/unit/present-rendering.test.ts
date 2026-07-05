import { describe, expect, it } from 'vitest';

import {
  deliberateClosePresentation,
  finalAnswerMarkdownPath,
  presentAbortReason,
} from '../../plugins/claude/scripts/present-rendering.ts';

describe('finalAnswerMarkdownPath (readable digest wins)', () => {
  it('prefers operator_summary_markdown_path (the readable digest) when it exists', () => {
    const result = {
      run_surface_markdown_path: '/runs/r/reports/run-surface.md',
      operator_summary_markdown_path: '/runs/r/reports/operator-summary.md',
    };
    expect(finalAnswerMarkdownPath(result, () => true)).toBe('/runs/r/reports/operator-summary.md');
  });

  it('falls back to run_surface_markdown_path when the operator summary path is absent', () => {
    const result = { run_surface_markdown_path: '/runs/r/reports/run-surface.md' };
    expect(finalAnswerMarkdownPath(result, () => true)).toBe('/runs/r/reports/run-surface.md');
  });

  it('falls back to the run surface when the operator summary path is set but missing on disk', () => {
    const result = {
      operator_summary_markdown_path: '/missing/operator-summary.md',
      run_surface_markdown_path: '/present/run-surface.md',
    };
    const exists = (path: string) => path === '/present/run-surface.md';
    expect(finalAnswerMarkdownPath(result, exists)).toBe('/present/run-surface.md');
  });

  it('returns undefined when neither markdown path exists', () => {
    expect(finalAnswerMarkdownPath({}, () => false)).toBeUndefined();
  });
});

describe('presentAbortReason (F-H-2)', () => {
  it('prefers the reason copied onto the stdout envelope', () => {
    const result = { reason: 'the specific reason', result_path: '/runs/r/reports/result.json' };
    expect(presentAbortReason(result, () => 'from-result-json')).toBe('the specific reason');
  });

  it('falls back to result.json reason via result_path when the envelope omits reason', () => {
    const result = { result_path: '/runs/r/reports/result.json' };
    const load = (path: string) =>
      path === '/runs/r/reports/result.json' ? 'reason from file' : undefined;
    expect(presentAbortReason(result, load)).toBe('reason from file');
  });

  it('returns undefined when neither the envelope nor result.json carry a reason', () => {
    expect(presentAbortReason({ result_path: '/x' }, () => undefined)).toBeUndefined();
    expect(presentAbortReason({}, () => 'unused')).toBeUndefined();
  });
});

// stopped/escalated/handoff closes exit nonzero for scripts, but they are
// deliberate closes, not crashes: the wrapper renders the run's own status
// text and must never print the generic "Circuit run failed" line for them.
describe('deliberateClosePresentation', () => {
  it('presents a stopped close with the run surface status text as the headline', () => {
    const result = {
      outcome: 'stopped',
      run_surface_status_text: 'Stopped: the operator ended the run at the Build checkpoint.',
    };
    expect(deliberateClosePresentation(result, () => undefined)).toEqual({
      headline: 'Stopped: the operator ended the run at the Build checkpoint.',
    });
  });

  it('composes a fallback headline when the envelope carries no status text', () => {
    expect(deliberateClosePresentation({ outcome: 'escalated' }, () => undefined)).toEqual({
      headline: 'Run closed with outcome escalated.',
    });
  });

  it('carries the close reason through the same envelope-then-result.json channel aborts use', () => {
    const result = {
      outcome: 'handoff',
      run_surface_status_text: 'Handoff: continuity saved for the next session.',
      result_path: '/runs/r/reports/result.json',
    };
    const load = (path: string) =>
      path === '/runs/r/reports/result.json' ? 'recovery limit reached' : undefined;
    expect(deliberateClosePresentation(result, load)).toEqual({
      headline: 'Handoff: continuity saved for the next session.',
      reason: 'recovery limit reached',
    });
  });

  it('returns undefined for every other outcome, so aborts and successes keep their branches', () => {
    expect(deliberateClosePresentation({ outcome: 'aborted' }, () => 'x')).toBeUndefined();
    expect(deliberateClosePresentation({ outcome: 'complete' }, () => 'x')).toBeUndefined();
    expect(
      deliberateClosePresentation({ outcome: 'checkpoint_waiting' }, () => 'x'),
    ).toBeUndefined();
    expect(deliberateClosePresentation({}, () => 'x')).toBeUndefined();
  });
});
