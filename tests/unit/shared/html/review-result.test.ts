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
        outcome: 'stopped',
        assessment: 'Reviewer found one high-severity issue.',
        verification: ['Read evil.js'],
        confidence_limitations: ['Untracked files were metadata only.'],
        evidence_summary: {
          kind: 'git-working-tree',
          untracked_content_policy: 'metadata-only',
          untracked_file_count: 1,
          untracked_files_sampled: 1,
          untracked_files_truncated: false,
          target_kind: 'working_tree',
          target_mode: 'staged',
          target_diff_included: true,
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
    expect(html).toContain('EVIDENCE INCOMPLETE');
    expect(html).not.toContain('>ISSUES_FOUND<');
    expect(html).toContain('eval call enables remote code execution');
    expect(html).toContain('evil.js:7');
    // The warning is named in plain English. `diff_truncated` is an internal
    // enum tag; putting it in front of an operator breaks the no-jargon rule in
    // AGENTS.md, and reviewers copied it back out into their own prose.
    expect(html).toContain('Content truncated before review');
    expect(html).not.toContain('diff_truncated');
    expect(html).toContain('Untracked files were metadata only.');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders a clean result with a non-evidence confidence note calmly', () => {
    const html = reviewResultProjector({
      runFolder: '/tmp/circuit-run',
      runId: '87000000-0000-0000-0000-000000000001',
      flowId: 'review',
      runOutcome: 'complete',
      flowReport: {
        scope: 'review this change',
        findings: [],
        verdict: 'CLEAN',
        outcome: 'complete',
        assessment: 'Reviewer inspected the evidence and found nothing actionable in scope.',
        verification: ['Inspected the relayed review-intake report.'],
        confidence_limitations: ['The full test suite was not rerun.'],
        evidence_summary: {
          kind: 'git-working-tree',
          untracked_content_policy: 'include-content',
          untracked_file_count: 0,
          untracked_files_sampled: 0,
          untracked_files_truncated: false,
          target_kind: 'working_tree',
          target_mode: 'all',
          target_diff_included: true,
        },
        evidence_warnings: [],
      },
      readJsonRunRelative: () => undefined,
      readEvidenceReportById: () => undefined,
    });

    expect(html).toBeDefined();
    if (html === undefined) throw new Error('expected review html');
    // Clean is calm: amber card borders are reserved for findings that need
    // caution, not for method notes on a clean result.
    expect(html).not.toMatch(/data-slot="card"[^>]*data-intent="attention"/);
    expect(html).toContain('The full test suite was not rerun.');
    expect(html).toContain('CLEAN');
  });

  it.each([
    'binary_content_not_inspected',
    'diff_truncated',
    'untracked_files_truncated',
    'untracked_file_skipped',
    'submodule_content_not_inspected',
  ] as const)(
    'does not render a clean verdict as clean when evidence has a %s warning',
    (warningKind) => {
      const html = reviewResultProjector({
        runFolder: '/tmp/circuit-run',
        runId: '87000000-0000-0000-0000-000000000004',
        flowId: 'review',
        runOutcome: 'complete',
        flowReport: {
          scope: 'review working tree changes',
          findings: [],
          verdict: 'CLEAN',
          outcome: 'complete',
          assessment: 'The old run returned no findings.',
          verification: ['Read the available working-tree evidence.'],
          confidence_limitations: [],
          evidence_summary: {
            kind: 'git-working-tree',
            untracked_content_policy: 'include-content',
            untracked_file_count: 1,
            untracked_files_sampled: 1,
            untracked_files_truncated: warningKind === 'untracked_files_truncated',
            target_kind: 'working_tree',
            target_mode: 'all',
            target_diff_included: true,
          },
          evidence_warnings: [
            {
              kind: warningKind,
              message: `Legacy Review evidence warning: ${warningKind}`,
            },
          ],
        },
        readJsonRunRelative: () => undefined,
        readEvidenceReportById: () => undefined,
      });

      expect(html).toBeDefined();
      expect(html).not.toContain('>CLEAN<');
    },
  );

  it('keeps amber cards when findings need caution', () => {
    const html = reviewResultProjector({
      runFolder: '/tmp/circuit-run',
      runId: '87000000-0000-0000-0000-000000000001',
      flowId: 'review',
      runOutcome: 'complete',
      flowReport: {
        scope: 'review staged risky.ts',
        findings: [
          {
            severity: 'medium',
            id: 'risk-001',
            text: 'Unbounded retry loop.',
            file_refs: ['risky.ts:12'],
          },
        ],
        verdict: 'ISSUES_FOUND',
        outcome: 'stopped',
        assessment: 'Reviewer found one medium issue.',
        verification: ['Read risky.ts'],
        confidence_limitations: [],
        evidence_warnings: [],
      },
      readJsonRunRelative: () => undefined,
      readEvidenceReportById: () => undefined,
    });

    expect(html).toBeDefined();
    if (html === undefined) throw new Error('expected review html');
    expect(html).toMatch(/data-slot="card"[^>]*data-intent="attention"/);
  });

  it('renders dedicated Git target evidence without expecting untracked-file fields', () => {
    const html = reviewResultProjector({
      runFolder: '/tmp/circuit-run',
      runId: '87000000-0000-0000-0000-000000000002',
      flowId: 'review',
      runOutcome: 'complete',
      flowReport: {
        scope: 'review commit HEAD^',
        findings: [],
        verdict: 'CLEAN',
        outcome: 'complete',
        assessment: 'Reviewer inspected the requested commit.',
        verification: ['Read the target diff.'],
        confidence_limitations: [],
        evidence_summary: {
          kind: 'git-target',
          target_kind: 'commit',
          target_ref: 'HEAD^',
          target_diff_included: true,
          target_diff_truncated: true,
        },
        evidence_warnings: [
          {
            kind: 'diff_truncated',
            message: 'HEAD^ diff was truncated before relay',
          },
        ],
      },
      readJsonRunRelative: () => undefined,
      readEvidenceReportById: () => undefined,
    });

    expect(html).toContain('Review target: HEAD^ (commit)');
    expect(html).toContain('Target diff included: yes');
    expect(html).toContain('Target diff truncated: yes');
    expect(html).not.toContain('Untracked files sampled');
  });

  it('renders a truncated dedicated Git target as incomplete without relying on a warning', () => {
    const html = reviewResultProjector({
      runFolder: '/tmp/circuit-run',
      runId: '87000000-0000-0000-0000-000000000007',
      flowId: 'review',
      runOutcome: 'complete',
      flowReport: {
        scope: 'review commit HEAD^',
        findings: [],
        verdict: 'CLEAN',
        outcome: 'complete',
        assessment: 'The persisted report claimed a clean result.',
        verification: ['Read the available target diff.'],
        confidence_limitations: [],
        evidence_summary: {
          kind: 'git-target',
          target_kind: 'commit',
          target_ref: 'HEAD^',
          target_diff_included: true,
          target_diff_truncated: true,
        },
        evidence_warnings: [],
      },
      readJsonRunRelative: () => undefined,
      readEvidenceReportById: () => undefined,
    });

    expect(html).toContain('EVIDENCE INCOMPLETE');
    expect(html).not.toContain('>CLEAN<');
  });

  it('renders a truncated working-tree file list as incomplete without relying on a warning', () => {
    const html = reviewResultProjector({
      runFolder: '/tmp/circuit-run',
      runId: '87000000-0000-0000-0000-000000000008',
      flowId: 'review',
      runOutcome: 'complete',
      flowReport: {
        scope: 'review current changes',
        findings: [],
        verdict: 'CLEAN',
        outcome: 'complete',
        assessment: 'The persisted report claimed a clean result.',
        verification: ['Read the sampled working-tree evidence.'],
        confidence_limitations: [],
        evidence_summary: {
          kind: 'git-working-tree',
          untracked_content_policy: 'include-content',
          untracked_file_count: 2,
          untracked_files_sampled: 1,
          untracked_files_truncated: true,
          target_kind: 'working_tree',
          target_mode: 'all',
          target_diff_included: true,
        },
        evidence_warnings: [],
      },
      readJsonRunRelative: () => undefined,
      readEvidenceReportById: () => undefined,
    });

    expect(html).toContain('EVIDENCE INCOMPLETE');
    expect(html).not.toContain('>CLEAN<');
  });

  it.each(['staged', 'unstaged', 'all'] as const)(
    'renders a selected %s working-tree target with no included source as unavailable',
    (mode) => {
      const html = reviewResultProjector({
        runFolder: '/tmp/circuit-run',
        runId: '87000000-0000-0000-0000-000000000009',
        flowId: 'review',
        runOutcome: 'complete',
        flowReport: {
          scope: `review ${mode} changes`,
          findings: [],
          verdict: 'CLEAN',
          outcome: 'complete',
          assessment: 'The persisted report claimed a clean result.',
          verification: [],
          confidence_limitations: [],
          evidence_summary: {
            kind: 'git-working-tree',
            untracked_content_policy: 'metadata-only',
            untracked_file_count: 0,
            untracked_files_sampled: 0,
            untracked_files_truncated: false,
            target_kind: 'working_tree',
            target_mode: mode,
            target_diff_included: false,
          },
          evidence_warnings: [],
        },
        readJsonRunRelative: () => undefined,
        readEvidenceReportById: () => undefined,
      });

      expect(html).toContain('EVIDENCE UNAVAILABLE');
      expect(html).not.toContain('>CLEAN<');
    },
  );

  it('does not mark complete untracked-only evidence unavailable', () => {
    const html = reviewResultProjector({
      runFolder: '/tmp/circuit-run',
      runId: '87000000-0000-0000-0000-000000000010',
      flowId: 'review',
      runOutcome: 'complete',
      flowReport: {
        scope: 'review current changes including untracked files',
        findings: [],
        verdict: 'CLEAN',
        outcome: 'complete',
        assessment: 'Reviewer inspected the complete untracked file content.',
        verification: ['Read the complete untracked file content.'],
        confidence_limitations: [],
        evidence_summary: {
          kind: 'git-working-tree',
          untracked_content_policy: 'include-content',
          untracked_file_count: 1,
          untracked_files_sampled: 1,
          untracked_files_truncated: false,
          target_kind: 'working_tree',
          target_mode: 'all',
          target_diff_included: false,
        },
        evidence_warnings: [],
      },
      readJsonRunRelative: () => undefined,
      readEvidenceReportById: () => undefined,
    });

    expect(html).toBeUndefined();
  });

  it('renders persisted unavailable legacy evidence as unavailable rather than clean', () => {
    const html = reviewResultProjector({
      runFolder: '/tmp/circuit-run',
      runId: '87000000-0000-0000-0000-000000000003',
      flowId: 'review',
      runOutcome: 'complete',
      flowReport: {
        scope: 'review commit missing',
        findings: [],
        verdict: 'CLEAN',
        outcome: 'complete',
        assessment: 'The old run returned no findings.',
        verification: [],
        confidence_limitations: [],
        evidence_summary: {
          kind: 'unavailable',
          message: 'The requested commit could not be read.',
        },
        evidence_warnings: [],
      },
      readJsonRunRelative: () => undefined,
      readEvidenceReportById: () => undefined,
    });

    expect(html).toContain('EVIDENCE UNAVAILABLE');
    expect(html).toContain('The requested commit could not be read.');
    expect(html).not.toContain('>CLEAN<');
  });

  it.each(['staged', 'unstaged', 'all'] as const)(
    'names the selected %s working-tree mode and whether its diff was included',
    (mode) => {
      const html = reviewResultProjector({
        runFolder: '/tmp/circuit-run',
        runId: '87000000-0000-0000-0000-000000000005',
        flowId: 'review',
        runOutcome: 'complete',
        flowReport: {
          scope: `review ${mode} working-tree changes`,
          findings: [],
          verdict: 'CLEAN',
          outcome: 'complete',
          assessment: 'Reviewer inspected the selected working-tree evidence.',
          verification: ['Read the selected diff.'],
          confidence_limitations: ['Rendered to exercise the evidence summary.'],
          evidence_summary: {
            kind: 'git-working-tree',
            untracked_content_policy: 'metadata-only',
            untracked_file_count: 0,
            untracked_files_sampled: 0,
            untracked_files_truncated: false,
            target_kind: 'working_tree',
            target_mode: mode,
            target_diff_included: true,
          },
          evidence_warnings: [],
        },
        readJsonRunRelative: () => undefined,
        readEvidenceReportById: () => undefined,
      });

      expect(html).toContain(`Review target: ${mode} working-tree changes`);
      expect(html).toContain('Target diff included: yes');
    },
  );

  it('uses a stopped badge when a complete evidence set produced blocking findings', () => {
    const html = reviewResultProjector({
      runFolder: '/tmp/circuit-run',
      runId: '87000000-0000-0000-0000-000000000006',
      flowId: 'review',
      runOutcome: 'stopped',
      flowReport: {
        scope: 'review staged changes',
        findings: [
          {
            severity: 'high',
            id: 'unsafe-change',
            text: 'The change is unsafe.',
            file_refs: ['src/example.ts:1'],
          },
        ],
        verdict: 'ISSUES_FOUND',
        outcome: 'stopped',
        assessment: 'Reviewer found one blocking issue.',
        verification: ['Read the full staged diff.'],
        confidence_limitations: [],
        evidence_summary: {
          kind: 'git-working-tree',
          untracked_content_policy: 'metadata-only',
          untracked_file_count: 0,
          untracked_files_sampled: 0,
          untracked_files_truncated: false,
          target_kind: 'working_tree',
          target_mode: 'staged',
          target_diff_included: true,
        },
        evidence_warnings: [],
      },
      readJsonRunRelative: () => undefined,
      readEvidenceReportById: () => undefined,
    });

    expect(html).toContain('REVIEW STOPPED');
    expect(html).not.toContain('>ISSUES_FOUND<');
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
        outcome: 'complete',
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
