import { describe, expect, it } from 'vitest';

import {
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
