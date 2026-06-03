import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECALL_REPORT_RELATIVE_PATH,
  RUN_ENVELOPE_RELATIVE_PATH,
  buildMemoryMergeReport,
  extractRunMemoryLinkage,
} from '../../src/app/history/memory-merge.js';
import { HISTORY_RECALL_REPORT_PATH } from '../../src/app/history/run-start-recall.js';
import { RUN_ENVELOPE_RELATIVE_PATH as CANONICAL_ENVELOPE_PATH } from '../../src/app/run-envelope/source-record.js';
import {
  HistoryMemoryMergeV1,
  HistoryRecallReportV1,
  MemoryInputV0,
  RunEnvelopeRecord,
} from '../../src/index.js';

const HISTORY_AUTHORITY_NOTICE =
  'History results are hint-only prior-run context. They cannot satisfy current proof, checkpoint, policy, route, recovery, verification, or write authority.';

const shaX = 'a'.repeat(64);
const shaY = 'b'.repeat(64);

const RUN_A = '00000000-0000-4000-8000-0000000000a1';
const RUN_B = '00000000-0000-4000-8000-0000000000b2';
const RUN_C = '00000000-0000-4000-8000-0000000000c3';
const RUN_D = '00000000-0000-4000-8000-0000000000d4';
const RUN_E = '00000000-0000-4000-8000-0000000000e5';
const RUN_F = '00000000-0000-4000-8000-0000000000f6';
const SRC_S1 = '00000000-0000-4000-8000-00000000a001';
const SRC_S2 = '00000000-0000-4000-8000-00000000a002';

function reportEvidence(extra: Record<string, unknown> = {}) {
  return {
    source: 'process_report',
    ref: {
      kind: 'report',
      ref: 'reports/build/verification.json',
      sha256: shaY,
      flow_id: 'build',
      ...extra,
    },
  };
}

// A valid run.envelope@v0 record. Defaults to a clean 'complete' run; overrides
// drive the memory context, outcome, and a blocked attempt for abort coverage.
function completeEnvelope(input: {
  runId: string;
  memoryUsed: boolean;
  memoryInputIds: readonly string[];
}) {
  const evidence = reportEvidence();
  return RunEnvelopeRecord.parse({
    schema: 'run.envelope@v0',
    run_id: input.runId,
    operator_intent: 'Add the dashboard filter and prove it works.',
    explicit_constraints: [],
    memory_context: {
      used: input.memoryUsed,
      memory_input_ids: [...input.memoryInputIds],
      authority: 'hint_only',
    },
    goal_contract: {
      schema: 'run.goal-contract@v0',
      objective: 'Add the dashboard filter and prove it works.',
      scope: { in: ['dashboard filter'], out: [], assumptions: [] },
      constraints: [],
      done_when: [
        {
          id: 'filter-works',
          claim: 'The dashboard filter is implemented and verified.',
          required_evidence: [{ kind: 'command', description: 'tests passed', required: true }],
        },
      ],
      recovery_policy: {
        max_process_attempts: 2,
        allowed_routes: ['retry-process', 'run-review', 'checkpoint', 'handoff', 'blocked'],
      },
      stop_conditions: [],
      completion_gate: {
        required_passes: 2,
        blocking_severities: ['critical', 'high', 'medium'],
        reset_on_blocking_finding: true,
      },
    },
    process_plan: {
      schema: 'run.process-plan@v0',
      selection_source: 'explicit_operator_request',
      rationale: 'Matched implementation request.',
      planned_attempts: [
        {
          attempt_id: 'attempt-build-1',
          process_id: 'build',
          goal: 'Implement and verify the dashboard filter.',
          expected_evidence: ['reports/build/verification.json'],
          depends_on_attempt_ids: [],
        },
      ],
    },
    process_attempts: [
      {
        schema: 'run.process-attempt@v0',
        attempt_id: 'attempt-build-1',
        process_id: 'build',
        goal: 'Implement and verify the dashboard filter.',
        started_at: '2026-05-28T05:00:00.000Z',
        completed_at: '2026-05-28T05:05:00.000Z',
        outcome: 'complete',
        child_run: {
          run_id: SRC_S1,
          run_folder: `.circuit/runs/${SRC_S1}`,
          result_ref: evidence,
          trace_entries_observed: 12,
          manifest_hash: 'runtime:build@0.1.0',
        },
        evidence_refs: [evidence],
        summary: 'Build attempt completed with current verification evidence.',
      },
    ],
    completion_gate: {
      schema: 'run.completion-gate@v0',
      verdict: 'complete',
      claim_results: [{ claim_id: 'filter-works', status: 'proved', evidence: [evidence] }],
      gate_passes: [
        {
          pass_id: 'gate-1',
          attack_lens: 'contract-and-proof',
          evidence_checked: [evidence],
          verdict: 'gate-pass',
        },
        {
          pass_id: 'gate-2',
          attack_lens: 'false-done-and-recovery',
          evidence_checked: [evidence],
          verdict: 'gate-pass',
        },
      ],
      clean_streak: 2,
      required_passes: 2,
      next_action: 'close',
    },
    decision_packets: [],
    memory_update_events: [],
    surface_output: {
      schema: 'run.surface-output@v0',
      status_text: 'Done: dashboard filter added and verified.',
      outcome: 'complete',
      next_action: 'close',
      artifact_links: [{ kind: 'report', ref: 'reports/run-envelope.json', sha256: shaY }],
    },
    outcome: 'complete',
  });
}

