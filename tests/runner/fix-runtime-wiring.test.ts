// End-to-end runtime wiring for the lite Fix flow.
//
// Loads `generated/flows/fix/low.json` (the compiled lite-mode
// CompiledFlow) and runs it through `runCompiledFlow` with stubbed relayers
// for context/diagnose/act and a custom compose executor that overrides
// fix-frame to produce a brief with a fast no-op verification command.
// Other compose steps fall through to the registered writer, so this
// is a real proof that fix.brief, fix.verify, and fix.result close
// writers compose correctly through the actual CompiledFlow + runtime runner.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';
import { initGitProjectRoot, reflectClaimedChangedFiles } from '../helpers/working-tree.js';

import {
  FixBaselineSnapshot,
  FixBrief,
  FixChangeSet,
  FixRegressionProof,
  FixRegressionRerun,
  FixResult,
} from '../../src/flows/fix/reports.js';
import { executeCompose } from '../../src/runtime/executors/compose.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { executeVerification } from '../../src/runtime/executors/verification.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const FIX_DEFAULT_FIXTURE_PATH = resolve('generated/flows/fix/circuit.json');
const FIX_LITE_FIXTURE_PATH = resolve('generated/flows/fix/low.json');

function loadDefaultFixture(): { bytes: Buffer } {
  return { bytes: readFileSync(FIX_DEFAULT_FIXTURE_PATH) };
}

function loadLiteFixture(): { bytes: Buffer } {
  return { bytes: readFileSync(FIX_LITE_FIXTURE_PATH) };
}

// Custom compose executor for the e2e test: overrides fix-frame to
// produce a brief with a fast no-op verification command (so fix-verify
// runs in milliseconds instead of executing real `npm run verify`),
// and falls through to the standard registered compose executor for every
// other compose step (notably fix-close-low, which exercises the
// registered fix.result close writer).
// Override the live verification executor for the two new git-driven steps
// (fix-baseline-snapshot and fix-change-set). The live executor would shell
// out to `git status --porcelain` against the host repo and fail because the
// stubbed fix-act doesn't actually touch `src/test.ts`. This stub writes a
// passing change-set for the file the relayer declared, so the e2e test
// exercises the full graph (including fix-close-low reading change-set)
// without needing a controlled git workspace.
function fixVerificationOverride(): ExecutorRegistry['verification'] {
  return async (step, context) => {
    if (step.kind !== 'verification') throw new Error('expected verification step');
    if (step.id === 'fix-regression-baseline') {
      const report = step.writes?.report;
      if (report === undefined) {
        throw new Error('fix-regression-baseline step missing writes.report');
      }
      const regression = FixRegressionProof.parse({
        status: 'proved',
        overall_status: 'passed',
        baseline: {
          command_id: 'fix-regression',
          cwd: '.',
          argv: [process.execPath, '-e', 'process.exit(1)'],
          timeout_ms: 30_000,
          max_output_bytes: 200_000,
          env: {},
          exit_code: 1,
          command_status: 'failed',
          duration_ms: 1,
          stdout_summary: '',
          stderr_summary: '',
        },
      });
      await context.files.writeJson(report, regression);
      await context.trace.append({
        run_id: context.runId,
        kind: 'step.report_written',
        step_id: step.id,
        attempt: context.activeStepAttempt ?? 1,
        report_path: report.path,
        ...(report.schema === undefined ? {} : { report_schema: report.schema }),
      });
      return { route: 'pass', details: { stub: 'regression-baseline' } };
    }
    if (step.id === 'fix-baseline-snapshot') {
      const report = step.writes?.report;
      if (report === undefined) {
        throw new Error('fix-baseline-snapshot step missing writes.report');
      }
      const snapshot = FixBaselineSnapshot.parse({
        overall_status: 'passed',
        head_sha: '0000000000000000000000000000000000000000',
        entries: [],
        hidden_index_flags: [],
      });
      await context.files.writeJson(report, snapshot);
      await context.trace.append({
        run_id: context.runId,
        kind: 'step.report_written',
        step_id: step.id,
        attempt: context.activeStepAttempt ?? 1,
        report_path: report.path,
        ...(report.schema === undefined ? {} : { report_schema: report.schema }),
      });
      return { route: 'pass', details: { stub: 'baseline-snapshot' } };
    }
    if (step.id === 'fix-change-set') {
      const report = step.writes?.report;
      if (report === undefined) {
        throw new Error('fix-change-set step missing writes.report');
      }
      const changeSet = FixChangeSet.parse({
        status: 'pass',
        overall_status: 'passed',
        baseline_head_sha: '0000000000000000000000000000000000000000',
        head_sha: '0000000000000000000000000000000000000000',
        declared: ['src/test.ts'],
        observed: ['src/test.ts'],
        undeclared_extras: [],
        missing_declared: [],
        baseline_dirty_mutated: [],
        hidden_index_flags: [],
      });
      await context.files.writeJson(report, changeSet);
      await context.trace.append({
        run_id: context.runId,
        kind: 'step.report_written',
        step_id: step.id,
        attempt: context.activeStepAttempt ?? 1,
        report_path: report.path,
        ...(report.schema === undefined ? {} : { report_schema: report.schema }),
      });
      return { route: 'pass', details: { stub: 'change-set' } };
    }
    if (step.id === 'fix-regression-rerun') {
      const report = step.writes?.report;
      if (report === undefined) {
        throw new Error('fix-regression-rerun step missing writes.report');
      }
      const rerun = FixRegressionRerun.parse({
        status: 'cleared',
        overall_status: 'passed',
        rerun: {
          command_id: 'fix-regression',
          cwd: '.',
          argv: [process.execPath, '-e', 'process.exit(1)'],
          timeout_ms: 30_000,
          max_output_bytes: 200_000,
          env: {},
          exit_code: 0,
          command_status: 'passed',
          duration_ms: 1,
          stdout_summary: '',
          stderr_summary: '',
        },
      });
      await context.files.writeJson(report, rerun);
      await context.trace.append({
        run_id: context.runId,
        kind: 'step.report_written',
        step_id: step.id,
        attempt: context.activeStepAttempt ?? 1,
        report_path: report.path,
        ...(report.schema === undefined ? {} : { report_schema: report.schema }),
      });
      return { route: 'pass', details: { stub: 'regression-rerun' } };
    }
    return await executeVerification(step, context);
  };
}

