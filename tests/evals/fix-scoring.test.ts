import { describe, expect, it } from 'vitest';
import {
  aggregate,
  circuitProofQuality,
  decideClaim,
  parseCircuitResult,
  parseVanillaClaim,
  parseVanillaEnvelopeClaim,
  scoreArm,
} from '../../scripts/evals/fix-vs-vanilla/scoring.ts';

// Aggregates are keyed by arm id, so every lookup is `T | undefined` under
// noUncheckedIndexedAccess. Throwing on a missing arm says which arm the
// aggregate failed to produce, where a non-null assertion would fail later
// with a property read on undefined and name nothing.
function arm<T>(aggregates: Record<string, T>, armId: string): T {
  const found = aggregates[armId];
  if (found === undefined) throw new Error(`no aggregate for arm '${armId}'`);
  return found;
}

describe('fix-vs-vanilla scoring', () => {
  it('marks claimed success with failing checks as false-fixed', () => {
    const score = scoreArm({
      task: { id: 'task', split: 'held-out', allowed_changed_files: ['src/fix.ts'] },
      armId: 'vanilla-claude-code',
      run: { exit_code: 0, timed_out: false, wallclock_ms: 12 },
      checks: [{ passed: false }],
      diff: { changed_files: ['src/fix.ts'], diff_path: '/tmp/task/diff.txt' },
      claim: { claimed_fixed: true, proof_quality: 2 },
    });

    expect(score.objective_fixed).toBe(false);
    expect(score.false_fixed).toBe(true);
    // No usage passed: the score says so explicitly instead of staying silent.
    expect(score.usage_present).toBe(false);
  });

  it('stamps prebuilt usage fields onto the arm score', () => {
    const score = scoreArm({
      task: { id: 'task', split: 'held-out', allowed_changed_files: ['src/fix.ts'] },
      armId: 'circuit-claude-code',
      run: { exit_code: 0, timed_out: false, wallclock_ms: 12 },
      checks: [{ passed: true }],
      diff: { changed_files: ['src/fix.ts'], diff_path: '/tmp/task/diff.txt' },
      claim: { claimed_fixed: true, proof_quality: 3 },
      usage: {
        usage_present: true,
        tokens_input: 500,
        tokens_output: 100,
        cost_usd_reported: 0.01,
        cost_usd_computed: 0.0101,
        cost_divergence_flag: false,
      },
    });

    expect(score.usage_present).toBe(true);
    expect(score.tokens_input).toBe(500);
    expect(score.cost_usd_computed).toBeCloseTo(0.0101, 10);
  });

  it('aggregates cost sums and counts the scores that captured no usage', () => {
    const base = {
      task: { id: 'task', split: 'held-out', allowed_changed_files: ['src/fix.ts'] },
      run: { exit_code: 0, timed_out: false, wallclock_ms: 10 },
      checks: [{ passed: true }],
      diff: { changed_files: [], diff_path: '/tmp/task/diff.txt' },
      claim: { claimed_fixed: true, proof_quality: 3 },
    };
    const withUsage = scoreArm({
      ...base,
      armId: 'circuit-claude-code',
      usage: {
        usage_present: true,
        tokens_input: 100,
        tokens_output: 50,
        tokens_cache_read: 10,
        tokens_cache_creation: 5,
        cost_usd_reported: 0.02,
        cost_usd_computed: 0.021,
        cost_divergence_flag: true,
      },
    });
    const withoutUsage = scoreArm({ ...base, armId: 'circuit-claude-code' });
    const vanillaNoUsage = scoreArm({ ...base, armId: 'vanilla-claude-code' });

    const out = aggregate([
      {
        split: 'held-out',
        arms: { 'circuit-claude-code': withUsage, 'vanilla-claude-code': vanillaNoUsage },
      },
      { split: 'held-out', arms: { 'circuit-claude-code': withoutUsage } },
    ]);

    const circuit = arm(out, 'circuit-claude-code');
    expect(circuit.total_tokens_input).toBe(100);
    expect(circuit.total_cost_usd_computed).toBeCloseTo(0.021, 10);
    expect(circuit.usage_missing_count).toBe(1);
    expect(circuit.cost_divergence_flag_count).toBe(1);

    // An arm with no captured usage anywhere reports null sums, never zero.
    const vanilla = arm(out, 'vanilla-claude-code');
    expect(vanilla.total_cost_usd_computed).toBeNull();
    expect(vanilla.usage_missing_count).toBe(1);
  });

  it('scores complete Circuit proof evidence as quality 3', () => {
    expect(
      circuitProofQuality({
        regression_status: 'proved',
        regression_rerun_status: 'cleared',
        verification_status: 'passed',
        change_set_status: 'pass',
      }),
    ).toBe(3);
    expect(
      parseCircuitResult({ outcome: 'fixed', verification_status: 'passed' }).claimed_fixed,
    ).toBe(true);
  });

  it('parses strong vanilla JSON claims and proof quality', () => {
    const claim = parseVanillaClaim(`Done.

\`\`\`json
{
  "claimed_fixed": true,
  "changed_files": ["src/example.ts"],
  "commands_run": [
    {"command": "npm test", "status": "failed-before"},
    {"command": "npm test", "status": "passed-after"}
  ],
  "regression_proof": {
    "command": "npm test",
    "failed_before": true,
    "passed_after": true
  },
  "residual_risks": []
}
\`\`\``);

    expect(claim.parse_status).toBe('parsed');
    expect(claim.claimed_fixed).toBe(true);
    expect(claim.proof_quality).toBe(3);
  });

  it('falls back to heuristic vanilla claims when JSON is missing', () => {
    const claim = parseVanillaClaim('The bug is fixed and tests are green.');
    expect(claim.parse_status).toBe('heuristic');
    expect(claim.claimed_fixed).toBe(true);
    expect(claim.proof_quality).toBe(0);
  });

  it('records an unparsed claim, never a guess, when the envelope is missing', () => {
    // A raw-stdout fallback here would let the brace-scan parse the envelope
    // itself (claimed_fixed false) or fire the heuristic on envelope text.
    const unparsed = parseVanillaEnvelopeClaim(undefined);
    expect(unparsed.parse_status).toBe('envelope-unparsed');
    expect(unparsed.claimed_fixed).toBe(false);
    expect(unparsed.proof_quality).toBe(0);

    const parsed = parseVanillaEnvelopeClaim({
      result_text: '```json\n{"claimed_fixed": true, "commands_run": []}\n```',
    });
    expect(parsed.parse_status).toBe('parsed');
    expect(parsed.claimed_fixed).toBe(true);
  });

  it('aggregates cost distribution, TTL split, and integrity counters', () => {
    const base = {
      task: { id: 'task', split: 'held-out', allowed_changed_files: [] as string[] },
      run: { exit_code: 0, timed_out: false, wallclock_ms: 10 },
      checks: [{ passed: true }],
      diff: { changed_files: [], diff_path: '/tmp/task/diff.txt' },
    };
    const costs = [0.001, 0.002, 0.01];
    const summaries = costs.map((cost, index) => ({
      split: 'held-out',
      arms: {
        'circuit-claude-code': scoreArm({
          ...base,
          armId: 'circuit-claude-code',
          claim:
            index === 0
              ? { claimed_fixed: false, parse_status: 'envelope-unparsed', proof_quality: 0 }
              : { claimed_fixed: true, parse_status: 'parsed', proof_quality: 3 },
          usage: {
            usage_present: true,
            tokens_cache_creation_5m: 100,
            tokens_cache_creation_1h: 400,
            cost_usd_computed: cost,
            envelopes_missing_reported_cost: index === 0 ? 1 : 0,
            relay_count: 2,
            relays_missing_usage: 0,
            relays_failed: index === 2 ? 1 : 0,
          },
        }),
      },
    }));

    const circuit = arm(aggregate(summaries), 'circuit-claude-code');
    expect(circuit.total_tokens_cache_creation_5m).toBe(300);
    expect(circuit.total_tokens_cache_creation_1h).toBe(1200);
    // Nearest-rank over [0.001, 0.002, 0.01].
    expect(circuit.median_cost_usd_computed).toBeCloseTo(0.002, 12);
    expect(circuit.p90_cost_usd_computed).toBeCloseTo(0.01, 12);
    expect(circuit.claim_parse_failure_count).toBe(1);
    expect(circuit.total_relay_count).toBe(6);
    expect(circuit.total_relays_failed).toBe(1);
    expect(circuit.total_envelopes_missing_reported_cost).toBe(1);

    // The vanilla arm captured nothing: distribution fields are null, not 0.
    const vanilla = arm(aggregate(summaries), 'vanilla-claude-code');
    expect(vanilla.median_cost_usd_computed).toBeNull();
    expect(vanilla.total_relays_failed).toBeNull();
  });

  it('supports a held-out claim only when false-fixed improves and fixed rate is not lower', () => {
    const claim = decideClaim({
      'circuit-claude-code': {
        task_count: 5,
        false_fixed_rate: 0,
        objective_fixed_rate: 1,
      },
      'vanilla-claude-code': {
        task_count: 5,
        false_fixed_rate: 0.2,
        objective_fixed_rate: 0.8,
      },
    });

    expect(claim.supported).toBe(true);
  });
});