// A valid 'blocked' run.envelope@v0 with a blocked attempt carrying a reason.
function blockedEnvelope(runId: string) {
  return RunEnvelopeRecord.parse({
    schema: 'run.envelope@v0',
    run_id: runId,
    operator_intent: 'Add the dashboard filter and prove it works.',
    explicit_constraints: [],
    memory_context: { used: false, memory_input_ids: [], authority: 'hint_only' },
    goal_contract: {
      schema: 'run.goal-contract@v0',
      objective: 'Add the dashboard filter and prove it works.',
      scope: { in: ['dashboard filter'], out: [], assumptions: [] },
      constraints: [],
      done_when: [
        {
          id: 'filter-works',
          claim: 'The dashboard filter is implemented and verified.',
          required_evidence: [{ kind: 'command', description: 'tests passed', required: true }],
        },
      ],
      recovery_policy: {
        max_process_attempts: 2,
        allowed_routes: ['retry-process', 'run-review', 'checkpoint', 'handoff', 'blocked'],
      },
      stop_conditions: [],
      completion_gate: {
        required_passes: 2,
        blocking_severities: ['critical', 'high', 'medium'],
        reset_on_blocking_finding: true,
      },
    },
    process_plan: {
      schema: 'run.process-plan@v0',
      selection_source: 'explicit_operator_request',
      rationale: 'Matched implementation request.',
      planned_attempts: [
        {
          attempt_id: 'attempt-build-1',
          process_id: 'build',
          goal: 'Implement and verify the dashboard filter.',
          expected_evidence: ['reports/build/verification.json'],
          depends_on_attempt_ids: [],
        },
      ],
    },
    process_attempts: [
      {
        schema: 'run.process-attempt@v0',
        attempt_id: 'attempt-build-1',
        process_id: 'build',
        goal: 'Implement and verify the dashboard filter.',
        started_at: '2026-05-28T05:00:00.000Z',
        completed_at: '2026-05-28T05:05:00.000Z',
        outcome: 'blocked',
        child_run: {
          run_id: SRC_S1,
          run_folder: `.circuit/runs/${SRC_S1}`,
          trace_entries_observed: 4,
          manifest_hash: 'runtime:build@0.1.0',
        },
        evidence_refs: [],
        summary: 'Build attempt blocked before verification.',
        blocked_reason: 'sandbox denied write to protected path',
      },
    ],
    completion_gate: {
      schema: 'run.completion-gate@v0',
      verdict: 'blocked',
      claim_results: [{ claim_id: 'filter-works', status: 'blocked', evidence: [] }],
      gate_passes: [],
      clean_streak: 0,
      required_passes: 2,
      next_action: 'blocked',
    },
    decision_packets: [],
    memory_update_events: [],
    surface_output: {
      schema: 'run.surface-output@v0',
      status_text: 'Blocked: sandbox denied a protected write.',
      outcome: 'blocked',
      next_action: 'Grant write access or rerun outside the sandbox.',
      artifact_links: [{ kind: 'report', ref: 'reports/run-envelope.json', sha256: shaY }],
    },
    outcome: 'blocked',
  });
}

