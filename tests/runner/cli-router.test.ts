import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureStreams, deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { main } from '../../src/cli/circuit.js';
import { ReviewIntake } from '../../src/flows/review/reports.js';
import { ProgressEvent } from '../../src/schemas/progress-event.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const EXPLORE_SYNTHESIS_BODY = JSON.stringify({
  verdict: 'accept',
  subject: 'CLI-routed explore goal',
  recommendation: 'Return the requested exploration summary',
  success_condition_alignment: 'The response satisfies the exploratory goal',
  supporting_aspects: [
    {
      aspect: 'routing',
      contribution: 'The explore flow reached the synthesize step',
      evidence_refs: ['reports/analysis.json'],
    },
  ],
});

const EXPLORE_REVIEW_VERDICT_BODY = JSON.stringify({
  verdict: 'accept',
  overall_assessment: 'The exploratory compose is acceptable',
  objections: [],
  missed_angles: [],
});

const BUILD_CONTEXT_BODY = JSON.stringify({
  verdict: 'accept',
  sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches.' }],
  observations: ['The target module is small and self-contained.'],
  open_questions: [],
  anticipated_file_extensions: ['.ts'],
});

const BUILD_IMPLEMENTATION_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'Implemented the requested change',
  changed_files: ['src/example.ts'],
  evidence: ['Stub implementation relay completed'],
});

const BUILD_REVIEW_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'No blocking issue found',
  findings: [],
  alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
});

const PURSUIT_BATCH_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'Completed the pursuit serially',
  serialized_execution: true,
  completed: [
    {
      pursuit_id: 'pursuit-1',
      status: 'completed',
      summary: 'Applied the requested pursuit',
      evidence: ['stub pursuit implementation completed'],
    },
  ],
  skipped: [],
  blocked: [],
  failed: [],
  actual_touch_set: {
    paths: ['README.md'],
    symbols: [],
    commands: ['npm run verify'],
    generated_outputs: [],
  },
  proof_evidence: ['npm run verify passed'],
});

const PURSUIT_REVIEW_BODY = JSON.stringify({
  verdict: 'clean',
  summary: 'No coordination issues found',
  reviewed_pursuits: [
    {
      pursuit_id: 'pursuit-1',
      assessment: 'Verified the single pursuit landed with no cross-goal regression.',
    },
  ],
  findings: [],
});

// Stub Review relay payload used across CLI router tests. The schema requires
// reviewer prose on every verdict, so a bare `{verdict, findings}` body would
// fail validation and abort the run.
const REVIEW_RELAY_BODY = JSON.stringify({
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
  verification: ['Inspected the relayed intake report.'],
  confidence_limitations: [],
});

