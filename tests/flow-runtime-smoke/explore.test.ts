import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectRunStatusFromRunFolder } from '../../src/app/run-status/run-folder-projector.js';
import type { RelayConnector } from '../../src/runtime/executors/relay.js';
import { resumeCompiledFlow } from '../../src/runtime/run/checkpoint-resume.js';
import { runCompiledFlowWithWaiting } from '../../src/runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../../src/runtime/run/graph-runner.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow } from '../helpers/runtime-fixtures.js';
import {
  completedStepIds,
  createSimpleParityExecutors,
  expectCompleteTrace,
  expectedPassStepIds,
  loadCompiledFlowFixture,
  readTrace,
  runSimpleCompiledFlow,
  withTempRun,
} from '../helpers/runtime-flow.js';

async function loadTournamentFixture() {
  const bytes = await readFile(
    join(process.cwd(), 'generated', 'flows', 'explore', 'tournament.json'),
  );
  return bytes;
}

async function readJson(runDir: string, path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(runDir, path), 'utf8'));
}

function relayResult(input: RelayInput, receiptId: string, body: unknown): RelayResult {
  return {
    request_payload: input.prompt,
    receipt_id: receiptId,
    result_body: JSON.stringify(body),
    duration_ms: 1,
    cli_version: '0.0.0-runtime-test',
  };
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

function tournamentRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input) => {
      if (input.prompt.includes('Step: proposal-fanout-step-option-1')) {
        return relayResult(input, 'proposal-option-1', {
          verdict: 'accept',
          option_id: 'option-1',
          option_label: 'React',
          case_summary: 'Choose React for the broad ecosystem and hiring pool.',
          assumptions: ['The operator values ecosystem maturity.'],
          evidence_refs: ['reports/decision-options.json'],
          risks: ['The larger ecosystem may add dependency sprawl.'],
          next_action: 'Run a Build plan for a React prototype.',
          rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
        });
      }
      if (input.prompt.includes('Step: proposal-fanout-step-option-2')) {
        return relayResult(input, 'proposal-option-2', {
          verdict: 'accept',
          option_id: 'option-2',
          option_label: 'Vue',
          case_summary: 'Choose Vue for a smaller surface and faster product iteration.',
          assumptions: ['The operator values implementation speed.'],
          evidence_refs: ['reports/decision-options.json'],
          risks: ['Team familiarity may be thinner.'],
          next_action: 'Run a Build plan for a Vue prototype.',
          rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
        });
      }
      if (input.prompt.includes('Step: proposal-fanout-step-option-3')) {
        return relayResult(input, 'proposal-option-3', {
          verdict: 'accept',
          option_id: 'option-3',
          option_label: 'Hybrid path',
          case_summary: 'Prototype the shared requirements before locking the framework.',
          assumptions: ['A brief comparison prototype is affordable.'],
          evidence_refs: ['reports/decision-options.json'],
          risks: ['The decision takes longer.'],
          next_action: 'Run a short Explore follow-up with prototype criteria.',
          rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
        });
      }
      if (input.prompt.includes('Step: proposal-fanout-step-option-4')) {
        return relayResult(input, 'proposal-option-4', {
          verdict: 'accept',
          option_id: 'option-4',
          option_label: 'Defer pending evidence',
          case_summary: 'Gather missing team and product constraints before choosing.',
          assumptions: ['The decision is reversible enough to pause briefly.'],
          evidence_refs: ['reports/decision-options.json'],
          risks: ['The project loses momentum.'],
          next_action: 'Collect the missing constraints and rerun the decision.',
          rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
        });
      }
      expect(input.prompt).toContain('Step: stress-proposals-step');
      return relayResult(input, 'proposal-review', {
        verdict: 'recommend',
        recommended_option_id: 'option-1',
        comparison: 'React is safer on ecosystem depth, while Vue is faster to shape.',
        objections: ['Vue depends more on team-specific familiarity.'],
        missing_evidence: ['No implementation spike was gathered.'],
        tradeoff_question: 'Choose React ecosystem depth or Vue iteration speed.',
        confidence: 'medium',
      });
    },
  };
}