function frameOverrideExecutors(): Pick<ExecutorRegistry, 'compose' | 'verification'> {
  return {
    verification: fixVerificationOverride(),
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      if (step.id !== 'fix-frame') {
        return await executeCompose(step, context);
      }
      const report = step.writes?.report;
      if (report === undefined) {
        throw new Error("Fix proof compose executor expected 'fix-frame' to write a report");
      }
      const brief = FixBrief.parse({
        problem_statement: context.goal,
        expected_behavior: `After fix: ${context.goal}`,
        observed_behavior: `Before fix: ${context.goal}`,
        scope: 'test scope',
        regression_contract: {
          expected_behavior: `After fix: ${context.goal}`,
          actual_behavior: `Before fix: ${context.goal}`,
          repro: {
            kind: 'not-reproducible',
            deferred_reason: 'e2e test - repro deferred',
          },
          regression_test: {
            status: 'deferred',
            deferred_reason: 'e2e test - regression test deferred',
          },
        },
        success_criteria: [`Verify exits 0 for: ${context.goal}`],
        verification_command_candidates: [
          {
            id: 'noop-verify',
            cwd: '.',
            argv: [process.execPath, '-e', 'process.exit(0)'],
            timeout_ms: 30_000,
            max_output_bytes: 200_000,
            env: {},
          },
        ],
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
      return { route: 'pass', details: { writer: step.writer, proof: 'test-fix-brief' } };
    },
  };
}

const CURRENT_CHANGE_SET_FAILURE_REASON =
  'CURRENT_CHANGE_SET_REASON: retry metadata omitted earlier changed files';

function frameOverrideExecutorsWithSecondChangeSetFailure(): Pick<
  ExecutorRegistry,
  'compose' | 'verification'
> {
  const base = frameOverrideExecutors();
  return {
    compose: base.compose,
    verification: async (step, context) => {
      if (
        step.kind === 'verification' &&
        step.id === 'fix-change-set' &&
        context.activeStepAttempt === 2
      ) {
        const report = step.writes?.report;
        if (report === undefined) throw new Error('fix-change-set step missing writes.report');
        const changeSet = FixChangeSet.parse({
          status: 'fail',
          overall_status: 'failed',
          reason: CURRENT_CHANGE_SET_FAILURE_REASON,
          baseline_head_sha: '0000000000000000000000000000000000000000',
          head_sha: '0000000000000000000000000000000000000000',
          declared: ['src/test.ts'],
          observed: ['src/current-failure.ts', 'src/test.ts'],
          undeclared_extras: ['src/current-failure.ts'],
          missing_declared: [],
          baseline_dirty_mutated: [],
          hidden_index_flags: [],
        });
        await context.files.writeJson(report, changeSet);
        await context.trace.append({
          run_id: context.runId,
          kind: 'step.report_written',
          step_id: step.id,
          attempt: 2,
          report_path: report.path,
          ...(report.schema === undefined ? {} : { report_schema: report.schema }),
        });
        await context.trace.append({
          run_id: context.runId,
          kind: 'check.evaluated',
          step_id: step.id,
          attempt: 2,
          check_kind: 'schema_sections',
          outcome: 'fail',
          reason: CURRENT_CHANGE_SET_FAILURE_REASON,
        });
        return { route: 'retry', details: { reason: CURRENT_CHANGE_SET_FAILURE_REASON } };
      }
      return await base.verification(step, context);
    },
  };
}

// The stub relayer reflects its self-reported `changed_files` onto disk in the
// isolated project root, exactly as a real worker would. The fix-act step now
// gates on those paths actually differing in the working tree, so a faithful
// stub must make its claim true.
function relayer(projectRoot: string): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input): Promise<RelayResult> => {
      const isContext = input.prompt.includes('Step: fix-gather-context');
      const isDiagnose = input.prompt.includes('Step: fix-diagnose');
      const isAct = input.prompt.includes('Step: fix-act');
      expect(isContext || isDiagnose || isAct).toBe(true);
      const body = isContext
        ? JSON.stringify({
            verdict: 'accept',
            sources: [{ kind: 'file', ref: 'src/test.ts:1', summary: 'stub source for e2e test' }],
            observations: ['Stubbed gather-context observation'],
            open_questions: [],
          })
        : isDiagnose
          ? JSON.stringify({
              verdict: 'accept',
              reproduction_status: 'reproduced',
              cause_summary: 'e2e test cause',
              confidence: 'high',
              evidence: ['Stubbed diagnose evidence'],
              residual_uncertainty: [],
            })
          : JSON.stringify({
              verdict: 'accept',
              summary: 'Stubbed change summary',
              diagnosis_ref: 'fix.diagnosis@v1',
              changed_files: ['src/test.ts'],
              evidence: ['Stubbed change evidence'],
            });
      if (isAct) reflectClaimedChangedFiles(projectRoot, body);
      return {
        request_payload: input.prompt,
        receipt_id: isContext
          ? 'stub-fix-context'
          : isDiagnose
            ? 'stub-fix-diagnose'
            : 'stub-fix-act',
        result_body: body,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

function relayerWithUnavailableReview(projectRoot: string): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input): Promise<RelayResult> => {
      if (input.prompt.includes('Step: fix-review')) {
        throw new Error('reviewer connector unavailable');
      }
      return relayer(projectRoot).relay(input);
    },
  };
}

