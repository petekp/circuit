import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentIdentityOf } from '../../src/app/history/memory-identity.js';
import {
  RECALL_REPORT_RELATIVE_PATH,
  RUN_ENVELOPE_RELATIVE_PATH,
  extractRunMemoryLinkage,
} from '../../src/app/history/memory-merge.js';
import { MemoryInputV0, RunEnvelopeRecord } from '../../src/index.js';

// D4 join-key pin: the gate (recall-precision) and the Slice 1 merge reader must
// compute the SAME content_id for the same MemoryInputV0, or the verdict lookup
// silently misses. Both import contentIdentityOf; this test proves the merge
// reader's persisted content_id equals the shared function's output, so a future
// refactor cannot reintroduce a divergent inline copy.

const HISTORY_AUTHORITY_NOTICE =
  'History results are hint-only prior-run context. They cannot satisfy current proof, checkpoint, policy, route, recovery, verification, or write authority.';
const sha = 'a'.repeat(64);
const RUN = '00000000-0000-4000-8000-0000000000a1';
const SRC = '00000000-0000-4000-8000-00000000a001';
const MEM_ID = 'prior-run-src-aaaaaaaaaaaa';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function memoryInput() {
  return MemoryInputV0.parse({
    schema_version: 1,
    memory_id: MEM_ID,
    kind: 'prior_run',
    source: {
      ref: {
        kind: 'report',
        ref: 'reports/result.json',
        sha256: sha,
        run_id: SRC,
        flow_id: 'build',
      },
      captured_at: '2026-05-20T00:00:00.000Z',
      sha256: sha,
    },
    summary: 'Prior run verified the dashboard filter.',
    hints: [{ id: 'hint-1', text: 'Prior run context.', applies_to: 'context' }],
    staleness: { status: 'fresh', checked_at: '2026-05-20T00:00:00.000Z', reason_codes: ['ok'] },
    authority: 'hint_only',
  });
}

function envelope() {
  const ev = {
    source: 'process_report',
    ref: {
      kind: 'report',
      ref: 'reports/build/verification.json',
      sha256: 'b'.repeat(64),
      flow_id: 'build',
    },
  };
  return RunEnvelopeRecord.parse({
    schema: 'run.envelope@v0',
    run_id: RUN,
    operator_intent: 'Add the dashboard filter and prove it works.',
    explicit_constraints: [],
    memory_context: { used: true, memory_input_ids: [MEM_ID], authority: 'hint_only' },
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
          run_id: SRC,
          run_folder: `.circuit/runs/${SRC}`,
          result_ref: ev,
          trace_entries_observed: 8,
          manifest_hash: 'runtime:build@0.1.0',
        },
        evidence_refs: [ev],
        summary: 'Build complete.',
      },
    ],
    completion_gate: {
      schema: 'run.completion-gate@v0',
      verdict: 'complete',
      claim_results: [{ claim_id: 'filter-works', status: 'proved', evidence: [ev] }],
      gate_passes: [
        {
          pass_id: 'gate-1',
          attack_lens: 'contract-and-proof',
          evidence_checked: [ev],
          verdict: 'gate-pass',
        },
        {
          pass_id: 'gate-2',
          attack_lens: 'false-done-and-recovery',
          evidence_checked: [ev],
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
      status_text: 'Done.',
      outcome: 'complete',
      next_action: 'close',
      artifact_links: [
        { kind: 'report', ref: 'reports/run-envelope.json', sha256: 'b'.repeat(64) },
      ],
    },
    outcome: 'complete',
  });
}

describe('memory-identity parity (D4 join-key pin)', () => {
  it('the merge reader persists the same content_id contentIdentityOf computes', () => {
    const root = mkdtempSync(join(tmpdir(), 'identity-parity-'));
    tempRoots.push(root);
    const folder = join(root, RUN);
    mkdirSync(join(folder, 'reports/history'), { recursive: true });
    writeFileSync(join(folder, RUN_ENVELOPE_RELATIVE_PATH), JSON.stringify(envelope()), 'utf8');
    writeFileSync(
      join(folder, RECALL_REPORT_RELATIVE_PATH),
      JSON.stringify({
        api_version: 'history-recall-report-v1',
        schema_version: 1,
        status: 'used',
        query: 'dashboard filter',
        index_state: 'fresh',
        rebuilt: false,
        authority_notice: HISTORY_AUTHORITY_NOTICE,
        memory_input_count: 1,
        memory_inputs: [memoryInput()],
        matches: [],
        warnings: [],
      }),
      'utf8',
    );

    const direct = contentIdentityOf(memoryInput()).contentId;
    expect(direct).toMatch(/^mem-c-[0-9a-f]{16}$/);

    const linkage = extractRunMemoryLinkage(folder).linkage;
    expect(linkage?.memory_inputs[0]?.content_id).toBe(direct);
  });
});