function memoryInput(input: {
  memoryId: string;
  sourceSha: string;
  sourceRun: string;
}) {
  return MemoryInputV0.parse({
    schema_version: 1,
    memory_id: input.memoryId,
    kind: 'prior_run',
    source: {
      ref: {
        kind: 'report',
        ref: 'reports/result.json',
        sha256: input.sourceSha,
        run_id: input.sourceRun,
        flow_id: 'build',
      },
      captured_at: '2026-05-20T00:00:00.000Z',
      sha256: input.sourceSha,
    },
    summary: 'Prior run verified the dashboard filter.',
    hints: [{ id: 'hint-1', text: 'Prior run context.', applies_to: 'context' }],
    staleness: { status: 'fresh', checked_at: '2026-05-20T00:00:00.000Z', reason_codes: ['ok'] },
    authority: 'hint_only',
  });
}

function recallReport(memoryInputs: ReturnType<typeof memoryInput>[]) {
  return HistoryRecallReportV1.parse({
    api_version: 'history-recall-report-v1',
    schema_version: 1,
    status: memoryInputs.length === 0 ? 'empty' : 'used',
    query: 'dashboard filter',
    index_state: 'fresh',
    rebuilt: false,
    authority_notice: HISTORY_AUTHORITY_NOTICE,
    memory_input_count: memoryInputs.length,
    memory_inputs: memoryInputs,
    matches: [],
    warnings: [],
  });
}

let root: string;
let runsBase: string;

function runFolder(runId: string): string {
  const folder = join(runsBase, runId);
  mkdirSync(join(folder, 'reports'), { recursive: true });
  // Make the folder a history candidate without depending on the in-flight
  // extraction path: an empty trace.ndjson is enough for isCandidateRunFolder.
  writeFileSync(join(folder, 'trace.ndjson'), '', 'utf8');
  return folder;
}

function writeEnvelope(folder: string, record: unknown): void {
  writeFileSync(join(folder, RUN_ENVELOPE_RELATIVE_PATH), JSON.stringify(record), 'utf8');
}

function writeRecall(folder: string, record: unknown): void {
  mkdirSync(join(folder, 'reports/history'), { recursive: true });
  writeFileSync(join(folder, RECALL_REPORT_RELATIVE_PATH), JSON.stringify(record), 'utf8');
}

