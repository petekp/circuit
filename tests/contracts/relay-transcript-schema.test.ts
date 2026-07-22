import { describe, expect, it } from 'vitest';
import {
  RelayFailedTraceEntry,
  RelayReceiptTraceEntry,
  RelayRequestTraceEntry,
  RelayResultTraceEntry,
  RunProjection,
  RunTrace,
  TraceEntry,
} from '../../src/index.js';

// `relay.request` / `relay.receipt` / `relay.result` are the
// non-substitutable close-criterion entries on a relay step. Each of
// the three trace_entry kinds is admitted by the TraceEntry discriminated
// union and consumed by the reducer. These tests pin the five-entry
// durable transcript shape (started, request, receipt, result, completed).

const RUN_A = '0191d2f0-aaaa-7fff-8aaa-000000000000';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const change_kind = {
  change_kind: 'ratchet-advance' as const,
  failure_mode: 'trace_entry-schema/CC#P2-2 incoherence',
  acceptance_evidence: 'five-trace_entry sequence parses end-to-end',
  alternate_framing: 'weaken CC#P2-2 to info-equivalence',
};

const bootstrapTraceEntry = {
  schema_version: 1 as const,
  sequence: 0,
  recorded_at: '2026-04-21T12:00:00.000Z',
  run_id: RUN_A,
  kind: 'run.bootstrapped' as const,
  flow_id: 'explore',
  depth: 'high',
  goal: 'relay-transcript fixture',
  manifest_hash: 'abc',
  change_kind,
};

const stepEnteredTraceEntry = {
  schema_version: 1 as const,
  sequence: 1,
  recorded_at: '2026-04-21T12:01:00.000Z',
  run_id: RUN_A,
  kind: 'step.entered' as const,
  step_id: 'frame',
  attempt: 1,
};

const relayStartedTraceEntry = {
  schema_version: 1 as const,
  sequence: 2,
  recorded_at: '2026-04-21T12:02:00.000Z',
  run_id: RUN_A,
  kind: 'relay.started' as const,
  step_id: 'frame',
  attempt: 1,
  connector: { kind: 'builtin' as const, name: 'codex' as const },
  role: 'researcher' as const,
  resolved_selection: { skills: [] },
  resolved_from: { source: 'explicit' as const },
};

const relayRequestTraceEntry = {
  schema_version: 1 as const,
  sequence: 3,
  recorded_at: '2026-04-21T12:03:00.000Z',
  run_id: RUN_A,
  kind: 'relay.request' as const,
  step_id: 'frame',
  attempt: 1,
  request_payload_hash: HASH_A,
};

const relayReceiptTraceEntry = {
  schema_version: 1 as const,
  sequence: 4,
  recorded_at: '2026-04-21T12:04:00.000Z',
  run_id: RUN_A,
  kind: 'relay.receipt' as const,
  step_id: 'frame',
  attempt: 1,
  cli_version: 'codex 1.2.3',
  receipt_id: 'rc_01HXYZabc',
};

const relayResultTraceEntry = {
  schema_version: 1 as const,
  sequence: 5,
  recorded_at: '2026-04-21T12:05:00.000Z',
  run_id: RUN_A,
  kind: 'relay.result' as const,
  step_id: 'frame',
  attempt: 1,
  result_report_hash: HASH_B,
};

const relayFailedTraceEntry = {
  schema_version: 1 as const,
  sequence: 4,
  recorded_at: '2026-04-21T12:04:00.000Z',
  run_id: RUN_A,
  kind: 'relay.failed' as const,
  step_id: 'frame',
  attempt: 1,
  connector: { kind: 'builtin' as const, name: 'codex' as const },
  role: 'researcher' as const,
  resolved_selection: { skills: [] },
  resolved_from: { source: 'explicit' as const },
  request_payload_hash: HASH_A,
  reason: 'connector invocation failed (spawn ENOENT)',
};

const relayCompletedTraceEntry = {
  schema_version: 1 as const,
  sequence: 6,
  recorded_at: '2026-04-21T12:06:00.000Z',
  run_id: RUN_A,
  kind: 'relay.completed' as const,
  step_id: 'frame',
  attempt: 1,
  verdict: 'pass',
  duration_ms: 1000,
  result_path: 'reports/result.json',
  receipt_path: 'reports/receipt.json',
};