function createProofProject(name: string): string {
  const projectRoot = join(runFolderBase, name);
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        scripts: {
          verify: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    )}\n`,
  );
  return projectRoot;
}

function relayerWithBody(body: string): RelayFn {
  return makeStubRelayer(
    (input) =>
      input.prompt.includes('Step: analyze-step') && body === '{"verdict":"accept"}'
        ? BUILD_CONTEXT_BODY
        : input.prompt.includes('Step: act-step') && body === '{"verdict":"accept"}'
          ? BUILD_IMPLEMENTATION_BODY
          : input.prompt.includes('Step: review-step') &&
              input.prompt.includes('build.review@v1') &&
              body === '{"verdict":"accept"}'
            ? BUILD_REVIEW_BODY
            : input.prompt.includes('Step: synthesize-step') && body === '{"verdict":"accept"}'
              ? EXPLORE_SYNTHESIS_BODY
              : input.prompt.includes('Step: review-step') && body === '{"verdict":"accept"}'
                ? EXPLORE_REVIEW_VERDICT_BODY
                : body,
    { receipt_id: 'stub-receipt-cli-router' },
  );
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
  const proposal = (option_id: string, option_label: string, case_summary: string) => ({
    verdict: 'accept',
    option_id,
    option_label,
    case_summary,
    assumptions: ['The operator accepts the stated tradeoff.'],
    evidence_refs: ['reports/decision-options.json'],
    risks: ['The proof fixture only covers synthetic decision evidence.'],
    next_action: `Run a Build plan for ${option_label}.`,
    rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
  });
  return makeStubRelayer((input) => {
    if (input.prompt.includes('Step: proposal-fanout-step-option-1')) {
      return JSON.stringify(proposal('option-1', 'React', 'Choose React for ecosystem depth.'));
    }
    if (input.prompt.includes('Step: proposal-fanout-step-option-2')) {
      return JSON.stringify(proposal('option-2', 'Vue', 'Choose Vue for iteration speed.'));
    }
    if (input.prompt.includes('Step: proposal-fanout-step-option-3')) {
      return JSON.stringify(
        proposal('option-3', 'Hybrid path', 'Prototype both paths before choosing.'),
      );
    }
    if (input.prompt.includes('Step: proposal-fanout-step-option-4')) {
      return JSON.stringify(
        proposal('option-4', 'Defer pending evidence', 'Gather missing constraints first.'),
      );
    }
    return JSON.stringify({
      verdict: 'recommend',
      recommended_option_id: 'option-1',
      comparison: 'React carries ecosystem depth while Vue carries speed.',
      objections: ['The choice lacks a spike.'],
      missing_evidence: ['No production spike exists.'],
      tradeoff_question: 'Choose ecosystem depth or iteration speed.',
      confidence: 'medium',
    });
  });
}

function runtimeVetoedTournamentRelayer(): RelayFn {
  const base = tournamentRelayer();
  return {
    connectorName: base.connectorName,
    relay: async (input) => {
      const result = await base.relay(input);
      const resultBody = JSON.parse(result.result_body) as Record<string, unknown>;
      if (resultBody.option_id !== 'option-1') return result;
      return {
        ...result,
        result_body: JSON.stringify({
          ...resultBody,
          evidence_refs: [],
        }),
      };
    },
  };
}

function pursueCliRelayer(): RelayFn {
  return makeStubRelayer((input) => {
    if (input.prompt.includes('Step: batch-step')) {
      return PURSUIT_BATCH_BODY;
    }
    if (input.prompt.includes('Step: review-step')) {
      return PURSUIT_REVIEW_BODY;
    }
    throw new Error(`unexpected pursue CLI relay prompt: ${input.prompt.slice(0, 240)}`);
  });
}

function traceEntryLog(runFolder: string): Array<Record<string, unknown>> {
  return readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// The CLI exit code mirrors the closed outcome: an aborted close exits 1,
// every other envelope (complete, waiting checkpoint, utility output) exits 0.
function expectExitMatchesOutcome(exit: number, output: Record<string, unknown>): void {
  expect(exit).toBe(output.outcome === 'aborted' ? 1 : 0);
}

async function runMainJson(
  argv: readonly string[],
  relayBody: string,
  options: { readonly configCwd?: string } = {},
): Promise<Record<string, unknown>> {
  const { result: exit, stdout: captured } = await captureStreams(() =>
    main(argv, {
      relayer: relayerWithBody(relayBody),
      now: deterministicNow(Date.UTC(2026, 3, 24, 15, 0, 0)),
      runId: '84000000-0000-0000-0000-000000000001',
      configHomeDir: join(runFolderBase, 'empty-home'),
      configCwd: options.configCwd ?? process.cwd(),
    }),
  );
  const parsed: unknown = JSON.parse(captured);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CLI output was not a JSON object');
  }
  const output = parsed as Record<string, unknown>;
  expectExitMatchesOutcome(exit, output);
  return output;
}

async function runMainJsonWithRelayer(
  argv: readonly string[],
  relayer: RelayFn,
  options: { readonly configCwd?: string } = {},
): Promise<Record<string, unknown>> {
  const { result: exit, stdout: captured } = await captureStreams(() =>
    main(argv, {
      relayer,
      now: deterministicNow(Date.UTC(2026, 3, 24, 15, 0, 0)),
      runId: '84000000-0000-0000-0000-000000000001',
      configHomeDir: join(runFolderBase, 'empty-home'),
      configCwd: options.configCwd ?? process.cwd(),
    }),
  );
  const output = JSON.parse(captured) as Record<string, unknown>;
  expectExitMatchesOutcome(exit, output);
  return output;
}

async function runMainJsonWithRelayerAndProgress(
  argv: readonly string[],
  relayer: RelayFn,
  options: { readonly configCwd?: string } = {},
): Promise<{ output: Record<string, unknown>; progress: Array<ProgressEvent> }> {
  const {
    result: exit,
    stdout,
    stderr,
  } = await captureStreams(() =>
    main(argv, {
      relayer,
      now: deterministicNow(Date.UTC(2026, 3, 24, 15, 0, 0)),
      runId: '84000000-0000-0000-0000-000000000001',
      configHomeDir: join(runFolderBase, 'empty-home'),
      configCwd: options.configCwd ?? process.cwd(),
    }),
  );
  const output = JSON.parse(stdout) as Record<string, unknown>;
  expectExitMatchesOutcome(exit, output);
  const progress = stderr
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => ProgressEvent.parse(JSON.parse(line)));
  return { output, progress };
}

async function runMainJsonWithProgress(
  argv: readonly string[],
  relayBody: string,
  options: { readonly configCwd?: string } = {},
): Promise<{ output: Record<string, unknown>; progress: Array<ProgressEvent> }> {
  const {
    result: exit,
    stdout,
    stderr,
  } = await captureStreams(() =>
    main(argv, {
      relayer: relayerWithBody(relayBody),
      now: deterministicNow(Date.UTC(2026, 3, 24, 15, 0, 0)),
      runId: '84000000-0000-0000-0000-000000000001',
      configHomeDir: join(runFolderBase, 'empty-home'),
      configCwd: options.configCwd ?? process.cwd(),
    }),
  );
  const output = JSON.parse(stdout) as Record<string, unknown>;
  expectExitMatchesOutcome(exit, output);
  const progress = stderr
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => ProgressEvent.parse(JSON.parse(line)));
  return { output, progress };
}

async function runMainExit(argv: readonly string[]): Promise<{ exit: number; stderr: string }> {
  const { result: exit, stderr } = await captureStreams(() =>
    main(argv, {
      relayer: relayerWithBody('{"verdict":"accept"}'),
      now: deterministicNow(Date.UTC(2026, 3, 24, 15, 0, 0)),
      runId: '84000000-0000-0000-0000-000000000099',
      configHomeDir: join(runFolderBase, 'empty-home'),
      configCwd: process.cwd(),
    }),
  );
  return { exit, stderr };
}

async function withStrictruntime<T>(operation: () => Promise<T>): Promise<T> {
  const originalStrictRuntime = process.env.CIRCUIT_SHOW_RUNTIME_DECISION;
  try {
    process.env.CIRCUIT_SHOW_RUNTIME_DECISION = '1';
    return await operation();
  } finally {
    process.env.CIRCUIT_SHOW_RUNTIME_DECISION = originalStrictRuntime;
  }
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-cli-router-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('CLI router', () => {
  it('explicit review flow dispatches and completes', async () => {
    const output = await runMainJson(
      [
        'run',
        'review',
        '--goal',
        'review this patch for safety problems',
        '--run-folder',
        join(runFolderBase, 'review'),
      ],
      REVIEW_RELAY_BODY,
    );

    expect(output.flow_id).toBe('review');
    expect(output.selected_flow).toBe('review');
    expect(output.routed_by).toBe('explicit');
    expect(output.router_reason).toMatch(/explicit flow/i);
    expect(output.outcome).toBe('complete');
  });

  it('emits parseable progress JSONL to stderr without changing final stdout JSON', async () => {
    const runFolder = join(runFolderBase, 'review-progress-jsonl');
    const { output, progress } = await runMainJsonWithProgress(
      [
        'run',
        'review',
        '--goal',
        'review this patch for safety problems',
        '--progress',
        'jsonl',
        '--run-folder',
        runFolder,
      ],
      REVIEW_RELAY_BODY,
    );

    expect(output.flow_id).toBe('review');
    expect(output.selected_flow).toBe('review');
    expect(output.outcome).toBe('complete');
    expect(typeof output.operator_summary_path).toBe('string');
    expect(typeof output.operator_summary_markdown_path).toBe('string');
    expect(existsSync(output.operator_summary_path as string)).toBe(true);
    expect(existsSync(output.operator_summary_markdown_path as string)).toBe(true);
    expect(progress.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'route.selected',
        'run.started',
        'task_list.updated',
        'step.started',
        'relay.started',
        'relay.completed',
        'run.completed',
      ]),
    );
    expect(progress.slice(0, 3).map((event) => event.type)).toEqual([
      'route.selected',
      'run.started',
      'task_list.updated',
    ]);
    const progressTypes = progress.map((event) => event.type);
    expect(progressTypes.indexOf('step.started')).toBeLessThan(
      progressTypes.indexOf('relay.started'),
    );
    expect(progressTypes.indexOf('relay.started')).toBeLessThan(
      progressTypes.indexOf('relay.completed'),
    );
    expect(progressTypes.indexOf('relay.completed')).toBeLessThan(
      progressTypes.indexOf('run.completed'),
    );
    expect(progress.every((event) => event.display.text.length > 0)).toBe(true);
    expect(progress.find((event) => event.type === 'route.selected')?.display.text).toContain(
      'Circuit: Chose review',
    );
    expect(progress.find((event) => event.type === 'route.selected')?.presentation).toMatchObject({
      block_id: output.run_id,
      line_mode: 'append',
      status_text: 'Chose review.',
    });
    const taskListEvents = progress.filter((event) => event.type === 'task_list.updated');
    expect(taskListEvents.length).toBeGreaterThan(1);
    expect(taskListEvents.every((event) => event.presentation?.line_mode === 'suppress')).toBe(
      true,
    );
    expect(taskListEvents[0]?.tasks.every((task) => task.status === 'pending')).toBe(true);
    expect(
      taskListEvents.some((event) => event.tasks.some((task) => task.status === 'in_progress')),
    ).toBe(true);
    expect(
      taskListEvents.some((event) => event.tasks.some((task) => task.status === 'completed')),
    ).toBe(true);
    expect(progress.find((event) => event.type === 'relay.started')).toMatchObject({
      role: 'reviewer',
      connector_name: 'claude-code',
      filesystem_capability: 'trusted-write',
      display: {
        importance: 'major',
        tone: 'info',
      },
    });
    expect(progress.find((event) => event.type === 'relay.started')?.display.text).toBe(
      'Circuit: Asking the reviewer to check the result...',
    );
    expect(progress.find((event) => event.type === 'relay.started')?.presentation).toMatchObject({
      line_mode: 'replace_slot',
      slot_id: 'audit-step:relay',
      status_text: 'Asking the reviewer to check the result...',
    });
    expect(progress.find((event) => event.type === 'relay.completed')?.presentation).toMatchObject({
      line_mode: 'replace_slot',
      slot_id: 'audit-step:relay',
      status_text: 'Finished checking the result.',
    });
    expect(progress.find((event) => event.type === 'relay.started')?.display.text).not.toContain(
      'trusted-write',
    );
    expect(progress.find((event) => event.type === 'step.started')).toMatchObject({
      step_id: 'intake-step',
      step_title: 'Intake — resolve review scope',
      attempt: 1,
    });
    expect(progress.find((event) => event.type === 'step.started')?.display.text).toBe(
      'Circuit: Framing the work...',
    );
    expect(progress.find((event) => event.type === 'step.started')?.presentation).toMatchObject({
      line_mode: 'append',
      status_text: 'Framing the work...',
    });
  });

  it('keeps Explore progress display focused on the operator, not internal report names', async () => {
    const runFolder = join(runFolderBase, 'explore-progress-jsonl');
    const { output, progress } = await runMainJsonWithRelayerAndProgress(
      [
        'run',
        'explore',
        '--goal',
        'explore better internal evals',
        '--progress',
        'jsonl',
        '--run-folder',
        runFolder,
      ],
      relayerWithBody('{"verdict":"accept"}'),
    );

    expect(output.flow_id).toBe('explore');
    const visibleText = progress
      .filter(
        (event) =>
          event.display.importance === 'major' ||
          event.display.tone === 'warning' ||
          event.display.tone === 'error' ||
          event.display.tone === 'checkpoint',
      )
      .map((event) => event.display.text)
      .join('\n');
    expect(visibleText).toContain('Circuit: Framing the work...');
    expect(visibleText).toContain('Circuit: Drafting the recommendation...');
    expect(visibleText).toContain('Circuit: Asking the reviewer to check the recommendation...');
    expect(visibleText).not.toContain('explore.brief');
    expect(visibleText).not.toContain('connector-bound relay');
    expect(visibleText).not.toContain('trusted-write');
    expect(visibleText).not.toContain('accept-with-fold-ins');
  });

  it('keeps explicit route selection machine-readable while Explore completion copy stays concise', async () => {
    const runFolder = join(runFolderBase, 'explore-progress-copy');
    const { output, progress } = await runMainJsonWithProgress(
      [
        'run',
        'explore',
        '--goal',
        'compare host rendering options',
        '--progress',
        'jsonl',
        '--run-folder',
        runFolder,
      ],
      '{"verdict":"accept"}',
    );

    expect(output.flow_id).toBe('explore');
    expect(progress.find((event) => event.type === 'route.selected')).toMatchObject({
      selected_flow: 'explore',
      routed_by: 'explicit',
    });
    const completedTexts = progress
      .filter((event) => event.type === 'step.completed' || event.type === 'task_list.updated')
      .map((event) => event.display.text);
    expect(completedTexts).toContain('Finished drafting the recommendation.');
    expect(completedTexts).toContain('Finished checking the recommendation.');
    expect(completedTexts).toContain('Finished wrapping up.');
  });

  it('runs an explicit Explore tournament through the public CLI', async () => {
    const runFolder = join(runFolderBase, 'explore-tournament-cli');
    const output = await runMainJsonWithRelayer(
      [
        'run',
        'explore',
        '--goal',
        'decide: React vs Vue',
        '--tournament',
        '--run-folder',
        runFolder,
      ],
      tournamentRelayer(),
    );

    const trace_entries = traceEntryLog(runFolder);
    const bootstrap = trace_entries.find((trace_entry) => trace_entry.kind === 'run.bootstrapped');
    const stressReview = trace_entries.find(
      (trace_entry) =>
        trace_entry.kind === 'relay.completed' && trace_entry.step_id === 'stress-proposals-step',
    );
    expect(output.flow_id).toBe('explore');
    expect(output.selected_flow).toBe('explore');
    expect(output.entry_mode).toBe('tournament');
    expect(output.entry_mode_source).toBe('explicit');
    expect(output.outcome).toBe('checkpoint_waiting');
    expect(output.checkpoint).toMatchObject({
      step_id: 'tradeoff-checkpoint-step',
      allowed_choices: ['option-1', 'option-2', 'option-3'],
    });
    expect(bootstrap).toMatchObject({ depth: 'tournament' });
    expect(stressReview).toBeDefined();
  });

  it('surfaces actual tournament option labels in checkpoint user input', async () => {
    const runFolder = join(runFolderBase, 'explore-tournament-progress');
    const { output, progress } = await runMainJsonWithRelayerAndProgress(
      [
        'run',
        'explore',
        '--goal',
        'decide: React vs Vue',
        '--tournament',
        '--run-folder',
        runFolder,
        '--progress',
        'jsonl',
      ],
      tournamentRelayer(),
    );

    expect(output.outcome).toBe('checkpoint_waiting');
    expect(progress.find((event) => event.type === 'fanout.started')?.presentation).toMatchObject({
      line_mode: 'replace_slot',
      status_text: 'Comparing 3 options...',
    });
    expect(
      progress
        .filter(
          (event) =>
            event.type === 'fanout.branch_started' || event.type === 'fanout.branch_completed',
        )
        .every((event) => event.presentation?.line_mode === 'suppress'),
    ).toBe(true);
    expect(progress.find((event) => event.type === 'fanout.joined')?.presentation).toMatchObject({
      line_mode: 'replace_slot',
      status_text: 'Finished comparing the options.',
    });
    const waiting = progress.find((event) => event.type === 'checkpoint.waiting');
    expect(waiting?.display.text).toContain('React, Vue');
    const userInput = progress.find((event) => event.type === 'user_input.requested');
    if (userInput?.type !== 'user_input.requested') {
      throw new Error('expected user_input.requested progress event');
    }
    const [question] = userInput.questions;
    expect(question?.question).toContain('ecosystem depth or iteration speed');
    expect(question?.options.map((option) => option.label)).toEqual([
      'React',
      'Vue',
      'Hybrid path',
    ]);
    expect(question?.options.map((option) => option.checkpoint_choice)).toEqual([
      'option-1',
      'option-2',
      'option-3',
    ]);
    expect(typeof output.operator_summary_markdown_path).toBe('string');
    const markdown = readFileSync(output.operator_summary_markdown_path as string, 'utf8');
    expect(markdown).toContain('Checkpoint options: React (option-1); Vue (option-2)');
  });

  it('passes explicit untracked-content opt-in to Review evidence intake', async () => {
    const projectRoot = join(runFolderBase, 'review-untracked-cli-project');
    const runFolder = join(runFolderBase, 'review-untracked-cli-run');
    const scratch = 'CLI flag explicitly allowed this untracked content';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'scratch.txt'), `${scratch}\n`);

    const output = await runMainJson(
      [
        'run',
        'review',
        '--goal',
        'review this untracked scratch file',
        '--include-untracked-content',
        '--run-folder',
        runFolder,
      ],
      REVIEW_RELAY_BODY,
      { configCwd: projectRoot },
    );

    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence.kind).toBe('git-working-tree');
    if (intake.evidence.kind !== 'git-working-tree') return;
    expect(intake.evidence.untracked_content_policy).toBe('include-content');
    expect(intake.evidence.untracked_files[0]).toMatchObject({
      path: 'scratch.txt',
      content: { text: `${scratch}\n`, truncated: false },
    });
    expect(typeof output.operator_summary_markdown_path).toBe('string');
    const markdown = readFileSync(output.operator_summary_markdown_path as string, 'utf8');
    expect(markdown).toContain('Untracked evidence: contents included for 1 file');
  });

  it('emits run.aborted progress when a run aborts', async () => {
    const abortRunFolder = join(runFolderBase, 'review-progress-aborted');
    const { output, progress } = await runMainJsonWithProgress(
      [
        'run',
        'review',
        '--goal',
        'review this malformed relay body',
        '--progress',
        'jsonl',
        '--run-folder',
        abortRunFolder,
      ],
      '{"verdict":"NO_ISSUES_FOUND","findings":"not-an-array"}',
    );

    expect(output.outcome).toBe('aborted');
    expect(typeof output.operator_summary_markdown_path).toBe('string');
    // F-H-2: the aborted stdout envelope must carry the specific reason so a
    // non-streaming host (and the present no-blocks branch) renders it instead
    // of a generic fallback. The envelope reason must equal result.json's
    // reason — the same source the present wrapper reads via result_path.
    expect(typeof output.reason).toBe('string');
    expect((output.reason as string).length).toBeGreaterThan(0);
    const resultJson = JSON.parse(
      readFileSync(join(abortRunFolder, 'reports', 'result.json'), 'utf8'),
    ) as { reason?: string };
    expect(output.reason).toBe(resultJson.reason);
    expect(progress.map((event) => event.type)).toContain('run.aborted');
    expect(progress.find((event) => event.type === 'run.aborted')?.display.tone).toBe('error');
    expect(progress.find((event) => event.type === 'run.aborted')?.presentation).toMatchObject({
      line_mode: 'append',
      status_text: expect.stringContaining('Run aborted:'),
    });
    const lastTaskList = progress.filter((event) => event.type === 'task_list.updated').at(-1);
    expect(lastTaskList?.tasks.some((task) => task.status === 'failed')).toBe(true);
  });

  it('explicit build flow dispatches and completes', async () => {
    const projectRoot = createProofProject('build-router-project');
    const output = await runMainJson(
      [
        'run',
        'build',
        '--goal',
        'develop: add a focused feature',
        '--run-folder',
        join(runFolderBase, 'build'),
      ],
      '{"verdict":"accept"}',
      { configCwd: projectRoot },
    );

    expect(output.flow_id).toBe('build');
    expect(output.selected_flow).toBe('build');
    expect(output.routed_by).toBe('explicit');
    expect(output.router_reason).toMatch(/explicit flow/i);
    expect(output.outcome).toBe('complete');
  }, 60_000);

  it('preserves route metadata on Build checkpoint_waiting output', async () => {
    const runFolder = join(runFolderBase, 'build-router-checkpoint-waiting');
    const projectRoot = createProofProject('build-router-checkpoint-waiting-project');
    const output = await runMainJson(
      [
        'run',
        'build',
        '--goal',
        'develop: add a focused feature that waits for framing',
        '--depth',
        'high',
        '--run-folder',
        runFolder,
      ],
      '{"verdict":"accept"}',
      { configCwd: projectRoot },
    );

    expect(output.schema_version).toBe(1);
    expect(output.flow_id).toBe('build');
    expect(output.selected_flow).toBe('build');
    expect(output.routed_by).toBe('explicit');
    expect(output.router_reason).toMatch(/explicit flow/i);
    expect(output.outcome).toBe('checkpoint_waiting');
    expect(output).not.toHaveProperty('result_path');
    expect(output.checkpoint).toMatchObject({
      step_id: 'frame-step',
      request_path: join(runFolder, 'reports/checkpoints/frame-step-request.json'),
      allowed_choices: ['continue'],
    });
  });

  it('emits checkpoint.waiting progress for paused checkpoint runs', async () => {
    const runFolder = join(runFolderBase, 'build-router-checkpoint-progress');
    const projectRoot = createProofProject('build-router-checkpoint-progress-project');
    const { output, progress } = await runMainJsonWithProgress(
      [
        'run',
        'build',
        '--goal',
        'develop: add a focused feature that waits for framing',
        '--depth',
        'high',
        '--progress',
        'jsonl',
        '--run-folder',
        runFolder,
      ],
      '{"verdict":"accept"}',
      { configCwd: projectRoot },
    );

    expect(output.outcome).toBe('checkpoint_waiting');
    expect(typeof output.operator_summary_markdown_path).toBe('string');
    expect(existsSync(output.operator_summary_markdown_path as string)).toBe(true);
    expect(progress).toContainEqual(
      expect.objectContaining({
        type: 'run.started',
        display: expect.objectContaining({
          tone: 'warning',
          text: expect.stringContaining('A worker can edit this checkout.'),
        }),
      }),
    );
    expect(progress).toContainEqual(
      expect.objectContaining({
        type: 'checkpoint.waiting',
        step_id: 'frame-step',
        allowed_choices: ['continue'],
        display: expect.objectContaining({ tone: 'checkpoint' }),
        presentation: expect.objectContaining({
          line_mode: 'append',
          status_text: 'Waiting for your choice...',
        }),
      }),
    );
    expect(progress).toContainEqual(
      expect.objectContaining({
        type: 'user_input.requested',
        checkpoint: expect.objectContaining({
          step_id: 'frame-step',
          request_path: join(runFolder, 'reports/checkpoints/frame-step-request.json'),
          allowed_choices: ['continue'],
        }),
        questions: [
          expect.objectContaining({
            id: 'checkpoint-choice',
            header: 'Choice',
            allow_free_text: false,
            options: [
              expect.objectContaining({
                label: 'Continue',
                checkpoint_choice: 'continue',
              }),
            ],
          }),
        ],
        resume: expect.objectContaining({
          run_folder: runFolder,
          checkpoint_choice_arg: '<choice>',
        }),
        display: expect.objectContaining({ tone: 'checkpoint' }),
        presentation: expect.objectContaining({ line_mode: 'suppress' }),
      }),
    );
  });

  it('explicit flow positional names the flow', async () => {
    const output = await runMainJson(
      [
        'run',
        'explore',
        '--goal',
        'review this patch for safety problems',
        '--run-folder',
        join(runFolderBase, 'explicit-explore'),
      ],
      '{"verdict":"accept"}',
    );

    expect(output.flow_id).toBe('explore');
    expect(output.selected_flow).toBe('explore');
    expect(output.routed_by).toBe('explicit');
    expect(output.router_reason).toMatch(/explicit flow/i);
  });

  it('rejects a run without an explicit flow (routing is model-only)', async () => {
    const runFolder = join(runFolderBase, 'run-no-flow-reject');
    const result = await runMainExit([
      'run',
      '--goal',
      'review this patch for safety problems',
      '--run-folder',
      runFolder,
    ]);

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('a flow name is required');
    expect(existsSync(runFolder)).toBe(false);
  });

  it('run <flow> --goal dispatches the explicit flow', async () => {
    const output = await runMainJson(
      [
        'run',
        'explore',
        '--goal',
        'review this patch for safety problems',
        '--run-folder',
        join(runFolderBase, 'run-explicit-explore'),
      ],
      '{"verdict":"accept"}',
    );

    expect(output.flow_id).toBe('explore');
    expect(output.routed_by).toBe('explicit');
  });

  it('runs explicit Pursue through the runtime support matrix', async () => {
    const runFolder = join(runFolderBase, 'run-explicit-pursue');
    const output = await withStrictruntime(() =>
      runMainJsonWithRelayer(
        ['run', 'pursue', '--goal', 'pursue: update README.md', '--run-folder', runFolder],
        pursueCliRelayer(),
        { configCwd: createProofProject('pursue-proof-project') },
      ),
    );

    expect(output.flow_id).toBe('pursue');
    expect(output.routed_by).toBe('explicit');
    expect(output.outcome).toBe('complete');
    expect(output.runtime_reason).toMatch(/runtime supports fresh pursue/i);
  });

  it('lets explicit --depth medium set the Build default depth', async () => {
    const runFolder = join(runFolderBase, 'build-explicit-default-mode');
    const projectRoot = createProofProject('build-explicit-default-mode-project');

    const output = await withStrictruntime(() =>
      runMainJson(
        [
          'run',
          'build',
          '--goal',
          'develop: add a small standard change',
          '--depth',
          'medium',
          '--run-folder',
          runFolder,
        ],
        '{"verdict":"accept"}',
        { configCwd: projectRoot },
      ),
    );

    const bootstrap = traceEntryLog(runFolder).find(
      (trace_entry) => trace_entry.kind === 'run.bootstrapped',
    );
    expect(output.flow_id).toBe('build');
    expect(output.entry_mode).toBe('default');
    expect(output.entry_mode_source).toBe('explicit');
    expect(bootstrap).toMatchObject({ depth: 'medium' });
  }, 30_000);

  it('uses --depth to select the matching axis depth', async () => {
    const runFolder = join(runFolderBase, 'build-depth-only');
    const projectRoot = createProofProject('build-depth-only-project');

    const output = await runMainJson(
      [
        'run',
        'build',
        '--goal',
        'develop: add a small deep change',
        '--depth',
        'high',
        '--run-folder',
        runFolder,
      ],
      '{"verdict":"accept"}',
      { configCwd: projectRoot },
    );

    expect(output.flow_id).toBe('build');
    expect(output.entry_mode).toBe('high');
    expect(output.entry_mode_source).toBe('explicit');
    const bootstrap = traceEntryLog(runFolder).find(
      (trace_entry) => trace_entry.kind === 'run.bootstrapped',
    );
    expect(bootstrap).toMatchObject({ depth: 'high' });
  }, 30_000);

  it('rejects tournament on flows whose axis allow-list does not support it', async () => {
    const runFolder = join(runFolderBase, 'fix-depth-tournament');

    const result = await runMainExit([
      'run',
      'fix',
      '--goal',
      'fix: a regression bug',
      '--tournament',
      '--run-folder',
      runFolder,
    ]);

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("--tournament is not supported by flow 'fix'");
    expect(result.stderr).toContain('fix allows depths:');
    expect(existsSync(runFolder)).toBe(false);
  });

  it('rejects prototype --tournament up-front when variant_models config is absent (F-M-2)', async () => {
    // With no `circuits.prototype.variant_models` config, the tournament axis
    // cannot resolve its model variants. This must reject up-front like an
    // unsupported axis (exit 2, no run folder) instead of aborting mid-run at
    // the variant-options step after framing and planning work. Empty config
    // dirs replicate a fresh repo with no project config.
    const runFolder = join(runFolderBase, 'prototype-tournament-no-config');
    const { result: exit, stderr } = await captureStreams(() =>
      main(
        [
          'run',
          'prototype',
          '--tournament',
          '--tournament-n',
          '2',
          '--goal',
          'compare two disposable README note variants',
          '--run-folder',
          runFolder,
        ],
        {
          relayer: relayerWithBody('{"verdict":"accept"}'),
          now: deterministicNow(Date.UTC(2026, 3, 24, 15, 0, 0)),
          runId: '84000000-0000-0000-0000-000000000077',
          configHomeDir: join(runFolderBase, 'empty-home'),
          configCwd: join(runFolderBase, 'empty-cwd'),
        },
      ),
    );

    expect(exit).toBe(2);
    expect(stderr).toContain('circuits.prototype.variant_models');
    expect(stderr).toContain('--tournament');
    // Up-front: no worker ran, so no run folder, no framing/planning artifacts.
    expect(existsSync(runFolder)).toBe(false);
  });

  it('rejects an internal flow absent from the host with a clear message (F-L-3)', async () => {
    // Simulate the host package: a flow root that ships only public flows, so
    // the internal `goal` fixture is absent. The reject must name goal as an
    // internal flow rather than leaking the generic fixture-not-found path.
    const hostFlowRoot = mkdtempSync(join(tmpdir(), 'circuit-host-flows-'));
    const runFolder = join(runFolderBase, 'goal-host-reject');
    const result = await runMainExit([
      'run',
      'goal',
      '--goal',
      'achieve the objective',
      '--flow-root',
      hostFlowRoot,
      '--run-folder',
      runFolder,
    ]);
    rmSync(hostFlowRoot, { recursive: true, force: true });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('goal is an internal flow');
    expect(result.stderr).not.toContain('flow fixture not found');
    expect(existsSync(runFolder)).toBe(false);
  });

  it('accepts --depth low and threads low depth into relay selection', async () => {
    const runFolder = join(runFolderBase, 'build-low-entry-mode');
    const projectRoot = createProofProject('build-low-entry-mode-project');
    const output = await runMainJson(
      [
        'run',
        'build',
        '--goal',
        'Add a tiny Build feature from the CLI',
        '--depth',
        'low',
        '--run-folder',
        runFolder,
      ],
      '{"verdict":"accept"}',
      { configCwd: projectRoot },
    );

    const trace_entries = traceEntryLog(runFolder);
    const bootstrap = trace_entries.find((trace_entry) => trace_entry.kind === 'run.bootstrapped');
    const relayStarted = trace_entries.find(
      (trace_entry) => trace_entry.kind === 'relay.started' && trace_entry.step_id === 'act-step',
    );
    const relayResolvedSelection = relayStarted?.resolved_selection;
    expect(output.flow_id).toBe('build');
    expect(output.outcome).toBe('complete');
    expect(bootstrap).toMatchObject({ depth: 'low' });
    expect(relayResolvedSelection).toMatchObject({ depth: 'low' });
  }, 30_000);

  it('threads resolved depth into the relay prompt and records resolved axes on the envelope (F-M-1)', async () => {
    const lowPrompts: string[] = [];
    const lowOutput = await runMainJsonWithRelayer(
      [
        'run',
        'build',
        '--goal',
        'Add a tiny Build feature from the CLI',
        '--depth',
        'low',
        '--run-folder',
        join(runFolderBase, 'build-depth-low-thread'),
      ],
      makeStubRelayer((input) => {
        lowPrompts.push(input.prompt);
        return '{"verdict":"accept"}';
      }),
      { configCwd: createProofProject('build-depth-low-thread-project') },
    );

    const mediumPrompts: string[] = [];
    const mediumOutput = await runMainJsonWithRelayer(
      [
        'run',
        'build',
        '--goal',
        'Add a tiny Build feature from the CLI',
        '--run-folder',
        join(runFolderBase, 'build-depth-medium-thread'),
      ],
      makeStubRelayer((input) => {
        mediumPrompts.push(input.prompt);
        return '{"verdict":"accept"}';
      }),
      { configCwd: createProofProject('build-depth-medium-thread-project') },
    );

    // Thread: the relay prompt now carries the resolved depth, so build-low and
    // build-medium prompts differ — the F-M-1 "byte-identical relay payloads"
    // defect. Every relay step in each run sees the run's resolved depth.
    expect(lowPrompts.length).toBeGreaterThan(0);
    expect(mediumPrompts.length).toBeGreaterThan(0);
    expect(lowPrompts.every((prompt) => prompt.includes('Depth: low'))).toBe(true);
    expect(mediumPrompts.every((prompt) => prompt.includes('Depth: medium'))).toBe(true);
    // Record: the resolved axes are echoed on the stdout envelope so a reader
    // can audit which depth actually ran.
    expect(lowOutput.resolved_axes).toMatchObject({ depth: 'low' });
    expect(mediumOutput.resolved_axes).toMatchObject({ depth: 'medium' });
  }, 30_000);

  it('accepts --autonomous and threads autonomous depth into relay selection', async () => {
    const runFolder = join(runFolderBase, 'build-autonomous-axis');
    const projectRoot = createProofProject('build-autonomous-axis-project');
    const output = await runMainJson(
      [
        'run',
        'build',
        '--goal',
        'Add a tiny Build feature from the CLI with autonomous checkpoints',
        '--autonomous',
        '--run-folder',
        runFolder,
      ],
      '{"verdict":"accept"}',
      { configCwd: projectRoot },
    );

    const bootstrap = traceEntryLog(runFolder).find(
      (trace_entry) => trace_entry.kind === 'run.bootstrapped',
    );
    expect(output.flow_id).toBe('build');
    expect(output.entry_mode).toBe('autonomous');
    expect(output.entry_mode_source).toBe('explicit');
    expect(bootstrap).toMatchObject({ depth: 'autonomous' });
  }, 30_000);

  it('rejects fixtures that declare the old refuse checkpoint auto-resolution policy', async () => {
    const fixturePath = join(runFolderBase, 'build-refuse-fixture.json');
    const raw = JSON.parse(readFileSync('generated/flows/build/circuit.json', 'utf8')) as {
      steps: Array<{
        id: string;
        kind: string;
        policy?: Record<string, unknown>;
      }>;
    };
    const frameStep = raw.steps.find((step) => step.id === 'frame-step');
    if (frameStep === undefined || frameStep.policy === undefined) {
      throw new Error('expected generated Build fixture to expose frame-step checkpoint policy');
    }
    frameStep.policy.auto_resolution = { policy: 'refuse' };
    writeFileSync(fixturePath, `${JSON.stringify(raw, null, 2)}\n`);

    await expect(
      main(
        [
          'run',
          'build',
          '--goal',
          'Try an invalid autonomous fixture',
          '--fixture',
          fixturePath,
          '--autonomous',
          '--run-folder',
          join(runFolderBase, 'build-refuse-run'),
        ],
        {
          relayer: relayerWithBody('{"verdict":"accept"}'),
          now: deterministicNow(Date.UTC(2026, 3, 24, 15, 0, 0)),
          runId: '84000000-0000-0000-0000-000000000006',
          configHomeDir: join(runFolderBase, 'empty-home'),
          configCwd: join(runFolderBase, 'empty-cwd'),
        },
      ),
    ).rejects.toThrow(/Invalid discriminator value\. Expected 'highest-score'/);
  });

  it('accepts explicit tournament flags on Explore and validates N in range', async () => {
    const runFolder = join(runFolderBase, 'explore-explicit-tournament-n4');
    const output = await runMainJsonWithRelayer(
      [
        'run',
        'explore',
        '--goal',
        'decide: React vs Vue',
        '--tournament',
        '--tournament-n',
        '4',
        '--run-folder',
        runFolder,
      ],
      tournamentRelayer(),
    );

    expect(output.flow_id).toBe('explore');
    expect(output.entry_mode).toBe('tournament');
    expect(output.entry_mode_source).toBe('explicit');
    expect(output.outcome).toBe('checkpoint_waiting');
    expect(output.checkpoint).toMatchObject({
      allowed_choices: ['option-1', 'option-2', 'option-3', 'option-4'],
    });
  });

  it('loads the tournament graph when autonomous is combined with tournament', async () => {
    const runFolder = join(runFolderBase, 'explore-autonomous-tournament');
    const output = await runMainJsonWithRelayer(
      [
        'run',
        'explore',
        '--goal',
        'decide: React vs Vue',
        '--tournament',
        '--autonomous',
        '--run-folder',
        runFolder,
      ],
      tournamentRelayer(),
    );
    const trace = traceEntryLog(runFolder);

    expect(output.flow_id).toBe('explore');
    expect(output.entry_mode).toBe('autonomous');
    expect(output.entry_mode_source).toBe('explicit');
    expect(output.outcome).toBe('complete');
    expect(trace.map((entry) => entry.step_id)).toContain('proposal-fanout-step');
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'checkpoint.resolved',
        step_id: 'tradeoff-checkpoint-step',
        auto_resolved: true,
        selection: 'option-1',
        resolution_source: 'policy',
      }),
    );
    const response = JSON.parse(
      readFileSync(join(runFolder, 'reports/checkpoints/tradeoff-response.json'), 'utf8'),
    ) as { auto_resolution: { policy: string; resolved_value: string; tie_break: string } };
    expect(response.auto_resolution).toMatchObject({
      policy: 'highest-score',
      resolved_value: 'option-1',
      tie_break: 'original_ordinal',
    });
  });

  it('runs autonomous tournament end-to-end with a highest-score auto-resolution', async () => {
    const runFolder = join(runFolderBase, 'explore-autonomous-tournament-winner');
    const output = await runMainJsonWithRelayer(
      [
        'run',
        'explore',
        '--goal',
        'decide: React vs Vue',
        '--tournament',
        '--tournament-n',
        '2',
        '--autonomous',
        '--run-folder',
        runFolder,
      ],
      runtimeVetoedTournamentRelayer(),
    );

    expect(output).toMatchObject({
      flow_id: 'explore',
      entry_mode: 'autonomous',
      outcome: 'complete',
    });

    const response = JSON.parse(
      readFileSync(join(runFolder, 'reports/checkpoints/tradeoff-response.json'), 'utf8'),
    ) as {
      selection: string;
      auto_resolution: {
        resolved_value: string;
        alternatives_available: string[];
        scores: Record<string, { aggregate_score: number; runtime_veto_count: number }>;
        rubric_results: Record<
          string,
          {
            aggregate_score: number;
            dims: Record<string, { runtime_signal: string; runtime_vetoed: boolean }>;
          }
        >;
        runtime_veto_effect: string;
      };
    };
    expect(response.selection).toBe('option-2');
    expect(response.auto_resolution).toMatchObject({
      resolved_value: 'option-2',
      alternatives_available: ['option-1'],
      scores: {
        'option-1': { aggregate_score: 0.875, runtime_veto_count: 1 },
        'option-2': { aggregate_score: 1, runtime_veto_count: 0 },
      },
      runtime_veto_effect:
        'option-1 evidence_rigor runtime_signal=missing forced final_score=fail and dim_score=0',
    });
    expect(response.auto_resolution.rubric_results['option-1']?.dims.evidence_rigor).toMatchObject({
      runtime_signal: 'missing',
      runtime_vetoed: true,
    });

    const decision = JSON.parse(readFileSync(join(runFolder, 'reports/decision.json'), 'utf8')) as {
      selected_option_id: string;
      selected_option_label: string;
    };
    expect(decision).toMatchObject({
      selected_option_id: 'option-2',
      selected_option_label: 'Vue',
    });

    const result = JSON.parse(
      readFileSync(join(runFolder, 'reports/explore-result.json'), 'utf8'),
    ) as { verdict_snapshot: { selected_option_id: string } };
    expect(result.verdict_snapshot.selected_option_id).toBe('option-2');

    const summary = JSON.parse(readFileSync(output.operator_summary_path as string, 'utf8')) as {
      auto_resolutions: Array<{
        resolved_value: string;
        rubric_results: typeof response.auto_resolution.rubric_results;
        runtime_veto_effect: string;
      }>;
    };
    expect(summary.auto_resolutions[0]).toMatchObject({
      resolved_value: 'option-2',
      runtime_veto_effect: response.auto_resolution.runtime_veto_effect,
    });
    expect(summary.auto_resolutions[0]?.rubric_results['option-1']?.aggregate_score).toBe(0.875);

    const markdown = readFileSync(output.operator_summary_markdown_path as string, 'utf8');
    expect(markdown).toContain('Auto-resolutions');
    expect(markdown).toContain('option-2 selected by policy `highest-score`');
  });

  it('accepts the lower tournament N bound', async () => {
    const output = await runMainJsonWithRelayer(
      [
        'run',
        'explore',
        '--goal',
        'decide: A vs B',
        '--tournament',
        '--tournament-n',
        '2',
        '--run-folder',
        join(runFolderBase, 'explore-tournament-n2'),
      ],
      tournamentRelayer(),
    );

    expect(output).toMatchObject({
      outcome: 'checkpoint_waiting',
      checkpoint: {
        allowed_choices: ['option-1', 'option-2'],
      },
    });
  });

  it('accepts the default tournament N when omitted', async () => {
    const output = await runMainJsonWithRelayer(
      [
        'run',
        'explore',
        '--goal',
        'decide: A vs B',
        '--tournament',
        '--run-folder',
        join(runFolderBase, 'explore-tournament-n3-default'),
      ],
      tournamentRelayer(),
    );

    expect(output).toMatchObject({
      outcome: 'checkpoint_waiting',
      checkpoint: {
        allowed_choices: ['option-1', 'option-2', 'option-3'],
      },
    });
  });

  it.each(['1', '5'])('rejects tournament N=%s outside the v1 range', async (n) => {
    const result = await runMainExit([
      'run',
      'explore',
      '--goal',
      'decide: A vs B',
      '--tournament',
      '--tournament-n',
      n,
      '--run-folder',
      join(runFolderBase, `explore-tournament-n${n}`),
    ]);

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('Tournament N must be between 2 and 4');
  });

  it('lets Commander reject unknown options', async () => {
    const result = await runMainExit([
      'run',
      'build',
      '--goal',
      'Add a tiny Build feature from the CLI with an old flag',
      '--mode',
      'high',
      '--run-folder',
      join(runFolderBase, 'old-mode-flag'),
    ]);

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("unknown option '--mode'");
  });

  it('requires the explicit run command for routed runs', async () => {
    const runFolder = join(runFolderBase, 'root-goal-cutover');
    const result = await runMainExit([
      '--goal',
      'review this patch without the run command',
      '--run-folder',
      runFolder,
    ]);

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("unknown option '--goal'");
    expect(existsSync(runFolder)).toBe(false);
  });

  it('requires the explicit run command for named flows', async () => {
    const runFolder = join(runFolderBase, 'bare-flow-cutover');
    const result = await runMainExit([
      'build',
      '--goal',
      'try the old bare flow shortcut',
      '--run-folder',
      runFolder,
    ]);

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("unknown command 'build'");
    expect(existsSync(runFolder)).toBe(false);
  });

  it('accepts equals-form long options through Commander', async () => {
    const runFolder = join(runFolderBase, 'equals-form-options');
    const projectRoot = createProofProject('equals-form-project');
    const output = await runMainJson(
      [
        'run',
        'build',
        '--goal=Build through equals syntax',
        '--depth=high',
        `--run-folder=${runFolder}`,
      ],
      '{"verdict":"accept"}',
      { configCwd: projectRoot },
    );

    expect(output).toMatchObject({
      flow_id: 'build',
      selected_flow: 'build',
      entry_mode: 'high',
    });
  });

  it('keeps --dry-run rejected before runtime work starts', async () => {
    const result = await runMainExit([
      'run',
      'build',
      '--goal',
      'Add a tiny Build feature',
      '--dry-run',
      '--run-folder',
      join(runFolderBase, 'dry-run-rejected'),
    ]);

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('--dry-run is not currently implemented and is rejected');
  });

  it('accepts dash-prefixed value-slot strings through Commander', async () => {
    const result = await runMainExit([
      'resume',
      '--run-folder',
      join(runFolderBase, 'not-resumable'),
      '--checkpoint-choice',
      '--goal',
    ]);

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('no Circuit run folder found at');
    expect(result.stderr).not.toContain('omit --goal');
  });

  it('rejects fixture overrides whose flow id does not match the selected flow', async () => {
    await expect(
      main(
        [
          'run',
          'review',
          '--goal',
          'review this patch for safety problems',
          '--fixture',
          'generated/flows/explore/circuit.json',
          '--run-folder',
          join(runFolderBase, 'mismatch'),
        ],
        {
          relayer: relayerWithBody('{"verdict":"accept"}'),
          now: deterministicNow(Date.UTC(2026, 3, 24, 15, 0, 0)),
          runId: '84000000-0000-0000-0000-000000000004',
          configHomeDir: join(runFolderBase, 'empty-home'),
          configCwd: join(runFolderBase, 'empty-cwd'),
        },
      ),
    ).rejects.toThrow(/flow fixture id mismatch/i);
  });

  it('rejects --entry-mode as an unknown flag before writing a run trace', async () => {
    const runFolder = join(runFolderBase, 'unknown-build-entry-mode');
    const result = await runMainExit([
      'run',
      'build',
      '--goal',
      'Try a missing Build entry mode',
      '--entry-mode',
      'missing',
      '--run-folder',
      runFolder,
    ]);

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("unknown option '--entry-mode'");
    expect(() => traceEntryLog(runFolder)).toThrow();
  });

  it('prints a versioned checkpoint_waiting envelope without result_path', async () => {
    const runFolder = join(runFolderBase, 'checkpoint-waiting');
    const projectRoot = createProofProject('checkpoint-waiting-project');
    const output = await runMainJson(
      ['run', 'build', '--goal', 'Frame via CLI', '--depth', 'high', '--run-folder', runFolder],
      '{"verdict":"accept"}',
      { configCwd: projectRoot },
    );

    expect(output.schema_version).toBe(1);
    expect(output.outcome).toBe('checkpoint_waiting');
    expect(output).not.toHaveProperty('result_path');
    expect(output.checkpoint).toMatchObject({
      step_id: 'frame-step',
      allowed_choices: ['continue'],
    });
  });

  it('fails closed when resuming a invalid checkpoint_waiting run', async () => {
    const runFolder = join(runFolderBase, 'checkpoint-resume');
    mkdirSync(runFolder, { recursive: true });
    writeFileSync(
      join(runFolder, 'trace.ndjson'),
      `${JSON.stringify({ schema_version: 1, kind: 'run.started', flow_id: 'build' })}\n`,
    );

    const resumed = await runMainExit([
      'resume',
      '--run-folder',
      runFolder,
      '--checkpoint-choice',
      'continue',
    ]);

    expect(resumed.exit).toBe(2);
    // The folder exists but is not a runtime run folder (its trace has no
    // runtime bootstrap). The answer must say so — not claim the folder was
    // not found — and still offer the two next steps: the run-id folder
    // convention and the decision inbox.
    expect(resumed.stderr).toContain('is not a resumable Circuit run folder');
    expect(resumed.stderr).not.toContain('no Circuit run folder found');
    expect(resumed.stderr).toContain('circuit inbox');
  });

  it('rejects resume-only incompatible flags', async () => {
    const withDepth = await runMainExit([
      'resume',
      '--run-folder',
      join(runFolderBase, 'not-needed'),
      '--checkpoint-choice',
      'continue',
      '--depth',
      'high',
    ]);
    expect(withDepth.exit).toBe(2);
    expect(withDepth.stderr).toMatch(/omit --depth\/--tournament\/--tournament-n\/--autonomous/);

    const withFixture = await runMainExit([
      'resume',
      '--run-folder',
      join(runFolderBase, 'not-needed'),
      '--checkpoint-choice',
      'continue',
      '--fixture',
      join(runFolderBase, 'fixture.json'),
    ]);
    expect(withFixture.exit).toBe(2);
    expect(withFixture.stderr).toMatch(/omit --fixture/);

    const withAutonomous = await runMainExit([
      'resume',
      '--run-folder',
      join(runFolderBase, 'not-needed'),
      '--checkpoint-choice',
      'continue',
      '--autonomous',
    ]);
    expect(withAutonomous.exit).toBe(2);
    expect(withAutonomous.stderr).toMatch(
      /omit --depth\/--tournament\/--tournament-n\/--autonomous/,
    );
  });

  it('lets Commander reject retired --rigor as an unknown option', async () => {
    const withRigor = await runMainExit([
      'resume',
      '--run-folder',
      join(runFolderBase, 'not-needed'),
      '--checkpoint-choice',
      'continue',
      '--rigor',
      'high',
    ]);
    expect(withRigor.exit).toBe(2);
    expect(withRigor.stderr).toMatch(/unknown option '--rigor'/);
  });

  it('lets Commander reject old --mode as an unknown option on resume too', async () => {
    const withMode = await runMainExit([
      'resume',
      '--run-folder',
      join(runFolderBase, 'not-needed'),
      '--checkpoint-choice',
      'continue',
      '--mode',
      'low',
    ]);
    expect(withMode.exit).toBe(2);
    expect(withMode.stderr).toMatch(/unknown option '--mode'/);
  });

  it('parses --run-folder before rejecting resume-only --depth', async () => {
    // Resume validates other flags after argv parsing; pairing --run-folder
    // with --depth exercises the downstream axis-omit branch. The
    // branch firing proves --run-folder parsed and populated the run-folder slot.
    const result = await runMainExit([
      'resume',
      '--run-folder',
      join(runFolderBase, 'not-needed'),
      '--checkpoint-choice',
      'continue',
      '--depth',
      'high',
    ]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/omit --depth\/--tournament\/--tournament-n\/--autonomous/);
  });

  it("uses Commander's last-value-wins behavior for repeated scalar options", async () => {
    const conflict = await runMainExit([
      'resume',
      '--run-folder',
      join(runFolderBase, 'not-needed'),
      '--checkpoint-choice',
      'continue',
      '--depth',
      'medium',
      '--depth',
      'high',
    ]);
    expect(conflict.exit).toBe(2);
    expect(conflict.stderr).toMatch(/omit --depth\/--tournament\/--tournament-n\/--autonomous/);
  });

  it('rejects --tournament-n without --tournament', async () => {
    const conflict = await runMainExit([
      'run',
      'explore',
      '--goal',
      'decide: A vs B',
      '--tournament-n',
      '3',
      '--run-folder',
      join(runFolderBase, 'not-needed'),
    ]);
    expect(conflict.exit).toBe(2);
    expect(conflict.stderr).toMatch(/--tournament-n requires --tournament/);
  });

  it("uses Commander's last-value-wins behavior for repeated --run-folder", async () => {
    const conflict = await runMainExit([
      'resume',
      '--run-folder',
      join(runFolderBase, 'a'),
      '--run-folder',
      join(runFolderBase, 'b'),
      '--checkpoint-choice',
      'continue',
    ]);
    expect(conflict.exit).toBe(2);
    // Last value wins: the message names folder b, proving a was discarded.
    expect(conflict.stderr).toMatch(/no Circuit run folder found at .*\/b\./);
  });

  it('keeps CLI help text aligned with the explicit-flow contract', () => {
    const source = readFileSync(join(process.cwd(), 'src/cli/circuit.ts'), 'utf-8');
    expect(source).toContain('pass one of build|fix|review|explore|prototype|pursue');
    expect(source).toContain('the CLI never classifies the goal text');
    expect(source).not.toContain('classifies the free-form goal');
    expect(source).not.toContain('registered explore/review/build flows');
    expect(source).not.toContain('registered explore/review flows');
  });
});
