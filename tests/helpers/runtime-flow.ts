import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BuildBaselineSnapshot,
  BuildBrief,
  BuildContext,
  BuildImplementation,
  BuildPlan,
  BuildResult,
  BuildReview,
  BuildTouchArea,
  BuildVerification,
} from '../../src/flows/build/reports.js';
import {
  ExploreAnalysis,
  ExploreBrief,
  ExploreCompose,
  ExploreDecision,
  ExploreDecisionOptions,
  ExploreResult,
  ExploreReviewVerdict,
  ExploreTournamentAggregate,
  ExploreTournamentProposal,
  ExploreTournamentReview,
} from '../../src/flows/explore/reports.js';
import {
  FixBaselineSnapshot,
  FixBrief,
  FixChange,
  FixChangeSet,
  FixContext,
  FixDiagnosis,
  FixRegressionProof,
  FixRegressionRerun,
  FixResult,
  FixReview,
  FixVerification,
} from '../../src/flows/fix/reports.js';
import { ReviewIntake, ReviewRelayResult, ReviewResult } from '../../src/flows/review/reports.js';
import { combineRubricResult } from '../../src/policy/rubric.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import type { RelayConnector } from '../../src/runtime/executors/relay.js';
import type { ExecutableStep } from '../../src/runtime/manifest/executable-flow.js';
import { projectStatusFromTrace } from '../../src/runtime/projections/status.js';
import type {
  ChildCompiledFlowResolver,
  CompiledFlowRunner,
  WorktreeRunner,
} from '../../src/runtime/run/child-runner.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import {
  type CompiledFlow,
  CompiledFlow as CompiledFlowSchema,
} from '../../src/schemas/compiled-flow.js';
import { computeManifestHash } from '../../src/schemas/manifest.js';

export interface CompiledFlowFixture {
  readonly flow: CompiledFlow;
  readonly bytes: Buffer;
  readonly manifestHash: string;
}

const TERMINAL_TARGETS = new Set(['@complete', '@stop', '@handoff', '@escalate']);

const PASSING_RUBRIC_MODEL_JUDGMENTS = {
  evidence_rigor: 'pass',
  actionability: 'pass',
  coverage_adequacy: 'pass',
  scope_discipline: 'pass',
  honest_calibration: 'pass',
  project_specificity: 'pass',
  insight_density: 'pass',
  branch_distinctness: 'pass',
} as const;

function passingExploreRubricResult() {
  return combineRubricResult({
    orderedDims: Object.keys(PASSING_RUBRIC_MODEL_JUDGMENTS),
    dims: {
      evidence_rigor: { runtime_signal: 'met', model_judgment: 'pass' },
      actionability: { runtime_signal: 'met', model_judgment: 'pass' },
      coverage_adequacy: { runtime_signal: 'met', model_judgment: 'pass' },
      scope_discipline: { runtime_signal: 'met', model_judgment: 'pass' },
      honest_calibration: { runtime_signal: 'n/a', model_judgment: 'pass' },
      project_specificity: { runtime_signal: 'n/a', model_judgment: 'pass' },
      insight_density: { runtime_signal: 'n/a', model_judgment: 'pass' },
      branch_distinctness: { runtime_signal: 'n/a', model_judgment: 'pass' },
    },
  });
}

const commandSpec = {
  id: 'runtime-parity-check',
  cwd: '.',
  argv: [process.execPath, '-e', 'process.exit(0)'],
  timeout_ms: 30_000,
  max_output_bytes: 200_000,
  env: {},
};

// A regression-test command that exits non-zero. Used so the
// runtime-owned fix.regression-proof@v1 baseline observes the test failing
// before the fix (matching the brief's failing-before-fix expectation),
// which is what proves the test reproduces the bug.
const regressionCommandSpec = {
  id: 'runtime-parity-regression',
  cwd: '.',
  argv: [process.execPath, '-e', 'process.exit(1)'],
  timeout_ms: 30_000,
  max_output_bytes: 200_000,
  env: {},
};