const stepCompletedTraceEntry = {
  schema_version: 1 as const,
  sequence: 7,
  recorded_at: '2026-04-21T12:07:00.000Z',
  run_id: RUN_A,
  kind: 'step.completed' as const,
  step_id: 'frame',
  attempt: 1,
  route_taken: 'pass',
};

const runClosedTraceEntry = {
  schema_version: 1 as const,
  sequence: 8,
  recorded_at: '2026-04-21T12:08:00.000Z',
  run_id: RUN_A,
  kind: 'run.closed' as const,
  outcome: 'complete' as const,
};

type ParsedRunTrace = ReturnType<typeof RunTrace.parse>;
type ProjectionStatus =
  | 'in_progress'
  | 'complete'
  | 'aborted'
  | 'handoff'
  | 'stopped'
  | 'escalated';

function projectionSnapshot(log: ParsedRunTrace, status: ProjectionStatus) {
  const bootstrap = log[0];
  const last = log[log.length - 1];
  if (bootstrap === undefined || bootstrap.kind !== 'run.bootstrapped') {
    throw new Error('projectionSnapshot requires a parsed run trace with a bootstrap entry');
  }
  if (last === undefined) {
    throw new Error('projectionSnapshot requires a non-empty parsed run trace');
  }
  return {
    schema_version: 1,
    run_id: bootstrap.run_id,
    flow_id: bootstrap.flow_id,
    depth: bootstrap.depth,
    change_kind: bootstrap.change_kind,
    status,
    steps: [],
    trace_entries_consumed: log.length,
    manifest_hash: bootstrap.manifest_hash,
    updated_at: last.recorded_at,
    ...(bootstrap.invocation_id === undefined ? {} : { invocation_id: bootstrap.invocation_id }),
  };
}

