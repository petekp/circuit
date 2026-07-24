import { describe, expect, it } from 'vitest';

import { parseReviewTarget } from '../../src/flows/review/index.js';

const ASSUMED_WORKING_TREE = {
  ok: true,
  target: { kind: 'working_tree', mode: 'all', explicit: false },
  assumed: true,
};

describe('Review target parsing', () => {
  describe('explicit working-tree forms', () => {
    it.each([
      { goal: 'review staged changes', mode: 'staged' },
      { goal: 'inspect staged work', mode: 'staged' },
      { goal: 'review the staged diff before I push', mode: 'staged' },
      { goal: 'review unstaged changes', mode: 'unstaged' },
      { goal: 'review not-staged work', mode: 'unstaged' },
      { goal: 'audit what is not staged yet', mode: 'unstaged' },
      { goal: 'review staged and unstaged changes', mode: 'all' },
      { goal: 'review the working tree', mode: 'all' },
      { goal: 'audit the worktree', mode: 'all' },
      { goal: 'review uncommitted changes', mode: 'all' },
      { goal: 'review our uncommitted files', mode: 'all' },
      { goal: 'check the current diff', mode: 'all' },
      // Working-tree wording outranks a bare HEAD mention.
      { goal: 'review current changes against HEAD', mode: 'all' },
    ])('reads $goal as the $mode working tree', ({ goal, mode }) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'working_tree', mode, explicit: true },
      });
    });
  });

  describe('explicit commit forms', () => {
    it.each([
      { goal: 'review commit abc1234', ref: 'abc1234' },
      { goal: 'review commit at v1.2.0', ref: 'v1.2.0' },
      { goal: 'review revision main', ref: 'main' },
      { goal: 'review rev HEAD~2', ref: 'HEAD~2' },
      { goal: 'review HEAD', ref: 'HEAD' },
      { goal: 'review HEAD^', ref: 'HEAD^' },
      { goal: 'review HEAD~3', ref: 'HEAD~3' },
    ])('reads $goal as commit $ref', ({ goal, ref }) => {
      expect(parseReviewTarget(goal)).toEqual({ ok: true, target: { kind: 'commit', ref } });
    });

    it.each([
      'review the latest commit',
      'review the last commit',
      'review my most recent commit',
      'review what I just committed',
      'review the commit I just made',
      'analyze what changed in the last commit',
    ])('reads the short latest-commit alias %j as HEAD', (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'commit', ref: 'HEAD' },
      });
    });

    // Malformed explicit forms fail closed. A "commit <ref>" the operator
    // clearly meant must never quietly become a working-tree review.
    it.each([
      'review commit -rf',
      'review commit --upload-pack=evil',
      'review commit HEAD@{1}',
      'review commit ../../etc/passwd',
    ])('refuses the unusable commit ref in %j', (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: false,
        reason: expect.stringContaining('unusable commit ref'),
      });
    });
  });

  describe('explicit range forms', () => {
    it.each([
      { goal: 'review main...feature', base: 'main', head: 'feature', dots: '...' },
      { goal: 'review main..feature', base: 'main', head: 'feature', dots: '..' },
      { goal: 'check HEAD~1..HEAD', base: 'HEAD~1', head: 'HEAD', dots: '..' },
      { goal: 'review release/1.x...main', base: 'release/1.x', head: 'main', dots: '...' },
      { goal: 'review 1.0.0..2.0.0', base: '1.0.0', head: '2.0.0', dots: '..' },
      { goal: 'review commit a..b', base: 'a', head: 'b', dots: '..' },
      { goal: 'review foo...bar please', base: 'foo', head: 'bar', dots: '...' },
    ])('reads $goal as a range', ({ goal, base, head, dots }) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'range', base, head, dots },
      });
    });

    // A prose ellipsis is not a range. Reading one as a range would fail the
    // run closed on ordinary phrasing.
    it.each([
      'review this plan...especially the rollout risks',
      'review it...ok',
      'review everything...including the tests',
    ])('does not read the prose ellipsis in %j as a range', (goal) => {
      expect(parseReviewTarget(goal)).toEqual(ASSUMED_WORKING_TREE);
    });
  });

  describe('supplied material', () => {
    it.each([
      "review this plan: don't ship without a rollback",
      'review the following report:\nThe migration ran twice.',
      'review this code:\n```ts\nconst value = 1;\n```',
      'review the following text: "one pinned target, then stop"',
    ])('reads inline supplied material in %j as a goal-only target', (goal) => {
      expect(parseReviewTarget(goal)).toEqual({ ok: true, target: { kind: 'goal' } });
    });

    it.each([
      'review this code:\n```ts\nconst value = 1;',
      'review this report: "unfinished',
      "review this quotation: 'unfinished",
    ])('fails closed when the supplied material is malformed in %j', (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: false,
        reason: expect.stringMatching(/unclosed/iu),
      });
    });

    it.each(['review this plan:', 'review the following report: ""'])(
      'fails closed when the supplied-material boundary is empty in %j',
      (goal) => {
        expect(parseReviewTarget(goal)).toEqual({
          ok: false,
          reason: expect.stringContaining('the goal ends before any material appears'),
        });
      },
    );
  });

  describe('unsupported explicit forms', () => {
    // D5: Review has no fetch story for a pull request, so it says what to do
    // instead rather than reviewing the wrong thing.
    it.each([
      'review PR #42',
      'review pull request 7',
      'review https://github.com/acme/widget/pull/42',
      'review my pull request',
      'review PRs in general',
    ])('refuses the pull-request target in %j with local instructions', (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: false,
        reason: expect.stringContaining('Check out the PR branch locally'),
      });
    });

    // D4: Review cannot pin a subset of paths as evidence. The stop says what
    // to run instead.
    it.each([
      'review only src/foo.ts',
      'review src/app.ts',
      'review changes in src/',
      'review everything except tests/',
      'review everything but node_modules',
      'review latest commit but do not review package-lock.json',
      'review latest commit, leaving out migrations',
      'review current changes except untracked files',
      'review the file: src/app.ts',
      // A narrowing clause outranks the target it narrows. Reviewing the whole
      // commit here would review more than the operator asked for.
      'review latest commit only in src/',
      'review latest commit only in src/foo.ts',
      'review only src/foo.ts in latest commit',
      'review HEAD~1..HEAD except node_modules/',
    ])('refuses the path subset in %j and names the alternative', (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: false,
        reason: expect.stringContaining('Review the whole working tree, a commit, or a range'),
      });
    });
  });

  describe('two explicit targets in one goal', () => {
    it.each([
      'review latest commit and staged changes',
      'review the working tree and commit abc1234',
      'review main...feature and the unstaged diff',
    ])('refuses %j and says to run it twice', (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: false,
        reason: expect.stringContaining('Review pins one target per run'),
      });
    });
  });

  describe('D1: unrecognised phrasing defaults to the working tree', () => {
    it.each([
      'review',
      'code review please',
      'take a look at what I did',
      'review my changes',
      'review local changes',
      'review this diff for races',
      'review this rollout plan for operational risks',
      'review docs explaining branch semantics',
      'review the plan, focus on rollback',
      'give this a once-over',
    ])('defaults %j to the working tree and marks the assumption', (goal) => {
      expect(parseReviewTarget(goal)).toEqual(ASSUMED_WORKING_TREE);
    });

    // The verb phrase "this changes" is not a working-tree selection, so it
    // must not read as an explicit target either.
    it('does not mistake the verb phrase "this changes" for an explicit target', () => {
      expect(parseReviewTarget('review how this changes for users')).toEqual(ASSUMED_WORKING_TREE);
    });

    it('does not read a curly-apostrophe negation as a target', () => {
      expect(parseReviewTarget('review this plan’s risks, don’t just skim it')).toEqual(
        ASSUMED_WORKING_TREE,
      );
    });

    it('does not read a bare issue-like token as a pull request', () => {
      expect(parseReviewTarget('review #123oops')).toEqual(ASSUMED_WORKING_TREE);
    });
  });

  describe('pasted material never votes on target selection', () => {
    it.each([
      'review this code:\n```sh\ngit diff main...feature\n```',
      'review the following text: "review the staged changes"',
    ])('ignores the target words inside the pasted body of %j', (goal) => {
      expect(parseReviewTarget(goal)).toEqual({ ok: true, target: { kind: 'goal' } });
    });
  });
});