const commandResult = {
  command_id: commandSpec.id,
  cwd: commandSpec.cwd,
  argv: commandSpec.argv,
  exit_code: 0,
  status: 'passed' as const,
  duration_ms: 0,
  stdout_summary: '',
  stderr_summary: '',
};

const fixCommandResult = {
  ...commandResult,
  timeout_ms: commandSpec.timeout_ms,
  max_output_bytes: commandSpec.max_output_bytes,
  env: commandSpec.env,
};

export { withTempRun } from './runtime-fixtures.js';

export async function loadCompiledFlowFixture(flowId: string): Promise<CompiledFlowFixture> {
  const bytes = await readFile(join(process.cwd(), 'generated', 'flows', flowId, 'circuit.json'));
  const raw = JSON.parse(bytes.toString('utf8'));
  return {
    flow: CompiledFlowSchema.parse(raw),
    bytes,
    manifestHash: computeManifestHash(bytes),
  };
}

export function expectedPassStepIds(flow: CompiledFlow, _axisSelectionName?: string): string[] {
  const stepsById = new Map(flow.steps.map((step) => [step.id as string, step]));
  const seen = new Set<string>();
  const stepIds: string[] = [];
  let current: string | undefined = flow.starts_at;

  while (current !== undefined) {
    if (seen.has(current)) throw new Error(`pass route cycle at ${current}`);
    seen.add(current);
    stepIds.push(current);
    const step = stepsById.get(current);
    if (step === undefined) throw new Error(`missing step ${current}`);
    const target = step.routes.pass;
    if (target === undefined) throw new Error(`missing pass route for ${current}`);
    if (TERMINAL_TARGETS.has(target)) return stepIds;
    current = target;
  }

  throw new Error('pass route walk ended without a terminal target');
}

export async function runSimpleCompiledFlow(options: {
  readonly flowBytes: Uint8Array;
  readonly runDir: string;
  readonly runId: string;
  readonly goal: string;
  readonly entryModeName?: string;
  readonly failStepId?: string;
  readonly routeByStepId?: Readonly<Record<string, string>>;
  readonly executors?: Partial<ExecutorRegistry>;
  readonly childExecutors?: Partial<ExecutorRegistry>;
  readonly childCompiledFlowResolver?: ChildCompiledFlowResolver;
  readonly childRunner?: CompiledFlowRunner;
  readonly projectRoot?: string;
  readonly worktreeRunner?: WorktreeRunner;
  readonly relayConnector?: RelayConnector;
}) {
  return await runCompiledFlow({
    flowBytes: options.flowBytes,
    runDir: options.runDir,
    runId: options.runId,
    goal: options.goal,
    ...(options.entryModeName === undefined ? {} : { entryModeName: options.entryModeName }),
    now: () => new Date('2026-05-02T12:00:00.000Z'),
    executors: {
      ...createSimpleParityExecutors({
        ...(options.failStepId === undefined ? {} : { failStepId: options.failStepId }),
        ...(options.routeByStepId === undefined ? {} : { routeByStepId: options.routeByStepId }),
      }),
      ...options.executors,
    },
    ...(options.childExecutors === undefined ? {} : { childExecutors: options.childExecutors }),
    ...(options.childCompiledFlowResolver === undefined
      ? {}
      : { childCompiledFlowResolver: options.childCompiledFlowResolver }),
    ...(options.childRunner === undefined ? {} : { childRunner: options.childRunner }),
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    ...(options.worktreeRunner === undefined ? {} : { worktreeRunner: options.worktreeRunner }),
    ...(options.relayConnector === undefined ? {} : { relayConnector: options.relayConnector }),
  });
}

export async function readTrace(runDir: string) {
  const trace = new TraceStore(runDir);
  return await trace.load();
}

