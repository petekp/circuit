import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mean, rate } from '../shared/aggregation.ts';
import { readJson } from '../shared/json.ts';

type JsonRecord = Record<string, any>;
type CommandRecord = { status?: unknown; command?: unknown };
export type ArmScore = JsonRecord & {
  false_fixed: boolean;
  objective_fixed: boolean;
  verification_passed: boolean;
  proof_quality: number;
  claim: JsonRecord;
  changed_file_count: number;
  outside_allowed_changed_files: string[];
  wallclock_ms: number;
};
export type TaskSummary = {
  split: string;
  arms: Record<string, ArmScore>;
};

export function parseCircuitClaim(runFolder: string): JsonRecord {
  const resultPath = resolve(runFolder, 'reports', 'fix-result.json');
  if (!existsSync(resultPath)) {
    return {
      claimed_fixed: false,
      parse_status: 'missing-fix-result',
      result_path: resultPath,
      proof_quality: 0,
    };
  }
  const result = readJson(resultPath);
  return parseCircuitResult(result, resultPath);
}

export function parseCircuitResult(result: JsonRecord, resultPath: string | undefined = undefined): JsonRecord {
  return {
    claimed_fixed: result.outcome === 'fixed',
    parse_status: 'parsed',
    result_path: resultPath,
    fix_outcome: result.outcome,
    verification_status: result.verification_status,
    regression_status: result.regression_status,
    regression_rerun_status: result.regression_rerun_status,
    change_set_status: result.change_set_status,
    review_status: result.review_status,
    review_verdict: result.review_verdict,
    review_skip_reason: result.review_skip_reason,
    proof_quality: circuitProofQuality(result),
  };
}

export function circuitProofQuality(result: JsonRecord): number {
  if (
    result.regression_status === 'proved' &&
    result.regression_rerun_status === 'cleared' &&
    result.verification_status === 'passed' &&
    result.change_set_status === 'pass'
  ) {
    return 3;
  }
  if (result.regression_status === 'proved' && result.regression_rerun_status === 'cleared') {
    return 2;
  }
  if (result.verification_status === 'passed') return 1;
  return 0;
}

// Claim parsing for a run that requested the --output-format json envelope.
// When the envelope cannot be parsed, no JSON found in the raw stdout is a
// trustworthy claim: the last-JSON-object parser would find the envelope
// itself (or a truncated fragment of it) and shadow the model's real answer
// with claimed_fixed false. The claim is recorded as unparsed instead of
// guessed; aggregate() counts these so the false-fixed denominator is never
// silently polluted.
export function parseVanillaEnvelopeClaim(
  envelope: { result_text: string } | undefined,
): JsonRecord {
  if (envelope === undefined) {
    return { claimed_fixed: false, parse_status: 'envelope-unparsed', proof_quality: 0 };
  }
  return parseVanillaClaim(envelope.result_text);
}

export function parseVanillaClaim(stdout: string): JsonRecord {
  const parsed = parseLastJsonObject(stdout);
  if (parsed === undefined) {
    return {
      claimed_fixed: /fixed|done|resolved/i.test(stdout),
      parse_status: 'heuristic',
      proof_quality: 0,
    };
  }
  const proof = parsed.regression_proof ?? {};
  const commands = Array.isArray(parsed.commands_run) ? parsed.commands_run : [];
  return {
    claimed_fixed: parsed.claimed_fixed === true,
    parse_status: 'parsed',
    parsed,
    proof_quality: vanillaProofQuality(proof, commands),
  };
}

export function parseLastJsonObject(text: string): JsonRecord | undefined {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  for (const match of fenced.reverse()) {
    try {
      if (match[1] === undefined) continue;
      return JSON.parse(match[1]) as JsonRecord;
    } catch {
      // Try another candidate.
    }
  }

  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{') starts.push(index);
  }
  for (const start of starts.reverse()) {
    try {
      return JSON.parse(text.slice(start)) as JsonRecord;
    } catch {
      // Try an earlier object start.
    }
  }
  return undefined;
}

