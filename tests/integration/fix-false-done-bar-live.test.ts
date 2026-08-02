// Live False-Done Fix bar.
//
// Companion to fix-false-done-bar.test.ts. Where that file stubs the
// verification executor for fix-baseline-snapshot and fix-change-set so the
// scenarios are deterministic regardless of the host repo, these tests run
// the writers against a real temp git repo. Each test:
//
//   1. Creates a fresh temp directory + `git init` + initial commit
//   2. Optionally pre-mutates the working tree to simulate operator dirt
//   3. Runs the lite Fix CompiledFlow with the real verification executor;
//      the relay for fix-act both returns the bogus declaration AND makes
//      the file mutations a real implementer would
//   4. Asserts the run's outcome != 'fixed'
//
// These tests are slower (each spawns multiple git processes) but they
// prove that the helper script + writers handle real porcelain output, real
// hash-object fingerprints, and real HEAD movement — not just hand-stubbed
// observations. They cover the highest-value live cases:
//
//   - pre-dirty file mutation: a baseline-dirty file gets further modified
//     by fix-act and is omitted from changed_files. The fingerprint check
//     in the change-set writer catches it.
//   - pure HEAD divergence: fix-act commits the declared change. Working
//     tree is clean; HEAD moved. Caught by fix.change-set@v1.
//   - regression still failing: brief declares a real failing regression
//     command; fix-act doesn't actually fix the bug. Caught by
//     fix.regression-rerun@v1.
//   - contaminated tree: a file left dirty by earlier work is declared by an
//     implementer that never touched it. Its fingerprint never moves, so the
//     change set records it as pre-existing dirt and the real repair closes
//     'fixed' instead of aborting.

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import {
  FixBrief,
  FixChangeSet,
  type FixRegressionContract,
  FixResult,
  type FixVerificationCommand,
} from '../../src/flows/fix/reports.js';
import { executeCompose } from '../../src/runtime/executors/compose.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { VerificationCommand } from '../../src/schemas/verification.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const FIX_LITE_FIXTURE_PATH = resolve('generated/flows/fix/low.json');
const LIVE_FALSE_DONE_TIMEOUT_MS = 120_000;

function loadLiteFixture(): { bytes: Buffer } {
  return { bytes: readFileSync(FIX_LITE_FIXTURE_PATH) };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'False-Done Bar',
      GIT_AUTHOR_EMAIL: 'bar@false-done.test',
      GIT_COMMITTER_NAME: 'False-Done Bar',
      GIT_COMMITTER_EMAIL: 'bar@false-done.test',
    },
  });
}

function writeRepoFile(repo: string, relPath: string, body: string): void {
  const fullPath = join(repo, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body, 'utf8');
}

function appendRepoFile(repo: string, relPath: string, body: string): void {
  const fullPath = join(repo, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  appendFileSync(fullPath, body, 'utf8');
}

interface InitOptions {
  readonly initialFiles?: Record<string, string>;
}

function initRepo(options: InitOptions = {}): string {
  // Resolve the symlink-canonical path so the verification executor's
  // realpath check doesn't trip over /tmp -> /private/tmp on macOS.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'fix-live-bar-repo-')));
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  for (const [relPath, body] of Object.entries(options.initialFiles ?? {})) {
    writeRepoFile(repo, relPath, body);
  }
  // Always have at least one tracked file so HEAD points at a real commit.
  if (options.initialFiles === undefined || Object.keys(options.initialFiles).length === 0) {
    writeRepoFile(repo, 'README.md', '# bar fixture\n');
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'initial', '--quiet']);
  return repo;
}

const NOOP_VERIFY_COMMAND = {
  id: 'noop-verify',
  cwd: '.',
  argv: [process.execPath, '-e', 'process.exit(0)'],
  timeout_ms: 30_000,
  max_output_bytes: 200_000,
  env: {},
};