interface ReviewReworkRecorder {
  readonly actPrompts: string[];
  readonly reviewPrompts: string[];
}

const REJECTING_REVIEW_MARKER =
  'BLOCKING_REVIEW_FEEDBACK_TOKEN: keep the newest tile owner authoritative';

function relayerWithReviewRework(
  projectRoot: string,
  recorder: ReviewReworkRecorder,
  reviewVerdicts: readonly ('reject' | 'accept')[],
): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input): Promise<RelayResult> => {
      if (input.prompt.includes('Step: fix-act')) {
        recorder.actPrompts.push(input.prompt);
        const body = JSON.stringify({
          verdict: 'accept',
          summary: 'Stubbed rework change summary',
          diagnosis_ref: 'fix.diagnosis@v1',
          changed_files: ['src/test.ts'],
          evidence: ['Stubbed rework evidence'],
        });
        reflectClaimedChangedFiles(projectRoot, body);
        return {
          request_payload: input.prompt,
          receipt_id: `stub-fix-act-${recorder.actPrompts.length}`,
          result_body: body,
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }

      if (input.prompt.includes('Step: fix-review')) {
        recorder.reviewPrompts.push(input.prompt);
        const verdict =
          reviewVerdicts[Math.min(recorder.reviewPrompts.length - 1, reviewVerdicts.length - 1)];
        const body =
          verdict === 'reject'
            ? {
                verdict: 'reject',
                summary: 'Blocking issue found',
                findings: [
                  {
                    severity: 'high',
                    text: REJECTING_REVIEW_MARKER,
                    file_refs: ['src/test.ts:1'],
                  },
                ],
              }
            : { verdict: 'accept', summary: 'Rework accepted', findings: [] };
        return {
          request_payload: input.prompt,
          receipt_id: `stub-fix-review-${recorder.reviewPrompts.length}`,
          result_body: JSON.stringify(body),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }

      return relayer(projectRoot).relay(input);
    },
  };
}