describe('explore runtime parity', () => {
  it.each([
    { label: 'default', entryModeName: undefined },
    { label: 'low', entryModeName: 'low' },
    { label: 'high', entryModeName: 'high' },
    { label: 'autonomous', entryModeName: 'autonomous' },
  ] as const)(
    'runs the generated explore $label flow through the runtime pass route path',
    async ({ label, entryModeName }) => {
      const fixture = await loadCompiledFlowFixture('explore');
      await withTempRun(async (runDir) => {
        const result = await runSimpleCompiledFlow({
          flowBytes: fixture.bytes,
          runDir,
          runId: '66666666-6666-4666-8666-666666666666',
          goal: `Explore a decision with runtime ${label}`,
          ...(entryModeName === undefined ? {} : { entryModeName }),
        });

        expect(result.outcome).toBe('complete');
        await expectCompleteTrace(runDir);
        expect(await completedStepIds(runDir)).toEqual(expectedPassStepIds(fixture.flow));
      });
    },
  );

  it('runs the generated explore tournament fanout through runtime survivor join', async () => {
    const bytes = await loadTournamentFixture();
    const relayConnector: RelayConnector = {
      async relay(request) {
        const optionId = request.stepId.endsWith('option-1')
          ? 'option-1'
          : request.stepId.endsWith('option-2')
            ? 'option-2'
            : 'option-3';
        return {
          verdict: 'accept',
          option_id: optionId,
          option_label: `Option ${optionId.at(-1)}`,
          case_summary: request.prompt,
          assumptions: [],
          evidence_refs: ['generated fixture'],
          risks: [],
          next_action: 'Continue the parity run.',
          rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
        };
      },
    };

    await withTempRun(async (runDir) => {
      const simple = createSimpleParityExecutors();
      const result = await runSimpleCompiledFlow({
        flowBytes: bytes,
        runDir,
        runId: '77777777-7777-4777-8777-777777777777',
        goal: 'Choose between options with runtime',
        entryModeName: 'tournament',
        relayConnector,
        executors: {
          ...simple,
          compose: async (step, context) => {
            if (step.id === 'decision-options-step') {
              await context.files.writeJson('reports/decision-options.json', {
                decision_question: 'Which option should we choose?',
                options: [
                  { id: 'option-1', best_case_prompt: 'make the case for option 1' },
                  { id: 'option-2', best_case_prompt: 'make the case for option 2' },
                  { id: 'option-3', best_case_prompt: 'make the case for option 3' },
                ],
              });
              return { route: 'pass', details: { report: 'reports/decision-options.json' } };
            }
            const compose = simple.compose;
            if (compose === undefined) throw new Error('missing compose executor');
            return await compose(step, context);
          },
        },
      });

      expect(result.outcome).toBe('complete');
      const trace = await readTrace(runDir);
      expect(trace.find((entry) => entry.kind === 'fanout.joined')?.branches_completed).toBe(3);
      const aggregate = JSON.parse(
        await readFile(join(runDir, 'reports', 'tournament-aggregate.json'), 'utf8'),
      ) as { branch_count: number };
      expect(aggregate.branch_count).toBe(3);
    });
  });

  it('runs the generated explore tournament through production runtime wait and resume', async () => {
    const bytes = await loadTournamentFixture();
    await withTempRun(async (runDir) => {
      const progressEvents: unknown[] = [];
      const waiting = await runCompiledFlowWithWaiting({
        flowBytes: bytes,
        runDir,
        runId: '77777777-7777-4777-8777-777777777778',
        goal: 'decide: React vs Vue',
        entryModeName: 'tournament',
        depth: 'tournament',
        relayer: tournamentRelayer(),
        now: deterministicNow(Date.UTC(2026, 3, 29, 16, 30, 0)),
        progress: (event) => progressEvents.push(event),
      });

      expect(isGraphCheckpointWaitingResult(waiting)).toBe(true);
      if (!isGraphCheckpointWaitingResult(waiting)) {
        throw new Error('expected checkpoint_waiting');
      }
      expect(waiting.checkpoint).toMatchObject({
        stepId: 'tradeoff-checkpoint-step',
        allowedChoices: ['option-1', 'option-2', 'option-3'],
      });
      expect(existsSync(join(runDir, 'reports/checkpoints/tradeoff-response.json'))).toBe(false);

      const options = (await readJson(runDir, 'reports/decision-options.json')) as {
        options: ReadonlyArray<{ id: string; label: string }>;
      };
      expect(options.options.map((option) => option.label)).toEqual([
        'React',
        'Vue',
        'Hybrid path',
      ]);

      for (const branch of ['option-1', 'option-2', 'option-3']) {
        const branchDir = join(runDir, 'reports', 'tournament-branches', branch);
        expect(existsSync(join(branchDir, 'request.txt'))).toBe(true);
        expect(existsSync(join(branchDir, 'request.json'))).toBe(false);
        expect(existsSync(join(branchDir, 'receipt.txt'))).toBe(true);
        expect(existsSync(join(branchDir, 'result.json'))).toBe(true);
        expect(existsSync(join(branchDir, 'report.json'))).toBe(true);
      }
      await expect(
        readFile(join(runDir, 'reports', 'tournament-branches', 'option-1', 'request.txt'), 'utf8'),
      ).resolves.toContain('Step: proposal-fanout-step-option-1');

      const aggregate = (await readJson(runDir, 'reports/tournament-aggregate.json')) as {
        branch_count: number;
        branches: ReadonlyArray<{ branch_id: string; result_body?: { option_id: string } }>;
      };
      expect(aggregate.branch_count).toBe(3);
      expect(aggregate.branches.map((branch) => branch.branch_id).sort()).toEqual([
        'option-1',
        'option-2',
        'option-3',
      ]);
      for (const branch of aggregate.branches) {
        expect(branch.result_body?.option_id).toBe(branch.branch_id);
      }

      const review = (await readJson(runDir, 'reports/tournament-review.json')) as {
        tradeoff_question: string;
      };
      expect(review.tradeoff_question).toBe('Choose React ecosystem depth or Vue iteration speed.');
      const userInput = progressEvents.find(
        (event) => (event as { type?: string }).type === 'user_input.requested',
      ) as
        | {
            questions: ReadonlyArray<{
              question: string;
              options: ReadonlyArray<{
                label: string;
                description: string;
                checkpoint_choice: string;
              }>;
            }>;
          }
        | undefined;
      expect(userInput?.questions[0]?.question).toBe(
        'Choose React ecosystem depth or Vue iteration speed.',
      );
      expect(userInput?.questions[0]?.options).toMatchObject([
        { label: 'React', checkpoint_choice: 'option-1' },
        { label: 'Vue', checkpoint_choice: 'option-2' },
        { label: 'Hybrid path', checkpoint_choice: 'option-3' },
      ]);

      const status = projectRunStatusFromRunFolder(runDir);
      expect(status).toMatchObject({
        engine_state: 'waiting_checkpoint',
        checkpoint: {
          prompt: 'Choose React ecosystem depth or Vue iteration speed.',
          choices: [
            { id: 'option-1', label: 'React', value: 'option-1' },
            { id: 'option-2', label: 'Vue', value: 'option-2' },
            { id: 'option-3', label: 'Hybrid path', value: 'option-3' },
          ],
        },
      });

      const resumed = await resumeCompiledFlow({
        runDir,
        selection: 'option-2',
        relayer: tournamentRelayer(),
        now: deterministicNow(Date.UTC(2026, 3, 29, 16, 40, 0)),
      });

      expect(resumed.outcome).toBe('complete');
      const response = (await readJson(runDir, 'reports/checkpoints/tradeoff-response.json')) as {
        selection: string;
        resolution_source: string;
      };
      expect(response).toMatchObject({
        selection: 'option-2',
        resolution_source: 'operator',
      });

      const decision = (await readJson(runDir, 'reports/decision.json')) as {
        selected_option_id: string;
        selected_option_label: string;
        decision: string;
        follow_up_workflow: string;
      };
      expect(decision.selected_option_id).toBe('option-2');
      expect(decision.selected_option_label).toBe('Vue');
      expect(decision.decision).toMatch(/smaller surface/);
      expect(decision.follow_up_workflow).toBe('Build');

      const result = (await readJson(runDir, 'reports/explore-result.json')) as {
        verdict_snapshot: { selected_option_id: string };
        evidence_links: ReadonlyArray<{ report_id: string; path: string; schema?: string }>;
      };
      expect(result.verdict_snapshot.selected_option_id).toBe('option-2');
      expect(result.evidence_links).toContainEqual({
        report_id: 'explore.tournament-aggregate',
        path: 'reports/tournament-aggregate.json',
        schema: 'explore.tournament-aggregate@v1',
      });
      await expect(readJson(runDir, 'reports/result.json')).resolves.toMatchObject({
        outcome: 'complete',
      });

      const trace = await readTrace(runDir);
      expect(trace.some((entry) => entry.kind === 'checkpoint.resolved')).toBe(true);
      expect(trace.at(-1)).toMatchObject({ kind: 'run.closed', outcome: 'complete' });
    });
  });
});
