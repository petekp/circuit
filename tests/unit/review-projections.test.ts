import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  MAX_REVIEW_UNITS,
  projectReviewIntake,
  projectReviewResult,
  reviewEvidenceWarnings,
} from '../../src/flows/review/index.js';
import {
  type ReviewEvidence,
  ReviewIntake,
  ReviewRelayResult,
  type ReviewResolvedTarget,
} from '../../src/flows/review/reports.js';

const COMMIT_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COMMIT_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COMMIT_C = 'cccccccccccccccccccccccccccccccccccccccc';

function cleanRelay() {
  return ReviewRelayResult.parse({
    verdict: 'NO_ISSUES_FOUND',
    findings: [],
    assessment: 'The requested source evidence had no actionable issue.',
    verification: ['Read the relayed diff.'],
    confidence_limitations: [],
  });
}

function workingTreeTarget(mode: 'staged' | 'unstaged' | 'all'): ReviewResolvedTarget {
  return { kind: 'working_tree', mode, explicit: true };
}

function workingTreeEvidence(
  mode: 'staged' | 'unstaged' | 'all',
  overrides: Record<string, unknown> = {},
) {
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
    target_kind: 'working_tree',
    target_mode: mode,
    untracked_file_count: 0,
    untracked_files_truncated: false,
    untracked_content_policy: 'metadata-only',
    untracked_files: [],
    ...overrides,
  } as ReviewEvidence;
}

/** Intake as the compose builder writes it: resolved target plus its evidence. */
function workingTreeIntake(
  scope: string,
  mode: 'staged' | 'unstaged' | 'all',
  evidenceOverrides: Record<string, unknown> = {},
  options: { readonly assumedTarget?: boolean } = {},
) {
  return projectReviewIntake({
    scope,
    target: workingTreeTarget(mode),
    // An assumed target is definitionally one nobody named. Everything else
    // here stands in for a target the caller stated, which is what keeps these
    // cases about evidence warnings rather than about provenance.
    targetProvenance: options.assumedTarget === true ? ('inferred' as const) : ('named' as const),
    evidence: workingTreeEvidence(mode, evidenceOverrides),
    maxUntrackedFiles: 20,
    ...(options.assumedTarget === true ? { assumedTarget: true } : {}),
  });
}

function targetIntake(
  scope: string,
  target: ReviewResolvedTarget,
  evidence: Record<string, unknown>,
) {
  return projectReviewIntake({
    scope,
    target,
    targetProvenance: 'named',
    evidence: {
      kind: 'git-target',
      project_root: '/tmp/project',
      target_diff: {
        text: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 2;\n',
        truncated: false,
      },
      target_diff_stat: ' src/example.ts | 1 +\n',
      ...evidence,
    } as ReviewEvidence,
    maxUntrackedFiles: 20,
  });
}

function commitIntake(ref: string, evidence: Record<string, unknown> = {}) {
  return targetIntake(
    `review commit ${ref}`,
    { kind: 'commit', ref },
    {
      target_kind: 'commit',
      target_ref: `commit ${ref}`,
      target_commit: COMMIT_A,
      ...evidence,
    },
  );
}

