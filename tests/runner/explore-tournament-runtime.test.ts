import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { executeCompose } from '../../src/runtime/executors/compose.js';
import { resumeCompiledFlow } from '../../src/runtime/run/checkpoint-resume.js';
import { runCompiledFlowWithWaiting } from '../../src/runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../../src/runtime/run/graph-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { Axes } from '../../src/schemas/axes.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

const TOURNAMENT_FIXTURE_PATH = resolve('generated/flows/explore/tournament.json');

function loadTournamentFixture(): { flow: CompiledFlow; bytes: Buffer } {
  const bytes = readFileSync(TOURNAMENT_FIXTURE_PATH);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  return { flow: CompiledFlow.parse(raw), bytes };
}

function loadTournamentFixtureRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(TOURNAMENT_FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
}

function readJson(runFolder: string, path: string): unknown {
  return JSON.parse(readFileSync(join(runFolder, path), 'utf8'));
}

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

function tournamentAxes(n: 2 | 3 | 4): Axes {
  return { depth: 'standard', tournament: true, tournament_n: n, autonomous: false };
}

function autonomousTournamentAxes(n: 2 | 3 | 4): Axes {
  return { depth: 'standard', tournament: true, tournament_n: n, autonomous: true };
}

function tournamentRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayResult> => {
      if (input.prompt.includes('Step: proposal-fanout-step-option-1')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proposal-option-1',
          result_body: JSON.stringify({
            verdict: 'accept',
            option_id: 'option-1',
            option_label: 'React',
            case_summary: 'Choose React for the broad ecosystem and hiring pool.',
            assumptions: ['The operator values ecosystem maturity.'],
            evidence_refs: ['reports/decision-options.json'],
            risks: ['The larger ecosystem may add dependency sprawl.'],
            next_action: 'Run a Build plan for a React prototype.',
            rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          }),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }
      if (input.prompt.includes('Step: proposal-fanout-step-option-2')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proposal-option-2',
          result_body: JSON.stringify({
            verdict: 'accept',
            option_id: 'option-2',
            option_label: 'Vue',
            case_summary: 'Choose Vue for a smaller surface and faster product iteration.',
            assumptions: ['The operator values implementation speed.'],
            evidence_refs: ['reports/decision-options.json'],
            risks: ['Team familiarity may be thinner.'],
            next_action: 'Run a Build plan for a Vue prototype.',
            rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          }),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }
      if (input.prompt.includes('Step: proposal-fanout-step-option-3')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proposal-option-3',
          result_body: JSON.stringify({
            verdict: 'accept',
            option_id: 'option-3',
            option_label: 'Hybrid path',
            case_summary: 'Prototype the shared requirements before locking the framework.',
            assumptions: ['A brief comparison prototype is affordable.'],
            evidence_refs: ['reports/decision-options.json'],
            risks: ['The decision takes longer.'],
            next_action: 'Run a short Explore follow-up with prototype criteria.',
            rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          }),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }
      if (input.prompt.includes('Step: proposal-fanout-step-option-4')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proposal-option-4',
          result_body: JSON.stringify({
            verdict: 'accept',
            option_id: 'option-4',
            option_label: 'Defer pending evidence',
            case_summary: 'Gather missing team and product constraints before choosing.',
            assumptions: ['The decision is reversible enough to pause briefly.'],
            evidence_refs: ['reports/decision-options.json'],
            risks: ['The project loses momentum.'],
            next_action: 'Collect the missing constraints and rerun the decision.',
            rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          }),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }
      expect(input.prompt).toContain('Step: stress-proposals-step');
      return {
        request_payload: input.prompt,
        receipt_id: 'proposal-review',
        result_body: JSON.stringify({
          verdict: 'recommend',
          recommended_option_id: 'option-1',
          comparison: 'React is safer on ecosystem depth, while Vue is faster to shape.',
          objections: ['Vue depends more on team-specific familiarity.'],
          missing_evidence: ['No implementation spike was gathered.'],
          tradeoff_question: 'Choose React ecosystem depth or Vue iteration speed.',
          confidence: 'medium',
        }),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-explore-tournament-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('explore tournament runtime', () => {
  it('rejects tournament fanout fixtures without the survivor failure contract', () => {
    for (const invalid of ['abort-all', 'aggregate-only'] as const) {
      const raw = loadTournamentFixtureRaw();
      const steps = raw.steps as Array<Record<string, unknown>>;
      const fanout = steps.find((step) => step.id === 'proposal-fanout-step');
      if (fanout === undefined) throw new Error('proposal-fanout-step missing');
      if (invalid === 'abort-all') {
        fanout.on_child_failure = 'abort-all';
      } else {
        const check = fanout.check as { join: { policy: string } };
        check.join.policy = 'aggregate-only';
      }

      const result = CompiledFlow.safeParse(raw);

      expect(result.success, invalid).toBe(false);
      if (!result.success) {
        expect(result.error.message, invalid).toContain(
          'tournament fanout requires on_child_failure: continue-others and join.policy: aggregate-survivors',
        );
      }
    }
  });

  it('keeps tournament review inside the Decision stage and not as canonical Review', () => {
    const { flow } = loadTournamentFixture();
    expect(flow.stages.map((stage) => stage.canonical)).toEqual([
      'frame',
      'analyze',
      'plan',
      'close',
    ]);
    const decisionStage = flow.stages.find((stage) => stage.canonical === 'plan');
    expect(decisionStage?.title).toBe('Plan or Decision');
    expect(decisionStage?.steps).toContain('stress-proposals-step');
    expect(flow.stage_path_policy).toMatchObject({
      mode: 'partial',
      omits: ['act', 'verify', 'review'],
    });
  });

  it('fans out option proposals, pauses for a bounded choice, then resumes to a final decision', async () => {
    const { bytes } = loadTournamentFixture();
    const runFolder = join(runFolderBase, 'tournament-run');

    const waiting = await runCompiledFlowWithWaiting({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '33333333-3333-3333-3333-333333333331',
      goal: 'decide: React vs Vue',
      depth: 'tournament',
      entryModeName: 'tournament',
      now: deterministicNow(Date.UTC(2026, 3, 29, 16, 30, 0)),
      relayer: tournamentRelayer(),
    });

    expect(waiting.outcome).toBe('checkpoint_waiting');
    if (!isGraphCheckpointWaitingResult(waiting)) {
      throw new Error('expected checkpoint_waiting');
    }
    expect(waiting.checkpoint).toMatchObject({
      stepId: 'tradeoff-checkpoint-step',
      allowedChoices: ['option-1', 'option-2', 'option-3'],
    });
    expect(existsSync(join(runFolder, 'reports/checkpoints/tradeoff-response.json'))).toBe(false);

    const options = readJson(runFolder, 'reports/decision-options.json') as {
      options: ReadonlyArray<{ id: string; label: string }>;
    };
    expect(options.options.map((option) => option.label)).toEqual(['React', 'Vue', 'Hybrid path']);

    for (const branch of ['option-1', 'option-2', 'option-3']) {
      const branchDir = join(runFolder, 'reports', 'tournament-branches', branch);
      expect(existsSync(join(branchDir, 'request.txt'))).toBe(true);
      expect(existsSync(join(branchDir, 'receipt.txt'))).toBe(true);
      expect(existsSync(join(branchDir, 'result.json'))).toBe(true);
      expect(existsSync(join(branchDir, 'report.json'))).toBe(true);
    }

    const aggregate = readJson(runFolder, 'reports/tournament-aggregate.json') as {
      branches: ReadonlyArray<{
        branch_id: string;
        result_body?: { option_id: string };
        rubric_result?: {
          dims: Record<string, { runtime_signal: string; runtime_vetoed: boolean }>;
          aggregate_score: number;
          runtime_veto_count: number;
        };
      }>;
    };
    expect(aggregate.branches.map((branch) => branch.branch_id).sort()).toEqual([
      'option-1',
      'option-2',
      'option-3',
    ]);
    for (const branch of aggregate.branches) {
      expect(branch.result_body?.option_id).toBe(branch.branch_id);
      expect(Object.keys(branch.rubric_result?.dims ?? {}).sort()).toEqual(
        Object.keys(PASSING_RUBRIC_MODEL_JUDGMENTS).sort(),
      );
      expect(branch.rubric_result?.aggregate_score).toBe(1);
      expect(branch.rubric_result?.runtime_veto_count).toBe(0);
      expect(branch.rubric_result?.dims.project_specificity).toMatchObject({
        runtime_signal: 'n/a',
        runtime_vetoed: false,
      });
    }

    const resumed = await resumeCompiledFlow({
      runDir: runFolder,
      selection: 'option-2',
      now: deterministicNow(Date.UTC(2026, 3, 29, 16, 40, 0)),
      relayer: tournamentRelayer(),
    });

    expect(resumed.outcome).toBe('complete');
    const decision = readJson(runFolder, 'reports/decision.json') as {
      selected_option_id: string;
      selected_option_label: string;
      decision: string;
      follow_up_workflow: string;
    };
    expect(decision.selected_option_id).toBe('option-2');
    expect(decision.selected_option_label).toBe('Vue');
    expect(decision.decision).toMatch(/smaller surface/);
    expect(decision.follow_up_workflow).toBe('Build');

    const result = readJson(runFolder, 'reports/explore-result.json') as {
      verdict_snapshot: { selected_option_id: string };
      evidence_links: ReadonlyArray<{ report_id: string; path: string }>;
    };
    expect(result.verdict_snapshot.selected_option_id).toBe('option-2');
    expect(result.evidence_links).toContainEqual({
      report_id: 'explore.tournament-aggregate',
      path: 'reports/tournament-aggregate.json',
      schema: 'explore.tournament-aggregate@v1',
    });
  });

  it.each([2, 3, 4] as const)(
    'wires tournament_n=%s through options, fanout, aggregate, and checkpoint choices',
    async (tournamentN) => {
      const { bytes } = loadTournamentFixture();
      const runFolder = join(runFolderBase, `tournament-n-${tournamentN}`);

      const waiting = await runCompiledFlowWithWaiting({
        runDir: runFolder,
        flowBytes: bytes,
        runId: `33333333-3333-3333-3333-33333333334${tournamentN}`,
        goal: 'decide: React vs Vue vs Svelte vs Angular',
        depth: 'tournament',
        entryModeName: 'tournament',
        axes: tournamentAxes(tournamentN),
        now: deterministicNow(Date.UTC(2026, 3, 29, 17, tournamentN, 0)),
        relayer: tournamentRelayer(),
      });

      expect(waiting.outcome).toBe('checkpoint_waiting');
      if (!isGraphCheckpointWaitingResult(waiting)) {
        throw new Error('expected checkpoint_waiting');
      }
      const expectedIds = Array.from({ length: tournamentN }, (_, index) => `option-${index + 1}`);
      expect(waiting.checkpoint.allowedChoices).toEqual(expectedIds);

      const options = readJson(runFolder, 'reports/decision-options.json') as {
        options: ReadonlyArray<{ id: string }>;
      };
      expect(options.options.map((option) => option.id)).toEqual(expectedIds);

      const aggregate = readJson(runFolder, 'reports/tournament-aggregate.json') as {
        branch_count: number;
        branches: ReadonlyArray<{ branch_id: string }>;
      };
      expect(aggregate.branch_count).toBe(tournamentN);
      expect(aggregate.branches.map((branch) => branch.branch_id).sort()).toEqual(expectedIds);

      const request = readJson(runFolder, 'reports/checkpoints/tradeoff-request.json') as {
        allowed_choices: readonly string[];
        execution_context: { axes: { tournament_n: number } };
      };
      expect(request.allowed_choices).toEqual(expectedIds);
      expect(request.execution_context.axes.tournament_n).toBe(tournamentN);

      const traceEntries = await new TraceStore(runFolder).load();
      expect(traceEntries.find((entry) => entry.kind === 'fanout.started')?.branch_ids).toEqual(
        expectedIds,
      );
      expect(traceEntries.find((entry) => entry.kind === 'checkpoint.requested')?.options).toEqual(
        expectedIds,
      );
    },
  );

  it('auto-resolves autonomous tournaments with highest-score provenance', async () => {
    const { bytes } = loadTournamentFixture();
    const runFolder = join(runFolderBase, 'autonomous-tournament-run');
    const baseRelayer = tournamentRelayer();

    const outcome = await runCompiledFlowWithWaiting({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '33333333-3333-3333-3333-333333333336',
      goal: 'decide: React vs Vue',
      depth: 'autonomous',
      entryModeName: 'autonomous',
      axes: autonomousTournamentAxes(2),
      now: deterministicNow(Date.UTC(2026, 3, 29, 19, 0, 0)),
      relayer: {
        connectorName: baseRelayer.connectorName,
        relay: async (input) => {
          const result = await baseRelayer.relay(input);
          const resultBody = JSON.parse(result.result_body) as Record<string, unknown>;
          if (resultBody.option_id === 'option-1') {
            return {
              ...result,
              result_body: JSON.stringify({
                ...resultBody,
                rubric_model_judgments: {
                  ...PASSING_RUBRIC_MODEL_JUDGMENTS,
                  evidence_rigor: 'concern',
                },
              }),
            };
          }
          return result;
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    const response = readJson(runFolder, 'reports/checkpoints/tradeoff-response.json') as {
      selection: string;
      resolution_source: string;
      auto_resolution: {
        policy: string;
        resolved_value: string;
        winning_score: number;
        runner_up_score: number;
        margin: number;
        tie_break: string;
        scores: Record<string, { aggregate_score: number; runtime_veto_count: number }>;
        rubric_results: Record<string, { aggregate_score: number }>;
      };
    };
    expect(response).toMatchObject({
      selection: 'option-2',
      resolution_source: 'policy',
      auto_resolution: {
        policy: 'highest-score',
        resolved_value: 'option-2',
        winning_score: 1,
        runner_up_score: 0.938,
        margin: 0.062,
        tie_break: 'aggregate_score',
      },
    });
    expect(response.auto_resolution.scores['option-1']).toEqual({
      aggregate_score: 0.938,
      runtime_veto_count: 0,
    });
    expect(response.auto_resolution.rubric_results['option-2']?.aggregate_score).toBe(1);

    const traceEntries = await new TraceStore(runFolder).load();
    expect(traceEntries).toContainEqual(
      expect.objectContaining({
        kind: 'guidance.decision',
        subject: 'checkpoint_resolution',
        scope: expect.objectContaining({ step_id: 'tradeoff-checkpoint-step' }),
        selected: expect.objectContaining({
          choice_id: 'option-2',
          resolution_source: 'policy',
        }),
        evidence_refs: [
          expect.objectContaining({
            kind: 'report',
            ref: 'reports/tournament-aggregate.json',
          }),
        ],
        rejected_options: [
          expect.objectContaining({
            option: { choice_id: 'option-1' },
            reason_code: 'lower_auto_resolution_score',
          }),
        ],
      }),
    );
    expect(traceEntries).toContainEqual(
      expect.objectContaining({
        kind: 'checkpoint.resolved',
        step_id: 'tradeoff-checkpoint-step',
        selection: 'option-2',
        auto_resolved: true,
        resolution_source: 'policy',
      }),
    );
  });

  it.each([
    { generated: 2, expected: 3 },
    { generated: 4, expected: 3 },
  ])(
    'rejects $generated generated tournament options when tournament_n=$expected before child relays start',
    async ({ generated, expected }) => {
      const { bytes } = loadTournamentFixture();
      const runFolder = join(runFolderBase, `tournament-mismatch-${generated}`);
      const relayInputs: RelayInput[] = [];

      const outcome = await runCompiledFlowWithWaiting({
        runDir: runFolder,
        flowBytes: bytes,
        runId: `33333333-3333-3333-3333-33333333335${generated}`,
        goal: 'decide: React vs Vue vs Svelte vs Angular',
        depth: 'tournament',
        entryModeName: 'tournament',
        axes: tournamentAxes(3),
        now: deterministicNow(Date.UTC(2026, 3, 29, 18, generated, 0)),
        relayer: {
          connectorName: 'claude-code',
          relay: async (input) => {
            relayInputs.push(input);
            return tournamentRelayer().relay(input);
          },
        },
        executors: {
          compose: async (step, context) => {
            if (step.id !== 'decision-options-step') {
              if (step.kind !== 'compose') throw new Error('expected compose step');
              return await executeCompose(step, context);
            }
            await context.files.writeJson('reports/decision-options.json', {
              decision_question: 'Which path should Circuit recommend?',
              recommendation_basis: 'Mismatch test.',
              options: Array.from({ length: generated }, (_, index) => ({
                id: `option-${index + 1}`,
                label: `Option ${index + 1}`,
                summary: `Generated option ${index + 1}.`,
                best_case_prompt: `Make the strongest case for option ${index + 1}.`,
                evidence_refs: ['reports/analysis.json'],
                tradeoffs: ['Fast to compare.'],
              })),
            });
            return { route: 'pass', details: { writer: 'mismatch-test' } };
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      if (isGraphCheckpointWaitingResult(outcome) || outcome.outcome !== 'aborted') {
        throw new Error('expected aborted');
      }
      expect(outcome.reason).toContain(`expected ${expected} items`);
      expect(relayInputs).toHaveLength(0);
    },
  );

  it('rejects a mismatched proposal branch while continuing with two survivors', async () => {
    const { bytes } = loadTournamentFixture();
    const runFolder = join(runFolderBase, 'mismatched-proposal-run');
    const relayer = tournamentRelayer();

    const outcome = await runCompiledFlowWithWaiting({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '33333333-3333-3333-3333-333333333332',
      goal: 'decide: React vs Vue',
      depth: 'tournament',
      entryModeName: 'tournament',
      now: deterministicNow(Date.UTC(2026, 3, 29, 16, 50, 0)),
      relayer: {
        connectorName: relayer.connectorName,
        relay: async (input) => {
          const result = await relayer.relay(input);
          if (input.prompt.includes('Step: proposal-fanout-step-option-1')) {
            return {
              ...result,
              result_body: JSON.stringify({
                ...(JSON.parse(result.result_body) as Record<string, unknown>),
                option_id: 'option-2',
              }),
            };
          }
          return result;
        },
      },
    });

    expect(outcome.outcome).toBe('checkpoint_waiting');
    if (!isGraphCheckpointWaitingResult(outcome)) {
      throw new Error('expected checkpoint_waiting');
    }
    expect(outcome.checkpoint.allowedChoices).toEqual(['option-2', 'option-3']);
    const traceEntries = await new TraceStore(runFolder).load();
    const failedCheck = traceEntries.find(
      (entry) =>
        entry.kind === 'check.evaluated' &&
        entry.step_id === 'proposal-fanout-step-option-1' &&
        entry.outcome === 'fail',
    );
    expect(failedCheck).toMatchObject({
      reason: expect.stringContaining("field 'option_id' must equal branch_id 'option-1'"),
    });
    expect(traceEntries).toContainEqual(
      expect.objectContaining({
        kind: 'fanout.joined',
        step_id: 'proposal-fanout-step',
        policy: 'aggregate-survivors',
        branches_completed: 2,
        branches_failed: 1,
      }),
    );
  });
});
