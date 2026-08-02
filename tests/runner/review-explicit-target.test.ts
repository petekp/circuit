// Naming the Review target instead of guessing it from prose.
//
// Review's only input for *what to review* has been a sentence, so the engine
// recovered the target from `--goal` with twenty-one hand-written phrase
// patterns. The process that types that sentence is a language model that
// already understood the request in full; the grammar exists to redo that
// understanding worse, and it can only ever recognise phrasings someone
// anticipated. `--target` lets the caller say it outright.
//
// Two properties are what make this worth doing, and both are asserted below:
//
//   The explicit target WINS over the prose. Not "fills a gap when the grammar
//   matched nothing" — wins outright, including when the grammar would happily
//   have matched something else. Otherwise the flag is advisory and the guess
//   is still in charge.
//
//   The report says which one happened. Today a guessed target and a named one
//   arrive looking identical, and the assumption is disclosed only when the
//   grammar matched *nothing*. When it matches the WRONG pattern the report is
//   confidently wrong, which is the failure mode that is worth catching, and
//   the one that was invisible. Provenance makes the inference visible whether
//   or not a pattern matched.
//
// The grammar is demoted, not deleted: a goal with no `--target` behaves
// exactly as before. What changes is that it stops growing, and that it can no
// longer pass a guess off as a fact.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeOperatorSummary } from '../../src/app/operator-summary/writer.js';
import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { ReviewIntake } from '../../src/flows/review/reports.js';
import { RunResult } from '../../src/schemas/result.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RuntimeGitOperation, RuntimeGitReader } from '../../src/shared/runtime-git-reader.js';
import { deterministicNow } from '../helpers/runtime-fixtures.js';
import {
  cleanRelayResult,
  loadFixture,
  pinnedTargetFor,
  reviewRunFolderBase,
  runCompiledFlow,
  stagedReviewProject,
  useReviewRunFolders,
} from './review-wiring-harness.js';

const RANGE_MARKER = 'explicit-range-target-marker';

/** A reader that answers a pinned range read and nothing else. */
function rangeGitReader(projectRoot: string, seen: RuntimeGitOperation[]): RuntimeGitReader {
  const outputs: Readonly<Record<RuntimeGitOperation, string>> = {
    status: '',
    staged_diff: '',
    unstaged_diff: '',
    staged_diff_stat: '',
    unstaged_diff_stat: '',
    resolve_target: '',
    target_diff: `diff --git a/src/app.ts b/src/app.ts\n+${RANGE_MARKER}\n`,
    target_diff_stat: ' src/app.ts | 1 +\n',
    hidden_index_flags: '',
    staged_changed_gitlinks: '',
    unstaged_changed_gitlinks: '',
    untracked_files: '',
    tracked_files: '',
  };
  return {
    read: async (request) => {
      expect(request.projectRoot).toBe(projectRoot);
      seen.push(request.operation);
      return {
        schema_version: 1,
        ok: true,
        operation: request.operation,
        stdout: outputs[request.operation],
        stderr: '',
        exit_code: 0,
        truncated: false,
        limit_bytes: 2 * 1024 * 1024,
        cleanup_confirmed: true,
        ...(request.operation === 'resolve_target'
          ? { resolved_target: pinnedTargetFor(request.target) }
          : {}),
      };
    },
  };
}

function stubRelayer(receipt: string) {
  return {
    connectorName: 'codex' as const,
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => ({
      request_payload: input.prompt,
      receipt_id: receipt,
      result_body: JSON.stringify(cleanRelayResult()),
      duration_ms: 1,
      cli_version: '0.0.0-stub',
    }),
  };
}

function readIntake(runFolder: string): ReviewIntake {
  return ReviewIntake.parse(
    JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
  );
}