function regressionCommandThatChecksFile(repo: string, relPath: string, expected: string) {
  // Reads the file at relPath and exits 0 iff its content equals `expected`.
  // Used for live regression-still-failing: the bug is "file content is X
  // when it should be Y"; the regression command exits 1 until fix-act
  // makes content == Y.
  return VerificationCommand.parse({
    id: 'regression-checks-file',
    cwd: '.',
    argv: [
      process.execPath,
      '-e',
      `const fs=require('node:fs'); const c=fs.readFileSync(${JSON.stringify(join(repo, relPath))},'utf8'); process.exit(c===${JSON.stringify(expected)}?0:1);`,
    ],
    timeout_ms: 30_000,
    max_output_bytes: 200_000,
    env: {},
  });
}

interface BarBriefOptions {
  readonly goal: string;
  readonly regression: FixRegressionContract;
  readonly verificationCommand?: FixVerificationCommand;
}

function frameOverrideExecutors(options: BarBriefOptions): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      if (step.id !== 'fix-frame') {
        return await executeCompose(step, context);
      }
      const report = step.writes?.report;
      if (report === undefined) throw new Error("compose executor missing 'fix-frame' report");
      const brief = FixBrief.parse({
        problem_statement: options.goal,
        expected_behavior: `After fix: ${options.goal}`,
        observed_behavior: `Before fix: ${options.goal}`,
        scope: 'live false-done bar',
        regression_contract: options.regression,
        success_criteria: [`Verify exits 0 for: ${options.goal}`],
        verification_command_candidates: [options.verificationCommand ?? NOOP_VERIFY_COMMAND],
      });
      await context.files.writeJson(report, brief);
      await context.trace.append({
        run_id: context.runId,
        kind: 'step.report_written',
        step_id: step.id,
        attempt: context.activeStepAttempt ?? 1,
        report_path: report.path,
        ...(report.schema === undefined ? {} : { report_schema: report.schema }),
      });
      return { route: 'pass', details: { live: 'frame' } };
    },
  };
}

interface ActMutationOptions {
  readonly declaredChangedFiles: readonly string[];
  // Side effects on the repo to simulate fix-act actually editing files.
  readonly mutate: (repo: string) => void | Promise<void>;
}

function relayer(repo: string, options: ActMutationOptions): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input): Promise<RelayResult> => {
      const isContext = input.prompt.includes('Step: fix-gather-context');
      const isDiagnose = input.prompt.includes('Step: fix-diagnose');
      const isAct = input.prompt.includes('Step: fix-act');
      expect(isContext || isDiagnose || isAct).toBe(true);
      let body: string;
      if (isContext) {
        body = JSON.stringify({
          verdict: 'accept',
          sources: [{ kind: 'file', ref: 'README.md:1', summary: 'live fixture context' }],
          observations: ['live fixture observation'],
          open_questions: [],
        });
      } else if (isDiagnose) {
        body = JSON.stringify({
          verdict: 'accept',
          reproduction_status: 'reproduced',
          cause_summary: 'live fixture cause',
          confidence: 'high',
          evidence: ['live evidence'],
          residual_uncertainty: [],
        });
      } else {
        // fix-act: the implementer's "edit." Side-effect first so the file
        // changes are present before fix-verify and fix-change-set observe.
        await options.mutate(repo);
        body = JSON.stringify({
          verdict: 'accept',
          summary: 'live fixture change',
          diagnosis_ref: 'fix.diagnosis@v1',
          changed_files: [...options.declaredChangedFiles],
          evidence: ['live change evidence'],
        });
      }
      return {
        request_payload: input.prompt,
        receipt_id: isContext
          ? 'live-fix-context'
          : isDiagnose
            ? 'live-fix-diagnose'
            : 'live-fix-act',
        result_body: body,
        duration_ms: 1,
        cli_version: '0.0.0-live',
      };
    },
  };
}

