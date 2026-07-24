import { describe, expect, it } from 'vitest';

import {
  projectReviewIntake,
  projectReviewResult,
  reviewEvidenceWarnings,
} from '../../src/flows/review/index.js';
import { ReviewIntake, ReviewRelayResult } from '../../src/flows/review/reports.js';

const COMMIT_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COMMIT_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COMMIT_C = 'cccccccccccccccccccccccccccccccccccccccc';
const COMMIT_D = 'dddddddddddddddddddddddddddddddddddddddd';

function cleanRelay() {
  return ReviewRelayResult.parse({
    verdict: 'NO_ISSUES_FOUND',
    findings: [],
    assessment: 'The requested source evidence had no actionable issue.',
    verification: ['Read the relayed diff.'],
    confidence_limitations: [],
  });
}

function legacyWorkingTreeEvidence(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'git-working-tree',
    project_root: '/tmp/project',
    status_short: 'M  staged.ts\n M unstaged.ts\n',
    staged_diff: {
      text: 'diff --git a/staged.ts b/staged.ts\n+staged\n',
      truncated: false,
    },
    unstaged_diff: {
      text: 'diff --git a/unstaged.ts b/unstaged.ts\n+unstaged\n',
      truncated: false,
    },
    diff_stat: ' staged.ts | 1 +\n unstaged.ts | 1 +\n',
    untracked_file_count: 0,
    untracked_files_truncated: false,
    untracked_content_policy: 'metadata-only',
    untracked_files: [],
    ...overrides,
  };
}

function legacyIntake(scope: string, evidenceOverrides: Record<string, unknown> = {}) {
  return ReviewIntake.parse({
    scope,
    evidence: legacyWorkingTreeEvidence(evidenceOverrides),
    evidence_warnings: [],
  });
}

function projectedLegacyIntake(scope: string, evidenceOverrides: Record<string, unknown> = {}) {
  const intake = legacyIntake(scope, evidenceOverrides);
  return projectReviewIntake({
    scope,
    evidence: intake.evidence,
    maxUntrackedFiles: 20,
  });
}

function dedicatedTargetIntake(scope: string, target: Record<string, unknown>) {
  const parsed = ReviewIntake.parse({
    scope,
    evidence: {
      kind: 'git-target',
      project_root: '/tmp/project',
      target_diff: {
        text: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 2;\n',
        truncated: false,
      },
      target_diff_stat: ' src/example.ts | 1 +\n',
      ...target,
    },
    evidence_warnings: [],
  });
  return projectReviewIntake({
    scope,
    evidence: parsed.evidence,
    maxUntrackedFiles: 20,
  });
}