describe('RelayRequestTraceEntry', () => {
  it('parses a well-formed relay.request trace_entry', () => {
    const parsed = RelayRequestTraceEntry.safeParse(relayRequestTraceEntry);
    expect(parsed.success).toBe(true);
  });

  it('rejects a relay.request missing request_payload_hash', () => {
    const { request_payload_hash, ...rest } = relayRequestTraceEntry;
    void request_payload_hash;
    const bad = RelayRequestTraceEntry.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.request whose request_payload_hash is not 64-char lowercase hex', () => {
    const bad = RelayRequestTraceEntry.safeParse({
      ...relayRequestTraceEntry,
      request_payload_hash: 'not-a-hash',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.request whose request_payload_hash is uppercase hex', () => {
    const bad = RelayRequestTraceEntry.safeParse({
      ...relayRequestTraceEntry,
      request_payload_hash: 'A'.repeat(64),
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.request whose request_payload_hash is 63 chars', () => {
    const bad = RelayRequestTraceEntry.safeParse({
      ...relayRequestTraceEntry,
      request_payload_hash: 'a'.repeat(63),
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.request with surplus top-level key (RUN-I8 strictness)', () => {
    const bad = RelayRequestTraceEntry.safeParse({
      ...relayRequestTraceEntry,
      smuggled: 'x',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.request with attempt = 0 (StepId invariant)', () => {
    const bad = RelayRequestTraceEntry.safeParse({
      ...relayRequestTraceEntry,
      attempt: 0,
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.request with negative sequence', () => {
    const bad = RelayRequestTraceEntry.safeParse({
      ...relayRequestTraceEntry,
      sequence: -1,
    });
    expect(bad.success).toBe(false);
  });
});

describe('RelayReceiptTraceEntry', () => {
  it('parses a well-formed relay.receipt trace_entry', () => {
    const parsed = RelayReceiptTraceEntry.safeParse(relayReceiptTraceEntry);
    expect(parsed.success).toBe(true);
  });

  it('rejects a relay.receipt missing receipt_id', () => {
    const { receipt_id, ...rest } = relayReceiptTraceEntry;
    void receipt_id;
    const bad = RelayReceiptTraceEntry.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.receipt with empty receipt_id', () => {
    const bad = RelayReceiptTraceEntry.safeParse({
      ...relayReceiptTraceEntry,
      receipt_id: '',
    });
    expect(bad.success).toBe(false);
  });

  it('accepts a relay.receipt with UUID-shaped receipt_id', () => {
    const ok = RelayReceiptTraceEntry.safeParse({
      ...relayReceiptTraceEntry,
      receipt_id: '0191d2f0-cccc-7fff-8aaa-000000000002',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a relay.receipt with surplus top-level key (RUN-I8 strictness)', () => {
    const bad = RelayReceiptTraceEntry.safeParse({
      ...relayReceiptTraceEntry,
      smuggled: 'x',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.receipt missing step_id', () => {
    const { step_id, ...rest } = relayReceiptTraceEntry;
    void step_id;
    const bad = RelayReceiptTraceEntry.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  // receipt_id must contain at least
  // one non-whitespace character. A spaces-only string has length > 0
  // and would have passed the naive `z.string().min(1)` constraint,
  // but such a value is useless as audit evidence.
  it('rejects a relay.receipt with whitespace-only receipt_id', () => {
    const bad = RelayReceiptTraceEntry.safeParse({
      ...relayReceiptTraceEntry,
      receipt_id: '   ',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.receipt with tab+newline-only receipt_id', () => {
    const bad = RelayReceiptTraceEntry.safeParse({
      ...relayReceiptTraceEntry,
      receipt_id: '\t\n\r ',
    });
    expect(bad.success).toBe(false);
  });

  // `model` is the optional connector-dispatch fact codex records when it
  // resolves a default at spawn (parallel to cli_version). These three cases
  // lock the round-trip: present-and-nonempty parses, empty rejected, absent
  // parses unchanged (byte-stable for connectors that never surface a model).
  it('accepts a relay.receipt carrying a resolved model', () => {
    const ok = RelayReceiptTraceEntry.safeParse({
      ...relayReceiptTraceEntry,
      model: 'gpt-5.5',
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.model).toBe('gpt-5.5');
  });

  it('rejects a relay.receipt with an empty model string', () => {
    const bad = RelayReceiptTraceEntry.safeParse({
      ...relayReceiptTraceEntry,
      model: '',
    });
    expect(bad.success).toBe(false);
  });

  it('accepts a relay.receipt with no model field (connector pinned its own)', () => {
    const ok = RelayReceiptTraceEntry.safeParse(relayReceiptTraceEntry);
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.model).toBeUndefined();
  });

  it('records a bounded count of reviewed web search events', () => {
    const ok = RelayReceiptTraceEntry.safeParse({
      ...relayReceiptTraceEntry,
      web_search_count: 2,
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.web_search_count).toBe(2);

    expect(
      RelayReceiptTraceEntry.safeParse({
        ...relayReceiptTraceEntry,
        web_search_count: -1,
      }).success,
    ).toBe(false);
  });
});

describe('RelayResultTraceEntry', () => {
  it('parses a well-formed relay.result trace_entry', () => {
    const parsed = RelayResultTraceEntry.safeParse(relayResultTraceEntry);
    expect(parsed.success).toBe(true);
  });

  it('rejects a relay.result missing result_report_hash', () => {
    const { result_report_hash, ...rest } = relayResultTraceEntry;
    void result_report_hash;
    const bad = RelayResultTraceEntry.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.result whose result_report_hash is not hex', () => {
    const bad = RelayResultTraceEntry.safeParse({
      ...relayResultTraceEntry,
      result_report_hash: 'z'.repeat(64),
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.result whose result_report_hash is empty', () => {
    const bad = RelayResultTraceEntry.safeParse({
      ...relayResultTraceEntry,
      result_report_hash: '',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.result with surplus top-level key (RUN-I8 strictness)', () => {
    const bad = RelayResultTraceEntry.safeParse({
      ...relayResultTraceEntry,
      smuggled: 'x',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a relay.result with non-integer attempt', () => {
    const bad = RelayResultTraceEntry.safeParse({
      ...relayResultTraceEntry,
      attempt: 1.5,
    });
    expect(bad.success).toBe(false);
  });
});

describe('RelayFailedTraceEntry', () => {
  it('parses a well-formed relay.failed trace_entry with full relay provenance', () => {
    const parsed = RelayFailedTraceEntry.safeParse(relayFailedTraceEntry);
    expect(parsed.success).toBe(true);
  });

  it('rejects relay.failed without request_payload_hash', () => {
    const { request_payload_hash, ...rest } = relayFailedTraceEntry;
    void request_payload_hash;
    const bad = RelayFailedTraceEntry.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it('rejects relay.failed without reason', () => {
    const { reason, ...rest } = relayFailedTraceEntry;
    void reason;
    const bad = RelayFailedTraceEntry.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it('rejects relay.failed with surplus top-level key (RUN-I8 strictness)', () => {
    const bad = RelayFailedTraceEntry.safeParse({
      ...relayFailedTraceEntry,
      smuggled: 'x',
    });
    expect(bad.success).toBe(false);
  });

  it('TraceEntry union rejects role-sourced relay.failed when resolved_from.role disagrees', () => {
    const bad = TraceEntry.safeParse({
      ...relayFailedTraceEntry,
      resolved_from: { source: 'role', role: 'reviewer' },
    });
    expect(bad.success).toBe(false);
  });
});

describe('TraceEntry discriminated union admits the three new relay transcript kinds', () => {
  it('parses relay.request via the TraceEntry union', () => {
    const parsed = TraceEntry.safeParse(relayRequestTraceEntry);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe('relay.request');
    }
  });

  it('parses relay.receipt via the TraceEntry union', () => {
    const parsed = TraceEntry.safeParse(relayReceiptTraceEntry);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe('relay.receipt');
    }
  });

  it('parses relay.result via the TraceEntry union', () => {
    const parsed = TraceEntry.safeParse(relayResultTraceEntry);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe('relay.result');
    }
  });

  it('parses relay.failed via the TraceEntry union', () => {
    const parsed = TraceEntry.safeParse(relayFailedTraceEntry);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe('relay.failed');
    }
  });

  it('rejects an unknown relay.* kind (closed union discrimination)', () => {
    const bad = TraceEntry.safeParse({
      ...relayRequestTraceEntry,
      kind: 'relay.unknown',
    });
    expect(bad.success).toBe(false);
  });
});

describe('Five-entry durable relay transcript sequence', () => {
  it('parses the canonical five-trace_entry sequence as a well-formed RunTrace', () => {
    const log = [
      bootstrapTraceEntry,
      stepEnteredTraceEntry,
      relayStartedTraceEntry,
      relayRequestTraceEntry,
      relayReceiptTraceEntry,
      relayResultTraceEntry,
      relayCompletedTraceEntry,
      stepCompletedTraceEntry,
      runClosedTraceEntry,
    ];
    const parsed = RunTrace.safeParse(log);
    if (!parsed.success) {
      // Surface the first Zod issue to make failure actionable.
      throw new Error(`RunTrace.safeParse failed: ${JSON.stringify(parsed.error.issues)}`);
    }
    expect(parsed.success).toBe(true);
  });

  it('parses the connector-invocation failure sequence as a well-formed RunTrace', () => {
    const checkFailed = {
      schema_version: 1 as const,
      sequence: 5,
      recorded_at: '2026-04-21T12:05:00.000Z',
      run_id: RUN_A,
      kind: 'check.evaluated' as const,
      step_id: 'frame',
      attempt: 1,
      check_kind: 'result_verdict' as const,
      outcome: 'fail' as const,
      reason: relayFailedTraceEntry.reason,
    };
    const stepAborted = {
      schema_version: 1 as const,
      sequence: 6,
      recorded_at: '2026-04-21T12:06:00.000Z',
      run_id: RUN_A,
      kind: 'step.aborted' as const,
      step_id: 'frame',
      attempt: 1,
      reason: relayFailedTraceEntry.reason,
    };
    const runAborted = {
      schema_version: 1 as const,
      sequence: 7,
      recorded_at: '2026-04-21T12:07:00.000Z',
      run_id: RUN_A,
      kind: 'run.closed' as const,
      outcome: 'aborted' as const,
      reason: relayFailedTraceEntry.reason,
    };
    const log = [
      bootstrapTraceEntry,
      stepEnteredTraceEntry,
      relayStartedTraceEntry,
      relayRequestTraceEntry,
      relayFailedTraceEntry,
      checkFailed,
      stepAborted,
      runAborted,
    ];
    const parsed = RunTrace.safeParse(log);
    if (!parsed.success) {
      throw new Error(`RunTrace.safeParse failed: ${JSON.stringify(parsed.error.issues)}`);
    }
    const snapshot = projectionSnapshot(parsed.data, 'aborted');
    expect(snapshot.status).toBe('aborted');
    expect(snapshot.trace_entries_consumed).toBe(log.length);
    const projection = RunProjection.safeParse({ log: parsed.data, snapshot });
    if (!projection.success) {
      throw new Error(`RunProjection.safeParse failed: ${JSON.stringify(projection.error.issues)}`);
    }
    expect(projection.success).toBe(true);
  });

  it('parses a dry-run-shaped relay log (no transcript trace_entries) as a RunTrace', () => {
    // Transcript entries are required for a non-dry-run connector. The
    // dry-run path remains legal at the schema layer — only
    // relay.started + relay.completed on a pair.
    const log = [
      bootstrapTraceEntry,
      stepEnteredTraceEntry,
      relayStartedTraceEntry,
      { ...relayCompletedTraceEntry, sequence: 3 },
      { ...stepCompletedTraceEntry, sequence: 4 },
      { ...runClosedTraceEntry, sequence: 5 },
    ];
    const parsed = RunTrace.safeParse(log);
    expect(parsed.success).toBe(true);
  });
});

// RunProjection must admit the full five-entry relay sequence. The connector
// round-trip test in tests/runner/agent-relay-roundtrip.test.ts covers
// the full real-connector path.
describe('RunProjection admits the five-trace_entry relay transcript', () => {
  it('binds trace_entries_consumed to the full log length on the canonical sequence', () => {
    const log = [
      bootstrapTraceEntry,
      stepEnteredTraceEntry,
      relayStartedTraceEntry,
      relayRequestTraceEntry,
      relayReceiptTraceEntry,
      relayResultTraceEntry,
      relayCompletedTraceEntry,
      stepCompletedTraceEntry,
      runClosedTraceEntry,
    ];
    const parsed = RunTrace.safeParse(log);
    if (!parsed.success) {
      throw new Error(`RunTrace.safeParse failed: ${JSON.stringify(parsed.error.issues)}`);
    }
    const snapshot = projectionSnapshot(parsed.data, 'complete');
    expect(snapshot.trace_entries_consumed).toBe(log.length);
    // The terminal run.closed has outcome=complete, so the snapshot
    // status must be `complete` (RUN-I7 binding).
    expect(snapshot.status).toBe('complete');
  });

  it('RunProjection.safeParse accepts {log, snapshot} for the canonical sequence', () => {
    // RUN-I6/I7 binding: bootstrap-frozen fields must agree, and
    // trace_entries_consumed on the snapshot must equal the log length.
    // Passing this for the five-trace_entry transcript proves the snapshot
    // accounts for every transcript trace_entry. Otherwise trace_entries_consumed
    // would underflow and RUN-I6 would reject the projection.
    const log = [
      bootstrapTraceEntry,
      stepEnteredTraceEntry,
      relayStartedTraceEntry,
      relayRequestTraceEntry,
      relayReceiptTraceEntry,
      relayResultTraceEntry,
      relayCompletedTraceEntry,
      stepCompletedTraceEntry,
      runClosedTraceEntry,
    ];
    const parsed = RunTrace.safeParse(log);
    if (!parsed.success) {
      throw new Error(`RunTrace.safeParse failed: ${JSON.stringify(parsed.error.issues)}`);
    }
    const snapshot = projectionSnapshot(parsed.data, 'complete');
    const projection = RunProjection.safeParse({ log: parsed.data, snapshot });
    if (!projection.success) {
      throw new Error(`RunProjection.safeParse failed: ${JSON.stringify(projection.error.issues)}`);
    }
    expect(projection.success).toBe(true);
  });

  it('binds dry-run-shaped trace_entries_consumed to the full log length', () => {
    const log = [
      bootstrapTraceEntry,
      stepEnteredTraceEntry,
      relayStartedTraceEntry,
      { ...relayCompletedTraceEntry, sequence: 3 },
      { ...stepCompletedTraceEntry, sequence: 4 },
      { ...runClosedTraceEntry, sequence: 5 },
    ];
    const parsed = RunTrace.safeParse(log);
    if (!parsed.success) {
      throw new Error(`RunTrace.safeParse failed: ${JSON.stringify(parsed.error.issues)}`);
    }
    const snapshot = projectionSnapshot(parsed.data, 'complete');
    expect(snapshot.trace_entries_consumed).toBe(log.length);
  });
});