const ID_A = `prior-run-${SRC_S1}-aaaaaaaaaaaa`.toLowerCase();
const ID_B = `prior-run-${SRC_S2}-bbbbbbbbbbbb`.toLowerCase();
const ID_E = `prior-run-${SRC_S1}-eeeeeeeeeeee`.toLowerCase();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-merge-'));
  runsBase = join(root, '.circuit/runs');
  mkdirSync(runsBase, { recursive: true });

  // Run A: memory-on, complete. Source content shaX (source run S1).
  const folderA = runFolder(RUN_A);
  writeEnvelope(
    folderA,
    completeEnvelope({ runId: RUN_A, memoryUsed: true, memoryInputIds: [ID_A] }),
  );
  writeRecall(
    folderA,
    recallReport([memoryInput({ memoryId: ID_A, sourceSha: shaX, sourceRun: SRC_S1 })]),
  );

  // Run B: memory-on, complete. Different memory_id (source run S2) but IDENTICAL
  // source content shaX — proves the content-addressed identity is run-independent.
  const folderB = runFolder(RUN_B);
  writeEnvelope(
    folderB,
    completeEnvelope({ runId: RUN_B, memoryUsed: true, memoryInputIds: [ID_B] }),
  );
  writeRecall(
    folderB,
    recallReport([memoryInput({ memoryId: ID_B, sourceSha: shaX, sourceRun: SRC_S2 })]),
  );

  // Run C: memory-off, complete. Control arm.
  const folderC = runFolder(RUN_C);
  writeEnvelope(folderC, completeEnvelope({ runId: RUN_C, memoryUsed: false, memoryInputIds: [] }));

  // Run D: shadow-only — candidate folder, no run-envelope.json.
  runFolder(RUN_D);

  // Run E: memory-on but recall.json missing — graceful degradation.
  const folderE = runFolder(RUN_E);
  writeEnvelope(
    folderE,
    completeEnvelope({ runId: RUN_E, memoryUsed: true, memoryInputIds: [ID_E] }),
  );

  // Run F: memory-off, blocked — abort reason coverage.
  const folderF = runFolder(RUN_F);
  writeEnvelope(folderF, blockedEnvelope(RUN_F));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('memory-merge constant drift', () => {
  it('keeps local relative paths in sync with the canonical exports', () => {
    expect(RUN_ENVELOPE_RELATIVE_PATH).toBe(CANONICAL_ENVELOPE_PATH);
    expect(RECALL_REPORT_RELATIVE_PATH).toBe(HISTORY_RECALL_REPORT_PATH);
  });
});

describe('buildMemoryMergeReport', () => {
  function build() {
    return buildMemoryMergeReport({ runsBase, now: () => new Date('2026-05-29T00:00:00.000Z') });
  }

  it('produces a schema-valid report', () => {
    expect(() => HistoryMemoryMergeV1.parse(build())).not.toThrow();
  });

  it('counts candidate folders, envelopes, and memory runs separately', () => {
    const report = build();
    expect(report.run_count).toBe(6); // A,B,C,D,E,F
    expect(report.envelope_count).toBe(5); // all but D (shadow-only)
    expect(report.memory_run_count).toBe(3); // A,B,E
    expect(report.linkages).toHaveLength(5);
  });

  it('links a memory-on run to its outcome with a derived content_id', () => {
    const a = build().linkages.find((l) => l.run_id === RUN_A);
    expect(a?.memory_used).toBe(true);
    expect(a?.outcome).toBe('complete');
    expect(a?.flow_id).toBe('build');
    expect(a?.memory_inputs).toHaveLength(1);
    expect(a?.memory_inputs[0]?.memory_input_id).toBe(ID_A);
    expect(a?.memory_inputs[0]?.content_id).toMatch(/^mem-c-[0-9a-f]{16}$/);
    expect(a?.memory_inputs[0]?.resolved_from_recall).toBe(true);
    expect(a?.memory_inputs[0]?.staleness).toBe('fresh');
  });

  it('records a memory-off run with no inputs', () => {
    const c = build().linkages.find((l) => l.run_id === RUN_C);
    expect(c?.memory_used).toBe(false);
    expect(c?.memory_inputs).toHaveLength(0);
  });

  it('derives an abort reason from a blocked attempt', () => {
    const f = build().linkages.find((l) => l.run_id === RUN_F);
    expect(f?.outcome).toBe('blocked');
    expect(f?.abort_reason).toBe('sandbox denied write to protected path');
  });

  it('degrades gracefully when the recall report is missing', () => {
    const report = build();
    const e = report.linkages.find((l) => l.run_id === RUN_E);
    expect(e?.memory_used).toBe(true);
    expect(e?.memory_inputs[0]?.content_id).toBeNull();
    expect(e?.memory_inputs[0]?.resolved_from_recall).toBe(false);
    expect(report.warnings.some((w) => w.code === 'recall_report_missing')).toBe(true);
  });

  it('warns about the shadow-only folder with no envelope', () => {
    const report = build();
    expect(
      report.warnings.some((w) => w.code === 'envelope_missing' && w.run_folder?.endsWith(RUN_D)),
    ).toBe(true);
  });

  it('groups runs that recalled identical source content under one content-addressed item', () => {
    const report = build();
    const grouped = report.memory_items.find((item) => item.used_by_run_ids.length === 2);
    expect(grouped).toBeDefined();
    expect(grouped?.content_id).toMatch(/^mem-c-[0-9a-f]{16}$/);
    expect(grouped?.memory_input_ids).toEqual([ID_A, ID_B].sort());
    expect(grouped?.used_by_run_ids).toEqual([RUN_A, RUN_B].sort());
    expect(grouped?.outcome_counts).toEqual([{ outcome: 'complete', count: 2 }]);
  });

  it('keeps a recall-less memory item in its own unresolved group', () => {
    const report = build();
    const unresolved = report.memory_items.find((item) => item.content_id === null);
    expect(unresolved?.group_key).toBe(`unresolved:${ID_E}`);
    expect(unresolved?.used_by_run_ids).toEqual([RUN_E]);
  });

  it('reports every memory item as not_enough_data (Slice 1 is report-only)', () => {
    const report = build();
    expect(report.memory_items.length).toBeGreaterThan(0);
    expect(report.memory_items.every((item) => item.effect_status === 'not_enough_data')).toBe(
      true,
    );
  });
});

