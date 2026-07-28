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

    // Same rule, but "everything" names the repository, which is a target
    // Review can now read: the tree itself, split into units.
    it('does not read the prose ellipsis in an everything-scoped goal as a range', () => {
      expect(parseReviewTarget('review everything...including the tests')).toEqual({
        ok: true,
        target: { kind: 'snapshot', paths: { include: ['.'], exclude: [] } },
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

    // The narrowing word can follow the path as easily as precede it, and the
    // two orders mean the same thing. Only the leading order was read, so
    // "review src/auth only" reviewed the entire working tree and said nothing
    // about having ignored the word.
    it.each([
      { goal: 'review src/auth only', include: ['src/auth'] },
      { goal: 'review src/app.ts alone', include: ['src/app.ts'] },
      { goal: 'review src/runtime and nothing else', include: ['src/runtime'] },
      { goal: 'review the tests only', include: ['tests'] },
    ])('reads the trailing narrowing in $goal as a scope on $include', ({ goal, include }) => {
      expect(parseReviewTarget(goal)).toMatchObject({
        ok: true,
        target: { kind: 'working_tree', paths: { include, exclude: [] } },
      });
    });

    // A trailing narrowing must not turn a ref into a path. "review
    // main...HEAD only" is a range, and scoping the range to a directory named
    // "main...HEAD" would review nothing at all.
    it.each([
      'review main...HEAD only',
      'review HEAD~1..HEAD only',
      'review commit abc1234 only',
      'review the latest commit only',
    ])('does not read the ref in %j as a trailing path scope', (goal) => {
      const parsed = parseReviewTarget(goal) as {
        ok: true;
        target: { kind: string; paths?: unknown };
      };
      expect(parsed.target.kind).toMatch(/^(?:commit|range)$/u);
      expect(parsed.target.paths).toBeUndefined();
    });

    // Ordinary prose that happens to end in a narrowing word names no path, so
    // it must not invent one.
    it.each([
      'review this only',
      'review my changes only',
      'review the plan only',
      'just review it',
    ])('invents no path scope for %j', (goal) => {
      const parsed = parseReviewTarget(goal) as {
        ok: true;
        target: { paths?: { include: string[] } };
      };
      expect(parsed.target.paths?.include ?? []).toEqual([]);
    });

    // "everything except X" is the repository minus a directory. The
    // repository is the target, so this reads the code there rather than the
    // diff, and the exclusion still keeps that directory out of it.
    it.each([
      { goal: 'review everything except tests/', exclude: ['tests/'] },
      { goal: 'review everything but node_modules', exclude: ['node_modules'] },
      { goal: 'review everything except the generated files', exclude: ['generated'] },
    ])('reads $goal as the repository excluding $exclude', ({ goal, exclude }) => {
      expect(parseReviewTarget(goal)).toEqual({
        ok: true,
        target: { kind: 'snapshot', paths: { include: ['.'], exclude } },
      });
    });

    // One filler word between the narrowing word and the path used to lose the
    // exclusion outright: "but" matched, "skip" was read as the path, failed the
    // path test, and "tests/" one word later was never reached. The operator
    // asked for tests/ to be left out and Review read them anyway, silently,
    // which is the failure mode a narrowing clause exists to avoid.
    it.each([
      { goal: 'review the staged changes but skip tests/', exclude: ['tests/'] },
      { goal: 'review the working tree but ignore node_modules', exclude: ['node_modules'] },
      { goal: 'review the working tree except maybe docs/', exclude: ['docs/'] },
    ])('reads the exclusion in $goal', ({ goal, exclude }) => {
      const parsed = parseReviewTarget(goal);
      if (!parsed.ok) throw new Error(parsed.reason);
      if (parsed.target.kind === 'goal') throw new Error('expected a git target');
      expect(parsed.target.paths?.exclude ?? []).toEqual(exclude);
    });

    // The lookahead only reaches a token that already looks like a path, so an
    // ordinary sentence still narrows nothing. Reading a scope out of these
    // would review a fraction of what was asked for.
    it.each([
      'review the diff but not too deeply',
      'review my changes but skip the boring parts',
      'review this branch but be quick about it',
    ])('reads no exclusion out of %s', (goal) => {
      const parsed = parseReviewTarget(goal);
      if (!parsed.ok) throw new Error(parsed.reason);
      if (parsed.target.kind === 'goal') throw new Error('expected a git target');
      expect(parsed.target.paths?.exclude ?? []).toEqual([]);
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

    // Naming a kind of code is naming a subset, even when Review cannot turn it
    // into a pathspec. These used to review the entire working tree and report
    // nothing, so the operator had no way to know the words were ignored.
    it.each([
      { goal: 'review only the typescript files', phrase: 'typescript files' },
      { goal: 'review just the auth module', phrase: 'auth module' },
      { goal: 'review only the auth service', phrase: 'auth service' },
      { goal: 'review just the frontend components', phrase: 'frontend components' },
    ])('reports $phrase as a narrowing it could not apply', ({ goal, phrase }) => {
      expect(parseReviewTarget(goal)).toMatchObject({
        ok: true,
        scopeNotApplied: [phrase],
      });
    });

    // Reported only when nothing resolved. "the generated files" reaches a real
    // directory, so claiming it went unapplied would be the opposite lie.
    it.each(['review only the generated files', 'review only the docs files'])(
      'stays quiet for %j because the narrowing did resolve',
      (goal) => {
        expect(parseReviewTarget(goal)).not.toHaveProperty('scopeNotApplied');
      },
    );

    // Ordinary prose that happens to contain a narrowing word must not produce
    // a warning quoting a random verb. This is what keeps the warning worth
    // reading at all.
    it.each([
      'review my changes but focus on safety',
      'give this a once-over, just be thorough',
      'review this but not too deeply',
      'review my work but only if it looks risky',
      'just review it',
      'review this diff but check the error paths',
    ])('reports no unapplied narrowing for the prose in %j', (goal) => {
      expect(parseReviewTarget(goal)).not.toHaveProperty('scopeNotApplied');
    });

    // A path that would escape the repository is never handed to Git, and the
    // run says so rather than quietly reviewing everything.
    it('refuses to scope to the escaping path in an unnamed-target goal and says so', () => {
      expect(parseReviewTarget('review only ../secrets')).toEqual({
        ok: true,
        target: { kind: 'working_tree', mode: 'all', explicit: false },
        assumed: true,
        scopeNotApplied: [expect.stringMatching(/\.\./u)],
      });
    });

    // The repository is still the target, so the run reads the code; the
    // escaping exclusion is refused and reported rather than handed to Git.
    it('refuses the escaping path in a repository-scoped goal and still reads the code', () => {
      expect(parseReviewTarget('review everything except ../../etc')).toEqual({
        ok: true,
        target: { kind: 'snapshot', paths: { include: ['.'], exclude: [] } },
        scopeNotApplied: [expect.stringMatching(/\.\./u)],
      });
    });
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

    // "Everything except tests" is the repository minus a directory. The
    // repository is a target Review reads a unit at a time, so this is a
    // snapshot of the tree with that directory left out.
    it('reads an excluding repository request as a snapshot of the rest', () => {
      expect(parseReviewTarget('review everything except tests/ as it stands')).toMatchObject({
        ok: true,
        target: { kind: 'snapshot', paths: { include: ['.'], exclude: ['tests/'] } },
      });
    });

    // "Everywhere" does not name the repository the way "everything" does, so
    // nothing bounds the read and it stays a change review.
    it('keeps an unbounded latent-issue sweep a change review', () => {
      const parsed = parseReviewTarget('find latent issues everywhere but node_modules');
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
    it.each(['review my code for latent issues'])(
      'records the dropped snapshot request in %j',
      (goal) => {
        expect(parseReviewTarget(goal)).toMatchObject({
          ok: true,
          target: { kind: 'working_tree' },
          snapshotNotApplied: true,
        });
      },
    );

    // Naming the repository is naming a target, so these read the code rather
    // than a diff and there is no dropped request to report.
    it.each(['review the repo as it stands', 'audit this codebase for latent bugs'])(
      'reads the repository named in %j as a snapshot',
      (goal) => {
        const parsed = parseReviewTarget(goal);
        expect(parsed).toMatchObject({
          ok: true,
          target: { kind: 'snapshot', paths: { include: ['.'], exclude: [] } },
        });
        expect(parsed).not.toHaveProperty('snapshotNotApplied');
      },
    );

    // A snapshot that was honoured has nothing to report as unapplied.
    it('does not record a dropped snapshot request when the snapshot happened', () => {
      expect(parseReviewTarget('review src/auth as it stands')).not.toHaveProperty(
        'snapshotNotApplied',
      );
    });
  });

  describe('whole-repository requests read the code, not the diff inside it', () => {
    // These name the repository as the subject. The subject is the code, so
    // Review reads the tree and splits it into units rather than reviewing
    // whatever happens to be uncommitted in it.
    it.each([
      'review the whole repo',
      'review this entire codebase',
      'audit this codebase',
      'review the whole project for problems',
      'do a full review of the repository',
      'review all the code',
      'review the codebase for security issues',
      'review everything',
    ])('reads %j as a snapshot of the repository', (goal) => {
      expect(parseReviewTarget(goal)).toMatchObject({
        ok: true,
        target: { kind: 'snapshot', paths: { include: ['.'], exclude: [] } },
      });
    });

    // The exclusion has to survive the switch from diff to code, or the run
    // reads the directory the operator asked it to leave alone.
    it('keeps the path exclusion on an excluding whole-repository request', () => {
      expect(parseReviewTarget('review everything except tests/')).toMatchObject({
        ok: true,
        target: { kind: 'snapshot', paths: { include: ['.'], exclude: ['tests/'] } },
      });
    });

    // Naming a path or a change is naming something narrower than the
    // repository, and none of these become a whole-tree read.
    it.each(['review src/runtime', 'review staged changes', 'review commit abc1234'])(
      'does not read %j as the whole repository',
      (goal) => {
        expect(parseReviewTarget(goal)).not.toMatchObject({
          target: { kind: 'snapshot', paths: { include: ['.'] } },
        });
      },
    );

    // D1 is a different situation with a different message: the operator named
    // nothing, so "assumed the working tree" is the honest thing to say.
    it.each(['review', 'review my changes', 'give this a once-over'])(
      'leaves the unnamed-target default alone for %j',
      (goal) => {
        expect(parseReviewTarget(goal)).toMatchObject({
          ok: true,
          target: { kind: 'working_tree' },
          assumed: true,
        });
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