let runFolderBase: string;
// Isolated git working tree the stubbed fix-act writes into, so the
// changed_on_disk acceptance gate sees a real diff for the declared file.
let projectRoot: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-fix-runtime-'));
  projectRoot = initGitProjectRoot(mkdtempSync(join(tmpdir(), 'circuit-fix-proj-')));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('Lite Fix runtime wiring', () => {
  it('runs the live lite Fix CompiledFlow end-to-end and closes with a FixResult', async () => {
    const { bytes } = loadLiteFixture();
    const runFolder = join(runFolderBase, 'lite-complete');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'f1000000-0000-0000-0000-000000000000',
      goal: 'fix off-by-one in pagination',
      depth: 'low',
      now: deterministicNow(Date.UTC(2026, 3, 26, 10, 0, 0)),
      relayer: relayer(projectRoot),
      executors: frameOverrideExecutors(),
      projectRoot,
    });

    if (outcome.outcome !== 'complete') {
      throw new Error(
        `lite Fix run did not complete: outcome=${outcome.outcome} reason=${outcome.reason ?? '<none>'}`,
      );
    }
    expect(outcome.outcome).toBe('complete');
    expect(existsSync(join(runFolder, 'reports/fix/brief.json'))).toBe(true);
    expect(existsSync(join(runFolder, 'reports/fix/context.json'))).toBe(true);
    expect(existsSync(join(runFolder, 'reports/fix/diagnosis.json'))).toBe(true);
    expect(existsSync(join(runFolder, 'reports/fix/change.json'))).toBe(true);
    expect(existsSync(join(runFolder, 'reports/fix/verification.json'))).toBe(true);
    expect(existsSync(join(runFolder, 'reports/fix-result.json'))).toBe(true);

    const result = FixResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/fix-result.json'), 'utf8')),
    );
    expect(result.review_status).toBe('skipped');
    expect(result.verification_status).toBe('passed');
    expect(['fixed', 'partial']).toContain(result.outcome);
    // Required pointers — review absent in lite.
    const ids = result.evidence_links.map((p) => p.report_id);
    expect(ids).toEqual([
      'fix.brief',
      'fix.context',
      'fix.diagnosis',
      'fix.regression-proof',
      'fix.baseline-snapshot',
      'fix.change',
      'fix.verification',
      'fix.regression-rerun',
      'fix.change-set',
    ]);
  });
});