export async function completedStepIds(runDir: string): Promise<string[]> {
  const entries = await readTrace(runDir);
  const stepIds: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'step.completed') stepIds.push(entry.step_id);
  }
  return stepIds;
}

export async function runFileExists(runDir: string, runFilePath: string): Promise<boolean> {
  try {
    await access(join(runDir, runFilePath));
    return true;
  } catch {
    return false;
  }
}

export async function expectCompleteTrace(runDir: string): Promise<void> {
  const entries = await readTrace(runDir);
  if (entries[0]?.kind !== 'run.bootstrapped') {
    throw new Error('trace did not bootstrap');
  }
  if (entries.at(-1)?.kind !== 'run.closed') {
    throw new Error('trace did not close');
  }
  if (projectStatusFromTrace(entries) !== 'complete') {
    throw new Error('status projection did not derive complete');
  }
  if (entries.some((entry) => entry.kind === 'step.aborted')) {
    throw new Error('trace contains an aborted step');
  }
}

function reviewEvidenceSummary() {
  return {
    kind: 'unavailable' as const,
    message: 'runtime parity fixture',
  };
}

function reportBody(
  step: ExecutableStep,
  context: RunContext,
  schema: string | undefined,
): unknown {
  const goal = context.goal || 'runtime parity goal';
  switch (schema) {
    case 'review.intake@v1':
      return ReviewIntake.parse({
        scope: goal,
        evidence: { kind: 'unavailable', reason: 'runtime parity fixture' },
        evidence_warnings: [],
      });
    case 'review.result@v1':
      return ReviewResult.parse({
        scope: goal,
        findings: [],
        verdict: 'CLEAN',
        assessment: 'Parity fixture: no findings observed in the relayed evidence.',
        verification: ['Runtime parity fixture stub.'],
        confidence_limitations: [],
        evidence_summary: reviewEvidenceSummary(),
        evidence_warnings: [],
      });
    case 'fix.brief@v1':
      return FixBrief.parse({
        problem_statement: goal,
        expected_behavior: 'The requested behavior works.',
        observed_behavior: 'The current behavior needs correction.',
        scope: 'runtime parity scope',
        regression_contract: {
          expected_behavior: 'The requested behavior works.',
          actual_behavior: 'The current behavior needs correction.',
          repro: { kind: 'command', command: regressionCommandSpec },
          regression_test: { status: 'failing-before-fix', command: regressionCommandSpec },
        },
        success_criteria: ['The run reaches the close step.'],
        verification_command_candidates: [commandSpec],
      });
    case 'fix.context@v1':
      return FixContext.parse({
        verdict: 'accept',
        sources: [
          { kind: 'file', ref: 'generated/flows/fix/circuit.json', summary: 'Parsed fixture' },
        ],
        observations: ['The runtime adapter preserves the current fix path.'],
        open_questions: [],
      });
    case 'fix.diagnosis@v1':
      return FixDiagnosis.parse({
        verdict: 'accept',
        reproduction_status: 'reproduced',
        cause_summary: 'The parity fixture provides a deterministic diagnosis.',
        confidence: 'high',
        evidence: ['The pass route reaches the act step.'],
        residual_uncertainty: [],
      });
    case 'fix.change@v1':
      return FixChange.parse({
        verdict: 'accept',
        summary: 'Applied the parity fixture change.',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/example.ts'],
        evidence: ['The runtime run reached the change report.'],
      });
    case 'fix.verification@v1':
      return FixVerification.parse({
        overall_status: 'passed',
        commands: [fixCommandResult],
      });
    case 'fix.regression-proof@v1':
      return FixRegressionProof.parse({
        status: 'proved',
        overall_status: 'passed',
        baseline: {
          command_id: regressionCommandSpec.id,
          cwd: regressionCommandSpec.cwd,
          argv: regressionCommandSpec.argv,
          timeout_ms: regressionCommandSpec.timeout_ms,
          max_output_bytes: regressionCommandSpec.max_output_bytes,
          env: regressionCommandSpec.env,
          exit_code: 1,
          command_status: 'failed',
          duration_ms: 0,
          stdout_summary: '',
          stderr_summary: '',
        },
      });
    case 'fix.baseline-snapshot@v1':
      return FixBaselineSnapshot.parse({
        overall_status: 'passed',
        head_sha: '0000000000000000000000000000000000000000',
        entries: [],
        hidden_index_flags: [],
      });
    case 'fix.change-set@v1':
      return FixChangeSet.parse({
        status: 'pass',
        overall_status: 'passed',
        baseline_head_sha: '0000000000000000000000000000000000000000',
        head_sha: '0000000000000000000000000000000000000000',
        declared: ['src/example.ts'],
        observed: ['src/example.ts'],
        undeclared_extras: [],
        missing_declared: [],
        baseline_dirty_mutated: [],
        hidden_index_flags: [],
      });
    case 'fix.regression-rerun@v1':
      return FixRegressionRerun.parse({
        status: 'cleared',
        overall_status: 'passed',
        rerun: {
          command_id: regressionCommandSpec.id,
          cwd: regressionCommandSpec.cwd,
          argv: regressionCommandSpec.argv,
          timeout_ms: regressionCommandSpec.timeout_ms,
          max_output_bytes: regressionCommandSpec.max_output_bytes,
          env: regressionCommandSpec.env,
          exit_code: 0,
          command_status: 'passed',
          duration_ms: 0,
          stdout_summary: '',
          stderr_summary: '',
        },
      });
    case 'fix.review@v1':
      return FixReview.parse({
        verdict: 'accept',
        summary: 'No blocking findings in the parity fixture.',
        findings: [],
      });
    case 'fix.result@v1':
      return FixResult.parse({
        summary: 'The fix flow completed in runtime.',
        outcome: 'fixed',
        verification_status: 'passed',
        regression_status: 'proved',
        regression_rerun_status: 'cleared',
        change_set_status: 'pass',
        review_status: 'completed',
        review_verdict: 'accept',
        residual_risks: [],
        evidence_links: [
          { report_id: 'fix.brief', path: 'reports/fix/brief.json', schema: 'fix.brief@v1' },
          { report_id: 'fix.context', path: 'reports/fix/context.json', schema: 'fix.context@v1' },
          {
            report_id: 'fix.diagnosis',
            path: 'reports/fix/diagnosis.json',
            schema: 'fix.diagnosis@v1',
          },
          {
            report_id: 'fix.regression-proof',
            path: 'reports/fix/regression-proof.json',
            schema: 'fix.regression-proof@v1',
          },
          {
            report_id: 'fix.baseline-snapshot',
            path: 'reports/fix/baseline-snapshot.json',
            schema: 'fix.baseline-snapshot@v1',
          },
          { report_id: 'fix.change', path: 'reports/fix/change.json', schema: 'fix.change@v1' },
          {
            report_id: 'fix.verification',
            path: 'reports/fix/verification.json',
            schema: 'fix.verification@v1',
          },
          {
            report_id: 'fix.regression-rerun',
            path: 'reports/fix/regression-rerun.json',
            schema: 'fix.regression-rerun@v1',
          },
          {
            report_id: 'fix.change-set',
            path: 'reports/fix/change-set.json',
            schema: 'fix.change-set@v1',
          },
          { report_id: 'fix.review', path: 'reports/fix/review.json', schema: 'fix.review@v1' },
        ],
      });
    case 'build.brief@v1':
      return BuildBrief.parse({
        objective: goal,
        scope: 'runtime parity scope',
        success_criteria: ['The run reaches the close step.'],
        verification_command_candidates: [commandSpec],
        checkpoint: {
          request_path: step.writes?.request?.path ?? 'reports/checkpoints/request.json',
          response_path: step.writes?.response?.path,
          allowed_choices: step.kind === 'checkpoint' ? [...step.choices] : ['continue'],
        },
        checkpoint_packet: {
          kind: 'build.checkpoint_packet@v1',
          salience: {
            summary: 'Confirm the Build brief before implementation starts.',
            why_now: ['The next route can edit the checkout.'],
            hidden_routine_work: ['Routine implementation chores stay inside the Build flow.'],
          },
          decision: {
            question: 'Confirm the Build brief before implementation starts.',
            operator_judgment: 'Decide whether this scope and proof plan should proceed.',
          },
          recommendation: {
            choice_id: step.kind === 'checkpoint' ? (step.choices[0] ?? 'continue') : 'continue',
            label: 'Continue',
            rationale: 'The scope is bounded and the verification plan is explicit.',
          },
          artifact: {
            title: 'Build brief',
            preview: `Objective: ${goal}`,
            scope: 'runtime parity scope',
            success_criteria: ['The run reaches the close step.'],
          },
          proof: {
            status: 'planned',
            summary: 'Circuit will verify with the parity command.',
            commands: [commandSpec],
            evidence: ['No implementation proof has been collected before the checkpoint.'],
          },
          risk: {
            summary: 'Scope mismatch is the meaningful risk.',
            tradeoffs: ['Too narrow misses intent.', 'Too broad touches unrelated files.'],
          },
          choices: [
            {
              id: step.kind === 'checkpoint' ? (step.choices[0] ?? 'continue') : 'continue',
              label: 'Continue',
              description: 'Proceed on the executable Build route.',
              route: { key: 'pass', target: '@complete' },
            },
          ],
          internal: {
            request_path: step.writes?.request?.path ?? 'reports/checkpoints/request.json',
            response_path: step.writes?.response?.path ?? 'reports/checkpoints/response.json',
            report_path: 'reports/build/brief.json',
            raw_evidence: ['reports/build/brief.json'],
          },
        },
      });
    case 'build.context@v1':
      return BuildContext.parse({
        verdict: 'accept',
        sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches.' }],
        observations: ['The target module is small and self-contained.'],
        open_questions: [],
        anticipated_file_extensions: ['.ts'],
      });
    case 'build.plan@v1':
      return BuildPlan.parse({
        objective: goal,
        approach: 'Use the converted v1 manifest.',
        slices: [
          { id: 'slice-1', intent: 'Run the simple path.', anticipated_file_extensions: ['.ts'] },
        ],
        anticipated_file_extensions: ['.ts'],
        verification: { commands: [commandSpec] },
      });
    // The parity plan declares no allowed_touch_area, so the touch-area gate is
    // off: the baseline and touch-area verification steps run no git and record
    // their inert reports. The real writers produce these shapes via git in a
    // real repo; the parity stub stands in with the same inert bodies because
    // the fixture's temp run dir is not a git checkout.
    case 'build.baseline-snapshot@v1':
      return BuildBaselineSnapshot.parse({ overall_status: 'passed', captured: false });
    case 'build.touch-area@v1':
      // Mirror of inertBuildTouchArea() (the writer's gate-off result); inlined
      // here because tests reach the flow only through reports.ts, not writers.
      // The parse pins this to the schema, so a required-field change fails here.
      return BuildTouchArea.parse({
        overall_status: 'passed',
        enforcement: 'not_enforced',
        containment: 'within',
        allowed_area: [],
        observed_paths: [],
        out_of_bounds_paths: [],
        head_diverged: false,
        hidden_index_flags: [],
      });
    case 'build.implementation@v1':
      return BuildImplementation.parse({
        verdict: 'accept',
        summary: 'Applied the parity fixture implementation.',
        changed_files: ['src/example.ts'],
        evidence: ['The runtime run reached the implementation report.'],
      });
    case 'build.verification@v1':
      return BuildVerification.parse({
        overall_status: 'passed',
        commands: [commandResult],
      });
    case 'build.review@v1':
      return BuildReview.parse({
        verdict: 'accept',
        summary: 'No blocking findings in the parity fixture.',
        findings: [],
        alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
      });
    case 'build.result@v1':
      return BuildResult.parse({
        summary: 'The build flow completed in runtime.',
        outcome: 'complete',
        verification_status: 'passed',
        review_verdict: 'accept',
        evidence_links: [
          { report_id: 'build.brief', path: 'reports/build/brief.json', schema: 'build.brief@v1' },
          { report_id: 'build.plan', path: 'reports/build/plan.json', schema: 'build.plan@v1' },
          {
            report_id: 'build.implementation',
            path: 'reports/build/implementation.json',
            schema: 'build.implementation@v1',
          },
          {
            report_id: 'build.verification',
            path: 'reports/build/verification.json',
            schema: 'build.verification@v1',
          },
          {
            report_id: 'build.review',
            path: 'reports/build/review.json',
            schema: 'build.review@v1',
          },
        ],
      });
    case 'explore.brief@v1':
      return ExploreBrief.parse({
        subject: goal,
        task: 'Understand the subject through the runtime parity path.',
        success_condition: 'The run reaches the close step.',
      });
    case 'explore.analysis@v1':
      return ExploreAnalysis.parse({
        subject: goal,
        aspects: [
          {
            name: 'parity',
            summary: 'The generated manifest converts and executes through runtime.',
            evidence: [
              { source: 'generated fixture', summary: 'The pass route is deterministic.' },
            ],
          },
        ],
      });
    case 'explore.compose@v1':
      return ExploreCompose.parse({
        verdict: 'accept',
        subject: goal,
        recommendation: 'Proceed with the current transition slice.',
        success_condition_alignment: 'The simple path reaches the close step.',
        supporting_aspects: [
          {
            aspect: 'parity',
            contribution: 'The fixture preserves route behavior.',
            evidence_refs: ['generated fixture'],
          },
        ],
      });
    case 'explore.review-verdict@v1':
      return ExploreReviewVerdict.parse({
        verdict: 'accept',
        overall_assessment: 'No blocking concerns in the parity fixture.',
        objections: [],
        missed_angles: [],
      });
    case 'explore.decision-options@v1':
      return ExploreDecisionOptions.parse({
        decision_question: 'Which runtime path should proceed?',
        options: [
          {
            id: 'option-1',
            label: 'Proceed',
            summary: 'Continue the transition slice.',
            best_case_prompt: 'Argue for proceeding.',
            evidence_refs: ['generated fixture'],
            tradeoffs: ['Keeps the transition moving.'],
          },
          {
            id: 'option-2',
            label: 'Pause',
            summary: 'Pause for more review.',
            best_case_prompt: 'Argue for pausing.',
            evidence_refs: ['generated fixture'],
            tradeoffs: ['Adds caution.'],
          },
        ],
        recommendation_basis: 'The fixture is deterministic.',
      });
    case 'explore.tournament-proposal@v1':
      return ExploreTournamentProposal.parse({
        verdict: 'accept',
        option_id: step.id.includes('option-2') ? 'option-2' : 'option-1',
        option_label: step.id.includes('option-2') ? 'Pause' : 'Proceed',
        case_summary: 'The parity fixture admits this option.',
        assumptions: [],
        evidence_refs: ['generated fixture'],
        risks: [],
        next_action: 'Continue the run.',
        rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
      });
    case 'explore.tournament-aggregate@v1':
      return ExploreTournamentAggregate.parse({
        schema_version: 1,
        join_policy: 'aggregate-survivors',
        branch_count: 2,
        branches: [
          {
            branch_id: 'option-1',
            child_run_id: 'option-1-run',
            child_outcome: 'complete',
            verdict: 'accept',
            admitted: true,
            result_path: 'reports/branches/option-1/report.json',
            duration_ms: 0,
            result_body: reportBody(
              { ...step, id: 'option-1' },
              context,
              'explore.tournament-proposal@v1',
            ),
            rubric_result: passingExploreRubricResult(),
          },
          {
            branch_id: 'option-2',
            child_run_id: 'option-2-run',
            child_outcome: 'complete',
            verdict: 'accept',
            admitted: true,
            result_path: 'reports/branches/option-2/report.json',
            duration_ms: 0,
            result_body: reportBody(
              { ...step, id: 'option-2' },
              context,
              'explore.tournament-proposal@v1',
            ),
            rubric_result: passingExploreRubricResult(),
          },
        ],
      });
    case 'explore.tournament-review@v1':
      return ExploreTournamentReview.parse({
        verdict: 'recommend',
        recommended_option_id: 'option-1',
        comparison: 'Proceed has the clearer transition path.',
        objections: [],
        missing_evidence: [],
        tradeoff_question: 'Is another review needed before proceeding?',
        confidence: 'high',
      });
    case 'explore.decision@v1':
      return ExploreDecision.parse({
        verdict: 'decided',
        decision_question: 'Which runtime path should proceed?',
        selected_option_id: 'option-1',
        selected_option_label: 'Proceed',
        decision: 'Continue the transition slice.',
        rationale: 'The parity fixture passed its checks.',
        rejected_options: [{ option_id: 'option-2', reason: 'More review is not needed here.' }],
        evidence_links: ['reports/tournament-aggregate.json'],
        assumptions: [],
        residual_risks: [],
        next_action: 'Continue with production readiness.',
        follow_up_workflow: 'build',
      });
    case 'explore.result@v1': {
      const isTournament = step.reads?.some((ref) => ref.path.includes('decision')) ?? false;
      return ExploreResult.parse(
        isTournament
          ? {
              summary: 'The explore tournament completed in runtime.',
              verdict_snapshot: {
                decision_verdict: 'decided',
                tournament_review_verdict: 'recommend',
                selected_option_id: 'option-1',
                objection_count: 0,
                missing_evidence_count: 0,
              },
              evidence_links: [
                {
                  report_id: 'explore.brief',
                  path: 'reports/brief.json',
                  schema: 'explore.brief@v1',
                },
                {
                  report_id: 'explore.analysis',
                  path: 'reports/analysis.json',
                  schema: 'explore.analysis@v1',
                },
                {
                  report_id: 'explore.decision-options',
                  path: 'reports/decision-options.json',
                  schema: 'explore.decision-options@v1',
                },
                {
                  report_id: 'explore.tournament-aggregate',
                  path: 'reports/tournament-aggregate.json',
                  schema: 'explore.tournament-aggregate@v1',
                },
                {
                  report_id: 'explore.tournament-review',
                  path: 'reports/tournament-review.json',
                  schema: 'explore.tournament-review@v1',
                },
                {
                  report_id: 'explore.decision',
                  path: 'reports/decision.json',
                  schema: 'explore.decision@v1',
                },
              ],
            }
          : {
              summary: 'The explore flow completed in runtime.',
              verdict_snapshot: {
                compose_verdict: 'accept',
                review_verdict: 'accept',
                objection_count: 0,
                missed_angle_count: 0,
              },
              evidence_links: [
                {
                  report_id: 'explore.brief',
                  path: 'reports/brief.json',
                  schema: 'explore.brief@v1',
                },
                {
                  report_id: 'explore.analysis',
                  path: 'reports/analysis.json',
                  schema: 'explore.analysis@v1',
                },
                {
                  report_id: 'explore.compose',
                  path: 'reports/compose.json',
                  schema: 'explore.compose@v1',
                },
                {
                  report_id: 'explore.review-verdict',
                  path: 'reports/review-verdict.json',
                  schema: 'explore.review-verdict@v1',
                },
              ],
            },
      );
    }
    default:
      return { step_id: step.id, schema: schema ?? 'none', ok: true };
  }
}

