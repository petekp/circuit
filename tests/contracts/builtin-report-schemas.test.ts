// Contract for the engine-built-in fanout-aggregate report schema. This shape
// backs PRODUCTION (src/runtime/executors/fanout.ts applies fanout-aggregate@v1
// whenever an aggregate does not name its own schema), so its internal
// consistency must not rest on writer discipline. The invariants mirror
// PrototypeVariantAggregate (src/flows/prototype/reports.ts): branch_count must
// match the actual branch array, and a named winner must be one of the branches.

import { describe, expect, it } from 'vitest';
import { BUILTIN_REPORT_SCHEMAS } from '../../src/schemas/builtin-report-schemas.js';

const FanoutAggregate = BUILTIN_REPORT_SCHEMAS['fanout-aggregate@v1'];

function branch(id: string, extra?: Record<string, unknown>) {
  return {
    branch_id: id,
    child_run_id: `run-${id}`,
    child_outcome: 'complete',
    verdict: 'accept',
    admitted: true,
    result_path: `reports/branches/${id}/result.json`,
    duration_ms: 12,
    ...extra,
  };
}

describe('fanout-aggregate@v1 builtin report schema', () => {
  it('is registered in BUILTIN_REPORT_SCHEMAS', () => {
    expect(FanoutAggregate).toBeDefined();
  });

  it('accepts a valid aggregate whose branch_count matches and winner is a member', () => {
    const ok = FanoutAggregate?.safeParse({
      schema_version: 1,
      join_policy: 'pick-winner',
      branch_count: 2,
      winner_branch_id: 'a',
      branches: [branch('a'), branch('b')],
    });
    expect(ok?.success).toBe(true);
  });

  it('accepts a valid aggregate with no winner named', () => {
    const ok = FanoutAggregate?.safeParse({
      schema_version: 1,
      join_policy: 'aggregate-only',
      branch_count: 1,
      branches: [branch('a')],
    });
    expect(ok?.success).toBe(true);
  });

  it('REJECTS an aggregate whose branch_count disagrees with branches.length', () => {
    const bad = FanoutAggregate?.safeParse({
      schema_version: 1,
      join_policy: 'aggregate-only',
      branch_count: 3,
      branches: [branch('a'), branch('b')],
    });
    expect(bad?.success).toBe(false);
    if (bad && !bad.success) {
      expect(bad.error.issues.some((issue) => issue.path.includes('branch_count'))).toBe(true);
    }
  });

  it('REJECTS an aggregate whose named winner is not one of the branches', () => {
    const bad = FanoutAggregate?.safeParse({
      schema_version: 1,
      join_policy: 'pick-winner',
      branch_count: 2,
      winner_branch_id: 'z',
      branches: [branch('a'), branch('b')],
    });
    expect(bad?.success).toBe(false);
    if (bad && !bad.success) {
      expect(bad.error.issues.some((issue) => issue.path.includes('winner_branch_id'))).toBe(true);
    }
  });
});