function relayerWithTwoDeltaActs(repo: string, recordedDeclarations: string[][]): RelayFn {
  const supportRelayer = relayer(repo, {
    declaredChangedFiles: ['src/unreachable.ts'],
    mutate: () => {
      throw new Error('support relayer must not execute fix-act');
    },
  });
  let actAttempt = 0;

  return {
    connectorName: 'claude-code',
    relay: async (input): Promise<RelayResult> => {
      if (!input.prompt.includes('Step: fix-act')) {
        return await supportRelayer.relay(input);
      }

      actAttempt += 1;
      const declaredChangedFiles =
        actAttempt === 1 ? ['src/a.ts'] : actAttempt === 2 ? ['src/b.ts'] : undefined;
      if (declaredChangedFiles === undefined) {
        throw new Error(`expected exactly two fix-act attempts, got attempt ${actAttempt}`);
      }

      const changedFile = declaredChangedFiles[0];
      if (changedFile === undefined) throw new Error('delta act declaration missing');
      writeRepoFile(repo, changedFile, `export const attempt = ${actAttempt};\n`);
      recordedDeclarations.push([...declaredChangedFiles]);

      return {
        request_payload: input.prompt,
        receipt_id: `live-fix-delta-act-${actAttempt}`,
        result_body: JSON.stringify({
          verdict: 'accept',
          summary: `live delta attempt ${actAttempt}`,
          diagnosis_ref: 'fix.diagnosis@v1',
          changed_files: declaredChangedFiles,
          evidence: [`created ${changedFile}`],
        }),
        duration_ms: 1,
        cli_version: '0.0.0-live',
      };
    },
  };
}