// The sour close. A Fix run whose repair worked, whose verification passed,
// whose change-set was clean, and whose reviewer accepted still closed
// 'partial' — which binds the run outcome to 'stopped', exit 1 — purely
// because no regression proof was captured.
//
// The frame step is read-only, so its relay honestly defers authoring a
// regression test: it cannot run anything to find out. fix-regression-baseline
// used to inherit that deferral instead of capturing the baseline itself, even
// though the brief hands it verification_command_candidates that Circuit
// resolved and that the baseline runs before fix-act touches anything.
//
// These two cases are the fork. In the first, the project's own check is red
// before the fix and green after: exactly the evidence a person would accept,
// so the run closes 'fixed'. In the second the check was already green, so
// there is no red to turn green — the run still needs attention, but it must
// not route to recovery and must say plainly what is missing.
const MARKER_PATH = 'src/test.ts';
const MARKER_CHECK_ARGV = [
  process.execPath,
  '-e',
  `process.exit(require('node:fs').existsSync(${JSON.stringify(MARKER_PATH)}) ? 0 : 1)`,
];
const ALWAYS_GREEN_ARGV = [process.execPath, '-e', 'process.exit(0)'];

function deferredBriefWithCandidate(
  candidateArgv: readonly string[],
): Pick<ExecutorRegistry, 'compose' | 'verification'> {
  return {
    // Only the two git-driven steps are stubbed. fix-regression-baseline,
    // fix-regression-rerun, and fix-verify all run for real, which is the
    // point: the baseline has to observe the red itself.
    verification: async (step, context) => {
      if (step.kind !== 'verification') throw new Error('expected verification step');
      if (step.id === 'fix-baseline-snapshot' || step.id === 'fix-change-set') {
        return await fixVerificationOverride()(step, context);
      }
      return await executeVerification(step, context);
    },
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      if (step.id !== 'fix-frame') return await executeCompose(step, context);
      const report = step.writes?.report;
      if (report === undefined) throw new Error("expected 'fix-frame' to write a report");
      const brief = FixBrief.parse({
        problem_statement: context.goal,
        expected_behavior: `After fix: ${context.goal}`,
        observed_behavior: `Before fix: ${context.goal}`,
        scope: 'test scope',
        regression_contract: {
          expected_behavior: `After fix: ${context.goal}`,
          actual_behavior: `Before fix: ${context.goal}`,
          repro: { kind: 'not-reproducible', deferred_reason: 'read-only frame step' },
          regression_test: {
            status: 'deferred',
            deferred_reason: 'read-only frame step cannot author a regression test',
          },
        },
        success_criteria: [`Verify exits 0 for: ${context.goal}`],
        verification_command_candidates: [
          {
            id: 'project-check',
            cwd: '.',
            argv: [...candidateArgv],
            timeout_ms: 30_000,
            max_output_bytes: 200_000,
            env: {},
          },
        ],
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
      return { route: 'pass', details: { stub: 'frame' } };
    },
  };
}

describe('Fix regression baseline when the brief deferred', () => {
  it('captures the baseline from the resolved check and closes fixed, not partial', async () => {
    const { bytes } = loadLiteFixture();
    const runFolder = join(runFolderBase, 'deferred-baseline-captured');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'f1000000-0000-0000-0000-000000000100',
      goal: 'fix off-by-one in pagination',
      depth: 'low',
      now: deterministicNow(Date.UTC(2026, 3, 26, 11, 0, 0)),
      relayer: relayer(projectRoot),
      executors: deferredBriefWithCandidate(MARKER_CHECK_ARGV),
      projectRoot,
    });

    expect(outcome.outcome).toBe('complete');

    const regression = FixRegressionProof.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/fix/regression-proof.json'), 'utf8')),
    );
    // The baseline ran the resolved check before fix-act and saw it fail.
    expect(regression.status).toBe('proved');
    expect(regression.command_source).toBe('adopted-verification');
    expect(regression.baseline?.argv).toEqual(MARKER_CHECK_ARGV);
    expect(regression.baseline?.command_status).toBe('failed');

    const rerun = FixRegressionRerun.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/fix/regression-rerun.json'), 'utf8')),
    );
    // And the SAME command cleared after the fix. Baseline and rerun must
    // agree on which command is the proof, or the rerun proves nothing.
    expect(rerun.status).toBe('cleared');
    expect(rerun.rerun?.argv).toEqual(MARKER_CHECK_ARGV);

    const result = FixResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/fix-result.json'), 'utf8')),
    );
    expect(result.regression_status).toBe('proved');
    expect(result.outcome).toBe('fixed');
  });

  it('continues, and names what is missing, when the check was already green', async () => {
    const { bytes } = loadLiteFixture();
    const runFolder = join(runFolderBase, 'deferred-baseline-not-captured');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'f1000000-0000-0000-0000-000000000101',
      goal: 'fix off-by-one in pagination',
      depth: 'low',
      now: deterministicNow(Date.UTC(2026, 3, 26, 11, 0, 0)),
      relayer: relayer(projectRoot),
      executors: deferredBriefWithCandidate(ALWAYS_GREEN_ARGV),
      projectRoot,
    });

    const regression = FixRegressionProof.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/fix/regression-proof.json'), 'utf8')),
    );
    expect(regression.status).toBe('not-captured');
    // The run reached its close instead of bouncing back to fix-frame. A suite
    // that never covered this bug is not a defect in the brief.
    expect(regression.overall_status).toBe('passed');

    const rerun = FixRegressionRerun.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/fix/regression-rerun.json'), 'utf8')),
    );
    // Nothing was proved, so there is nothing to clear. Re-running the already
    // green command here would let 'cleared' mean nothing.
    expect(rerun.status).toBe('deferred');

    const result = FixResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/fix-result.json'), 'utf8')),
    );
    expect(result.regression_status).toBe('deferred');
    expect(result.outcome).toBe('partial');

    // This run does need a look, so 'stopped' is right. What was wrong was the
    // operator having to go read reports to discover that the only shortfall
    // was missing proof.
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.reason).toContain('no before-and-after proof was captured for the reported bug');
  });
});

