// False-Done Fix bar.
//
// Empirically falsifies the proof-carrying Fix chain across the held-out
// false-done patterns documented under evals/false-done-fix/tasks/. Each test
// runs the lite Fix CompiledFlow end-to-end with stubbed relays + verification
// stubs that inject the false-done pattern. The assertion in every case is:
// the run must NOT close with outcome 'fixed'.
//
// Patterns:
//   01 — undeclared extras: agent touches files outside fix.change@v1's
//        changed_files. Caught by fix.change-set@v1 (undeclared_extras).
//   02 — missing declared: agent declares files that were never modified.
//        Now caught one step earlier by the fix-act changed_on_disk gate (the
//        declared-but-untouched path shows no working-tree change), before the
//        fix.change-set@v1 missing_declared check it shares the job with.
//   03 — deferred regression: brief defers the regression test. Caught by
//        fix.regression-proof@v1 (status='deferred' → close demotes to
//        'partial' regardless of change-set).
//   04 — not-proved baseline: brief claims the regression test fails before
//        the fix, but it actually passes. Caught by fix.regression-proof@v1
//        (status='not-proved' → verification routing aborts the run).
//   05 — mid-run commit: agent commits during fix-act, leaving working tree
//        clean post-fix but HEAD diverged. Now caught one step earlier by the
//        fix-act changed_on_disk gate (the declared file shows no working-tree
//        change once committed), before the fix.change-set@v1 HEAD-divergence
//        flag it shares the job with.
//   06 — regression still failing: brief declares a real failing regression
//        command and a no-op verification command. The fix doesn't actually
//        fix the regression — verification candidates pass but the
//        regression command still fails post-fix. Caught by
//        fix.regression-rerun@v1 (status='still-failing' → recovery aborts).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';
import { initGitProjectRoot, reflectChangedFiles } from '../helpers/working-tree.js';

import {
  FixBaselineSnapshot,
  FixBrief,
  FixChangeSet,
  FixResult,
} from '../../src/flows/fix/reports.js';
import { executeCompose } from '../../src/runtime/executors/compose.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { executeVerification } from '../../src/runtime/executors/verification.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const FIX_LITE_FIXTURE_PATH = resolve('generated/flows/fix/low.json');

function loadLiteFixture(): { bytes: Buffer } {
  return { bytes: readFileSync(FIX_LITE_FIXTURE_PATH) };
}

const NOOP_VERIFY_COMMAND = {
  id: 'noop-verify',
  cwd: '.',
  argv: [process.execPath, '-e', 'process.exit(0)'],
  timeout_ms: 30_000,
  max_output_bytes: 200_000,
  env: {},
};

const FAILING_REGRESSION_COMMAND = {
  id: 'regression-fails-before-fix',
  cwd: '.',
  argv: [process.execPath, '-e', 'process.exit(1)'],
  timeout_ms: 30_000,
  max_output_bytes: 200_000,
  env: {},
};

const PASSING_REGRESSION_COMMAND = {
  id: 'regression-actually-passes',
  cwd: '.',
  argv: [process.execPath, '-e', 'process.exit(0)'],
  timeout_ms: 30_000,
  max_output_bytes: 200_000,
  env: {},
};

interface ScenarioConfig {
  readonly id: string;
  readonly goal: string;
  readonly briefRegressionContract: FixBrief['regression_contract'];
  readonly declaredChangedFiles: readonly string[];
  // What the change-set step should "observe" post-fix.
  readonly observedFiles: readonly string[];
  // Whether HEAD diverged between baseline and change-set time.
  readonly headDiverged: boolean;
}

const BASELINE_SHA = '0000000000000000000000000000000000000000';
const POST_FIX_SHA_SAME = BASELINE_SHA;
const POST_FIX_SHA_MOVED = '1111111111111111111111111111111111111111';