describe('review --target: the caller names the target', () => {
  useReviewRunFolders();

  // The load-bearing test. The goal text names the staged changes, which the
  // grammar reads correctly and would act on. The explicit target names a
  // range instead. If the flag is only a fallback for an unmatched goal, this
  // reviews the staged set and the flag is decorative.
  it('reviews the named target even when the goal prose names a different one', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'explicit-beats-prose');
    const projectRoot = join(reviewRunFolderBase(), 'explicit-beats-prose-project');
    mkdirSync(projectRoot, { recursive: true });
    const seen: RuntimeGitOperation[] = [];

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000301',
      goal: 'review the staged changes for regressions',
      target: 'main...HEAD',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      gitReader: rangeGitReader(projectRoot, seen),
      relayer: stubRelayer('stub-receipt-explicit-range'),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = readIntake(runFolder);
    expect(intake.target).toEqual({ kind: 'range', base: 'main', head: 'HEAD', dots: '...' });
    // The staged read never happened. The prose lost.
    expect(seen).toEqual(['resolve_target', 'target_diff', 'target_diff_stat']);
  });

  it('records a named target as named, and says nothing about inference', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'named-provenance');
    const projectRoot = stagedReviewProject('named-provenance-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000302',
      goal: 'look for regressions',
      target: 'staged',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('stub-receipt-named-staged'),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = readIntake(runFolder);
    expect(intake.target).toEqual({ kind: 'working_tree', mode: 'staged', explicit: true });
    expect(intake.target_provenance).toBe('named');
    const kinds = intake.evidence_warnings.map((warning) => warning.kind);
    expect(kinds).not.toContain('target_inferred');
    // A named target is not an assumption, so the assumption warning must not
    // fire either — the goal text here names no target at all.
    expect(kinds).not.toContain('target_assumed');
  });

  // Naming a target skips the prose parser, and the prose parser is what reads
  // path narrowings today. So a goal that says "only src/auth" alongside
  // --target would have its narrowing dropped on the floor. Dropping it in
  // silence is the exact failure this whole change exists to remove, so the
  // review runs wide and the report says which narrowing it could not honour.
  it('reports a prose narrowing it cannot apply alongside a named target', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'named-with-narrowing');
    const projectRoot = stagedReviewProject('named-with-narrowing-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000310',
      goal: 'review only src/auth for regressions',
      target: 'staged',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('stub-receipt-named-narrowing'),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = readIntake(runFolder);
    expect(intake.target).toEqual({ kind: 'working_tree', mode: 'staged', explicit: true });
    const notApplied = intake.evidence_warnings.filter(
      (warning) => warning.kind === 'scope_not_applied',
    );
    expect(notApplied).toHaveLength(1);
    expect(notApplied[0]?.message).toContain('src/auth');
  });

  it('stays quiet about narrowing when the goal asks for none', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'named-no-narrowing');
    const projectRoot = stagedReviewProject('named-no-narrowing-project');

    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000311',
      goal: 'look for regressions',
      target: 'staged',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('stub-receipt-named-no-narrowing'),
    });

    const kinds = readIntake(runFolder).evidence_warnings.map((warning) => warning.kind);
    expect(kinds).not.toContain('scope_not_applied');
  });

  it('accepts a named commit', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'named-commit');
    const projectRoot = join(reviewRunFolderBase(), 'named-commit-project');
    mkdirSync(projectRoot, { recursive: true });
    const seen: RuntimeGitOperation[] = [];

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000303',
      goal: 'look for regressions',
      target: 'commit:abc1234',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      gitReader: rangeGitReader(projectRoot, seen),
      relayer: stubRelayer('stub-receipt-named-commit'),
    });

    expect(outcome.outcome).toBe('complete');
    expect(readIntake(runFolder).target).toEqual({ kind: 'commit', ref: 'abc1234' });
  });

  it('accepts a two-dot range distinctly from a three-dot one', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'named-two-dot');
    const projectRoot = join(reviewRunFolderBase(), 'named-two-dot-project');
    mkdirSync(projectRoot, { recursive: true });
    const seen: RuntimeGitOperation[] = [];

    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000304',
      goal: 'look for regressions',
      target: 'HEAD~3..HEAD',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      gitReader: rangeGitReader(projectRoot, seen),
      relayer: stubRelayer('stub-receipt-named-two-dot'),
    });

    expect(readIntake(runFolder).target).toEqual({
      kind: 'range',
      base: 'HEAD~3',
      head: 'HEAD',
      dots: '..',
    });
  });

  // An explicitly named target that Review does not support is an error, not a
  // silent fallback to a guess. The caller said what they wanted; guessing
  // something else after being told is worse than saying so.
  it('rejects an unknown target kind by name and lists what exists', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'unknown-target');
    const projectRoot = join(reviewRunFolderBase(), 'unknown-target-project');
    mkdirSync(projectRoot, { recursive: true });
    let relayCalls = 0;
    let gitReads = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000305',
      goal: 'look for regressions',
      target: 'last-tuesday',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      gitReader: {
        read: async ({ operation }) => {
          gitReads += 1;
          throw new Error(`an unknown target must not request Git operation ${operation}`);
        },
      },
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('reviewer must not run for an unknown target');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toContain('last-tuesday');
    expect(outcome.reason).toMatch(/working-tree/);
    expect(outcome.reason).toMatch(/staged/);
    expect(outcome.reason).toMatch(/commit:/);
    expect(gitReads).toBe(0);
    expect(relayCalls).toBe(0);
  });

  it('rejects a target whose ref shape is unsafe', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'unsafe-ref');
    const projectRoot = join(reviewRunFolderBase(), 'unsafe-ref-project');
    mkdirSync(projectRoot, { recursive: true });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000306',
      goal: 'look for regressions',
      target: 'commit:--upload-pack=evil',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('stub-receipt-unsafe-ref'),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toContain('--upload-pack=evil');
  });
});