describe('Review evidence projections', () => {
  it('summarizes pinned target evidence without working-tree fields', () => {
    const intake = commitIntake('HEAD^', {
      target_diff: {
        text: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 2;\n',
        truncated: true,
      },
    });

    expect(intake.evidence_warnings).toEqual([
      {
        kind: 'diff_truncated',
        message: 'commit HEAD^ diff was truncated before relay',
      },
    ]);
    expect(projectReviewResult({ intake, relayResult: cleanRelay() }).evidence_summary).toEqual({
      kind: 'git-target',
      target_kind: 'commit',
      target_ref: 'commit HEAD^',
      target_diff_included: true,
      target_diff_truncated: true,
    });
  });

  it('accepts a commit target whose evidence pins the same ref', () => {
    expect(
      projectReviewResult({ intake: commitIntake('HEAD^'), relayResult: cleanRelay() }),
    ).toMatchObject({
      verdict: 'CLEAN',
      outcome: 'complete',
    });
  });

  it('accepts a range target whose evidence pins both endpoints', () => {
    const intake = targetIntake(
      'review main...feature',
      { kind: 'range', base: 'main', head: 'feature', dots: '...' },
      {
        target_kind: 'range',
        target_ref: 'range main...feature',
        target_base_ref: 'main',
        target_head_ref: 'feature',
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
      },
    );

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'CLEAN',
      outcome: 'complete',
    });
  });

  it.each([
    {
      name: 'the commit ref differs from the resolved target',
      target: { kind: 'commit', ref: 'HEAD^' } as const,
      evidence: {
        target_kind: 'commit',
        target_ref: 'commit HEAD~2',
        target_commit: COMMIT_A,
      },
    },
    {
      name: 'a range endpoint differs from the resolved target',
      target: { kind: 'range', base: 'main', head: 'feature', dots: '...' } as const,
      evidence: {
        target_kind: 'range',
        target_ref: 'range main...other',
        target_base_ref: 'main',
        target_head_ref: 'other',
        target_base_commit: COMMIT_A,
        target_head_commit: COMMIT_B,
      },
    },
    {
      name: 'a working-tree request received commit evidence',
      target: workingTreeTarget('staged'),
      evidence: {
        target_kind: 'commit',
        target_ref: 'commit HEAD',
        target_commit: COMMIT_A,
      },
    },
    {
      name: 'a goal-only request received commit evidence',
      target: { kind: 'goal' } as const,
      evidence: {
        target_kind: 'commit',
        target_ref: 'commit HEAD',
        target_commit: COMMIT_A,
      },
    },
  ])('rejects persisted evidence when $name', ({ target, evidence }) => {
    const intake = targetIntake('review something', target, evidence);
    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'does not match the requested scope',
    );
  });

  it('rejects working-tree evidence collected for the wrong layer', () => {
    const intake = ReviewIntake.parse({
      ...workingTreeIntake('review staged changes', 'staged'),
      target: workingTreeTarget('unstaged'),
    });
    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'does not match the requested scope',
    );
  });

  it('rejects working-tree evidence for a goal-only Review', () => {
    const intake = ReviewIntake.parse({
      ...workingTreeIntake('review this rollout plan for operational risks', 'all'),
      target: { kind: 'goal' },
    });
    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'does not match the requested scope',
    );
  });

  it.each([
    {
      name: 'pinned commit diff',
      intake: () =>
        commitIntake('aaaaaaa', {
          target_diff: {
            text: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 2;\n',
            truncated: true,
          },
        }),
    },
    {
      name: 'selected staged diff',
      intake: () =>
        workingTreeIntake('review staged changes', 'staged', {
          staged_diff: {
            text: 'diff --git a/staged.ts b/staged.ts\n+staged\n',
            truncated: true,
          },
        }),
    },
    {
      name: 'selected unstaged diff',
      intake: () =>
        workingTreeIntake('review unstaged changes', 'unstaged', {
          unstaged_diff: {
            text: 'diff --git a/unstaged.ts b/unstaged.ts\n+unstaged\n',
            truncated: true,
          },
        }),
    },
    {
      name: 'requested untracked file content',
      intake: () =>
        workingTreeIntake('review the working tree', 'all', {
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
      name: 'requested untracked file list',
      intake: () =>
        workingTreeIntake('review the working tree', 'all', {
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
  ])('cannot report CLEAN when the selected $name is truncated', ({ intake }) => {
    expect(projectReviewResult({ intake: intake(), relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
    });
  });

  it('cannot report CLEAN from a truncated pinned target when its persisted warning is missing', () => {
    const intake = ReviewIntake.parse({
      ...commitIntake('aaaaaaa', {
        target_diff: {
          text: 'diff --git a/src/example.ts b/src/example.ts\n+const visiblePrefix = true;\n',
          truncated: true,
        },
      }),
      evidence_warnings: [],
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
    });
  });

  it('cannot report CLEAN from a truncated selected diff when its persisted warning is missing', () => {
    const intake = ReviewIntake.parse({
      ...workingTreeIntake('review staged changes', 'staged', {
        staged_diff: {
          text: 'diff --git a/staged.ts b/staged.ts\n+const visiblePrefix = true;\n',
          truncated: true,
        },
      }),
      evidence_warnings: [],
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
    });
  });

  // D2: untracked files relayed as metadata only are the default posture, not a
  // coverage gap. They are reported as a limitation and the verdict stands.
  it('still reports CLEAN when untracked files were relayed as metadata only', () => {
    const intake = workingTreeIntake('review the working tree', 'all', {
      status_short: 'M  staged.ts\n?? hidden.ts\n',
      unstaged_diff: { text: '', truncated: false },
      untracked_content_policy: 'metadata-only',
      untracked_file_count: 1,
      untracked_files: [{ path: 'hidden.ts', byte_length: 42 }],
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'CLEAN',
      outcome: 'complete',
      confidence_limitations: [
        expect.stringContaining('untracked file contents were not included'),
      ],
    });
  });

  it('cannot report CLEAN when a requested untracked file was skipped', () => {
    const intake = workingTreeIntake('review the working tree', 'all', {
      status_short: 'M  staged.ts\n?? binary.dat\n',
      unstaged_diff: { text: '', truncated: false },
      untracked_content_policy: 'include-content',
      untracked_file_count: 1,
      untracked_files: [
        {
          path: 'binary.dat',
          byte_length: 3,
          skipped_reason: 'binary file skipped',
        },
      ],
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('cannot report CLEAN when nested submodule working-tree content was not inspected', () => {
    const intake = workingTreeIntake('review the working tree', 'all', {
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
    const intake = commitIntake('aaaaaaa', {
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
    const intake = commitIntake('aaaaaaa', {
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
    const intake = workingTreeIntake('review staged changes', 'staged', {
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
    const intake = workingTreeIntake('review the working tree', 'all', {
      status_short: 'M  staged.ts\n M unstaged.ts\n',
      unstaged_diff: { text: '', truncated: false },
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('cannot report CLEAN when a requested untracked count and file list disagree', () => {
    const intake = workingTreeIntake('review the working tree', 'all', {
      status_short: 'M  staged.ts\n?? missing-new-file.ts\n',
      unstaged_diff: { text: '', truncated: false },
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
      mode: 'staged',
      stagedText: 'diff --git a/staged.ts b/staged.ts\n+staged\n',
      unstagedText: '',
    },
    {
      mode: 'unstaged',
      stagedText: '',
      unstagedText: 'diff --git a/unstaged.ts b/unstaged.ts\n+unstaged\n',
    },
    {
      mode: 'all',
      stagedText: '',
      unstagedText: 'diff --git a/unstaged.ts b/unstaged.ts\n+unstaged\n',
    },
  ] as const)(
    'reports the selected $mode working-tree diff as included',
    ({ mode, stagedText, unstagedText }) => {
      const result = projectReviewResult({
        intake: workingTreeIntake(`review ${mode} changes`, mode, {
          status_short: stagedText.length > 0 ? 'M  staged.ts\n' : ' M unstaged.ts\n',
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

  // D1: an unrecognised goal reviews the working tree and says so, rather than
  // refusing. The assumption is a named limitation, not a verdict.
  it('names the assumed working-tree target without holding it against the verdict', () => {
    const intake = workingTreeIntake('review this thing', 'all', {}, { assumedTarget: true });

    expect(intake.evidence_warnings[0]).toEqual({
      kind: 'target_assumed',
      message: expect.stringContaining('Assumed target: the current working tree.'),
    });
    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'CLEAN',
      outcome: 'complete',
      confidence_limitations: [
        expect.stringContaining('Assumed target: the current working tree.'),
      ],
    });
  });

  // Every intake carries the units its reviewers were split into. These three
  // literals are hand-built rather than produced by the intake writer, so they
  // supply the single-unit shape the writer would have given them.
  const SINGLE_UNIT = {
    units: [
      {
        unit_id: 'unit-1',
        label: 'the whole target',
        paths: [],
        goal: 'Review this target.',
        contents: '{}',
      },
    ],
    unit_coverage: { matched_file_count: 1, reviewed_file_count: 1, truncated: false },
  } as const;

  it('refuses to turn persisted unavailable evidence into a clean result', () => {
    const intake = ReviewIntake.parse({
      scope: 'review commit missing',
      target: { kind: 'commit', ref: 'missing' },
      target_provenance: 'named',
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
      ...SINGLE_UNIT,
    });

    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'Review cannot complete because its source evidence is unavailable',
    );
  });

  it('keeps a Review of actual supplied material usable without Git evidence', () => {
    const intake = ReviewIntake.parse({
      scope: 'review this rollout plan:\nUse one pinned target and stop if it is unavailable.',
      target: { kind: 'goal' },
      target_provenance: 'named',
      evidence: { kind: 'goal' },
      evidence_warnings: [],
      ...SINGLE_UNIT,
    });

    expect(projectReviewResult({ intake, relayResult: cleanRelay() })).toMatchObject({
      verdict: 'CLEAN',
      outcome: 'complete',
      evidence_summary: { kind: 'goal' },
    });
  });

  it('refuses an unavailable pinned target instead of falling back to the working tree', () => {
    const unavailable = 'Target unavailable: deadbeef could not be read from this repository.';
    const intake = ReviewIntake.parse({
      scope: 'review commit deadbeef',
      target: { kind: 'commit', ref: 'deadbeef' },
      target_provenance: 'named',
      evidence: {
        kind: 'git-target',
        project_root: '/tmp/project',
        target_kind: 'commit',
        target_ref: 'commit deadbeef',
        target_commit: COMMIT_C,
        target_diff: { text: unavailable, truncated: false },
        target_diff_stat: unavailable,
      },
      evidence_warnings: [{ kind: 'target_unavailable', message: unavailable }],
      ...SINGLE_UNIT,
    });

    expect(() => projectReviewResult({ intake, relayResult: cleanRelay() })).toThrow(
      'Review cannot complete because its source evidence is unavailable',
    );
  });

  it('rejects evidence from the unselected working-tree layer', () => {
    const intake = workingTreeIntake('review staged changes', 'staged', {
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

  it('marks an empty pinned target as unavailable', () => {
    const evidence = {
      kind: 'git-target',
      project_root: '/tmp/project',
      target_kind: 'range',
      target_ref: 'range HEAD..HEAD',
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
        message: 'Target unavailable: range HEAD..HEAD produced an empty diff.',
      },
    ]);
  });

  // `include: ['.']` is how a whole-repository snapshot writes "everywhere".
  // It is a path in the data and nothing in the prose: a scope warning that
  // reads it out tells the operator the review was narrowed when it was not,
  // and the bare "." reads as a typo mid-sentence.
  describe('a scope that narrows nothing', () => {
    function snapshotIntake(paths: { include: string[]; exclude: string[] }, truncated = false) {
      return projectReviewIntake({
        scope: 'review this codebase as it stands',
        target: { kind: 'snapshot', paths },
        targetProvenance: 'named',
        evidence: {
          kind: 'git-snapshot',
          project_root: '/tmp/project',
          target_kind: 'snapshot',
          files: [
            {
              path: 'src/retry/loop.ts',
              byte_length: 24,
              content: { text: 'export const loop = 1;\n', truncated: false },
            },
          ],
          matched_file_count: truncated ? 2566 : 1,
          files_truncated: truncated,
          path_scope: paths,
        } as ReviewEvidence,
        maxUntrackedFiles: 20,
      });
    }

    it('says nothing about scope when the scope is the whole repository', () => {
      const kinds = snapshotIntake({ include: ['.'], exclude: [] }).evidence_warnings.map(
        (warning) => warning.kind,
      );
      expect(kinds).not.toContain('target_scoped');
    });

    it('names the repository rather than a bare dot when it does have to say', () => {
      const truncation = snapshotIntake(
        { include: ['.'], exclude: [] },
        true,
      ).evidence_warnings.find((warning) => warning.kind === 'snapshot_truncated');
      expect(truncation?.message).toContain('the repository matched 2566 files');
      expect(truncation?.message).not.toContain('. matched');
    });

    it('still reports a scope that really does narrow the read', () => {
      const scoped = snapshotIntake({ include: ['src/retry'], exclude: [] }).evidence_warnings.find(
        (warning) => warning.kind === 'target_scoped',
      );
      expect(scoped?.message).toContain('src/retry');
    });

    it('treats an exclusion as a narrowing even when everything else is in scope', () => {
      const scoped = snapshotIntake({
        include: ['.'],
        exclude: ['docs'],
      }).evidence_warnings.find((warning) => warning.kind === 'target_scoped');
      expect(scoped?.message).toContain('the repository excluding docs');
    });
  });

  // A citation is the one part of a finding an operator can check. When it
  // names a file Circuit never put in front of the reviewer, nothing in the
  // report distinguished it from a real one. Circuit says so rather than
  // rejecting the review: throwing the whole answer away over one bad
  // reference loses the findings that were good.
  describe('citations Circuit cannot back', () => {
    function findingRelay(fileRefs: readonly string[]) {
      return ReviewRelayResult.parse({
        verdict: 'ISSUES_FOUND',
        findings: [
          {
            severity: 'medium',
            id: 'unbounded-retry',
            text: 'The retry helper loops with no attempt cap.',
            file_refs: [...fileRefs],
          },
        ],
        assessment: 'One medium issue in the relayed diff.',
        verification: ['Read the relayed diff.'],
        confidence_limitations: [],
      });
    }

    it('names a finding that cites a file the run never relayed', () => {
      const result = projectReviewResult({
        intake: workingTreeIntake('review the working tree', 'all'),
        relayResult: findingRelay(['src/auth/session.ts:88']),
      });

      expect(
        result.confidence_limitations.some((limit) => limit.includes('src/auth/session.ts')),
      ).toBe(true);
      // The finding survives. Only its backing is in question.
      expect(result.findings).toHaveLength(1);
      expect(result.verdict).toBe('ISSUES_FOUND');
    });

    it('says nothing about a citation that names a relayed file', () => {
      const result = projectReviewResult({
        intake: workingTreeIntake('review the working tree', 'all'),
        relayResult: findingRelay(['staged.ts:3']),
      });

      expect(result.confidence_limitations).toEqual([]);
    });

    it('says nothing when the relayed diff was truncated', () => {
      // Paths past the cut are missing from the relayed set, so a real
      // citation would look invented. No opinion beats a false accusation.
      const result = projectReviewResult({
        intake: workingTreeIntake('review the working tree', 'all', {
          staged_diff: { text: 'diff --git a/staged.ts b/staged.ts\n+staged\n', truncated: true },
        }),
        relayResult: findingRelay(['src/auth/session.ts:88']),
      });

      expect(
        result.confidence_limitations.some((limit) => limit.includes('src/auth/session.ts')),
      ).toBe(false);
    });

    it('says nothing when the goal supplied the material itself', () => {
      const result = projectReviewResult({
        intake: projectReviewIntake({
          scope: 'review this patch',
          target: { kind: 'goal' },
          targetProvenance: 'named',
          evidence: { kind: 'goal' } as ReviewEvidence,
          maxUntrackedFiles: 20,
        }),
        relayResult: findingRelay(['src/auth/session.ts:88']),
      });

      expect(result.confidence_limitations).toEqual([]);
    });

    it('names a snapshot citation outside the files it read', () => {
      const result = projectReviewResult({
        intake: projectReviewIntake({
          scope: 'review src/retry as it stands',
          target: { kind: 'snapshot', paths: { include: ['src/retry'], exclude: [] } },
          targetProvenance: 'named',
          evidence: {
            kind: 'git-snapshot',
            project_root: '/tmp/project',
            target_kind: 'snapshot',
            files: [
              {
                path: 'src/retry/loop.ts',
                byte_length: 24,
                content: { text: 'export const loop = 1;\n', truncated: false },
              },
            ],
            matched_file_count: 1,
            files_truncated: false,
            path_scope: { include: ['src/retry'], exclude: [] },
          } as ReviewEvidence,
          maxUntrackedFiles: 20,
        }),
        relayResult: findingRelay(['src/retry/loop.ts:4', 'src/other/thing.ts:9']),
      });

      const named = result.confidence_limitations.join(' ');
      expect(named).toContain('src/other/thing.ts');
      expect(named).not.toContain('src/retry/loop.ts');
    });
  });

  // How many units the intake may emit. The audit step fans out one reviewer
  // per unit and the engine throws when a dynamic fan-out expands past
  // max_branches, so a packer free to emit more units than the flow declares
  // does not degrade — it kills the run after the intake already succeeded, on
  // exactly the "review this codebase" request the split exists to serve.
  describe('units the audit step can actually run', () => {
    // Many small directories, which is what an ordinary tree looks like and
    // what the packer handles worst: units flush at directory boundaries, so
    // the count is set by how the tree is shaped, not by how much text it holds.
    function wideTree(directories: number, filesPerDirectory: number): ReviewEvidence {
      const files = [];
      for (let d = 0; d < directories; d += 1) {
        for (let f = 0; f < filesPerDirectory; f += 1) {
          files.push({
            path: `src/pkg-${d}/mod-${f}.ts`,
            byte_length: 20_000,
            content: { text: 'x'.repeat(20_000), truncated: false },
          });
        }
      }
      return {
        kind: 'git-snapshot',
        project_root: '/tmp/project',
        target_kind: 'snapshot',
        files,
        matched_file_count: files.length,
        files_truncated: false,
        path_scope: { include: ['src'], exclude: [] },
      } as ReviewEvidence;
    }

    function intakeFor(evidence: ReviewEvidence): ReviewIntake {
      return projectReviewIntake({
        scope: 'review this codebase',
        target: { kind: 'snapshot', paths: { include: ['src'], exclude: [] } },
        targetProvenance: 'named',
        evidence,
        maxUntrackedFiles: 20,
      });
    }

    it('never emits more units than the audit fan-out will run', () => {
      // 40 directories of 2 files each packs to one unit per directory or
      // worse, which is well past the reviewer count.
      const intake = intakeFor(wideTree(40, 2));
      expect(intake.units.length).toBeLessThanOrEqual(MAX_REVIEW_UNITS);
    });

    it('reports the files it dropped rather than claiming it covered them', () => {
      const evidence = wideTree(40, 2);
      const intake = intakeFor(evidence);
      const carried = new Set(intake.units.flatMap((unit) => unit.paths));

      // Coverage counts what the units actually carry, so a verdict built on
      // them cannot read as covering the whole target.
      expect(intake.unit_coverage.matched_file_count).toBe(80);
      expect(intake.unit_coverage.reviewed_file_count).toBe(carried.size);
      expect(carried.size).toBeLessThan(80);
      expect(intake.unit_coverage.truncated).toBe(true);
    });

    it('leaves a tree that fits alone', () => {
      const intake = intakeFor(wideTree(3, 2));
      expect(intake.units.length).toBeLessThanOrEqual(MAX_REVIEW_UNITS);
      expect(intake.unit_coverage.reviewed_file_count).toBe(6);
      expect(intake.unit_coverage.truncated).toBe(false);
    });

    // A reviewer that is handed a warning about a file it was never given has
    // no way to act on it, and hedges its whole verdict over ground it does not
    // hold. Per-file warnings belong to the unit that carries the file; only
    // warnings about the target as a whole belong to every unit.
    it('gives each unit only the warnings about files it actually holds', () => {
      const evidence = wideTree(6, 2);
      const files = [...(evidence as { files: { path: string }[] }).files];
      // Two files spoiled in different directories, so the packer puts them in
      // different units.
      const spoiled = [files[0]?.path, files[10]?.path].filter(
        (path): path is string => path !== undefined,
      );
      expect(spoiled).toHaveLength(2);
      const spoiledEvidence = {
        ...evidence,
        files: (evidence as unknown as { files: Record<string, unknown>[] }).files.map((file) =>
          spoiled.includes(file.path as string)
            ? { ...file, content: { text: 'x'.repeat(20_000), truncated: true } }
            : file,
        ),
      } as ReviewEvidence;

      const intake = intakeFor(spoiledEvidence);
      // Every spoiled file is still named somewhere: scoping must not silently
      // drop a warning.
      const allUnitWarnings = intake.units.flatMap((unit) => {
        const body = JSON.parse(unit.contents) as {
          evidence_warnings?: ReadonlyArray<{ path?: string }>;
        };
        return body.evidence_warnings ?? [];
      });
      for (const path of spoiled) {
        expect(allUnitWarnings.filter((warning) => warning.path === path)).toHaveLength(1);
      }

      for (const unit of intake.units) {
        const body = JSON.parse(unit.contents) as {
          evidence_warnings?: ReadonlyArray<{ path?: string }>;
        };
        for (const warning of body.evidence_warnings ?? []) {
          if (warning.path === undefined) continue;
          expect(unit.paths).toContain(warning.path);
        }
      }
    });

    // The whole-target warning list is what the merge step and the operator
    // report read, so scoping the per-unit copies must not thin it.
    it('keeps every warning on the intake itself', () => {
      const evidence = wideTree(6, 2);
      const files = (evidence as unknown as { files: Record<string, unknown>[] }).files;
      const spoiledEvidence = {
        ...evidence,
        files: files.map((file, index) =>
          index === 0 ? { ...file, content: { text: 'x'.repeat(20_000), truncated: true } } : file,
        ),
      } as ReviewEvidence;

      const intake = intakeFor(spoiledEvidence);
      expect(
        intake.evidence_warnings.filter((warning) => warning.kind === 'diff_truncated'),
      ).toHaveLength(1);
    });

    // Reviewers write prose for operators. Anything in their prompt is
    // something they can echo, and one of them echoed the raw enum tag
    // `diff_truncated` into a finding. The prompt gets the message, not the
    // machine vocabulary.
    it('does not put internal warning tags in a reviewer prompt', () => {
      const evidence = wideTree(3, 2);
      const files = (evidence as unknown as { files: Record<string, unknown>[] }).files;
      const spoiledEvidence = {
        ...evidence,
        files: files.map((file, index) =>
          index === 0 ? { ...file, content: { text: 'x'.repeat(20_000), truncated: true } } : file,
        ),
      } as ReviewEvidence;

      const intake = intakeFor(spoiledEvidence);
      const carrying = intake.units.filter((unit) => unit.contents.includes('truncated before'));
      expect(carrying.length).toBeGreaterThan(0);
      for (const unit of intake.units) {
        expect(unit.contents).not.toContain('diff_truncated');
        expect(unit.contents).not.toContain('"kind": "snapshot_file_skipped"');
      }
      // The message itself still reaches the reviewer that holds the file.
      expect(carrying[0]?.contents).toContain('file content was truncated before relay');
    });

    // The cap is only correct while it equals what the schematic declares, and
    // the two live in different files in different languages.
    it('matches the max_branches the audit step declares', () => {
      const schematic = JSON.parse(
        readFileSync(new URL('../../src/flows/review/schematic.json', import.meta.url), 'utf8'),
      ) as { items: ReadonlyArray<{ fanout?: { branches?: { max_branches?: number } } }> };
      const declared = schematic.items
        .map((item) => item.fanout?.branches?.max_branches)
        .filter((value): value is number => value !== undefined);

      expect(declared).not.toHaveLength(0);
      for (const maxBranches of declared) expect(maxBranches).toBe(MAX_REVIEW_UNITS);
    });
  });
});