describe('extractRunMemoryLinkage', () => {
  it('returns only a warning for a folder with no envelope', () => {
    const folder = join(runsBase, RUN_D);
    const result = extractRunMemoryLinkage(folder);
    expect(result.linkage).toBeUndefined();
    expect(result.warnings.map((w) => w.code)).toContain('envelope_missing');
  });

  it('refuses a content_id for a source with no content hash (no path-only fabrication)', () => {
    const folder = runFolder('00000000-0000-4000-8000-0000000000g7');
    writeEnvelope(
      folder,
      completeEnvelope({ runId: RUN_A, memoryUsed: true, memoryInputIds: ['prior-run-trace-x'] }),
    );
    const traceMemory = MemoryInputV0.parse({
      schema_version: 1,
      memory_id: 'prior-run-trace-x',
      kind: 'prior_run',
      source: {
        ref: { kind: 'trace', ref: 'trace.ndjson#sequence=5', run_id: SRC_S1, sequence: 5 },
        captured_at: '2026-05-20T00:00:00.000Z',
      },
      summary: 'Prior trace context.',
      hints: [{ id: 'hint-1', text: 'Prior trace.', applies_to: 'context' }],
      staleness: { status: 'fresh', checked_at: '2026-05-20T00:00:00.000Z', reason_codes: ['ok'] },
      authority: 'hint_only',
    });
    writeRecall(folder, recallReport([traceMemory]));
    const result = extractRunMemoryLinkage(folder);
    // The input is still resolved from recall (kind/source_ref/staleness are
    // populated), but it carries no content identity.
    expect(result.linkage?.memory_inputs[0]?.content_id).toBeNull();
    expect(result.linkage?.memory_inputs[0]?.resolved_from_recall).toBe(true);
    expect(result.linkage?.memory_inputs[0]?.kind).toBe('prior_run');
    expect(result.warnings.map((w) => w.code)).toContain('content_id_unhashed_source');
  });

  it('warns when a recall report is present but does not contain the envelope id', () => {
    const folder = runFolder('00000000-0000-4000-8000-0000000000h8');
    writeEnvelope(
      folder,
      completeEnvelope({ runId: RUN_A, memoryUsed: true, memoryInputIds: [ID_A] }),
    );
    // Recall exists, but lists a different memory id than the envelope recorded.
    writeRecall(
      folder,
      recallReport([memoryInput({ memoryId: ID_B, sourceSha: shaX, sourceRun: SRC_S2 })]),
    );
    const result = extractRunMemoryLinkage(folder);
    expect(result.linkage?.memory_inputs[0]?.content_id).toBeNull();
    expect(result.linkage?.memory_inputs[0]?.resolved_from_recall).toBe(false);
    expect(result.warnings.map((w) => w.code)).toContain('memory_input_unmatched');
  });
});