describe('Standard Fix review-unavailable wiring', () => {
  it('closes with proof evidence when the reviewer connector fails after verification passes', async () => {
    const { bytes } = loadDefaultFixture();
    const runFolder = join(runFolderBase, 'review-unavailable-complete');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'f1000000-0000-0000-0000-000000000001',
      goal: 'fix off-by-one in pagination',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 26, 11, 0, 0)),
      relayer: relayerWithUnavailableReview(projectRoot),
      executors: frameOverrideExecutors(),
      projectRoot,
    });

    if (outcome.outcome !== 'complete') {
      throw new Error(
        `standard Fix run did not complete: outcome=${outcome.outcome} reason=${outcome.reason ?? '<none>'}`,
      );
    }
    expect(outcome.outcome).toBe('complete');

    const result = FixResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/fix-result.json'), 'utf8')),
    );
    expect(result.outcome).toBe('fixed');
    expect(result.review_status).toBe('skipped');
    expect(result.review_skip_reason).toMatch(/Reviewer connector failed after proof passed/);
    expect(result.verification_status).toBe('passed');
    expect(result.regression_status).toBe('proved');
    expect(result.regression_rerun_status).toBe('cleared');
    expect(result.change_set_status).toBe('pass');
    expect(result.evidence_links.map((p) => p.report_id)).not.toContain('fix.review');

    const traceEntries = await new TraceStore(runFolder).load();
    const reviewFailure = traceEntries.find(
      (entry) => entry.kind === 'relay.failed' && entry.step_id === 'fix-review',
    );
    if (reviewFailure?.kind !== 'relay.failed') throw new Error('expected review relay failure');
    expect(reviewFailure.reason).toContain('reviewer connector unavailable');

    const reviewCompletion = traceEntries.find(
      (entry) => entry.kind === 'step.completed' && entry.step_id === 'fix-review',
    );
    if (reviewCompletion?.kind !== 'step.completed') {
      throw new Error('expected review step completion');
    }
    expect(reviewCompletion.route_taken).toBe('connector-failed');

    const closeCompletion = traceEntries.find(
      (entry) => entry.kind === 'step.completed' && entry.step_id === 'fix-close',
    );
    if (closeCompletion?.kind !== 'step.completed') {
      throw new Error('expected close completion');
    }
    expect(closeCompletion.route_taken).toBe('pass');
  });
});

