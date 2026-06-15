import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractVariantRecord } from './extract.ts';
import { FIXTURES_ROOT, fixtureExtractInput } from './fixture.ts';

// These prove the extractor against the two bundled fixture run folders. The
// fixtures are realistic engine artifacts (validated against the real schemas
// in fixtures.test.ts), so passing here means the extractor reads the fields
// the engine actually writes, at the paths it writes them.

describe('extractVariantRecord — holistic-pass (a genuine fix)', () => {
  const record = extractVariantRecord(
    fixtureExtractInput(join(FIXTURES_ROOT, 'holistic-pass'), 'holistic', 'fix'),
  );

  it('verdicts pass because the objective (visible + hidden) checks passed', () => {
    expect(record.verdict).toBe('pass');
    expect(record.quality_signal.objective_passed).toBe(true);
    expect(record.quality_signal.false_fixed).toBe(false);
    expect(record.failure_seam).toBeNull();
  });

  it('reads the usd cost meter and per-role spend from the receipt', () => {
    expect(record.cost.unit).toBe('usd');
    expect(record.cost.total).toBeCloseTo(0.42, 5);
    expect(record.cost.partial).toBe(false);
    expect(record.cost.per_role).toEqual({
      researcher: 0.08,
      implementer: 0.22,
      reviewer: 0.12,
    });
  });

  it('counts step.completed entries and the recorded_at span', () => {
    expect(record.steps).toBe(3);
    expect(record.wall_time_ms).toBe(42000);
  });

  it('surfaces evidence refs and the run self-claim', () => {
    expect(record.evidence_refs).toEqual([
      'evidence:reports/verify-npm-test.txt',
      'report:reports/result.json',
    ]);
    expect(record.quality_signal.flow_claimed_done).toBe(true);
    expect(record.quality_signal.run_verdict).toBe('accept');
    expect(record.quality_signal.checks_evaluated).toBe(2);
    expect(record.quality_signal.checks_failed).toBe(0);
    expect(record.quality_signal.missing_evidence_count).toBe(0);
  });

  it('carries the committed diff through verbatim', () => {
    expect(record.changed_files).toEqual(['src/wrap.mjs']);
  });
});

describe('extractVariantRecord — separated-falsefix (claimed done, hidden check fails)', () => {
  const record = extractVariantRecord(
    fixtureExtractInput(join(FIXTURES_ROOT, 'separated-falsefix'), 'separated', 'build'),
  );

  it('verdicts fail and flags the false-fix even though the run claimed done', () => {
    expect(record.verdict).toBe('fail');
    expect(record.quality_signal.flow_claimed_done).toBe(true);
    expect(record.quality_signal.objective_passed).toBe(false);
    expect(record.quality_signal.false_fixed).toBe(true);
  });

  it('names the objective-check seam, not a step abort', () => {
    expect(record.failure_seam).toEqual({
      step_id: 'verify',
      contract: 'objective_check',
      reason: "claimed complete but objective check 'wrap-negative' failed",
    });
  });

  it('reads the higher build cost', () => {
    expect(record.cost.unit).toBe('usd');
    expect(record.cost.total).toBeCloseTo(1.85, 5);
    expect(record.cost.per_role).toEqual({
      researcher: 0.18,
      implementer: 1.2,
      reviewer: 0.47,
    });
  });

  it('counts the slice-loop steps and the longer wall time', () => {
    expect(record.steps).toBe(6);
    expect(record.wall_time_ms).toBe(95000);
  });

  it('carries the wider committed diff', () => {
    expect(record.changed_files).toEqual(['src/wrap.mjs', 'tests/wrap.test.mjs']);
  });
});

describe('extractVariantRecord — defensive degradation', () => {
  it('degrades honestly when the run folder is empty (no artifacts)', () => {
    const record = extractVariantRecord({
      runFolder: join(FIXTURES_ROOT, 'does-not-exist'),
      variantId: 'holistic',
      flowId: 'fix',
      worktreePath: '/tmp/none',
      objective: { baseline_reproduced: false, post_checks: [], objective_passed: false },
      changedFiles: [],
      fallbackWallTimeMs: 1234,
    });
    expect(record.cost).toEqual({ per_role: {}, total: 0, unit: 'none', partial: true });
    expect(record.steps).toBe(0);
    expect(record.wall_time_ms).toBe(1234);
    expect(record.evidence_refs).toEqual([]);
    // No flow claim + objective not met is an honest miss, not a false-fix.
    expect(record.quality_signal.false_fixed).toBe(false);
    expect(record.verdict).toBe('fail');
  });
});
