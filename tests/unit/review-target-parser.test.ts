import { describe, expect, it } from 'vitest';

import { parseReviewTarget } from '../../src/flows/review/index.js';

describe('Review target parsing', () => {
  it.each([
    'review this rollout plan for operational risks',
    'review this plan for how to commit changes safely',
    'review docs explaining HEAD semantics',
    'review this plan...especially the rollout risks',
    'review the plan in latest commit',
    'review only src/foo.ts in latest commit',
  ])('rejects a text-only Review when the actual material was not supplied in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/actual|complete|material|source|target|text/iu),
    });
  });

  it('does not mistake the verb phrase "this changes" for a working-tree target', () => {
    const goal = 'review how this changes for users';
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/actual|complete|material|source|target|text/iu),
    });
  });

  it.each([
    'review this plan:',
    'review the following report: ""',
    'review this report: "unfinished',
    'review this code:\n```ts\nconst value = 1;',
    "review this quotation: '",
  ])('fails closed when the supplied-material boundary is empty or malformed in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/actual|complete|empty|malformed|material|text/iu),
    });
  });

  it.each(['review my changes', 'review this diff'])(
    'treats common working-tree wording as an explicit target for %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'working_tree', mode: 'all', explicit: true },
      });
    },
  );

  it.each(['review local changes', 'local changes'])(
    'treats local changes as the full working tree for %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'working_tree', mode: 'all', explicit: true },
      });
    },
  );

  it.each(['review these local changes', 'review my local changes', 'review our local changes'])(
    'accepts ordinary determiners before local changes for %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'working_tree', mode: 'all', explicit: true },
      });
    },
  );

  it.each([
    'review latest committed changes',
    'review the changes in this commit',
    'latest commit',
    'latest commit review',
  ])('treats clear latest-commit aliases as HEAD for %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: { kind: 'commit', ref: 'HEAD' },
    });
  });

  it.each([
    'review what I just committed',
    'review the commit I just made',
    'review the most recent commit',
    'review what changed in the last commit',
    'what I just committed',
    'commit I just made',
    'most recent commit',
    'what changed in the last commit',
  ])('maps an unambiguous conversational commit alias to HEAD for %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: { kind: 'commit', ref: 'HEAD' },
    });
  });

  it.each([
    'review what’s staged',
    "review what's staged",
    'what’s staged',
    "what's staged",
    'review what I staged',
  ])('maps an unambiguous staged alias to the index for %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode: 'staged', explicit: true },
    });
  });

  it('maps all uncommitted files to the complete working tree', () => {
    for (const goal of [
      'review all uncommitted files',
      'all uncommitted files',
      'review everything I have not committed',
    ]) {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'working_tree', mode: 'all', explicit: true },
      });
    }
  });

  it.each([
    { goal: 'PR #42', target: { kind: 'pull_request', number: 42 } },
    { goal: 'HEAD', target: { kind: 'commit', ref: 'HEAD' } },
    { goal: 'HEAD~1', target: { kind: 'commit', ref: 'HEAD~1' } },
    { goal: 'commit abc123', target: { kind: 'commit', ref: 'abc123' } },
    {
      goal: 'main...HEAD',
      target: { kind: 'range', base: 'main', head: 'HEAD', dots: '...' },
    },
    {
      goal: 'staged changes',
      target: { kind: 'working_tree', mode: 'staged', explicit: true },
    },
    {
      goal: 'unstaged changes',
      target: { kind: 'working_tree', mode: 'unstaged', explicit: true },
    },
  ])('accepts an unambiguous bare target for $goal', ({ goal, target }) => {
    expect(parseReviewTarget(goal)).toEqual({ ok: true, target });
  });

  it.each(['review the working tree', 'review uncommitted work', 'review uncommitted code'])(
    'recognizes common working-tree shorthand for %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'working_tree', mode: 'all', explicit: true },
      });
    },
  );

  it.each([
    {
      goal: 'review the changes from commit abc1234',
      target: { kind: 'commit', ref: 'abc1234' },
    },
    {
      goal: 'review these changes in PR #123',
      target: { kind: 'pull_request', number: 123 },
    },
    {
      goal: 'review this diff from https://github.com/acme/widget/pull/123',
      target: {
        kind: 'pull_request',
        number: 123,
        repository: { host: 'github.com', owner: 'acme', name: 'widget' },
      },
    },
    {
      goal: 'review the changes in main...feature',
      target: { kind: 'range', base: 'main', head: 'feature', dots: '...' },
    },
  ])(
    'treats generic change wording as a description of the named target for $goal',
    ({ goal, target }) => {
      expect(parseReviewTarget(goal)).toEqual({ ok: true, target });
    },
  );

  it.each([
    'review staged and unstaged changes',
    'review unstaged & staged changes',
    'review both staged + unstaged changes',
    'review staged changes and unstaged changes',
    'review staged changes plus unstaged diffs',
  ])('keeps both working-tree layers for %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode: 'all', explicit: true },
    });
  });

  it('does not mistake not-staged changes for a staged-and-unstaged request', () => {
    expect(parseReviewTarget('review not staged changes')).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode: 'unstaged', explicit: true },
    });
  });

  it.each([
    {
      goal: 'review staged changes, excluding unstaged changes',
      mode: 'staged',
    },
    {
      goal: 'review staged changes without unstaged changes',
      mode: 'staged',
    },
    {
      goal: 'review unstaged changes, excluding staged changes',
      mode: 'unstaged',
    },
    {
      goal: 'review unstaged changes without staged changes',
      mode: 'unstaged',
    },
  ])('honors an explicitly excluded working-tree layer for $goal', ({ goal, mode }) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode, explicit: true },
    });
  });

  it.each([
    {
      goal: 'review staged but not unstaged changes',
      mode: 'staged',
    },
    {
      goal: 'review what is staged',
      mode: 'staged',
    },
    {
      goal: 'review the index',
      mode: 'staged',
    },
    {
      goal: 'review only unstaged',
      mode: 'unstaged',
    },
  ])('recognizes clear staged and unstaged shorthand for $goal', ({ goal, mode }) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode, explicit: true },
    });
  });

  it.each([
    'review current changes except untracked files',
    'review current changes excluding untracked files',
    'review working tree but not untracked files',
    'review only tracked files',
    'review tracked changes only',
  ])('fails closed when untracked evidence is explicitly excluded in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/untracked|tracked/iu),
    });
  });

  it.each([
    'review current changes except docs/',
    'review latest commit but skip package-lock.json',
    'review PR #42 without docs changes',
    'review latest commit except src/excluded-secret.ts',
  ])('fails closed when a file or path is explicitly excluded in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/exclusion|exclude|path|subset/iu),
    });
  });

  it.each([
    'review latest commit ignoring docs',
    'review latest commit ignoring src/excluded-secret.ts',
    'review latest commit omitting package-lock.json',
    'review latest commit but not src/excluded-secret.ts',
    'review latest commit without tests',
    'review changes between main and feature, excluding docs',
    'review latest commit excluding .github',
  ])('fails closed for conversational file or path exclusions in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/exclusion|exclude|path|subset/iu),
    });
  });

  it.each([
    'review latest commit except the lockfile',
    'review latest commit, leaving out migrations',
    'review latest commit but do not review package-lock.json',
    'review latest commit but don’t review README',
    'review latest commit save for docs',
    'review all changes other than tests',
  ])('fails closed for target-clause exclusions before negation cleanup in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/complete|exclusion|path|target/iu),
    });
  });

  it.each([
    'review latest commit, skipping generating docs',
    'review latest commit but skip writing documentation',
  ])('does not mistake an operating constraint for a path exclusion in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: { kind: 'commit', ref: 'HEAD' },
    });
  });

  it('keeps a path mentioned as review guidance inside the selected commit', () => {
    expect(parseReviewTarget('review latest commit focusing on src/foo.ts')).toEqual({
      ok: true,
      target: { kind: 'commit', ref: 'HEAD' },
    });
  });

  it.each([
    {
      goal: 'review main...HEAD with emphasis on packages/api',
      target: { kind: 'range', base: 'main', head: 'HEAD', dots: '...' },
    },
    {
      goal: 'review PR #42, especially src/foo.ts',
      target: { kind: 'pull_request', number: 42 },
    },
  ])('keeps a complete target when a path is only review guidance in $goal', ({ goal, target }) => {
    expect(parseReviewTarget(goal)).toEqual({ ok: true, target });
  });

  it.each([
    'review latest commit only in src/foo.ts',
    'review latest commit, but only src/foo.ts',
    'review latest commit for src/foo.ts',
    'review latest commit in src/foo.ts',
    'review latest commit limited to src/foo.ts',
    'review latest commit restricted to the file src/foo.ts',
    'review latest commit only in src/',
    'review PR #42 restricted to docs/',
    'review staged changes but only docs/',
    'review latest commit only in src',
    'review PR #42 restricted to the docs directory',
    'review only src/foo.ts in latest commit',
    'review only src/ in PR #42',
    'review the src directory in latest commit',
    'review HEAD only in src/',
    'review commit abc123 restricted to directory src',
    'review main...HEAD only under packages/api',
    'review changes from main to HEAD scoped to package.json',
    'review PR #42 in docs/',
    'review staged changes for tests/foo.test.ts',
    'a review of the latest commit only in src/foo.ts',
    'review src/foo.ts in latest commit',
    'review src/ in HEAD',
    'review the file package.json from commit abc123',
    'review docs/ in PR #42',
    'review packages/api in main...HEAD',
    'review tests in staged changes',
    'review directory src in working tree changes',
    'review src/foo.ts from main to HEAD',
    'review src/foo.ts between main and HEAD',
    'review src/foo.ts in changes between main and HEAD',
    'a review of src/foo.ts in the latest commit',
    'review PR #42, frontend only',
  ])('rejects a path subset of an otherwise complete target in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/complete|path|subset|target/iu),
    });
  });

  it.each([
    'review docs explaining how to skip package-lock.json',
    'review the implementation of excluding files from src/',
    'skip package-lock.json handling',
    'excluding files from src/',
  ])('rejects file-exclusion subject matter when no actual material is supplied in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/actual|complete|material|source|target|text/iu),
    });
  });

  it.each([
    'review support for excluding untracked files',
    'review untracked-file handling in the intake writer',
  ])('rejects untracked-file subject matter when no actual material is supplied in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/actual|complete|material|source|target|text/iu),
    });
  });

  it.each([
    'review src/foo.ts',
    'review package.json',
    'review the code in src/foo.ts',
    'review README.md',
    'review docs/release/plan.md',
    'review the plan in docs/release/plan.md',
    'review /tmp/patch.diff',
    'review this file: src/foo.ts',
  ])('rejects a path-only request that contains no reviewable text in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/complete working tree|commit|range|PR|actual text/iu),
    });
  });

  it.each([
    'review this plan: move the parser before the relay and verify the stored evidence',
    'review this report: the release proof passed with no manual repair',
    'review this code: const answer = 42',
    'review this plan: update src/foo.ts after validating the parser',
    'review this report: src/foo.ts failed the focused check',
    'review the following plan: "Review PR #42"',
    'review the following documentation: "Review main...HEAD"',
    'review this attached report: "Review commit abc123"',
    'review the following plan:\n```text\nReview staged changes\n```',
    'review "Review PR #42"',
    'review this attached proposal — Deploy to a canary before the public release.',
    'review the following quote: “Review main...HEAD.”',
    'review this excerpt:\n> Review PR #42',
  ])('keeps actual supplied material as a goal-only Review for %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: { kind: 'goal' },
    });
  });

  it('does not let quoted guidance add a second target to a selected commit', () => {
    expect(parseReviewTarget('review latest commit; note: "Review PR #42"')).toEqual({
      ok: true,
      target: { kind: 'commit', ref: 'HEAD' },
    });
    expect(parseReviewTarget("review latest commit; note: 'Review PR #42'")).toEqual({
      ok: true,
      target: { kind: 'commit', ref: 'HEAD' },
    });
  });

  it('recognizes an unstaged-diffs request as explicit and unstaged-only', () => {
    expect(parseReviewTarget('review unstaged diffs')).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode: 'unstaged', explicit: true },
    });
  });

  it('recognizes a staged file target without requiring the word changes', () => {
    expect(parseReviewTarget('review the staged symlink')).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode: 'staged', explicit: true },
    });
  });

  it('recognizes an explicitly named untracked file as working-tree evidence', () => {
    expect(parseReviewTarget('review this untracked scratch file')).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode: 'all', explicit: true },
    });
  });

  it.each([
    'review https://github.com/Acme/Widget/pull/123',
    'review https://github.com/Acme/Widget/pull/123/files?diff=split',
    'review https://github.com/Acme/Widget/pull/123/commits',
    'review https://github.com/Acme/Widget/pull/123/commits/abcdef1',
    'review HTTPS://GITHUB.COM/Acme/Widget/pull/123/checks#summary',
    'review <https://www.github.com/Acme/Widget/pull/123/files>',
  ])('preserves the repository and number for %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: {
        kind: 'pull_request',
        number: 123,
        repository: { host: 'github.com', owner: 'acme', name: 'widget' },
      },
    });
  });

  it.each([
    'review https://github.com/acme/widget/pull/',
    'review https://github.com/acme/widget/pull',
    'review https://github.com/acme/widget/pull/not-a-number',
    'review https://github.com/acme/widget/pull/123/files/extra',
    'review https://github.com/acme/widget/pull/123/unknown',
    'review https://evilgithub.com/acme/widget/pull/123',
    'review https://github.com.evil.test/acme/widget/pull/123',
    'review PR #nope',
    'review PR 1000000',
    'review pull request 1234567',
    'review the PR',
    'review main..',
    'review ..feature',
  ])('fails closed for malformed target %j', (goal) => {
    expect(parseReviewTarget(goal)).toMatchObject({ ok: false });
  });

  it.each([
    'review commit abc123 and current changes',
    'review PR #123 and commit abc123',
    'review main...feature and PR #123',
    'review PR #41 and https://github.com/acme/widget/pull/42',
    'review both PR #41 and https://github.com/acme/widget/pull/42',
    'review PR #41 plus https://github.com/acme/widget/pull/42',
    'review https://github.com/acme/widget/pull/41 and PR #42',
    'review commit abc123 and https://github.com/acme/widget/pull/42',
    'review https://github.com/acme/widget/pull/41 and commit abc123',
    'review https://github.com/acme/widget/pull/41 and main...HEAD',
    'review main...HEAD and https://github.com/acme/widget/pull/41',
    'review PR #42; plus latest commit',
  ])('fails closed when multiple code targets conflict in %j', (goal) => {
    expect(parseReviewTarget(goal)).toMatchObject({ ok: false });
  });

  it.each([
    'review commit abc123 and commit def456',
    'review PR #41 and PR #42',
    'review main...feature and release...hotfix',
    'review commits abc123 and def456',
    'review PRs #41 and #42',
    'review https://github.com/acme/a/pull/123 and https://github.com/acme/b/pull/123',
    'review https://github.com/acme/widget/pull/41 and https://github.com/acme/widget/pull/42',
    'review commit abc123, commit def456',
    'review PR #41 & PR #42',
    'review main...feature + release...hotfix',
    'review https://github.com/acme/widget/pull/41, https://github.com/acme/widget/pull/42',
  ])('fails closed when distinct targets of the same kind conflict in %j', (goal) => {
    expect(parseReviewTarget(goal)).toMatchObject({ ok: false });
  });

  it.each([
    'review PR #41/#42',
    'review PRs #41/#42',
    'review PR #41/PR #42',
    'review PR #41 / pull request #42',
    'review commit abc123/def456',
    'review commits abc123/def456',
    'review commit abc123/commit def456',
    'review commit abc123 / revision def456',
  ])('fails closed for slash-separated multiple targets in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/more than one|ambiguous/iu),
    });
  });

  it.each([
    'review PR #41 and #42',
    'review PR #41 or #42',
    'review PR #41 plus #42',
    'review PR #41, #42',
    'review changes in PR #41 and #42',
    'review PRs #41, #42',
    'review commit abc123 and def456',
    'review commit abc123 or def456',
    'review commit abc123 plus def456',
    'review commit abc123, def456',
    'review commits abc123, def456',
  ])('fails closed for shorthand lists containing multiple targets in %j', (goal) => {
    expect(parseReviewTarget(goal)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/more than one|ambiguous/iu),
    });
  });

  it.each([
    'review commit abc123 and focus on regressions',
    'review commit abc123 and pay attention to tests',
    'review commit abc123, especially the risky code',
  ])('does not mistake prose after one commit target for a second ref in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: { kind: 'commit', ref: 'abc123' },
    });
  });

  it.each([
    'review PR #41 and PR #nope',
    'review commit abc123 and PR #nope',
    'review commit abc123 and HEAD',
    'review PR #41 and HEAD',
    'review main...feature and HEAD',
    'review PR #41 and branch feature',
    'review commit abc123 and branch feature',
  ])('fails closed when a later target is malformed or conflicts in %j', (goal) => {
    expect(parseReviewTarget(goal)).toMatchObject({ ok: false });
  });

  it('fails closed when a selected PR URL list continues with a malformed repository URL', () => {
    expect(
      parseReviewTarget(
        'review https://github.com/acme/widget/pull/41 and https://github.com.evil.test/acme/widget/pull/42',
      ),
    ).toMatchObject({ ok: false });
  });

  it('deduplicates a PR number and URL that identify the same target', () => {
    expect(parseReviewTarget('review PR #123 at https://github.com/acme/widget/pull/123')).toEqual({
      ok: true,
      target: {
        kind: 'pull_request',
        number: 123,
        repository: { host: 'github.com', owner: 'acme', name: 'widget' },
      },
    });
  });

  it.each([
    'review the commit handling code',
    'review commit handling',
    'review PR handling in the parser',
    'review code that handles staged changes',
    'review how we render unstaged diffs',
    'review the parser...focus on edge cases',
    'review working tree handling in the intake writer',
    'review branch handling in the checkout code',
    'review branch handling',
    'review HEAD parsing logic',
    'review code that handles main...feature ranges',
  ])('rejects conceptual target prose when no actual material is supplied in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/actual|complete|material|source|target|text/iu),
    });
  });

  it.each([
    'review branch naming logic',
    'review branch protection rules',
    'review working tree cleanup',
    'review worktree discovery',
    'review PR approval logic',
    'review pull request comments UI',
    'review commit author metadata',
    'review HEAD cleanup',
    'review latest commit handling',
    'review this code for the latest commit message formatting',
  ])('rejects target-like conceptual prose when no actual material is supplied in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/actual|complete|material|source|target|text/iu),
    });
  });

  it.each([
    {
      goal: "I'd like a review of the latest commit",
      target: { kind: 'commit', ref: 'HEAD' },
    },
    {
      goal: 'please provide a review of HEAD',
      target: { kind: 'commit', ref: 'HEAD' },
    },
    {
      goal: 'can I get a review of PR #42?',
      target: { kind: 'pull_request', number: 42 },
    },
  ])(
    'recognizes a complete target introduced by noun-form Review wording in $goal',
    ({ goal, target }) => {
      expect(parseReviewTarget(goal)).toEqual({ ok: true, target });
    },
  );

  it.each([
    'review the proposal: audit the latest commit',
    'review this report: audit commit abc123',
    'review this plan: inspect PR #42',
    'review docs: review latest commit',
    'review this report: analyze main...HEAD',
    'review this plan: check staged changes',
  ])(
    'does not treat a target quoted inside supplied Review subject text as authority in %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'goal' },
      });
    },
  );

  it('recognizes a natural branch comparison as a range', () => {
    expect(parseReviewTarget('review changes between main and feature')).toEqual({
      ok: true,
      target: { kind: 'range', base: 'main', head: 'feature', dots: '...' },
    });
    expect(parseReviewTarget('review changes between main and feature.')).toEqual({
      ok: true,
      target: { kind: 'range', base: 'main', head: 'feature', dots: '...' },
    });
  });

  it.each([
    'review changes between main and feature and changes between release and hotfix',
    'review changes from main to feature plus changes from release to hotfix',
    'review changes between main and feature and changes from release to hotfix',
  ])('fails closed when more than one natural-language range is named in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/more than one|ambiguous/iu),
    });
  });

  it.each([
    'review PR #42 and changes between main and HEAD',
    'review changes between main and HEAD and PR #42',
    'review PR #42 plus changes from main to HEAD',
    'review changes from main to HEAD plus PR #42',
  ])('fails closed for a PR combined with a natural-language range in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/more than one|ambiguous/iu),
    });
  });

  it.each([
    'review changes from main to feature and changes in PR #42',
    'review changes between main and feature and PR #42',
    'review changes from main to feature plus changes in pull request #42',
  ])('fails closed when a natural range is followed by a PR in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/more than one|ambiguous/iu),
    });
  });

  it.each([
    'review changes between main and feature, and changes between release and hotfix',
    'review changes between main and feature, then changes between release and hotfix',
    'review changes from main to feature and also changes from release to hotfix',
    'review changes from main to feature as well as changes between release and hotfix',
  ])('fails closed for naturally connected multiple ranges in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/more than one|ambiguous/iu),
    });
  });

  it.each([
    {
      goal: 'review changes from main to HEAD',
      target: { kind: 'range', base: 'main', head: 'HEAD', dots: '...' },
    },
    {
      goal: 'review the diff from release/1.0 to feature',
      target: { kind: 'range', base: 'release/1.0', head: 'feature', dots: '...' },
    },
  ])('recognizes an explicit from-to comparison in $goal', ({ goal, target }) => {
    expect(parseReviewTarget(goal)).toEqual({ ok: true, target });
  });

  it('rejects an against comparison with an explicit-range remedy', () => {
    expect(parseReviewTarget('review main against HEAD')).toEqual({
      ok: false,
      reason: expect.stringMatching(/explicit range[\s\S]*main\.\.\.HEAD/iu),
    });
  });

  it.each([
    'review commit abc123 through def456',
    'review latest commit versus PR #42',
    'review HEAD compared to main',
    'review changes across abc123 and def456',
    'review abc123 versus def456',
    'review feature compared with main',
  ])('rejects an unsupported or conflicting comparison instead of guessing for %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/choose one|comparison|explicit range|target/iu),
    });
  });

  it.each(['review changes from main', 'review changes from main to', 'review changes to HEAD'])(
    'fails closed when clear comparison wording is incomplete in %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: false,
        reason: expect.stringMatching(/explicit range|target/iu),
      });
    },
  );

  it('recognizes a natural branch comparison ending in a question mark', () => {
    expect(parseReviewTarget('review changes between main and feature?')).toEqual({
      ok: true,
      target: { kind: 'range', base: 'main', head: 'feature', dots: '...' },
    });
  });

  it('ignores a negated target clause instead of reviewing the opposite scope', () => {
    expect(
      parseReviewTarget('do not review staged changes; review the plan: deploy to a canary'),
    ).toEqual({ ok: true, target: { kind: 'goal' } });
    expect(
      parseReviewTarget('do not review staged changes and instead review commit abc123'),
    ).toEqual({
      ok: true,
      target: { kind: 'commit', ref: 'abc123' },
    });
  });

  it('recognizes a curly-apostrophe negated Review clause', () => {
    expect(
      parseReviewTarget('don’t review staged changes; review the plan: deploy to a canary'),
    ).toEqual({ ok: true, target: { kind: 'goal' } });
  });

  it('keeps the affirmative Review after a negated commit clause', () => {
    expect(parseReviewTarget('do not review commit abc123 and review staged changes')).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode: 'staged', explicit: true },
    });
  });

  it.each([
    {
      goal: 'review the latest commit only; ignore my working tree',
      target: { kind: 'commit', ref: 'HEAD' },
    },
    {
      goal: 'review only commit abc1234 and ignore the worktree',
      target: { kind: 'commit', ref: 'abc1234' },
    },
    {
      goal: 'review PR #42, ignore current changes',
      target: { kind: 'pull_request', number: 42 },
    },
    {
      goal: 'review main...HEAD only; do not include working tree changes',
      target: { kind: 'range', base: 'main', head: 'HEAD', dots: '...' },
    },
    {
      goal: 'review commit abc1234 but exclude my uncommitted changes',
      target: { kind: 'commit', ref: 'abc1234' },
    },
  ])('does not count an excluded working tree as another target for $goal', ({ goal, target }) => {
    expect(parseReviewTarget(goal)).toEqual({ ok: true, target });
  });

  it('does not mistake target vocabulary inside the subject for a code target', () => {
    expect(parseReviewTarget('review this plan: add PR #123 support')).toEqual({
      ok: true,
      target: { kind: 'goal' },
    });
    expect(parseReviewTarget('review docs: explain latest commit handling')).toEqual({
      ok: true,
      target: { kind: 'goal' },
    });
    expect(parseReviewTarget('review docs: link https://github.com/acme/widget/pull/123')).toEqual({
      ok: true,
      target: { kind: 'goal' },
    });
  });

  it('rejects commit implementation wording when no source material is supplied', () => {
    expect(parseReviewTarget('review the commit implementation')).toEqual({
      ok: false,
      reason: expect.stringMatching(/actual|complete|material|source|target|text/iu),
    });
  });

  it('accepts ordinary PR URL and commit-at wording', () => {
    expect(parseReviewTarget('review PR https://github.com/acme/widget/pull/123')).toEqual({
      ok: true,
      target: {
        kind: 'pull_request',
        number: 123,
        repository: { host: 'github.com', owner: 'acme', name: 'widget' },
      },
    });
    expect(parseReviewTarget('review the commit at abc1234')).toEqual({
      ok: true,
      target: { kind: 'commit', ref: 'abc1234' },
    });
  });

  it.each(['review PR #123.', 'review pull request 123.'])(
    'accepts terminal sentence punctuation after a PR number for %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'pull_request', number: 123 },
      });
    },
  );

  it.each(['review PR #123oops.', 'review pull request 123oops.'])(
    'still rejects malformed PR suffixes before terminal punctuation for %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toMatchObject({ ok: false });
    },
  );

  it('maps a clear working-tree exclusion to the remaining layer', () => {
    expect(parseReviewTarget('review current changes except staged changes')).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode: 'unstaged', explicit: true },
    });
    expect(parseReviewTarget('review current changes except unstaged changes')).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode: 'staged', explicit: true },
    });
  });

  it.each([
    {
      goal: "review current changes, but don't include unstaged changes",
      mode: 'staged',
    },
    {
      goal: "review current changes, but don't include staged changes",
      mode: 'unstaged',
    },
  ])('honors a conversational working-tree exclusion for $goal', ({ goal, mode }) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: true,
      target: { kind: 'working_tree', mode, explicit: true },
    });
  });

  it.each([
    'review everything except commit abc123',
    'review changes since commit abc123',
    'review changes after commit abc123',
  ])('rejects unsupported comparative or exclusion wording for %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/explicit|range|target/iu),
    });
  });

  it('rejects a branch without a comparison base and gives an explicit range remedy', () => {
    expect(parseReviewTarget('review branch feature')).toEqual({
      ok: false,
      reason: expect.stringMatching(/range[\s\S]*main\.\.\.feature/iu),
    });
  });

  it.each(['review current branch', 'review all changes in this branch'])(
    'rejects a branch target without a base for %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: false,
        reason: expect.stringMatching(/explicit range[\s\S]*main\.\.\.HEAD/iu),
      });
    },
  );

  it.each([
    'review everything in this branch',
    'review this branch',
    'review all changes on this branch',
    'review everything on the current branch for regressions',
  ])('rejects common current-branch aliases without a base for %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/explicit range[\s\S]*main\.\.\.HEAD/iu),
    });
  });

  it.each(['review last 2 commits', 'review the last 10 commits', 'last 3 commits'])(
    'rejects a multi-commit count for %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: false,
        reason: expect.stringMatching(/explicit range/iu),
      });
    },
  );

  it.each([
    'review last two commits',
    'review the previous three commits',
    'review last 2 commits for regressions',
    'review previous 2 commits',
    'last two commits, focus on tests',
    'review latest commits',
    'review the last twenty commits',
    'review the previous couple of commits',
  ])('rejects spelled-out or embedded multi-commit targets for %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/explicit range/iu),
    });
  });

  it.each([
    {
      goal: 'PR #42, focus on regressions',
      target: { kind: 'pull_request', number: 42 },
    },
    {
      goal: 'latest commit, focus on tests',
      target: { kind: 'commit', ref: 'HEAD' },
    },
    {
      goal: 'HEAD for security issues',
      target: { kind: 'commit', ref: 'HEAD' },
    },
    {
      goal: 'commit abc123 and focus on regressions',
      target: { kind: 'commit', ref: 'abc123' },
    },
    {
      goal: 'main...HEAD, focus on regressions',
      target: { kind: 'range', base: 'main', head: 'HEAD', dots: '...' },
    },
    {
      goal: 'staged changes, focus on tests',
      target: { kind: 'working_tree', mode: 'staged', explicit: true },
    },
  ])('keeps a bare target when review instructions follow for $goal', ({ goal, target }) => {
    expect(parseReviewTarget(goal)).toEqual({ ok: true, target });
  });

  it.each([
    'PR #42 and commit abc123',
    'latest commit and staged changes',
    'staged changes and commit abc123',
    'main...HEAD and unstaged changes',
  ])('fails closed when bare targets conflict in %j', (goal) => {
    expect(parseReviewTarget(goal)).toEqual({
      ok: false,
      reason: expect.stringMatching(/more than one|ambiguous/iu),
    });
  });

  it.each(['commit handling', 'commit parser', 'commit support', 'commit implementation'])(
    'rejects a bare commit subject when no source material is supplied in %j',
    (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: false,
        reason: expect.stringMatching(/actual|complete|material|source|target|text/iu),
      });
    },
  );

  it('strips sentence punctuation after a range target', () => {
    expect(parseReviewTarget('review main...feature.')).toEqual({
      ok: true,
      target: { kind: 'range', base: 'main', head: 'feature', dots: '...' },
    });
  });

  it.each([
    {
      goal: 'review current changes against HEAD',
      target: { kind: 'working_tree', mode: 'all', explicit: true },
    },
    {
      goal: 'review the current large staged diff',
      target: { kind: 'working_tree', mode: 'staged', explicit: true },
    },
    {
      goal: 'review staged changes against HEAD',
      target: { kind: 'working_tree', mode: 'staged', explicit: true },
    },
    {
      goal: 'review main...feature',
      target: { kind: 'range', base: 'main', head: 'feature', dots: '...' },
    },
    {
      goal: 'review commit origin/main',
      target: { kind: 'commit', ref: 'origin/main' },
    },
  ])('keeps the requested target exclusive for $goal', ({ goal, target }) => {
    expect(parseReviewTarget(goal)).toEqual({ ok: true, target });
  });
});