describe('Standard Fix review rework wiring', () => {
  it('passes a rejected review into the retry implementer prompt', async () => {
    const { bytes } = loadDefaultFixture();
    const recorder: ReviewReworkRecorder = { actPrompts: [], reviewPrompts: [] };

    const outcome = await runCompiledFlow({
      runDir: join(runFolderBase, 'review-reject-then-accept'),
      flowBytes: bytes,
      runId: 'f1000000-0000-0000-0000-000000000002',
      goal: 'fix overlapping tile ownership',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 26, 12, 0, 0)),
      relayer: relayerWithReviewRework(projectRoot, recorder, ['reject', 'accept']),
      executors: frameOverrideExecutors(),
      projectRoot,
    });

    expect(outcome.outcome).toBe('complete');
    expect(recorder.actPrompts).toHaveLength(2);
    expect(recorder.reviewPrompts).toHaveLength(2);
    expect(recorder.actPrompts[0]).toContain('[reads unavailable: reports/fix/review.json]');
    expect(recorder.actPrompts[1]).toContain('<read path="reports/fix/review.json">');
    expect(recorder.actPrompts[1]).toContain(REJECTING_REVIEW_MARKER);
    expect(recorder.actPrompts[1]).toContain('src/test.ts:1');
  }, 120_000);

  it('uses the current failure reason at each exhaustion door across the change-set reroute', async () => {
    const { bytes } = loadDefaultFixture();
    const recorder: ReviewReworkRecorder = { actPrompts: [], reviewPrompts: [] };

    const runDir = join(runFolderBase, 'review-rework-current-retry-reason');
    const outcome = await runCompiledFlow({
      runDir,
      flowBytes: bytes,
      runId: 'f1000000-0000-0000-0000-000000000003',
      goal: 'surface the failure that actually exhausted the retry budget',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 26, 13, 0, 0)),
      relayer: relayerWithReviewRework(projectRoot, recorder, ['reject']),
      executors: frameOverrideExecutorsWithSecondChangeSetFailure(),
      projectRoot,
    });

    // First door: fix-change-set selects retry, finds fix-act exhausted, and
    // takes its declared exhaustion route instead of aborting. The reroute
    // must record the change-set failure that spent the budget, not the older
    // review reject from the corridor the run was inside.
    const entries = await new TraceStore(runDir).load();
    const reroutes = entries.filter((entry) => entry.kind === 'step.exhaustion_rerouted');
    expect(reroutes[0]).toMatchObject({
      step_id: 'fix-change-set',
      from_route: 'retry',
      to_route: 'continue',
    });
    expect(reroutes[0]?.reason ?? '').toContain(CURRENT_CHANGE_SET_FAILURE_REASON);

    // The run then moves forward with the failure on record: verify and the
    // regression rerun run again, and review runs a second time and rejects
    // again. That reject re-enters the review corridor and fix-act is still
    // exhausted. fix-review declares no exhaustion route, which used to abort
    // the run; it now falls back to fix-review's own stop route.
    //
    // The property this test exists for is unchanged, and it is the reason
    // discipline: each door cites the failure that actually spent the budget
    // in front of it. The second door says the reviewer rejected the work, and
    // must not still be quoting the change-set failure the first door handled.
    expect(recorder.actPrompts).toHaveLength(2);
    expect(recorder.reviewPrompts).toHaveLength(2);
    expect(reroutes[1]).toMatchObject({ step_id: 'fix-review', from_route: 'retry' });
    expect(reroutes[1]?.reason ?? '').toContain('max_attempts=2');
    expect(reroutes[1]?.reason ?? '').toContain(
      "the reviewer rejected the work (verdict 'reject')",
    );
    expect(reroutes[1]?.reason ?? '').not.toContain(CURRENT_CHANGE_SET_FAILURE_REASON);
    expect(outcome.outcome).toBe('stopped');
  }, 120_000);
});