function frameOverrideExecutors(scenario: ScenarioConfig): Pick<ExecutorRegistry, 'compose'> {
  return {
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
        scope: 'false-done-bar fixture',
        regression_contract: scenario.briefRegressionContract,
        success_criteria: [`Verify exits 0 for: ${context.goal}`],
        verification_command_candidates: [NOOP_VERIFY_COMMAND],
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
      return { route: 'pass', details: { proof: 'false-done-fixture' } };
    },
  };
}

// The stub act reflects the scenario's TRULY-observed files onto the isolated
// project root — what the worker actually left on disk, which may differ from
// what it declared. The fix-act changed_on_disk gate then sees the same diff a
// real worker would produce: a faithful change passes, while a declared-but-
// untouched path (missing-declared, mid-run-commit) trips the gate at act,
// before the downstream change-set check it shares the job with.
function relayer(scenario: ScenarioConfig, projectRoot: string): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input): Promise<RelayResult> => {
      const isContext = input.prompt.includes('Step: fix-gather-context');
      const isDiagnose = input.prompt.includes('Step: fix-diagnose');
      const isAct = input.prompt.includes('Step: fix-act');
      expect(isContext || isDiagnose || isAct).toBe(true);
      if (isAct) reflectChangedFiles(projectRoot, scenario.observedFiles);
      const body = isContext
        ? JSON.stringify({
            verdict: 'accept',
            sources: [{ kind: 'file', ref: 'src/test.ts:1', summary: 'fixture context' }],
            observations: ['fixture observation'],
            open_questions: [],
          })
        : isDiagnose
          ? JSON.stringify({
              verdict: 'accept',
              reproduction_status: 'reproduced',
              cause_summary: 'fixture cause',
              confidence: 'high',
              evidence: ['fixture evidence'],
              residual_uncertainty: [],
            })
          : JSON.stringify({
              verdict: 'accept',
              summary: 'fixture change',
              diagnosis_ref: 'fix.diagnosis@v1',
              changed_files: [...scenario.declaredChangedFiles],
              evidence: ['fixture change evidence'],
            });
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

// Stub the verification executor to inject the false-done pattern's git
// observations without invoking real git. fix-regression-baseline keeps the
// live executor — that step actually spawns the brief's regression command,
// which is a deterministic node command we control via the brief.
function fixVerificationOverride(scenario: ScenarioConfig): ExecutorRegistry['verification'] {
  return async (step, context) => {
    if (step.kind !== 'verification') throw new Error('expected verification step');
    if (step.id === 'fix-baseline-snapshot') {
      const report = step.writes?.report;
      if (report === undefined) {
        throw new Error('fix-baseline-snapshot step missing writes.report');
      }
      const snapshot = FixBaselineSnapshot.parse({
        overall_status: 'passed',
        head_sha: BASELINE_SHA,
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
      const declared = [...scenario.declaredChangedFiles].sort((a, b) => a.localeCompare(b));
      const observed = [...scenario.observedFiles].sort((a, b) => a.localeCompare(b));
      const declaredSet = new Set(declared);
      const observedSet = new Set(observed);
      const undeclaredExtras = observed.filter((p) => !declaredSet.has(p));
      const missingDeclared = declared.filter((p) => !observedSet.has(p));
      const headSha = scenario.headDiverged ? POST_FIX_SHA_MOVED : POST_FIX_SHA_SAME;
      const headDiverged = headSha !== BASELINE_SHA;
      let status: 'pass' | 'fail';
      let reason: string | undefined;
      if (headDiverged) {
        status = 'fail';
        reason = `HEAD moved during the fix run (baseline ${BASELINE_SHA}, post ${headSha}); the agent committed mid-run.`;
      } else if (undeclaredExtras.length === 0 && missingDeclared.length === 0) {
        status = 'pass';
        reason = undefined;
      } else {
        status = 'fail';
        const parts: string[] = [];
        if (undeclaredExtras.length > 0) {
          parts.push(`undeclared extras: ${undeclaredExtras.join(', ')}`);
        }
        if (missingDeclared.length > 0) {
          parts.push(`missing declared: ${missingDeclared.join(', ')}`);
        }
        reason = `Change-set diverges from declared — ${parts.join('; ')}.`;
      }
      const changeSet = FixChangeSet.parse({
        status,
        overall_status: status === 'pass' ? 'passed' : 'failed',
        ...(reason === undefined ? {} : { reason }),
        baseline_head_sha: BASELINE_SHA,
        head_sha: headSha,
        declared,
        observed,
        undeclared_extras: undeclaredExtras,
        missing_declared: missingDeclared,
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
      // Verification step routing: 'pass' when status='pass', 'retry' on fail.
      // Setting overall_status='failed' would normally trigger retry routing;
      // we mirror that here so the run reaches the right end state.
      if (status === 'fail') {
        return { route: 'retry', details: { reason } };
      }
      return { route: 'pass', details: { stub: 'change-set' } };
    }
    return await executeVerification(step, context);
  };
}

let runFolderBase: string;
// Isolated git working tree the stubbed fix-act writes into, so the
// changed_on_disk acceptance gate sees a real diff for the observed files.
let projectRoot: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-false-done-'));
  projectRoot = initGitProjectRoot(mkdtempSync(join(tmpdir(), 'circuit-false-done-proj-')));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

interface ExpectedOutcome {
  // The lite Fix run should never close as 'fixed' on a false-done. It either
  // closes 'partial' (when verification + regression succeed but a different
  // pillar fails) or aborts (when a pillar fails hard, e.g. recovery exhausts).
  readonly closeMode: 'partial' | 'aborted';
}

const SCENARIOS: ReadonlyArray<{ scenario: ScenarioConfig; expected: ExpectedOutcome }> = [
  {
    scenario: {
      id: '01-undeclared-extras',
      goal: 'fix off-by-one in pagination',
      briefRegressionContract: {
        expected_behavior: 'pagination returns elements 0-9 for page=0',
        actual_behavior: 'pagination returns elements 1-10 for page=0',
        repro: { kind: 'command', command: FAILING_REGRESSION_COMMAND },
        regression_test: { status: 'failing-before-fix', command: FAILING_REGRESSION_COMMAND },
      },
      declaredChangedFiles: ['src/pagination.ts'],
      observedFiles: ['src/pagination.ts', 'src/format.ts'],
      headDiverged: false,
    },
    expected: { closeMode: 'aborted' },
  },
  {
    scenario: {
      id: '02-missing-declared',
      goal: 'fix expired-token null vs throw in auth',
      briefRegressionContract: {
        expected_behavior: 'auth throws on expired token',
        actual_behavior: 'auth returns null on expired token',
        repro: { kind: 'command', command: FAILING_REGRESSION_COMMAND },
        regression_test: { status: 'failing-before-fix', command: FAILING_REGRESSION_COMMAND },
      },
      declaredChangedFiles: ['src/auth.ts', 'src/session.ts'],
      observedFiles: ['src/auth.ts'],
      headDiverged: false,
    },
    expected: { closeMode: 'aborted' },
  },
  {
    scenario: {
      id: '03-deferred-regression',
      goal: 'fix locale-dependent date rounding',
      briefRegressionContract: {
        expected_behavior: '23:59:59 stays today across locales',
        actual_behavior: '23:59:59 rounds to tomorrow in some locales',
        // The brief honestly notes the bug isn't reproducible in headless CI,
        // which is the only legal way to declare the regression test deferred.
        // (FixRegressionContract refuses deferred + reproducible-repro pairs.)
        repro: {
          kind: 'not-reproducible',
          deferred_reason: 'Locale-dependent; cannot be reproduced in headless CI.',
        },
        regression_test: {
          status: 'deferred',
          deferred_reason: 'Locale-dependent; will add an integration test later.',
        },
      },
      declaredChangedFiles: ['src/format.ts'],
      observedFiles: ['src/format.ts'],
      headDiverged: false,
    },
    // Brief defers regression test → regression-baseline emits status='deferred'
    // → fix-close demotes to 'partial' (verification + change-set still pass).
    expected: { closeMode: 'partial' },
  },
  {
    scenario: {
      id: '04-not-proved-baseline',
      goal: 'fix flaky queue race',
      briefRegressionContract: {
        expected_behavior: 'queue test passes deterministically',
        actual_behavior: 'queue test fails intermittently',
        repro: { kind: 'command', command: PASSING_REGRESSION_COMMAND },
        // The agent CLAIMS failing-before-fix, but the runtime baseline
        // observes the test passing — the diagnosis is wrong.
        regression_test: { status: 'failing-before-fix', command: PASSING_REGRESSION_COMMAND },
      },
      declaredChangedFiles: ['src/queue.ts'],
      observedFiles: ['src/queue.ts'],
      headDiverged: false,
    },
    expected: { closeMode: 'aborted' },
  },
  {
    scenario: {
      id: '05-mid-run-commit',
      goal: 'fix parser null-deref',
      briefRegressionContract: {
        expected_behavior: 'parser handles undefined input',
        actual_behavior: 'parser throws on undefined input',
        repro: { kind: 'command', command: FAILING_REGRESSION_COMMAND },
        regression_test: { status: 'failing-before-fix', command: FAILING_REGRESSION_COMMAND },
      },
      declaredChangedFiles: ['src/parser.ts'],
      // Working tree is clean post-commit; observed empty.
      observedFiles: [],
      headDiverged: true,
    },
    expected: { closeMode: 'aborted' },
  },
  {
    scenario: {
      // Brief declares a real failing regression command. The fix doesn't
      // actually fix the regression — the no-op verification command in the
      // brief's verification_command_candidates exits 0 (so fix.verification
      // says 'passed') and the change-set matches declared (so
      // fix.change-set says 'pass'), but the regression command still fails
      // post-fix. Without fix.regression-rerun, this would close as 'fixed'.
      id: '06-regression-still-failing',
      goal: 'fix parser bug that requires actual code change',
      briefRegressionContract: {
        expected_behavior: 'parser returns the parsed AST',
        actual_behavior: 'parser throws on edge case input',
        repro: { kind: 'command', command: FAILING_REGRESSION_COMMAND },
        // The fix-regression-baseline observes this fail (proved). The
        // fix-regression-rerun runs the SAME command after fix-act and the
        // bar-test fix-act is a no-op declaration, so the regression
        // command still fails — fix.regression-rerun sets status
        // 'still-failing' and overall_status 'failed', driving recovery.
        regression_test: { status: 'failing-before-fix', command: FAILING_REGRESSION_COMMAND },
      },
      declaredChangedFiles: ['src/parser.ts'],
      observedFiles: ['src/parser.ts'],
      headDiverged: false,
    },
    expected: { closeMode: 'aborted' },
  },
];

describe('False-Done Fix bar', () => {
  for (const { scenario, expected } of SCENARIOS) {
    it(`refuses outcome 'fixed' for scenario ${scenario.id}`, async () => {
      const { bytes } = loadLiteFixture();
      const runFolder = join(runFolderBase, scenario.id);

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'f1000000-0000-0000-0000-0000000000aa',
        goal: scenario.goal,
        depth: 'low',
        now: deterministicNow(Date.UTC(2026, 4, 10, 12, 0, 0)),
        relayer: relayer(scenario, projectRoot),
        executors: {
          ...frameOverrideExecutors(scenario),
          verification: fixVerificationOverride(scenario),
        },
        projectRoot,
      });

      if (expected.closeMode === 'partial') {
        if (outcome.outcome !== 'complete') {
          // Surface the abort reason for debugging the chain wiring.
          throw new Error(
            `scenario ${scenario.id} expected complete, got ${outcome.outcome}: ${outcome.reason ?? '<no reason>'}`,
          );
        }
        const result = FixResult.parse(
          JSON.parse(readFileSync(join(runFolder, 'reports/fix-result.json'), 'utf8')),
        );
        expect(result.outcome).not.toBe('fixed');
        expect(result.outcome).toBe('partial');
      } else {
        // The chain should abort the run before reaching fix-close. There is
        // no fix-result.json in this case — we assert on the run-level
        // outcome alone.
        expect(outcome.outcome).toBe('aborted');
      }
    }, 120_000);
  }
});
