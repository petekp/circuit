import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HISTORY_RECALL_PRECISION_PATH,
  HISTORY_RECALL_REPORT_PATH,
} from '../../src/app/history/run-start-recall.js';
import { RUN_ENVELOPE_RELATIVE_PATH } from '../../src/app/run-envelope/source-record.js';
import { main } from '../../src/cli/circuit.js';
import { HistoryRecallPrecisionV1 } from '../../src/index.js';
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

// A prior review-flow run so a review run recalls it under flow-scoping.
function writePriorReviewRun(projectRoot: string): void {
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
    goal: 'Prior review of the dashboard filter',
    summary: 'Run closed with outcome complete for the dashboard filter review.',
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
      goal: 'Prior review of the dashboard filter',
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
      report_schema: 'review.decision@v1',
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

function stubRelayer(): RelayFn {
  return makeStubRelayer(() => REVIEW_RELAY_BODY);
}

async function captureMain(argv: readonly string[], options: Parameters<typeof main>[1] = {}) {
  const { result, stdout, stderr } = await captureStreams(() =>
    main(argv, { now: () => new Date('2026-05-26T12:30:00.000Z'), ...options }),
  );
  return { code: result, stdout, stderr };
}

describe('Slice 3 precision write/record surfaces (downstream of the recall fn)', () => {
  it('writes the precision sidecar, records the gated ids, and fills the recall indicator', async () => {
    const projectRoot = tempRoot('precision-envelope-project-');
    const runFolder = tempRoot('precision-envelope-run-');
    writePriorReviewRun(projectRoot);

    const result = await captureMain(
      [
        'run',
        'review',
        '--goal',
        'Review the dashboard filter with cited hint-only recall',
        '--run-folder',
        runFolder,
      ],
      {
        configCwd: projectRoot,
        historyRecall: 'enabled',
        runId: '33333333-3333-4333-8333-333333333333',
        relayer: stubRelayer(),
      },
    );
    expect(result.code, result.stderr).toBe(0);

    // 1) the runtime wrote the precision sidecar next to recall.json
    const precisionPath = join(runFolder, HISTORY_RECALL_PRECISION_PATH);
    expect(existsSync(precisionPath)).toBe(true);
    expect(existsSync(join(runFolder, HISTORY_RECALL_REPORT_PATH))).toBe(true);
    const precision = HistoryRecallPrecisionV1.parse(
      JSON.parse(readFileSync(precisionPath, 'utf8')),
    );
    expect(precision.flow_id).toBe('review');
    expect(precision.decisions.length).toBeGreaterThan(0);

    // 2) the envelope records exactly the gated (injected) memory_input_ids
    const envelope = RunEnvelopeRecord.parse(
      JSON.parse(readFileSync(join(runFolder, RUN_ENVELOPE_RELATIVE_PATH), 'utf8')),
    );
    const injectedIds = precision.decisions.filter((d) => d.injected).map((d) => d.memory_input_id);
    expect(envelope.memory_context.memory_input_ids.sort()).toEqual(injectedIds.sort());
    expect(envelope.memory_context.used).toBe(injectedIds.length > 0);

    // 3) no memory-write event exists in Slice 3, so the recall indicator fills the
    //    single surface_output.memory_indicator (the precedence rule's else-branch)
    expect(envelope.memory_update_events).toEqual([]);
    expect(envelope.surface_output.memory_indicator).toBe(precision.indicator);
  });
});