async function writeText(context: RunContext, path: string, value: string): Promise<void> {
  const fullPath = context.files.resolve(path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, value, 'utf8');
}

async function writeReport(step: ExecutableStep, context: RunContext): Promise<void> {
  const report = step.writes?.report;
  if (report !== undefined) {
    await context.files.writeJson(report, reportBody(step, context, report.schema));
  }
}

async function writeRelayFiles(step: ExecutableStep, context: RunContext): Promise<void> {
  if (step.writes?.request !== undefined) {
    await context.files.writeJson(step.writes.request, {
      step_id: step.id,
      goal: context.goal,
    });
  }
  if (step.writes?.receipt !== undefined) {
    await writeText(context, step.writes.receipt.path, `stub receipt for ${step.id}\n`);
  }
  if (step.writes?.result !== undefined) {
    const body =
      step.id === 'audit-step'
        ? ReviewRelayResult.parse({
            verdict: 'NO_ISSUES_FOUND',
            findings: [],
            assessment: 'Parity fixture: no findings observed in the relayed evidence.',
            verification: ['Runtime parity fixture stub.'],
            confidence_limitations: [],
          })
        : reportBody(step, context, step.writes.report?.schema);
    await context.files.writeJson(step.writes.result, body);
  }
}

function checkpointChoice(step: ExecutableStep): string {
  if (step.kind !== 'checkpoint') throw new Error('expected checkpoint step');
  const candidates = [step.policy.safe_default_choice, ...step.choices, 'pass'];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && step.routes[candidate] !== undefined) return candidate;
  }
  throw new Error(`checkpoint step '${step.id}' has no usable route`);
}