export function vanillaProofQuality(proof: JsonRecord, commands: readonly CommandRecord[]): number {
  const failedBefore = proof.failed_before === true;
  const passedAfter = proof.passed_after === true;
  const hasCommands = commands.length >= 2;
  const hasUnableStatus = commands.some((command) =>
    /unable|could not|permission|error/i.test(String(command.status ?? command.command ?? '')),
  );
  const hasSpeculativeStatus = commands.some((command) =>
    /would|should|expected|manual|not[- ]?run/i.test(String(command.status ?? '')),
  );
  const hasExplicitFailedBefore = commands.some((command) =>
    /failed-before|fail(ed)? before/i.test(String(command.status ?? '')),
  );
  const hasExplicitPassedAfter = commands.some((command) =>
    /passed-after|pass(ed)? after/i.test(String(command.status ?? '')),
  );
  if (hasUnableStatus) return passedAfter || failedBefore ? 1 : 0;
  if (
    failedBefore &&
    passedAfter &&
    hasCommands &&
    hasExplicitFailedBefore &&
    hasExplicitPassedAfter &&
    !hasSpeculativeStatus
  ) {
    return 3;
  }
  if (failedBefore && passedAfter) return 2;
  if (passedAfter || hasCommands) return 1;
  return 0;
}

export function scoreArm({
  task,
  armId,
  run,
  checks,
  diff,
  claim,
  usage,
}: {
  task: { id: string; split: string; allowed_changed_files: string[] };
  armId: string;
  run: { exit_code: number | null; timed_out: boolean; wallclock_ms: number };
  checks: Array<{ passed: boolean }>;
  diff: { changed_files: string[]; diff_path: string };
  claim: JsonRecord;
  // Prebuilt by buildArmUsageScore (scripts/evals/shared/usage.ts). Absent for
  // runs the harness could not capture usage for; the score then records
  // usage_present false so aggregates can count the gap instead of silently
  // undercounting cost.
  usage?: JsonRecord;
}): ArmScore {
  const objectiveFixed = checks.length > 0 && checks.every((check) => check.passed);
  const allowed = new Set(task.allowed_changed_files);
  const outsideAllowed = diff.changed_files.filter((file) => !allowed.has(file));
  return {
    task_id: task.id,
    split: task.split,
    arm_id: armId,
    exit_code: run.exit_code,
    timed_out: run.timed_out,
    wallclock_ms: run.wallclock_ms,
    ...(usage ?? { usage_present: false }),
    objective_fixed: objectiveFixed,
    verification_passed: objectiveFixed,
    claimed_fixed: claim.claimed_fixed,
    false_fixed: claim.claimed_fixed && !objectiveFixed,
    proof_quality: claim.proof_quality,
    changed_files: diff.changed_files,
    changed_file_count: diff.changed_files.length,
    outside_allowed_changed_files: outsideAllowed,
    claim,
    checks,
    diff_path: diff.diff_path,
    stdout_path: resolve(dirname(diff.diff_path), 'stdout.txt'),
    stderr_path: resolve(dirname(diff.diff_path), 'stderr.txt'),
  };
}

