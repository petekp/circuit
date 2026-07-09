// Contract for the check.evaluated trace entry — the durable evidence-ledger
// record of a check's verdict. The cross-field invariant mirrors its sibling
// verification.command_evaluated (src/schemas/trace-entry.ts): when a check
// carries BOTH a command exit_code and a status, status must be 'passed'
// exactly when exit_code is 0 (proof-plan.ts derives the observation status
// that way). The union-level superRefine enforces it so a tampered or
// hand-built entry that pairs a passing status with a nonzero exit — or the
// reverse — is rejected instead of resting on writer discipline.
//
// outcome is deliberately NOT tied to status/exit_code: a command acceptance
// criterion may expect a nonzero exit (expected_status 'failed'), so a passing
// outcome can honestly carry a failed status. That case must still parse.

import { describe, expect, it } from 'vitest';
import { CheckEvaluatedTraceEntry, TraceEntry } from '../../src/schemas/trace-entry.js';

const BASE = {
  schema_version: 1 as const,
  sequence: 4,
  recorded_at: '2026-06-28T05:00:00.000Z',
  run_id: '0191d2f0-aaaa-7fff-8aaa-000000000000',
  kind: 'check.evaluated' as const,
  step_id: 'implement',
  attempt: 1,
};

describe('check.evaluated trace entry', () => {
  it('accepts a passing command check whose exit_code 0 matches status passed', () => {
    const ok = TraceEntry.safeParse({
      ...BASE,
      check_kind: 'acceptance_criteria',
      outcome: 'pass',
      criterion_id: 'verify-green',
      criterion_kind: 'command',
      exit_code: 0,
      status: 'passed',
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a failing command check whose nonzero exit_code matches status failed', () => {
    const ok = TraceEntry.safeParse({
      ...BASE,
      check_kind: 'acceptance_criteria',
      outcome: 'fail',
      criterion_id: 'verify-green',
      criterion_kind: 'command',
      exit_code: 1,
      status: 'failed',
      reason: "acceptance criterion 'verify-green' failed",
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a passing outcome that honestly carries a failed status (expected-failure criterion)', () => {
    // A command criterion with expected_status 'failed': the command exits
    // nonzero (status 'failed') and that MEETS the criterion, so outcome is
    // 'pass'. status still matches its own exit_code, so the entry is honest.
    const ok = TraceEntry.safeParse({
      ...BASE,
      check_kind: 'acceptance_criteria',
      outcome: 'pass',
      criterion_id: 'must-not-compile',
      criterion_kind: 'command',
      exit_code: 3,
      status: 'failed',
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a check that carries neither exit_code nor status', () => {
    const ok = TraceEntry.safeParse({
      ...BASE,
      check_kind: 'fanout_aggregate',
      outcome: 'pass',
    });
    expect(ok.success).toBe(true);
  });

  it('also accepts the variant schema directly for a consistent entry', () => {
    const ok = CheckEvaluatedTraceEntry.safeParse({
      ...BASE,
      check_kind: 'acceptance_criteria',
      outcome: 'pass',
      criterion_kind: 'command',
      exit_code: 0,
      status: 'passed',
    });
    expect(ok.success).toBe(true);
  });

  it('REJECTS a passing status paired with a nonzero exit_code (a laundered check)', () => {
    const bad = TraceEntry.safeParse({
      ...BASE,
      check_kind: 'acceptance_criteria',
      outcome: 'pass',
      criterion_kind: 'command',
      exit_code: 1,
      status: 'passed',
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((issue) => issue.path.includes('status'))).toBe(true);
    }
  });

  it('REJECTS a failed status paired with exit_code 0', () => {
    const bad = TraceEntry.safeParse({
      ...BASE,
      check_kind: 'acceptance_criteria',
      outcome: 'fail',
      criterion_kind: 'command',
      exit_code: 0,
      status: 'failed',
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((issue) => issue.path.includes('status'))).toBe(true);
    }
  });
});
