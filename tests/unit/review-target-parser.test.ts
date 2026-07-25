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
    it.each(['review this plan...especially the rollout risks', 'review it...ok'])(
      'does not read the prose ellipsis in %j as a range',
      (goal) => {
        expect(parseReviewTarget(goal)).toEqual(ASSUMED_WORKING_TREE);
      },
    );

    // Same rule, but "everything" also names the repository, so this one lands
    // on the working tree carrying the whole-repository mark rather than the
    // plain unnamed-target default.
    it('does not read the prose ellipsis in an everything-scoped goal as a range', () => {
      expect(parseReviewTarget('review everything...including the tests')).toEqual({
        ...ASSUMED_WORKING_TREE,
        wholeRepository: true,
      });
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
  });

  describe('path scopes', () => {
    // A bare path is the whole request. It names what to look at, not which
    // changes, so the working tree is still an assumption and still declared.
    // The same path rides along as a snapshot fallback: if nothing has changed
    // there, the code at that path is still what the operator pointed at.
    it.each([
      { goal: 'review src/app.ts', include: ['src/app.ts'] },
      { goal: 'review only src/foo.ts', include: ['src/foo.ts'] },
      { goal: 'review the file: src/app.ts', include: ['src/app.ts'] },
      { goal: 'review src/auth', include: ['src/auth'] },
      { goal: 'review changes in src/', include: ['src/'] },
    ])('reads $goal as the working tree scoped to $include', ({ goal, include }) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: {
          kind: 'working_tree',
          mode: 'all',
          explicit: false,
          paths: { include, exclude: [] },
        },
        assumed: true,
        snapshotFallback: { include, exclude: [] },
      });
    });

    // "everything except X" is the repository minus a directory, so the
    // exclusion narrows the change review and the whole-repository mark rides
    // along to keep the report from claiming no target was named.
    it.each([
      { goal: 'review everything except tests/', exclude: ['tests/'] },
      { goal: 'review everything but node_modules', exclude: ['node_modules'] },
      { goal: 'review everything except the generated files', exclude: ['generated'] },
    ])('reads $goal as the working tree excluding $exclude', ({ goal, exclude }) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: {
          kind: 'working_tree',
          mode: 'all',
          explicit: false,
          paths: { include: [], exclude },
        },
        assumed: true,
        wholeRepository: true,
      });
    });

    // A narrowing clause rides along with the target it narrows. Reviewing the
    // whole commit here would review more than the operator asked for.
    it.each([
      { goal: 'review latest commit only in src/', include: ['src/'], exclude: [] },
      { goal: 'review latest commit only in src/foo.ts', include: ['src/foo.ts'], exclude: [] },
      { goal: 'review only src/foo.ts in latest commit', include: ['src/foo.ts'], exclude: [] },
      {
        goal: 'review latest commit but do not review package-lock.json',
        include: [],
        exclude: ['package-lock.json'],
      },
      {
        goal: 'review latest commit, leaving out migrations',
        include: [],
        exclude: ['migrations'],
      },
    ])('scopes the commit named by $goal', ({ goal, include, exclude }) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'commit', ref: 'HEAD', paths: { include, exclude } },
      });
    });

    it('scopes a range', () => {
      expect(parseReviewTarget('review HEAD~1..HEAD except node_modules/')).toEqual({
        ok: true,
        target: {
          kind: 'range',
          base: 'HEAD~1',
          head: 'HEAD',
          dots: '..',
          paths: { include: [], exclude: ['node_modules/'] },
        },
      });
    });

    it('scopes an explicit working-tree mode', () => {
      expect(parseReviewTarget('review staged changes in src/')).toEqual({
        ok: true,
        target: {
          kind: 'working_tree',
          mode: 'staged',
          explicit: true,
          paths: { include: ['src/'], exclude: [] },
        },
      });
    });

    // "except untracked files" is not a pathspec, but it is a working-tree
    // mode, so Review honours it by narrowing to the tracked layers.
    it.each([
      'review current changes except untracked files',
      'review the working tree but not untracked',
      'review uncommitted changes, ignoring untracked files',
    ])('narrows %j to the tracked working tree', (goal) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'working_tree', mode: 'tracked', explicit: true },
      });
    });

    // The exclusion was already true of the target, so there is nothing to
    // narrow and nothing to warn about.
    it.each([
      { goal: 'review staged changes except untracked files', mode: 'staged' },
      { goal: 'review unstaged changes, ignoring untracked', mode: 'unstaged' },
    ])('leaves $goal alone because it already excludes untracked files', ({ goal, mode }) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'working_tree', mode, explicit: true },
      });
    });

    it('leaves a commit target alone because its diff has no untracked files', () => {
      expect(parseReviewTarget('review the latest commit except untracked files')).toEqual({
        ok: true,
        target: { kind: 'commit', ref: 'HEAD' },
      });
    });

    // A narrowing Review cannot express as a pathspec or a mode does not stop
    // the run. The review covers the whole target and says what it could not
    // apply.
    it.each([
      { goal: 'review current changes except deleted files', phrase: 'except deleted' },
      { goal: 'review the latest commit but not renamed files', phrase: 'but not renamed' },
    ])('reviews the whole target when $phrase cannot be carved out', ({ goal, phrase }) => {
      const parsed = parseReviewTarget(goal);
      expect(parsed).toMatchObject({ ok: true, scopeNotApplied: [phrase] });
    });

    // A path that would escape the repository is never handed to Git, and the
    // run says so rather than quietly reviewing everything.
    it.each([
      { goal: 'review only ../secrets', wholeRepository: false },
      // Also names the repository, so both facts are reported: the escaping
      // path was refused, and the request was about the repository as a whole.
      { goal: 'review everything except ../../etc', wholeRepository: true },
    ])(
      'refuses to scope to the escaping path in $goal and says so',
      ({ goal, wholeRepository }) => {
        expect(parseReviewTarget(goal)).toEqual({
          ok: true,
          target: { kind: 'working_tree', mode: 'all', explicit: false },
          assumed: true,
          scopeNotApplied: [expect.stringMatching(/\.\./u)],
          ...(wholeRepository ? { wholeRepository: true } : {}),
        });
      },
    );
  });

  describe('snapshot targets', () => {
    // Some requests are about the code rather than a change to it. When the
    // operator says so and names somewhere to look, Review reads the files
    // rather than a diff, without waiting to discover the diff is empty.
    it.each([
      'review src/auth as it stands',
      'review src/auth for latent issues',
      'look at the current state of src/auth',
      'review the existing code in src/auth',
      'review the whole file src/auth',
    ])('reads %j as a snapshot of the named path', (goal) => {
      expect(parseReviewTarget(goal)).toMatchObject({
        ok: true,
        target: { kind: 'snapshot', paths: { include: ['src/auth'], exclude: [] } },
      });
    });

    // A snapshot needs somewhere to look. "Everything except tests" is the
    // repository minus a directory, which is more than one review can hold, so
    // it stays a change review rather than becoming an unbounded snapshot.
    it.each([
      'review everything except tests/ as it stands',
      'find latent issues everywhere but node_modules',
    ])('keeps %j a change review because no path is named', (goal) => {
      const parsed = parseReviewTarget(goal);
      expect(parsed).toMatchObject({ ok: true, target: { kind: 'working_tree' } });
      expect(parsed).not.toHaveProperty('snapshotFallback');
    });

    // Without a path there is nothing to bound the read, so the phrasing alone
    // never turns a whole-repository request into a snapshot.
    it('keeps an unscoped latent-issue request a change review', () => {
      expect(parseReviewTarget('review my code for latent issues')).toMatchObject({
        ok: true,
        target: { kind: 'working_tree', mode: 'all', explicit: false },
        assumed: true,
      });
    });

    // Staying a change review is the right call, but doing it quietly is not.
    // The operator asked for the code as it stands and got a diff, so the
    // request has to come back named rather than dropped on the floor.
    it.each([
      'review my code for latent issues',
      'review the repo as it stands',
      'audit this codebase for latent bugs',
    ])('records the dropped snapshot request in %j', (goal) => {
      expect(parseReviewTarget(goal)).toMatchObject({
        ok: true,
        target: { kind: 'working_tree' },
        snapshotNotApplied: true,
      });
    });

    // A snapshot that was honoured has nothing to report as unapplied.
    it('does not record a dropped snapshot request when the snapshot happened', () => {
      expect(parseReviewTarget('review src/auth as it stands')).not.toHaveProperty(
        'snapshotNotApplied',
      );
    });
  });

  describe('whole-repository requests are a named target, not a missing one', () => {
    // These name the repository as the subject. Reading them as "no target
    // given" tells the operator they said nothing when they said something,
    // and then offers four alternatives that are all narrower than the ask.
    it.each([
      'review the whole repo',
      'review this entire codebase',
      'audit this codebase',
      'review the whole project for problems',
      'do a full review of the repository',
      'review all the code',
      'review the codebase for security issues',
      'review everything',
    ])('marks %j as a whole-repository request', (goal) => {
      expect(parseReviewTarget(goal)).toMatchObject({
        ok: true,
        target: { kind: 'working_tree', mode: 'all', explicit: false },
        wholeRepository: true,
      });
    });

    // An exclusion still narrows the change review, and the request is still
    // about the repository as a whole, so both facts have to survive.
    it('keeps the path exclusion on an excluding whole-repository request', () => {
      expect(parseReviewTarget('review everything except tests/')).toMatchObject({
        ok: true,
        target: { paths: { include: [], exclude: ['tests/'] } },
        wholeRepository: true,
      });
    });

    // Naming a path is naming a target. These must not pick up the
    // whole-repository message, or a scoped review would describe itself as
    // something it is not.
    it.each([
      'review src/runtime',
      'review src/auth as it stands',
      'review staged changes',
      'review commit abc1234',
    ])('does not mark %j as a whole-repository request', (goal) => {
      expect(parseReviewTarget(goal)).not.toHaveProperty('wholeRepository');
    });

    // D1 is a different situation with a different message: the operator named
    // nothing, so "assumed the working tree" is the honest thing to say.
    it.each(['review', 'review my changes', 'give this a once-over'])(
      'leaves the unnamed-target default alone for %j',
      (goal) => {
        expect(parseReviewTarget(goal)).not.toHaveProperty('wholeRepository');
      },
    );
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