describe('review --target: the prose fallback is demoted, not removed', () => {
  useReviewRunFolders();

  // The confidently-wrong case, and the reason provenance is worth recording.
  // The grammar reads this goal correctly today and discloses nothing, so a
  // reader cannot tell a guess from a fact. The guess is now labelled.
  it('labels a target read out of prose as inferred even when a pattern matched', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'inferred-provenance');
    const projectRoot = stagedReviewProject('inferred-provenance-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000307',
      goal: 'review the staged changes for regressions',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('stub-receipt-inferred-staged'),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = readIntake(runFolder);
    expect(intake.target).toEqual({ kind: 'working_tree', mode: 'staged', explicit: true });
    expect(intake.target_provenance).toBe('inferred');
    const inferred = intake.evidence_warnings.find((warning) => warning.kind === 'target_inferred');
    expect(inferred?.message).toMatch(/--target/);
  });

  // Recording provenance in a report nobody opens is not a disclosure. The
  // operator brief is the surface a run is actually read on, so the inference
  // has to arrive there.
  it('carries the inference through to the operator brief', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'inferred-in-brief');
    const projectRoot = stagedReviewProject('inferred-in-brief-project');

    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000309',
      goal: 'review the staged changes for regressions',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('stub-receipt-inferred-brief'),
    });

    const runResult = RunResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8')),
    );
    const written = writeOperatorSummary({
      runFolder,
      runResult,
      route: { selectedFlow: 'review' },
    });

    const brief = readFileSync(written.markdownPath, 'utf8');
    expect(brief).toContain('--target');
  });

  // The two disclosures describe the same failure at different resolutions, so
  // only the more specific one fires. `target_assumed` already says the goal
  // named nothing; adding "inferred from the goal text" next to it says the
  // same thing twice and reads as two separate problems.
  it('does not double-report when the grammar matched nothing at all', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'assumed-not-doubled');
    const projectRoot = stagedReviewProject('assumed-not-doubled-project');

    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000308',
      goal: 'review this rollout plan for operational risks',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('stub-receipt-assumed-not-doubled'),
    });

    const intake = readIntake(runFolder);
    expect(intake.target_provenance).toBe('inferred');
    const kinds = intake.evidence_warnings.map((warning) => warning.kind);
    expect(kinds).toContain('target_assumed');
    expect(kinds).not.toContain('target_inferred');
  });
});

// `--target <path>` names a place, not a Git selector.
//
// The grammar this flag replaces already understood places: "review src/auth"
// scopes the read there. `--target` took only Git selectors, so the flag was
// strictly less capable than the sentence, and naming a directory outright was
// refused. These prove the whole path end to end: the run starts, the scope
// reaches the intake report, and a path with nothing changed in it comes back
// as the code as it stands rather than as an empty review.
describe('review --target: the caller names a path', () => {
  useReviewRunFolders();

  function projectWithSubdirectory(label: string): string {
    const projectRoot = join(reviewRunFolderBase(), label);
    mkdirSync(join(projectRoot, 'src', 'auth'), { recursive: true });
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'auth', 'login.ts'), 'export const login = 1;\n');
    writeFileSync(join(projectRoot, 'docs', 'guide.md'), '# guide\n');
    execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
    return projectRoot;
  }

  it('scopes the review to the named directory', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'named-path');
    const projectRoot = projectWithSubdirectory('named-path-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000401',
      goal: 'look for problems',
      target: 'src/auth',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('stub-receipt-named-path'),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = readIntake(runFolder);
    expect(intake.target).toMatchObject({
      kind: 'working_tree',
      explicit: true,
      paths: { include: ['src/auth'], exclude: [] },
    });
    // The caller said where. Nothing was recovered from prose, and nothing was
    // assumed about the subject.
    expect(intake.target_provenance).toBe('named');
    const kinds = intake.evidence_warnings.map((warning) => warning.kind);
    expect(kinds).not.toContain('target_inferred');
    expect(kinds).not.toContain('target_assumed');
  });

  it('reads the code as it stands when nothing changed at the named path', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'named-path-snapshot');
    const projectRoot = projectWithSubdirectory('named-path-snapshot-project');
    execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=t', 'commit', '-m', 'seed'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000402',
      goal: 'look for problems',
      target: 'src/auth',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('stub-receipt-named-path-snapshot'),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = readIntake(runFolder);
    expect(intake.target).toMatchObject({ kind: 'snapshot', paths: { include: ['src/auth'] } });
  });

  it('still refuses a value that names nothing in the repository', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'named-path-missing');
    const projectRoot = projectWithSubdirectory('named-path-missing-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000403',
      goal: 'look for problems',
      target: 'src/nope',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('stub-receipt-named-path-missing'),
    });

    expect(outcome.outcome).toBe('aborted');
    // The value reads as a path, so the refusal says the path was not found
    // rather than that the word was not understood, and still lists what
    // would have worked. The next attempt is one edit away either way.
    expect(outcome.reason).toContain('Review found no "src/nope" in this repository');
    expect(outcome.reason).toContain('a path in this repository');
  });
});
