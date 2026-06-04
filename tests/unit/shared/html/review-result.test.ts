import { describe, expect, it } from 'vitest';

import { reviewResultProjector } from '../../../../src/flows/review/index.js';

describe('reviewResultProjector', () => {
  it('renders Review HTML when findings or evidence caveats need legibility', () => {
    const html = reviewResultProjector({
      runFolder: '/tmp/circuit-run',
      runId: '87000000-0000-0000-0000-000000000001',
      flowId: 'review',
      runOutcome: 'complete',
      flowReport: {
        scope: 'review staged evil.js',
        findings: [
          {
            severity: 'high',
            id: 'eval-001',
            text: 'eval call enables remote code execution <script>alert(1)</script>',
            file_refs: ['evil.js:7'],
          },
        ],
        verdict: 'ISSUES_FOUND',
        assessment: 'Reviewer found one high-severity issue.',
        verification: ['Read evil.js'],
        confidence_limitations: ['Untracked files were metadata only.'],
        evidence_summary: {
          kind: 'git-working-tree',
          untracked_content_policy: 'metadata-only',
          untracked_file_count: 1,
          untracked_files_sampled: 1,
          untracked_files_truncated: false,
        },
        evidence_warnings: [
          {
            kind: 'diff_truncated',
            message: 'staged diff was truncated before relay',
          },
        ],
      },
      readJsonRunRelative: () => undefined,
      readEvidenceReportById: () => undefined,
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Review result');
    expect(html).toContain('ISSUES_FOUND');
    expect(html).toContain('eval call enables remote code execution');
    expect(html).toContain('evil.js:7');
    expect(html).toContain('diff_truncated');
    expect(html).toContain('Untracked files were metadata only.');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('stays markdown-only for clean Review results without caveats', () => {
    const html = reviewResultProjector({
      runFolder: '/tmp/circuit-run',
      runId: '87000000-0000-0000-0000-000000000001',
      flowId: 'review',
      runOutcome: 'complete',
      flowReport: {
        scope: 'review staged safe.ts',
        findings: [],
        verdict: 'CLEAN',
        assessment: 'Reviewer found nothing actionable.',
        verification: ['Read safe.ts'],
        confidence_limitations: [],
        evidence_warnings: [],
      },
      readJsonRunRelative: () => undefined,
      readEvidenceReportById: () => undefined,
    });

    expect(html).toBeUndefined();
  });
});
