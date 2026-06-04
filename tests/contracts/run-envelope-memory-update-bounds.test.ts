import { describe, expect, it } from 'vitest';

import { RunEnvelopeRecord, RunMemoryUpdateEvent } from '../../src/index.js';

// Slice 5 (D3): the two additive envelope prerequisites.
//   - `.max(1)` on RunEnvelopeRecord.memory_update_events (fire on signal, not
//     on completion), with an empty array still legal (every run today).
//   - an optional `staleness` object on RunMemoryUpdateEvent, mirroring the
//     memory-input layer's MemoryStaleness reason-code invariants.
// The existing refines (operator_indicator on proposed/recorded; flow_id on
// flow scope) stay intact.

const sha = 'b'.repeat(64);
const runId = '00000000-0000-4000-8000-00000000f001';
const childRunId = '00000000-0000-4000-8000-00000000c101';

function ref(kind: string, path: string, extra: Record<string, unknown> = {}) {
  return {
    kind,
    ref: path,
    sha256: kind === 'policy' || kind === 'trace' ? undefined : sha,
    ...extra,
  };
}

function evidence(source: string, kind: string, path: string, extra: Record<string, unknown> = {}) {
  return { source, ref: ref(kind, path, extra) };
}

const verificationEvidence = evidence(
  'process_report',
  'report',
  'reports/build/verification.json',
  {
    flow_id: 'build',
  },
);
const childResultEvidence = evidence('child_result', 'report', 'reports/result.json', {
  flow_id: 'build',
});
const envelopeRef = ref('report', 'reports/run-envelope.json');

function memoryUpdateEvent(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'run.memory-update-event@v0',
    event_id: 'memory-update-1',
    scope: 'flow',
    flow_id: 'build',
    action: 'recorded',
    reason: 'The run confirmed the current verification command for this project.',
    summary: 'Use npm run test:fast as a fast verification hint for dashboard work.',
    source_refs: [verificationEvidence.ref],
    authority: 'hint_only',
    operator_indicator: 'Updated Build memory: fast dashboard verification command.',
    ...overrides,
  };
}

function freshStaleness(overrides: Record<string, unknown> = {}) {
  return {
    status: 'fresh',
    checked_at: '2026-05-29T00:00:00.000Z',
    reason_codes: ['source_hash_verified'],
    ...overrides,
  };
}

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
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
          required_evidence: [
            { kind: 'command', description: 'npm run test:fast passed', required: true },
          ],
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
          run_id: childRunId,
          run_folder: `.circuit/runs/${childRunId}`,
          result_ref: childResultEvidence,
          trace_entries_observed: 12,
          manifest_hash: 'runtime:build@0.1.0',
        },
        evidence_refs: [childResultEvidence, verificationEvidence],
        summary: 'Build attempt completed with current verification evidence.',
      },
    ],
    completion_gate: {
      schema: 'run.completion-gate@v0',
      verdict: 'complete',
      claim_results: [
        { claim_id: 'filter-works', status: 'proved', evidence: [verificationEvidence] },
      ],
      gate_passes: [
        {
          pass_id: 'gate-1',
          attack_lens: 'contract-and-proof',
          evidence_checked: [childResultEvidence, verificationEvidence],
          verdict: 'gate-pass',
        },
        {
          pass_id: 'gate-2',
          attack_lens: 'false-done-and-recovery',
          evidence_checked: [childResultEvidence, verificationEvidence],
          verdict: 'gate-pass',
        },
      ],
      clean_streak: 2,
      required_passes: 2,
      next_action: 'close',
    },
    decision_packets: [],
    memory_update_events: [memoryUpdateEvent()],
    surface_output: {
      schema: 'run.surface-output@v0',
      status_text: 'Done: dashboard filter added and verified.',
      outcome: 'complete',
      next_action: 'close',
      artifact_links: [envelopeRef, childResultEvidence.ref],
      memory_indicator: 'Updated Build memory: fast dashboard verification command.',
    },
    outcome: 'complete',
    ...overrides,
  };
}

describe('RunMemoryUpdateEvent staleness (Slice 5 D3)', () => {
  it('accepts an event with no staleness (backwards-compatible)', () => {
    expect(RunMemoryUpdateEvent.safeParse(memoryUpdateEvent()).success).toBe(true);
  });

  it('round-trips an optional fresh staleness object', () => {
    const parsed = RunMemoryUpdateEvent.parse(memoryUpdateEvent({ staleness: freshStaleness() }));
    expect(parsed.staleness?.status).toBe('fresh');
    expect(parsed.staleness?.reason_codes).toEqual(['source_hash_verified']);
  });

  it('requires memory_unverified for unknown staleness', () => {
    expect(
      RunMemoryUpdateEvent.safeParse(
        memoryUpdateEvent({
          staleness: freshStaleness({ status: 'unknown', reason_codes: ['source_hash_verified'] }),
        }),
      ).success,
    ).toBe(false);
    expect(
      RunMemoryUpdateEvent.safeParse(
        memoryUpdateEvent({
          staleness: freshStaleness({ status: 'unknown', reason_codes: ['memory_unverified'] }),
        }),
      ).success,
    ).toBe(true);
  });

  it('requires memory_stale for stale staleness', () => {
    expect(
      RunMemoryUpdateEvent.safeParse(
        memoryUpdateEvent({
          staleness: freshStaleness({ status: 'stale', reason_codes: ['source_hash_verified'] }),
        }),
      ).success,
    ).toBe(false);
    expect(
      RunMemoryUpdateEvent.safeParse(
        memoryUpdateEvent({
          staleness: freshStaleness({ status: 'stale', reason_codes: ['memory_stale'] }),
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects an empty reason_codes set', () => {
    expect(
      RunMemoryUpdateEvent.safeParse(
        memoryUpdateEvent({ staleness: freshStaleness({ reason_codes: [] }) }),
      ).success,
    ).toBe(false);
  });

  it('still requires operator_indicator on proposed/recorded', () => {
    expect(
      RunMemoryUpdateEvent.safeParse(
        memoryUpdateEvent({ action: 'proposed', operator_indicator: undefined }),
      ).success,
    ).toBe(false);
  });

  it('rejects unknown keys on the staleness object (strict)', () => {
    expect(
      RunMemoryUpdateEvent.safeParse(memoryUpdateEvent({ staleness: freshStaleness({ extra: 1 }) }))
        .success,
    ).toBe(false);
  });
});

describe('RunEnvelopeRecord.memory_update_events bound (Slice 5 D3)', () => {
  it('accepts an empty memory_update_events array (every run today)', () => {
    expect(RunEnvelopeRecord.safeParse(baseRecord({ memory_update_events: [] })).success).toBe(
      true,
    );
  });

  it('accepts exactly one memory update event', () => {
    expect(RunEnvelopeRecord.safeParse(baseRecord()).success).toBe(true);
  });

  it('rejects more than one memory update event', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          memory_update_events: [
            memoryUpdateEvent(),
            memoryUpdateEvent({ event_id: 'memory-update-2' }),
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts a single event carrying the new optional staleness', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          memory_update_events: [memoryUpdateEvent({ staleness: freshStaleness() })],
        }),
      ).success,
    ).toBe(true);
  });
});