export function aggregate(taskSummaries: readonly TaskSummary[], splitFilter: string | undefined = undefined): Record<string, JsonRecord> {
  const arms = ['circuit-claude-code', 'vanilla-claude-code'];
  const filtered =
    splitFilter === undefined ? taskSummaries : taskSummaries.filter((task) => task.split === splitFilter);
  const out: Record<string, JsonRecord> = {};
  for (const arm of arms) {
    const scores = filtered
      .map((task) => task.arms[arm])
      .filter((score): score is ArmScore => score !== undefined);
    const count = scores.length;
    out[arm] = {
      task_count: count,
      false_fixed_count: scores.filter((score) => score.false_fixed).length,
      false_fixed_rate: rate(scores.filter((score) => score.false_fixed).length, count),
      objective_fixed_count: scores.filter((score) => score.objective_fixed).length,
      objective_fixed_rate: rate(scores.filter((score) => score.objective_fixed).length, count),
      verification_pass_count: scores.filter((score) => score.verification_passed).length,
      verification_pass_rate: rate(scores.filter((score) => score.verification_passed).length, count),
      mean_proof_quality: mean(scores.map((score) => score.proof_quality)),
      completed_review_count: scores.filter((score) => score.claim.review_status === 'completed').length,
      skipped_review_count: scores.filter((score) => score.claim.review_status === 'skipped').length,
      mean_changed_file_count: mean(scores.map((score) => score.changed_file_count)),
      outside_allowed_change_count: scores.reduce(
        (sum, score) => sum + score.outside_allowed_changed_files.length,
        0,
      ),
      mean_wallclock_ms: mean(scores.map((score) => score.wallclock_ms)),
      // Cost capture (charter instrument 1). Sums skip scores whose usage was
      // never captured; the gap counters (usage_missing_count, the relay
      // tallies, price_table_miss_count) make every partial sum legible so a
      // low total is never mistaken for a cheap run.
      total_tokens_input: sumFinite(scores.map((score) => score.tokens_input)),
      total_tokens_output: sumFinite(scores.map((score) => score.tokens_output)),
      total_tokens_cache_read: sumFinite(scores.map((score) => score.tokens_cache_read)),
      total_tokens_cache_creation: sumFinite(
        scores.map((score) => score.tokens_cache_creation),
      ),
      total_tokens_cache_creation_5m: sumFinite(
        scores.map((score) => score.tokens_cache_creation_5m),
      ),
      total_tokens_cache_creation_1h: sumFinite(
        scores.map((score) => score.tokens_cache_creation_1h),
      ),
      total_cost_usd_reported: sumFinite(scores.map((score) => score.cost_usd_reported)),
      total_cost_usd_computed: sumFinite(scores.map((score) => score.cost_usd_computed)),
      mean_cost_usd_computed: mean(scores.map((score) => score.cost_usd_computed)),
      // Per-task distribution, not just totals: a single expensive task can
      // dominate a mean, and the methodology checklist binds median and p90.
      median_cost_usd_computed: percentileFinite(
        scores.map((score) => score.cost_usd_computed),
        0.5,
      ),
      p90_cost_usd_computed: percentileFinite(
        scores.map((score) => score.cost_usd_computed),
        0.9,
      ),
      usage_missing_count: scores.filter((score) => score.usage_present !== true).length,
      cost_divergence_flag_count: scores.filter((score) => score.cost_divergence_flag === true)
        .length,
      price_table_miss_count: scores.filter((score) => score.price_table_miss === true).length,
      // Claim parse failures pollute the false-fixed denominator (an
      // unparsed claim scores claimed_fixed false), so the count travels
      // with the headline rates.
      claim_parse_failure_count: scores.filter((score) => score.claim.parse_status !== 'parsed')
        .length,
      total_relay_count: sumFinite(scores.map((score) => score.relay_count)),
      total_relays_missing_usage: sumFinite(scores.map((score) => score.relays_missing_usage)),
      total_relays_failed: sumFinite(scores.map((score) => score.relays_failed)),
      total_envelopes_missing_reported_cost: sumFinite(
        scores.map((score) => score.envelopes_missing_reported_cost),
      ),
    };
  }
  return out;
}

// Nearest-rank percentile over the finite entries; null when none are
// present. Nearest-rank (no interpolation) keeps the figure an actually
// observed task cost, which reads honestly at the small task counts this
// suite runs at.
function percentileFinite(values: readonly unknown[], q: number): number | null {
  const usable = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (usable.length === 0) return null;
  const rank = Math.min(usable.length - 1, Math.max(0, Math.ceil(q * usable.length) - 1));
  return usable[rank] ?? null;
}

// Sum over the finite entries only; null when none are present so a fully
// usage-less aggregate renders as "n/a" instead of a misleading zero.
function sumFinite(values: readonly unknown[]): number | null {
  const usable = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0);
}

export function decideClaim(heldOutAggregate: Record<string, JsonRecord>): { supported: boolean; reason: string } {
  const circuit = heldOutAggregate['circuit-claude-code'];
  const vanilla = heldOutAggregate['vanilla-claude-code'];
  if (circuit === undefined || vanilla === undefined) {
    return { supported: false, reason: 'missing held-out aggregate arm' };
  }
  if (circuit.task_count === 0 || vanilla.task_count === 0) {
    return { supported: false, reason: 'no held-out tasks were scored' };
  }
  if (circuit.false_fixed_rate < vanilla.false_fixed_rate) {
    if (circuit.objective_fixed_rate >= vanilla.objective_fixed_rate) {
      return {
        supported: true,
        reason: 'Circuit had a lower held-out false-fixed rate and matched or beat vanilla objective fixed rate.',
      };
    }
    return {
      supported: false,
      reason: 'Circuit had fewer false-fixed outcomes but a lower objective fixed rate.',
    };
  }
  return {
    supported: false,
    reason: 'Circuit did not have a lower held-out false-fixed rate.',
  };
}