export function createSimpleParityExecutors(
  options: {
    readonly failStepId?: string;
    readonly routeByStepId?: Readonly<Record<string, string>>;
  } = {},
): Partial<ExecutorRegistry> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      if (step.id === options.failStepId) throw new Error(`forced failure at ${step.id}`);
      await writeReport(step, context);
      return {
        route: options.routeByStepId?.[step.id] ?? 'pass',
        details: { report: step.writes?.report?.path },
      };
    },
    relay: async (step, context) => {
      if (step.kind !== 'relay') throw new Error('expected relay step');
      if (step.id === options.failStepId) throw new Error(`forced failure at ${step.id}`);
      await writeRelayFiles(step, context);
      await writeReport(step, context);
      const route = options.routeByStepId?.[step.id] ?? 'pass';
      if (route !== 'pass') {
        await context.trace.append({
          run_id: context.runId,
          kind: 'check.evaluated',
          step_id: step.id,
          attempt: context.activeStepAttempt ?? 1,
          check_kind: 'result_verdict',
          outcome: 'fail',
          reason: `parity fixture forced route '${route}'`,
        });
      }
      return { route, details: { role: step.role } };
    },
    verification: async (step, context) => {
      if (step.kind !== 'verification') throw new Error('expected verification step');
      if (step.id === options.failStepId) throw new Error(`forced failure at ${step.id}`);
      await writeReport(step, context);
      return {
        route: options.routeByStepId?.[step.id] ?? 'pass',
        details: { report: step.writes?.report?.path },
      };
    },
    checkpoint: async (step, context) => {
      if (step.kind !== 'checkpoint') throw new Error('expected checkpoint step');
      if (step.id === options.failStepId) throw new Error(`forced failure at ${step.id}`);
      const choice = options.routeByStepId?.[step.id] ?? checkpointChoice(step);
      if (step.writes?.request !== undefined) {
        await context.files.writeJson(step.writes.request, {
          step_id: step.id,
          prompt: step.policy.prompt,
          choices: step.choices,
        });
      }
      if (step.writes?.response !== undefined) {
        await context.files.writeJson(step.writes.response, {
          step_id: step.id,
          selected_choice: choice,
          answered_by: 'mode-default',
          rationale: 'runtime parity fixture',
        });
      }
      await writeReport(step, context);
      return { route: choice, details: { selected_choice: choice } };
    },
  };
}