let runFolderBase: string;
const repos: string[] = [];

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'fix-live-bar-runs-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe('Live False-Done Fix bar', () => {
  it(
    'carries accepted act declarations across a verification retry',
    async () => {
      const repo = initRepo();
      repos.push(repo);
      const runFolder = join(runFolderBase, 'verification-retry-cumulative-change-set');
      const recordedDeclarations: string[][] = [];
      const verifySecondDeltaExists: FixVerificationCommand = VerificationCommand.parse({
        id: 'verify-second-delta-exists',
        cwd: '.',
        argv: [
          process.execPath,
          '-e',
          `const fs=require('node:fs'); process.exit(fs.existsSync(${JSON.stringify(join(repo, 'src/b.ts'))})?0:1);`,
        ],
        timeout_ms: 30_000,
        max_output_bytes: 200_000,
        env: {},
      });
      const regressionFirstDeltaExists: FixVerificationCommand = VerificationCommand.parse({
        ...verifySecondDeltaExists,
        id: 'regression-first-delta-exists',
        argv: [
          process.execPath,
          '-e',
          `const fs=require('node:fs'); process.exit(fs.existsSync(${JSON.stringify(join(repo, 'src/a.ts'))})?0:1);`,
        ],
      });

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: loadLiteFixture().bytes,
        runId: 'f1000000-0000-0000-0000-0000000000aa',
        goal: 'carry cumulative declarations across verification rework',
        depth: 'low',
        now: deterministicNow(Date.UTC(2026, 4, 10, 12, 0, 0)),
        relayer: relayerWithTwoDeltaActs(repo, recordedDeclarations),
        executors: frameOverrideExecutors({
          goal: 'carry cumulative declarations across verification rework',
          regression: {
            expected_behavior: 'both accepted deltas remain in the final fix',
            actual_behavior: 'a retry can replace the first declaration with the second delta',
            repro: { kind: 'command', command: regressionFirstDeltaExists },
            regression_test: {
              status: 'failing-before-fix',
              command: regressionFirstDeltaExists,
            },
          },
          verificationCommand: verifySecondDeltaExists,
        }),
        projectRoot: repo,
      });

      if (outcome.outcome !== 'complete') {
        throw new Error(
          `expected complete, got ${outcome.outcome}: ${outcome.reason ?? '<no reason>'}`,
        );
      }
      expect(recordedDeclarations).toEqual([['src/a.ts'], ['src/b.ts']]);

      const changeSet = FixChangeSet.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/fix/change-set.json'), 'utf8')),
      );
      expect(changeSet.status).toBe('pass');
      expect(changeSet.declared).toEqual(['src/a.ts', 'src/b.ts']);
      expect(changeSet.observed).toEqual(['src/a.ts', 'src/b.ts']);
      expect(changeSet.undeclared_extras).toEqual([]);
      expect(changeSet.missing_declared).toEqual([]);

      const trace = await new TraceStore(runFolder).load();
      const verificationChecks = trace.filter(
        (entry): entry is Extract<(typeof trace)[number], { kind: 'check.evaluated' }> =>
          entry.kind === 'check.evaluated' &&
          entry.step_id === 'fix-verify' &&
          entry.check_kind === 'schema_sections',
      );
      expect(verificationChecks.map((entry) => entry.outcome)).toEqual(['fail', 'pass']);
    },
    LIVE_FALSE_DONE_TIMEOUT_MS,
  );

  it(
    "denies 'fixed' when fix-act mutates a baseline-dirty file but omits it from changed_files",
    async () => {
      // Pre-dirty: src/preexisting.ts is committed, then operator-dirtied.
      // Fix-act declares only ['src/a.ts'] but ALSO appends to
      // src/preexisting.ts (pretending the operator's earlier edit owns the
      // dirt). The fingerprint check in fix.change-set@v1 catches the further
      // mutation as an undeclared extra.
      const repo = initRepo({
        initialFiles: { 'src/preexisting.ts': 'export const initial = 1;\n' },
      });
      repos.push(repo);
      appendRepoFile(repo, 'src/preexisting.ts', '// operator was investigating\n');

      const runDir = join(runFolderBase, 'pre-dirty');
      const outcome = await runCompiledFlow({
        runDir,
        flowBytes: loadLiteFixture().bytes,
        runId: 'f1000000-0000-0000-0000-0000000000bb',
        goal: 'fix the broken initialization',
        depth: 'low',
        now: deterministicNow(Date.UTC(2026, 4, 10, 12, 0, 0)),
        relayer: relayer(repo, {
          declaredChangedFiles: ['src/a.ts'],
          mutate: (r) => {
            writeRepoFile(r, 'src/a.ts', 'export const a = 1;\n');
            // The undeclared mutation: appending to the baseline-dirty file.
            appendRepoFile(r, 'src/preexisting.ts', '// fix-act snuck a change in\n');
          },
        }),
        executors: frameOverrideExecutors({
          goal: 'fix the broken initialization',
          regression: {
            expected_behavior: 'initialization completes',
            actual_behavior: 'initialization throws',
            repro: { kind: 'not-reproducible', deferred_reason: 'live bar uses no real repro' },
            regression_test: { status: 'deferred', deferred_reason: 'live bar uses no rerun' },
          },
        }),
        projectRoot: repo,
      });

      // fix.change-set@v1 keeps failing on the undeclared mutation; recovery
      // routes to retry until attempts are exhausted, then the step's declared
      // exhaustion route advances the run to close with the failure on record.
      // The run stops (never completes) and the result denies 'fixed'.
      expect(outcome.outcome).toBe('stopped');
      expect(outcome.reason ?? '').toMatch(/primary result/);
      const primary = JSON.parse(
        readFileSync(join(runDir, 'reports', 'fix-result.json'), 'utf8'),
      ) as { outcome: string; change_set_status: string };
      expect(primary.outcome).not.toBe('fixed');
      expect(primary.change_set_status).toBe('fail');
    },
    LIVE_FALSE_DONE_TIMEOUT_MS,
  );

  it(
    "denies 'fixed' when fix-act commits the declared change mid-run (HEAD diverges)",
    async () => {
      // Working tree is clean post-commit; baseline_head_sha != head_sha.
      // The change-set writer flags HEAD divergence as fail even with
      // otherwise-clean path sets.
      const repo = initRepo();
      repos.push(repo);

      const runDir = join(runFolderBase, 'mid-run-commit');
      const outcome = await runCompiledFlow({
        runDir,
        flowBytes: loadLiteFixture().bytes,
        runId: 'f1000000-0000-0000-0000-0000000000cc',
        goal: 'fix the parser',
        depth: 'low',
        now: deterministicNow(Date.UTC(2026, 4, 10, 12, 0, 0)),
        relayer: relayer(repo, {
          declaredChangedFiles: ['src/parser.ts'],
          mutate: (r) => {
            writeRepoFile(r, 'src/parser.ts', 'export const parse = (x) => x;\n');
            git(r, ['add', 'src/parser.ts']);
            git(r, ['commit', '--allow-empty', '-m', 'fix-act committed mid-run', '--quiet']);
          },
        }),
        executors: frameOverrideExecutors({
          goal: 'fix the parser',
          regression: {
            expected_behavior: 'parser handles input',
            actual_behavior: 'parser throws',
            repro: { kind: 'not-reproducible', deferred_reason: 'live bar uses no real repro' },
            regression_test: { status: 'deferred', deferred_reason: 'live bar uses no rerun' },
          },
        }),
        projectRoot: repo,
      });

      // HEAD divergence keeps failing the change-set; once the retry budget is
      // spent the declared exhaustion route closes the run with the failure on
      // record instead of aborting. Stopped, and the result denies 'fixed'.
      expect(outcome.outcome).toBe('stopped');
      expect(outcome.reason ?? '').toMatch(/primary result/);
      const primary = JSON.parse(
        readFileSync(join(runDir, 'reports', 'fix-result.json'), 'utf8'),
      ) as { outcome: string; change_set_status: string };
      expect(primary.outcome).not.toBe('fixed');
      expect(primary.change_set_status).toBe('fail');
    },
    LIVE_FALSE_DONE_TIMEOUT_MS,
  );

  it(
    "denies 'fixed' when the regression command still fails post-fix",
    async () => {
      // Brief declares a real failing regression command. Fix-act writes a
      // change to a different file (so fix.change-set passes — declared
      // matches observed) but does NOT touch the file the regression command
      // checks. fix.regression-rerun reruns the command, which still fails,
      // and the chain aborts via recovery routing.
      const repo = initRepo({
        initialFiles: { 'src/buggy.ts': 'export const v = "broken";\n' },
      });
      repos.push(repo);
      const expectedFixedContent = 'export const v = "fixed";\n';
      const regression = regressionCommandThatChecksFile(
        repo,
        'src/buggy.ts',
        expectedFixedContent,
      );

      const runDir = join(runFolderBase, 'regression-still-failing');
      const outcome = await runCompiledFlow({
        runDir,
        flowBytes: loadLiteFixture().bytes,
        runId: 'f1000000-0000-0000-0000-0000000000dd',
        goal: 'fix the bug in v',
        depth: 'low',
        now: deterministicNow(Date.UTC(2026, 4, 10, 12, 0, 0)),
        relayer: relayer(repo, {
          // Declare an unrelated file so change-set passes; the regression
          // command checks src/buggy.ts which we never touch — that's the
          // false-done.
          declaredChangedFiles: ['src/notes.ts'],
          mutate: (r) => {
            writeRepoFile(r, 'src/notes.ts', '// notes\n');
          },
        }),
        executors: frameOverrideExecutors({
          goal: 'fix the bug in v',
          regression: {
            expected_behavior: 'v is "fixed"',
            actual_behavior: 'v is "broken"',
            repro: { kind: 'command', command: regression },
            regression_test: { status: 'failing-before-fix', command: regression },
          },
        }),
        projectRoot: repo,
      });

      // The rerun keeps proving the regression still fails; after the retry
      // budget is spent the declared exhaustion route closes the run with the
      // still-failing rerun on record. Stopped, and the result denies 'fixed'.
      expect(outcome.outcome).toBe('stopped');
      expect(outcome.reason ?? '').toMatch(/primary result/);
      const primary = JSON.parse(
        readFileSync(join(runDir, 'reports', 'fix-result.json'), 'utf8'),
      ) as { outcome: string; regression_rerun_status: string };
      expect(primary.outcome).not.toBe('fixed');
      expect(primary.regression_rerun_status).toBe('still-failing');
    },
    LIVE_FALSE_DONE_TIMEOUT_MS,
  );

  it(
    "permits 'fixed' on a clean live run (sanity: the pillars don't false-positive)",
    async () => {
      // Sanity case: brief declares a real failing regression command, fix-act
      // makes the exact change the regression command checks for and declares
      // it correctly. All pillars should pass and the run should close as
      // 'fixed'. If this test starts failing, the new gating is too strict.
      const repo = initRepo({
        initialFiles: { 'src/buggy.ts': 'export const v = "broken";\n' },
      });
      repos.push(repo);
      const expectedFixedContent = 'export const v = "fixed";\n';
      const regression = regressionCommandThatChecksFile(
        repo,
        'src/buggy.ts',
        expectedFixedContent,
      );

      const outcome = await runCompiledFlow({
        runDir: join(runFolderBase, 'clean-fixed'),
        flowBytes: loadLiteFixture().bytes,
        runId: 'f1000000-0000-0000-0000-0000000000ee',
        goal: 'fix the bug in v cleanly',
        depth: 'low',
        now: deterministicNow(Date.UTC(2026, 4, 10, 12, 0, 0)),
        relayer: relayer(repo, {
          declaredChangedFiles: ['src/buggy.ts'],
          mutate: (r) => {
            writeRepoFile(r, 'src/buggy.ts', expectedFixedContent);
          },
        }),
        executors: frameOverrideExecutors({
          goal: 'fix the bug in v cleanly',
          regression: {
            expected_behavior: 'v is "fixed"',
            actual_behavior: 'v is "broken"',
            repro: { kind: 'command', command: regression },
            regression_test: { status: 'failing-before-fix', command: regression },
          },
        }),
        projectRoot: repo,
      });

      if (outcome.outcome !== 'complete') {
        throw new Error(
          `expected complete, got ${outcome.outcome}: ${outcome.reason ?? '<no reason>'}`,
        );
      }
      const result = FixResult.parse(
        JSON.parse(
          readFileSync(join(runFolderBase, 'clean-fixed', 'reports/fix-result.json'), 'utf8'),
        ),
      );
      expect(result.outcome).toBe('fixed');
      expect(result.regression_status).toBe('proved');
      expect(result.regression_rerun_status).toBe('cleared');
      expect(result.change_set_status).toBe('pass');
    },
    LIVE_FALSE_DONE_TIMEOUT_MS,
  );

  it(
    "permits 'fixed' when the implementer declares a file an earlier run left dirty",
    async () => {
      // Contamination case. src/stale.ts was left modified and uncommitted by
      // earlier work before this run started. The implementer read the working
      // tree, took that dirt for its own, and declared it alongside the file it
      // really changed. Its content never moves during the run, so the change
      // set records it as pre-existing dirt rather than aborting a repair that
      // genuinely worked.
      const repo = initRepo({
        initialFiles: { 'src/stale.ts': 'export const stale = 1;\n' },
      });
      repos.push(repo);
      appendRepoFile(repo, 'src/stale.ts', '// left behind by an earlier run\n');

      const expectedFixedContent = 'export const v = "fixed";\n';
      const regression = regressionCommandThatChecksFile(
        repo,
        'src/buggy.ts',
        expectedFixedContent,
      );
      const runDir = join(runFolderBase, 'contaminated-tree');

      const outcome = await runCompiledFlow({
        runDir,
        flowBytes: loadLiteFixture().bytes,
        runId: 'f1000000-0000-0000-0000-0000000000ff',
        goal: 'fix v in a working tree that was already dirty',
        depth: 'low',
        now: deterministicNow(Date.UTC(2026, 4, 10, 12, 0, 0)),
        relayer: relayer(repo, {
          declaredChangedFiles: ['src/buggy.ts', 'src/stale.ts'],
          mutate: (r) => {
            writeRepoFile(r, 'src/buggy.ts', expectedFixedContent);
          },
        }),
        executors: frameOverrideExecutors({
          goal: 'fix v in a working tree that was already dirty',
          regression: {
            expected_behavior: 'v is "fixed"',
            actual_behavior: 'v is "broken"',
            repro: { kind: 'command', command: regression },
            regression_test: { status: 'failing-before-fix', command: regression },
          },
        }),
        projectRoot: repo,
      });

      if (outcome.outcome !== 'complete') {
        throw new Error(
          `expected complete, got ${outcome.outcome}: ${outcome.reason ?? '<no reason>'}`,
        );
      }

      const changeSet = FixChangeSet.parse(
        JSON.parse(readFileSync(join(runDir, 'reports/fix/change-set.json'), 'utf8')),
      );
      expect(changeSet.status).toBe('pass');
      expect(changeSet.observed).toEqual(['src/buggy.ts']);
      expect(changeSet.missing_declared).toEqual([]);
      expect(changeSet.declared_pre_existing_dirt).toEqual(['src/stale.ts']);

      const result = FixResult.parse(
        JSON.parse(readFileSync(join(runDir, 'reports/fix-result.json'), 'utf8')),
      );
      expect(result.outcome).toBe('fixed');
      expect(result.change_set_status).toBe('pass');
    },
    LIVE_FALSE_DONE_TIMEOUT_MS,
  );
});
