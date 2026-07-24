import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HISTORY_RECALL_REPORT_PATH } from '../../src/app/history/run-start-recall.js';
import { RUN_ENVELOPE_RELATIVE_PATH } from '../../src/app/run-envelope/source-record.js';
import { main } from '../../src/cli/circuit.js';
import { HistoryRecallReportV1, MemoryInputV0 } from '../../src/index.js';
import { RunEnvelopeRecord } from '../../src/schemas/run-envelope.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { captureStreams, makeStubRelayer } from '../helpers/runtime-fixtures.js';

const tempRoots: string[] = [];
const PRIOR_RUN_ID = '22222222-2222-4222-8222-222222222222';
const RECORDED_AT = '2026-05-26T12:00:00.000Z';
const REVIEW_RELAY_BODY = JSON.stringify({
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
  verification: ['Inspected the relayed intake report.'],
  confidence_limitations: [],
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writePriorHistoryFixture(projectRoot: string): void {
  const runFolder = join(projectRoot, '.circuit', 'runs', PRIOR_RUN_ID);
  mkdirSync(runFolder, { recursive: true });
  writeJson(join(runFolder, 'manifest.snapshot.json'), {
    schema_version: 1,
    run_id: PRIOR_RUN_ID,
    flow_id: 'review',
    captured_at: RECORDED_AT,
  });
  writeJson(join(runFolder, 'reports', 'result.json'), {
    flow_id: 'review',
    outcome: 'complete',
    goal: 'Explore local history memory injection',
    summary: 'Run closed with outcome complete.',
  });
  writeJson(join(runFolder, 'reports', 'decision.json'), {
    decision: 'Use automatic run-start recall from local history.',
    rationale: 'Recall must be cited and hint-only, and it must not grant authority.',
  });
  const trace = [
    {
      schema_version: 1,
      sequence: 0,
      recorded_at: RECORDED_AT,
      run_id: PRIOR_RUN_ID,
      kind: 'run.bootstrapped',
      flow_id: 'review',
      depth: 'medium',
      goal: 'Explore local history memory injection',
      change_kind: {
        change_kind: 'discovery',
        failure_mode: 'manual recall is easy to forget',
        acceptance_evidence: 'run-start recall writes a cited report',
        alternate_framing: 'arbitrary recall block',
      },
      manifest_hash: 'a'.repeat(64),
    },
    {
      schema_version: 1,
      sequence: 1,
      recorded_at: RECORDED_AT,
      run_id: PRIOR_RUN_ID,
      kind: 'step.report_written',
      step_id: 'decision-step',
      attempt: 1,
      report_path: 'reports/decision.json',
      report_schema: 'explore.decision@v1',
    },
    {
      schema_version: 1,
      sequence: 2,
      recorded_at: RECORDED_AT,
      run_id: PRIOR_RUN_ID,
      kind: 'run.closed',
      outcome: 'complete',
    },
  ];
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${trace.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

function captureRelayer(prompts: string[]): RelayFn {
  return makeStubRelayer((input) => {
    prompts.push(input.prompt);
    return REVIEW_RELAY_BODY;
  });
}

async function captureMain(
  argv: readonly string[],
  options: Parameters<typeof main>[1] = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const { result, stdout, stderr } = await captureStreams(() =>
    main(argv, {
      now: () => new Date('2026-05-26T12:30:00.000Z'),
      ...options,
    }),
  );
  return { code: result, stdout, stderr };
}

describe('run-start history recall', () => {
  it('rebuilds local history, writes a recall report, and adds hint-only memory to relay prompts', async () => {
    const projectRoot = tempRoot('circuit-history-recall-project-');
    const runFolder = tempRoot('circuit-history-recall-run-');
    const prompts: string[] = [];
    writePriorHistoryFixture(projectRoot);

    const result = await captureMain(
      [
        'run',
        'review',
        '--goal',
        'Review this supplied text: use local history memory injection with cited hint-only recall.',
        '--run-folder',
        runFolder,
      ],
      {
        configCwd: projectRoot,
        historyRecall: 'enabled',
        runId: '33333333-3333-4333-8333-333333333333',
        relayer: captureRelayer(prompts),
      },
    );

    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      readonly history_recall?: {
        readonly status: string;
        readonly memory_input_count: number;
        readonly rebuilt: boolean;
        readonly report_path: string;
      };
    };
    expect(output.history_recall).toMatchObject({
      status: 'used',
      memory_input_count: 1,
      rebuilt: true,
      report_path: join(runFolder, HISTORY_RECALL_REPORT_PATH),
    });

    const report = HistoryRecallReportV1.parse(
      JSON.parse(readFileSync(join(runFolder, HISTORY_RECALL_REPORT_PATH), 'utf8')),
    );
    expect(report.status).toBe('used');
    expect(report.memory_input_count).toBe(1);
    expect(MemoryInputV0.parse(report.memory_inputs[0]).authority).toBe('hint_only');
    expect(report.matches[0]?.source_ref.kind).toBe('report');
    const envelope = RunEnvelopeRecord.parse(
      JSON.parse(readFileSync(join(runFolder, RUN_ENVELOPE_RELATIVE_PATH), 'utf8')),
    );
    expect(envelope.memory_context).toEqual({
      used: true,
      memory_input_ids: [report.memory_inputs[0]?.memory_id],
      authority: 'hint_only',
    });
    expect(envelope.memory_update_events).toEqual([]);
    expect(prompts.join('\n')).toContain('Prior Circuit History (hint-only):');
    expect(prompts.join('\n')).toContain('Recall must be cited and hint-only');
    expect(prompts.join('\n')).toContain('cannot satisfy current proof, checkpoint, policy, route');
  });

  it('continues without memory when local history is unavailable', async () => {
    const projectRoot = tempRoot('circuit-history-recall-empty-project-');
    const runFolder = tempRoot('circuit-history-recall-empty-run-');
    const prompts: string[] = [];

    const result = await captureMain(
      [
        'run',
        'review',
        '--goal',
        'Review this supplied text: no prior history is available.',
        '--run-folder',
        runFolder,
      ],
      {
        configCwd: projectRoot,
        historyRecall: 'enabled',
        runId: '44444444-4444-4444-8444-444444444444',
        relayer: captureRelayer(prompts),
      },
    );

    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      readonly history_recall?: { readonly status: string; readonly memory_input_count: number };
    };
    expect(output.history_recall).toMatchObject({
      status: 'unavailable',
      memory_input_count: 0,
    });
    const report = HistoryRecallReportV1.parse(
      JSON.parse(readFileSync(join(runFolder, HISTORY_RECALL_REPORT_PATH), 'utf8')),
    );
    expect(report.status).toBe('unavailable');
    expect(report.warnings[0]?.message).toContain('runs_base_not_found');
    expect(prompts.join('\n')).not.toContain('Prior Circuit History (hint-only):');
  });
});