describe('Review evidence projections', () => {
  it('summarizes the dedicated Git target evidence without working-tree fields', () => {
    const intake = projectReviewIntake({
      scope: 'review commit HEAD^',
      maxUntrackedFiles: 20,
      evidence: {
        kind: 'git-target',
        project_root: '/tmp/project',
        target_kind: 'commit',
        target_ref: 'HEAD^',
        target_commit: COMMIT_A,
        target_diff: {
          text: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 2;\n',
          truncated: true,
        },
        target_diff_stat: ' src/example.ts | 1 +\n',
      },
    });

    expect(intake.evidence_warnings).toEqual([
      {
        kind: 'diff_truncated',
        message: 'HEAD^ diff was truncated before relay',
      },
    ]);
    expect(projectReviewResult({ intake, relayResult: cleanRelay() }).evidence_summary).toEqual({
      kind: 'git-target',
      target_kind: 'commit',
      target_ref: 'HEAD^',
      target_diff_included: true,
      target_diff_truncated: true,
    });
  });

  it('accepts dedicated target evidence only when it matches the requested target', () => {
    const matching = projectReviewIntake({
      scope: 'review commit HEAD^',
      maxUntrackedFiles: 20,
      evidence: {
        kind: 'git-target',
        project_root: '/tmp/project',
        target_kind: 'commit',
        target_ref: 'HEAD^',
        target_commit: COMMIT_A,
        target_diff: {
          text: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 2;\n',
          truncated: false,
        },
        target_diff_stat: ' src/example.ts | 1 +\n',
      },
    });
    expect(projectReviewResult({ intake: matching, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'CLEAN',
      outcome: 'complete',
    });

    const mismatched = ReviewIntake.parse({
      ...matching,
      evidence: {
        ...matching.evidence,
        target_ref: 'HEAD~2',
      },
    });
    expect(() => projectReviewResult({ intake: mismatched, relayResult: cleanRelay() })).toThrow(
      'does not match the requested scope',
    );
  });

  it.each([
    {
      name: 'range endpoint differs',
      scope: 'review main...feature',
      evidence: {
        kind: 'git-target',
        project_root: '/tmp/project',
        target_kind: 'range',
        target_ref: 'main...other',
        target_base_ref: 'main',
        target_head_ref: 'other',
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
        target_diff: { text: 'diff for main...other\n', truncated: false },
        target_diff_stat: ' other.ts | 1 +\n',
      },
    },
    {
      name: 'pull request number differs',
      scope: 'review PR #42',
      evidence: {
        kind: 'git-target',
        project_root: '/tmp/project',
        target_kind: 'pull_request',
        target_ref: 'PR #41',
        target_repository: 'github.com/openai/codex',
        target_merge_commit: COMMIT_D,
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
        target_diff: { text: 'diff for PR #41\n', truncated: false },
        target_diff_stat: ' pull-request.ts | 1 +\n',
      },
    },
    {
      name: 'working tree request received commit evidence',
      scope: 'review staged changes',
      evidence: {
        kind: 'git-target',
        project_root: '/tmp/project',
        target_kind: 'commit',
        target_ref: 'HEAD',
        target_commit: COMMIT_A,
        target_diff: { text: 'diff for HEAD\n', truncated: false },
        target_diff_stat: ' committed.ts | 1 +\n',
      },
    },
  ])('rejects dedicated target evidence when $name', ({ scope, evidence }) => {
    const intake = ReviewIntake.parse({
      scope,
      evidence,
      evidence_warnings: [],
    });
    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'does not match the requested scope',
    );
  });

  it('keeps legacy working-tree evidence parseable but does not let it complete an explicit target', () => {
    const duplicatedDiff = {
      text: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 2;\n',
      truncated: false,
    };
    const intake = ReviewIntake.parse({
      scope: 'review the latest commit',
      evidence: {
        kind: 'git-working-tree',
        project_root: '/tmp/project',
        status_short: '',
        staged_diff: { text: '', truncated: false },
        unstaged_diff: { text: '', truncated: false },
        diff_stat: '',
        target_kind: 'commit',
        target_ref: 'HEAD',
        target_diff: duplicatedDiff,
        target_diff_stat: ' src/example.ts | 1 +\n',
        committed_diff_ref: 'HEAD',
        committed_diff: duplicatedDiff,
        committed_diff_stat: ' src/example.ts | 1 +\n',
        untracked_file_count: 0,
        untracked_files_truncated: false,
        untracked_content_policy: 'metadata-only',
        untracked_files: [],
      },
      evidence_warnings: [],
    });

    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'does not match the requested scope',
    );
  });

  it('rejects old generic working-tree evidence when the scope is goal-only', () => {
    expect(() =>
      projectReviewResult({
        intake: legacyIntake('review this code for architectural risks'),
        relayResult: cleanRelay(),
      }),
    ).toThrow('does not match the requested scope');
  });

  it('rejects legacy working-tree evidence for a goal-only Review', () => {
    expect(() =>
      projectReviewResult({
        intake: legacyIntake('review this rollout plan for operational risks'),
        relayResult: cleanRelay(),
      }),
    ).toThrow('does not match the requested scope');
  });

  it.each([
    {
      name: 'commit diff',
      intake: () =>
        dedicatedTargetIntake('review commit aaaaaaa', {
          target_kind: 'commit',
          target_ref: 'aaaaaaa',
          target_commit: COMMIT_A,
          target_diff: {
            text: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 2;\n',
            truncated: true,
          },
        }),
    },
    {
      name: 'selected staged diff',
      intake: () =>
        projectedLegacyIntake('review staged changes', {
          target_kind: 'working_tree',
          target_mode: 'staged',
          staged_diff: {
            text: 'diff --git a/staged.ts b/staged.ts\n+staged\n',
            truncated: true,
          },
        }),
    },
    {
      name: 'selected unstaged diff',
      intake: () =>
        projectedLegacyIntake('review unstaged changes', {
          target_kind: 'working_tree',
          target_mode: 'unstaged',
          unstaged_diff: {
            text: 'diff --git a/unstaged.ts b/unstaged.ts\n+unstaged\n',
            truncated: true,
          },
        }),
    },
    {
      name: 'untracked file content',
      intake: () =>
        projectedLegacyIntake('review current working tree changes', {
          target_kind: 'working_tree',
          target_mode: 'all',
          status_short: '?? new-file.ts\n',
          staged_diff: { text: '', truncated: false },
          unstaged_diff: { text: '', truncated: false },
          diff_stat: '',
          untracked_content_policy: 'include-content',
          untracked_file_count: 1,
          untracked_files: [
            {
              path: 'new-file.ts',
              byte_length: 48_000,
              content: {
                text: 'export const visiblePrefix = true;\n[truncated]',
                truncated: true,
              },
            },
          ],
        }),
    },
    {
      name: 'untracked file list',
      intake: () =>
        projectedLegacyIntake('review current working tree changes', {
          target_kind: 'working_tree',
          target_mode: 'all',
          status_short: '?? first-new-file.ts\n',
          staged_diff: { text: '', truncated: false },
          unstaged_diff: { text: '', truncated: false },
          diff_stat: '',
          untracked_content_policy: 'include-content',
          untracked_file_count: 21,
          untracked_files_truncated: true,
          untracked_files: [
            {
              path: 'first-new-file.ts',
              byte_length: 28,
              content: {
                text: 'export const first = true;\n',
                truncated: false,
              },
            },
          ],
        }),
    },
  ])('cannot report CLEAN when the selected $name evidence is truncated', ({ intake }) => {
    expect(projectReviewResult({ intake: intake(), relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
    });
  });

  it('cannot report CLEAN from a truncated dedicated target when its persisted warning is missing', () => {
    const intake = ReviewIntake.parse({
      scope: 'review commit aaaaaaa',
      evidence: {
        kind: 'git-target',
        project_root: '/tmp/project',
        target_kind: 'commit',
        target_ref: 'aaaaaaa',
        target_commit: COMMIT_A,
        target_diff: {
          text: 'diff --git a/src/example.ts b/src/example.ts\n+const visiblePrefix = true;\n',
          truncated: true,
        },
        target_diff_stat: ' src/example.ts | 1 +\n',
      },
      evidence_warnings: [],
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
    });
  });

  it('cannot report CLEAN from a truncated selected working-tree diff when its persisted warning is missing', () => {
    const intake = legacyIntake('review staged changes', {
      target_kind: 'working_tree',
      target_mode: 'staged',
      staged_diff: {
        text: 'diff --git a/staged.ts b/staged.ts\n+const visiblePrefix = true;\n',
        truncated: true,
      },
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
    });
  });

  it.each([
    {
      name: 'metadata-only untracked file',
      evidence: {
        untracked_content_policy: 'metadata-only',
        untracked_file_count: 1,
        untracked_files: [{ path: 'hidden.ts', byte_length: 42 }],
      },
    },
    {
      name: 'skipped binary untracked file',
      evidence: {
        untracked_content_policy: 'include-content',
        untracked_file_count: 1,
        untracked_files: [
          {
            path: 'binary.dat',
            byte_length: 3,
            skipped_reason: 'binary file skipped',
          },
        ],
      },
    },
  ])('cannot report CLEAN when selected all-mode evidence omits a $name', ({ evidence }) => {
    const intake = legacyIntake('review current working tree changes', {
      target_kind: 'working_tree',
      target_mode: 'all',
      staged_diff: {
        text: 'diff --git a/staged.ts b/staged.ts\n+staged\n',
        truncated: false,
      },
      unstaged_diff: { text: '', truncated: false },
      ...evidence,
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('cannot report CLEAN when nested submodule working-tree content was not inspected', () => {
    const intake = projectedLegacyIntake('review current working tree changes', {
      target_kind: 'working_tree',
      target_mode: 'all',
      staged_diff: {
        text: 'diff --git a/staged.ts b/staged.ts\n+staged\n',
        truncated: false,
      },
      unstaged_diff: { text: '', truncated: false },
      submodule_paths: ['modules/child'],
    });

    expect(intake.evidence_warnings).toContainEqual({
      kind: 'submodule_content_not_inspected',
      path: 'modules/child',
      message: 'nested submodule source content was not inspected',
    });
    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('cannot report CLEAN when a pinned target contains only a submodule gitlink update', () => {
    const intake = dedicatedTargetIntake('review commit aaaaaaa', {
      target_kind: 'commit',
      target_ref: 'aaaaaaa',
      target_commit: COMMIT_A,
      target_diff: {
        text: [
          'diff --git a/modules/child b/modules/child',
          'index aaaaaaa..bbbbbbb 160000',
          '--- a/modules/child',
          '+++ b/modules/child',
          '@@ -1 +1 @@',
          `-Subproject commit ${COMMIT_A}`,
          `+Subproject commit ${COMMIT_B}`,
          '',
        ].join('\n'),
        truncated: false,
      },
      target_diff_stat: ' modules/child | 2 +-\n',
    });

    expect(intake.evidence_warnings).toContainEqual({
      kind: 'submodule_content_not_inspected',
      message: 'nested submodule source content was not inspected',
    });
    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('names uninspected binary content in a pinned target', () => {
    const intake = dedicatedTargetIntake('review commit aaaaaaa', {
      target_kind: 'commit',
      target_ref: 'aaaaaaa',
      target_commit: COMMIT_A,
      target_diff: {
        text: [
          'diff --git a/assets/logo.png b/assets/logo.png',
          'index 1f2e3d4..5a6b7c8 100644',
          'Binary files a/assets/logo.png and b/assets/logo.png differ',
          '',
        ].join('\n'),
        truncated: false,
      },
      target_diff_stat: ' assets/logo.png | Bin 12 -> 24 bytes\n',
    });

    expect(intake.evidence_warnings).toContainEqual({
      kind: 'binary_content_not_inspected',
      path: 'assets/logo.png',
      message: 'binary file content was not inspected: assets/logo.png',
    });
    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      confidence_limitations: [
        expect.stringContaining('binary file content was not inspected: assets/logo.png'),
      ],
    });
  });

  it('cannot report CLEAN when the selected diff contains only a binary-file marker', () => {
    const intake = projectedLegacyIntake('review staged changes', {
      target_kind: 'working_tree',
      target_mode: 'staged',
      status_short: 'M  image.png\n',
      staged_diff: {
        text: [
          'diff --git a/image.png b/image.png',
          'index 1f2e3d4..5a6b7c8 100644',
          'Binary files a/image.png and b/image.png differ',
          '',
        ].join('\n'),
        truncated: false,
      },
      unstaged_diff: { text: '', truncated: false },
      diff_stat: ' image.png | Bin 12 -> 24 bytes\n',
    });

    expect(intake.evidence_warnings).toContainEqual({
      kind: 'binary_content_not_inspected',
      path: 'image.png',
      message: 'binary file content was not inspected: image.png',
    });
    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      assessment: expect.stringMatching(/^Circuit could inspect only part/),
      confidence_limitations: [
        expect.stringContaining('binary file content was not inspected: image.png'),
      ],
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('cannot report CLEAN when all-mode status names an unstaged change but its diff is empty', () => {
    const intake = legacyIntake('review current working tree changes', {
      target_kind: 'working_tree',
      target_mode: 'all',
      status_short: 'M  staged.ts\n M unstaged.ts\n',
      staged_diff: {
        text: 'diff --git a/staged.ts b/staged.ts\n+const staged = true;\n',
        truncated: false,
      },
      unstaged_diff: { text: '', truncated: false },
      diff_stat: ' staged.ts | 1 +\n unstaged.ts | 1 +\n',
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('cannot report CLEAN when the untracked count and complete file list disagree', () => {
    const intake = legacyIntake('review current working tree changes', {
      target_kind: 'working_tree',
      target_mode: 'all',
      status_short: 'M  staged.ts\n?? missing-new-file.ts\n',
      staged_diff: {
        text: 'diff --git a/staged.ts b/staged.ts\n+const staged = true;\n',
        truncated: false,
      },
      unstaged_diff: { text: '', truncated: false },
      diff_stat: ' staged.ts | 1 +\n',
      untracked_content_policy: 'include-content',
      untracked_file_count: 1,
      untracked_files_truncated: false,
      untracked_files: [],
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it.each([
    {
      name: 'abbreviated commit ref',
      scope: 'review commit aaaaaaa',
      target_ref: 'aaaaaaa',
      target_commit: COMMIT_A,
    },
    {
      name: 'full commit ref',
      scope: `review commit ${COMMIT_A}`,
      target_ref: COMMIT_A,
      target_commit: COMMIT_A,
    },
  ])('accepts a commit target pinned by its $name', ({ scope, target_ref, target_commit }) => {
    const result = projectReviewResult({
      intake: dedicatedTargetIntake(scope, {
        target_kind: 'commit',
        target_ref,
        target_commit,
      }),
      relayResult: cleanRelay(),
    });
    expect(result).toMatchObject({ verdict: 'CLEAN', outcome: 'complete' });
  });

  it.each([
    {
      name: 'missing commit pin',
      target: {},
    },
    {
      name: 'range pin on a commit target',
      target: {
        target_commit: COMMIT_A,
        target_base_commit: COMMIT_B,
      },
    },
    {
      name: 'pull-request pin on a commit target',
      target: {
        target_commit: COMMIT_A,
        target_merge_commit: COMMIT_D,
      },
    },
    {
      name: 'range refs on a commit target',
      target: {
        target_commit: COMMIT_A,
        target_base_ref: 'main',
        target_head_ref: 'feature',
      },
    },
    {
      name: 'commit ref that does not match the pinned object',
      target: {
        target_commit: COMMIT_B,
      },
    },
  ])('rejects commit evidence with $name', ({ target }) => {
    expect(() =>
      projectReviewResult({
        intake: dedicatedTargetIntake('review commit aaaaaaa', {
          target_kind: 'commit',
          target_ref: 'aaaaaaa',
          ...target,
        }),
        relayResult: cleanRelay(),
      }),
    ).toThrow();
  });

  it('rejects a malformed commit pin in dedicated evidence', () => {
    expect(() =>
      dedicatedTargetIntake('review commit aaaaaaa', {
        target_kind: 'commit',
        target_ref: 'aaaaaaa',
        target_commit: 'not-an-object-id',
      }),
    ).toThrow();
  });

  it('rejects a mismatched object ID for an uppercase abbreviated commit ref', () => {
    expect(() =>
      projectReviewResult({
        intake: dedicatedTargetIntake('review commit AAAAAAA', {
          target_kind: 'commit',
          target_ref: 'AAAAAAA',
          target_commit: COMMIT_B,
        }),
        relayResult: cleanRelay(),
      }),
    ).toThrow();
  });

  it.each([
    {
      name: 'named refs',
      scope: 'review main...feature',
      target_ref: 'main...feature',
      target_base_ref: 'main',
      target_head_ref: 'feature',
    },
    {
      name: 'abbreviated object-id refs',
      scope: 'review aaaaaaa...bbbbbbb',
      target_ref: 'aaaaaaa...bbbbbbb',
      target_base_ref: 'aaaaaaa',
      target_head_ref: 'bbbbbbb',
    },
  ])(
    'accepts a range target pinned by its $name',
    ({ scope, target_ref, target_base_ref, target_head_ref }) => {
      const result = projectReviewResult({
        intake: dedicatedTargetIntake(scope, {
          target_kind: 'range',
          target_ref,
          target_base_ref,
          target_head_ref,
          target_base_commit: COMMIT_A,
          target_head_commit: COMMIT_B,
        }),
        relayResult: cleanRelay(),
      });
      expect(result).toMatchObject({ verdict: 'CLEAN', outcome: 'complete' });
    },
  );

  it.each([
    {
      name: 'missing base ref',
      target: {
        target_base_ref: undefined,
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
      },
    },
    {
      name: 'missing head ref',
      target: {
        target_head_ref: undefined,
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
      },
    },
    {
      name: 'missing base commit pin',
      target: {
        target_head_commit: COMMIT_B,
      },
    },
    {
      name: 'missing head commit pin',
      target: {
        target_base_commit: COMMIT_A,
      },
    },
    {
      name: 'commit pin on a range target',
      target: {
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
        target_commit: COMMIT_C,
      },
    },
    {
      name: 'pull-request pin on a range target',
      target: {
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
        target_merge_commit: COMMIT_D,
      },
    },
    {
      name: 'repository pin on a range target',
      target: {
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
        target_repository: 'github.com/openai/codex',
      },
    },
    {
      name: 'base ref that does not match the pinned object',
      target: {
        target_base_commit: COMMIT_C,
        target_head_commit: COMMIT_B,
      },
    },
    {
      name: 'head ref that does not match the pinned object',
      target: {
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_C,
      },
    },
  ])('rejects range evidence with $name', ({ target }) => {
    expect(() =>
      projectReviewResult({
        intake: dedicatedTargetIntake('review aaaaaaa...bbbbbbb', {
          target_kind: 'range',
          target_ref: 'aaaaaaa...bbbbbbb',
          target_base_ref: 'aaaaaaa',
          target_head_ref: 'bbbbbbb',
          ...target,
        }),
        relayResult: cleanRelay(),
      }),
    ).toThrow();
  });

  it('rejects a malformed range pin in dedicated evidence', () => {
    expect(() =>
      dedicatedTargetIntake('review main...feature', {
        target_kind: 'range',
        target_ref: 'main...feature',
        target_base_ref: 'main',
        target_head_ref: 'feature',
        target_base_commit: COMMIT_A,
        target_head_commit: 'not-an-object-id',
      }),
    ).toThrow();
  });

  it('rejects mismatched object IDs for uppercase abbreviated range refs', () => {
    expect(() =>
      projectReviewResult({
        intake: dedicatedTargetIntake('review AAAAAAA...BBBBBBB', {
          target_kind: 'range',
          target_ref: 'AAAAAAA...BBBBBBB',
          target_base_ref: 'AAAAAAA',
          target_head_ref: 'BBBBBBB',
          target_base_commit: COMMIT_C,
          target_head_commit: COMMIT_D,
        }),
        relayResult: cleanRelay(),
      }),
    ).toThrow();
  });

  it('accepts a pull request pinned to its normalized repository and three commits', () => {
    const result = projectReviewResult({
      intake: dedicatedTargetIntake('review https://github.com/openai/codex/pull/42', {
        target_kind: 'pull_request',
        target_ref: 'PR #42',
        target_repository: 'github.com/openai/codex',
        target_merge_commit: COMMIT_D,
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
      }),
      relayResult: cleanRelay(),
    });
    expect(result).toMatchObject({ verdict: 'CLEAN', outcome: 'complete' });
  });

  it.each([
    {
      name: 'missing repository',
      target: {
        target_merge_commit: COMMIT_D,
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
      },
    },
    {
      name: 'missing merge commit pin',
      target: {
        target_repository: 'github.com/openai/codex',
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
      },
    },
    {
      name: 'missing base commit pin',
      target: {
        target_repository: 'github.com/openai/codex',
        target_merge_commit: COMMIT_D,
        target_head_commit: COMMIT_B,
      },
    },
    {
      name: 'missing head commit pin',
      target: {
        target_repository: 'github.com/openai/codex',
        target_merge_commit: COMMIT_D,
        target_base_commit: COMMIT_A,
      },
    },
    {
      name: 'commit pin on a pull-request target',
      target: {
        target_repository: 'github.com/openai/codex',
        target_merge_commit: COMMIT_D,
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
        target_commit: COMMIT_C,
      },
    },
    {
      name: 'range refs on a pull-request target',
      target: {
        target_repository: 'github.com/openai/codex',
        target_merge_commit: COMMIT_D,
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
        target_base_ref: 'main',
        target_head_ref: 'feature',
      },
    },
  ])('rejects pull-request evidence with $name', ({ target }) => {
    expect(() =>
      projectReviewResult({
        intake: dedicatedTargetIntake('review https://github.com/openai/codex/pull/42', {
          target_kind: 'pull_request',
          target_ref: 'PR #42',
          ...target,
        }),
        relayResult: cleanRelay(),
      }),
    ).toThrow();
  });

  it('rejects a non-normalized pull-request repository', () => {
    expect(() =>
      dedicatedTargetIntake('review https://github.com/openai/codex/pull/42', {
        target_kind: 'pull_request',
        target_ref: 'PR #42',
        target_repository: 'github.com/OpenAI/Codex',
        target_merge_commit: COMMIT_D,
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
      }),
    ).toThrow();
  });

  it('rejects a malformed pull-request pin in dedicated evidence', () => {
    expect(() =>
      dedicatedTargetIntake('review https://github.com/openai/codex/pull/42', {
        target_kind: 'pull_request',
        target_ref: 'PR #42',
        target_repository: 'github.com/openai/codex',
        target_merge_commit: 'not-an-object-id',
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
      }),
    ).toThrow();
  });

  it('rejects same-number pull-request evidence from another repository', () => {
    expect(() =>
      projectReviewResult({
        intake: dedicatedTargetIntake('review https://github.com/openai/codex/pull/42', {
          target_kind: 'pull_request',
          target_ref: 'PR #42',
          target_repository: 'github.com/anthropics/claude-code',
          target_merge_commit: COMMIT_D,
          target_base_commit: COMMIT_A,
          target_head_commit: COMMIT_B,
        }),
        relayResult: cleanRelay(),
      }),
    ).toThrow('does not match the requested scope');
  });

  it('rejects legacy pull-request evidence that cannot pin the requested repository and commits', () => {
    expect(() =>
      projectReviewResult({
        intake: legacyIntake('review https://github.com/openai/codex/pull/42', {
          target_kind: 'pull_request',
          target_ref: 'PR #42',
          target_diff: {
            text: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 2;\n',
            truncated: false,
          },
          target_diff_stat: ' src/example.ts | 1 +\n',
        }),
        relayResult: cleanRelay(),
      }),
    ).toThrow('does not match the requested scope');
  });

  it.each([
    {
      name: 'commit',
      scope: 'review commit abc1234',
      evidence: {
        target_kind: 'commit',
        target_ref: 'abc1234',
        target_diff: { text: 'diff for abc1234\n', truncated: false },
        target_diff_stat: ' commit.ts | 1 +\n',
      },
    },
    {
      name: 'range',
      scope: 'review main...feature',
      evidence: {
        target_kind: 'range',
        target_ref: 'main...feature',
        target_base_ref: 'main',
        target_head_ref: 'feature',
        target_diff: { text: 'diff for main...feature\n', truncated: false },
        target_diff_stat: ' feature.ts | 1 +\n',
      },
    },
  ])('rejects legacy $name evidence without immutable pins', ({ scope, evidence }) => {
    expect(() =>
      projectReviewResult({
        intake: legacyIntake(scope, evidence),
        relayResult: cleanRelay(),
      }),
    ).toThrow('does not match the requested scope');
  });

  it.each([
    {
      name: 'commit metadata is missing',
      scope: 'review commit abc1234',
      evidence: {},
    },
    {
      name: 'commit ref differs',
      scope: 'review commit abc1234',
      evidence: {
        target_kind: 'commit',
        target_ref: 'def5678',
        target_diff: { text: 'diff for def5678\n', truncated: false },
        target_diff_stat: ' other.ts | 1 +\n',
      },
    },
    {
      name: 'range refs differ',
      scope: 'review main...feature',
      evidence: {
        target_kind: 'range',
        target_ref: 'main...other',
        target_base_ref: 'main',
        target_head_ref: 'other',
        target_diff: { text: 'diff for main...other\n', truncated: false },
        target_diff_stat: ' other.ts | 1 +\n',
      },
    },
    {
      name: 'range endpoint metadata is missing',
      scope: 'review main...feature',
      evidence: {
        target_kind: 'range',
        target_ref: 'main...feature',
        target_diff: { text: 'diff for main...feature\n', truncated: false },
        target_diff_stat: ' feature.ts | 1 +\n',
      },
    },
    {
      name: 'pull request number differs',
      scope: 'review PR #42',
      evidence: {
        target_kind: 'pull_request',
        target_ref: 'PR #41',
        target_diff: { text: 'diff for PR #41\n', truncated: false },
        target_diff_stat: ' pull-request.ts | 1 +\n',
      },
    },
  ])('rejects legacy target evidence when $name', ({ scope, evidence }) => {
    expect(() =>
      projectReviewResult({
        intake: legacyIntake(scope, evidence),
        relayResult: cleanRelay(),
      }),
    ).toThrow('does not match the requested scope');
  });

  it.each([
    {
      name: 'staged',
      scope: 'review staged changes',
      mode: 'staged',
      otherMode: 'unstaged',
    },
    {
      name: 'unstaged',
      scope: 'review unstaged changes',
      mode: 'unstaged',
      otherMode: 'all',
    },
    {
      name: 'all',
      scope: 'review current working tree changes',
      mode: 'all',
      otherMode: 'staged',
    },
  ] as const)('requires exact $name working-tree target metadata', ({ scope, mode, otherMode }) => {
    const matching = projectReviewResult({
      intake: legacyIntake(scope, {
        target_kind: 'working_tree',
        target_mode: mode,
      }),
      relayResult: cleanRelay(),
    });
    expect(matching).toMatchObject({ verdict: 'CLEAN', outcome: 'complete' });

    for (const evidence of [
      {},
      { target_kind: 'working_tree' },
      { target_kind: 'working_tree', target_mode: otherMode },
    ]) {
      expect(() =>
        projectReviewResult({
          intake: legacyIntake(scope, evidence),
          relayResult: cleanRelay(),
        }),
      ).toThrow('does not match the requested scope');
    }
  });

  it.each([
    {
      name: 'staged',
      scope: 'review staged changes',
      mode: 'staged',
      stagedText: 'diff --git a/staged.ts b/staged.ts\n+staged\n',
      unstagedText: '',
    },
    {
      name: 'unstaged',
      scope: 'review unstaged changes',
      mode: 'unstaged',
      stagedText: '',
      unstagedText: 'diff --git a/unstaged.ts b/unstaged.ts\n+unstaged\n',
    },
    {
      name: 'all',
      scope: 'review current working tree changes',
      mode: 'all',
      stagedText: '',
      unstagedText: 'diff --git a/unstaged.ts b/unstaged.ts\n+unstaged\n',
    },
  ] as const)(
    'reports the selected $name working-tree diff as included',
    ({ scope, mode, stagedText, unstagedText }) => {
      const result = projectReviewResult({
        intake: legacyIntake(scope, {
          target_kind: 'working_tree',
          target_mode: mode,
          staged_diff: { text: stagedText, truncated: false },
          unstaged_diff: { text: unstagedText, truncated: false },
        }),
        relayResult: cleanRelay(),
      });

      expect(result.evidence_summary).toMatchObject({
        kind: 'git-working-tree',
        target_kind: 'working_tree',
        target_mode: mode,
        target_diff_included: true,
      });
    },
  );

  it('refuses to turn persisted unavailable evidence into a clean result', () => {
    const intake = ReviewIntake.parse({
      scope: 'review commit missing',
      evidence: {
        kind: 'unavailable',
        reason: 'The requested commit could not be read.',
      },
      evidence_warnings: [
        {
          kind: 'evidence_unavailable',
          message: 'The requested commit could not be read.',
        },
      ],
    });

    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'Review cannot complete because its source evidence is unavailable',
    );
  });

  it('refuses to report a vague goal-only Review as clean without supplied material', () => {
    const intake = ReviewIntake.parse({
      scope: 'review this rollout plan for operational risks',
      evidence: { kind: 'goal' },
      evidence_warnings: [],
    });

    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      /actual|material|source|target|text/iu,
    );
  });

  it('keeps a Review of actual supplied material usable without Git evidence', () => {
    const intake = ReviewIntake.parse({
      scope: 'review this rollout plan:\nUse one pinned target and stop if it is unavailable.',
      evidence: { kind: 'goal' },
      evidence_warnings: [],
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'CLEAN',
      outcome: 'complete',
      evidence_summary: { kind: 'goal' },
    });
  });

  it('refuses a legacy explicit target even when unrelated working-tree evidence exists', () => {
    const unavailable = 'Target unavailable: deadbeef could not be read from this repository.';
    const intake = ReviewIntake.parse({
      scope: 'review commit deadbeef',
      evidence: {
        kind: 'git-working-tree',
        project_root: '/tmp/project',
        status_short: 'M unrelated.ts\n',
        staged_diff: {
          text: 'diff --git a/unrelated.ts b/unrelated.ts\n+unrelated\n',
          truncated: false,
        },
        unstaged_diff: { text: '', truncated: false },
        diff_stat: ' unrelated.ts | 1 +\n',
        target_kind: 'commit',
        target_ref: 'deadbeef',
        target_diff: { text: unavailable, truncated: false },
        target_diff_stat: unavailable,
        untracked_file_count: 0,
        untracked_files_truncated: false,
        untracked_content_policy: 'metadata-only',
        untracked_files: [],
      },
      evidence_warnings: [{ kind: 'target_unavailable', message: unavailable }],
    });

    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'Review cannot complete because its source evidence is unavailable',
    );
  });

  it('rejects an unrelated legacy committed diff as evidence for a requested commit', () => {
    const intake = legacyIntake('review commit abc1234', {
      target_kind: 'commit',
      target_ref: 'abc1234',
      target_diff: undefined,
      target_diff_stat: undefined,
      committed_diff_ref: 'HEAD~9',
      committed_diff: {
        text: 'diff --git a/unrelated.ts b/unrelated.ts\n+unrelated\n',
        truncated: false,
      },
      committed_diff_stat: ' unrelated.ts | 1 +\n',
    });

    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'expected dedicated pinned commit target evidence',
    );
  });

  it('rejects evidence from the unselected working-tree layer', () => {
    const intake = legacyIntake('review staged changes', {
      target_kind: 'working_tree',
      target_mode: 'staged',
      staged_diff: { text: '', truncated: false },
      unstaged_diff: {
        text: 'diff --git a/unstaged.ts b/unstaged.ts\n+unrelated unstaged work\n',
        truncated: false,
      },
    });

    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'no usable selected evidence',
    );
  });

  it('marks an empty dedicated target as unavailable', () => {
    const evidence = {
      kind: 'git-target',
      project_root: '/tmp/project',
      target_kind: 'range',
      target_ref: 'HEAD..HEAD',
      target_base_ref: 'HEAD',
      target_head_ref: 'HEAD',
      target_base_commit: COMMIT_A,
      target_head_commit: COMMIT_A,
      target_diff: { text: '', truncated: false },
      target_diff_stat: '',
    } as const;

    expect(reviewEvidenceWarnings({ evidence, maxUntrackedFiles: 20 })).toEqual([
      {
        kind: 'target_unavailable',
        message: 'Target unavailable: HEAD..HEAD produced an empty diff.',
      },
    ]);
  });
});
