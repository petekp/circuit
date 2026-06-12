// Committed eval ledger: a small, public, scrubbed record that a
// release-grade eval actually ran against a given commit.
//
// The release cadence gate (scripts/release/eval-cadence.ts) reads these
// entries to decide whether the numbers on the page are fresh. Because the
// ledger is committed, it must NEVER carry operator-private content. A fix
// summary in particular holds absolute paths, the working-tree status, task
// ids, and full task records (including prompts) at its top level. The
// builders below are an ALLOWLIST: they copy only named safe fields, so none
// of that content can reach a ledger file even if a future summary grows new
// sensitive keys. The validator is the belt-and-suspenders second line: it
// scans every string leaf for path/newline/"prompt" poison.

export const LEDGER_SCHEMA_VERSION = 1;

export interface LedgerEntry {
  readonly schema_version: number;
  readonly eval_id: string;
  /** ISO 8601 UTC instant the run finished. */
  readonly ran_at: string;
  /** 40-char lowercase hex commit the run was measured against. */
  readonly repo_commit: string;
  readonly model: string;
  /** Short, safe descriptive strings (judge, suite, set, ...). */
  readonly descriptors: Record<string, string>;
  /** Numeric headline metrics. Never strings, so nothing can leak here. */
  readonly metrics: Record<string, number>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function collectMetrics(pairs: ReadonlyArray<readonly [string, unknown]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of pairs) {
    const value = finiteNumber(raw);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface VerdictLedgerOptions {
  readonly model: string;
  readonly repoCommit: string;
  readonly suite: string;
  /** Overrides the summary's finished_at when set (needed for re-stamped seeds). */
  readonly ranAt?: string;
}

export function buildVerdictLedgerEntry(
  summary: unknown,
  options: VerdictLedgerOptions,
): LedgerEntry {
  const s = (summary ?? {}) as Record<string, unknown>;
  const overall = (s.overall ?? {}) as Record<string, unknown>;
  const controls = (s.controls ?? {}) as Record<string, unknown>;
  const ranAt = options.ranAt ?? asString(s.finished_at) ?? asString(s.started_at);
  if (!ranAt) {
    throw new Error(
      'verdict ledger: no ran_at available (pass --ran-at or use a summary with finished_at)',
    );
  }
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    eval_id: 'verdict-correctness',
    ran_at: ranAt,
    repo_commit: options.repoCommit,
    model: options.model,
    descriptors: {
      judge: asString(s.judge) ?? 'unknown',
      suite: options.suite,
    },
    metrics: collectMetrics([
      ['catch_rate', overall.catch_rate],
      ['protocol_failure_rate', overall.protocol_failure_rate],
      ['cases', overall.cases],
      ['attempted', overall.attempted],
      ['catches', overall.catches],
      ['misses', overall.misses],
      ['errors', overall.errors],
      ['harness_skipped', overall.harness_skipped],
      ['control_passes', controls.passes],
      ['control_fails', controls.fails],
    ]),
  };
}

export interface FixLedgerOptions {
  /** Fix summaries carry no timestamp; ran_at comes from the result dir name. */
  readonly ranAt: string;
  readonly model?: string;
  readonly repoCommit?: string;
  readonly set?: string;
}

export function buildFixLedgerEntry(summary: unknown, options: FixLedgerOptions): LedgerEntry {
  const s = (summary ?? {}) as Record<string, unknown>;
  const aggregates = (s.aggregates ?? {}) as Record<string, unknown>;
  const all = (aggregates.all ?? {}) as Record<string, unknown>;
  const circuit = (all['circuit-claude-code'] ?? all['circuit-codex'] ?? {}) as Record<
    string,
    unknown
  >;
  const vanilla = (all['vanilla-claude-code'] ?? all['vanilla-codex'] ?? {}) as Record<
    string,
    unknown
  >;
  const repoCommit = options.repoCommit ?? asString(s.repo_commit);
  if (!repoCommit) throw new Error('fix ledger: no repo_commit (pass --repo-commit)');
  const model = options.model ?? asString(s.model);
  if (!model) throw new Error('fix ledger: no model (pass --model)');
  const claim = (s.claim ?? {}) as Record<string, unknown>;
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    eval_id: 'fix-vs-vanilla',
    ran_at: options.ranAt,
    repo_commit: repoCommit,
    model,
    descriptors: {
      provider: asString(s.provider) ?? 'unknown',
      effort: asString(s.effort) ?? 'unknown',
      set: options.set ?? asString(s.set) ?? 'unknown',
      circuit_mode: asString(s.circuit_mode) ?? 'unknown',
      // Power axis. circuit_power is the requested dial (empty -> CLI
      // default-on medium); pin_model marks a same-model control run. Older
      // summaries predate these fields, so they read as the legacy default.
      circuit_power: asString(s.circuit_power) || 'default',
      pin_model: String(s.pin_model === true),
      claim_supported: String(claim.supported === true),
    },
    metrics: collectMetrics([
      ['task_count', circuit.task_count],
      ['circuit_false_fixed_rate', circuit.false_fixed_rate],
      ['vanilla_false_fixed_rate', vanilla.false_fixed_rate],
      ['circuit_objective_fixed_rate', circuit.objective_fixed_rate],
      ['vanilla_objective_fixed_rate', vanilla.objective_fixed_rate],
      ['circuit_verification_pass_rate', circuit.verification_pass_rate],
      ['vanilla_verification_pass_rate', vanilla.verification_pass_rate],
      ['circuit_mean_proof_quality', circuit.mean_proof_quality],
      ['vanilla_mean_proof_quality', vanilla.mean_proof_quality],
      ['circuit_mean_wallclock_ms', circuit.mean_wallclock_ms],
      ['vanilla_mean_wallclock_ms', vanilla.mean_wallclock_ms],
      // Cost capture (charter instrument 1). Token sums by class plus both
      // dollar figures per arm; the counters mark when those numbers are not
      // citable (uncaptured usage, price-table misses, reported-vs-computed
      // divergence). All finite numbers, so the poison scan is unaffected.
      ['circuit_total_tokens_input', circuit.total_tokens_input],
      ['circuit_total_tokens_output', circuit.total_tokens_output],
      ['circuit_total_tokens_cache_read', circuit.total_tokens_cache_read],
      ['circuit_total_tokens_cache_creation', circuit.total_tokens_cache_creation],
      ['circuit_total_tokens_cache_creation_5m', circuit.total_tokens_cache_creation_5m],
      ['circuit_total_tokens_cache_creation_1h', circuit.total_tokens_cache_creation_1h],
      ['vanilla_total_tokens_input', vanilla.total_tokens_input],
      ['vanilla_total_tokens_output', vanilla.total_tokens_output],
      ['vanilla_total_tokens_cache_read', vanilla.total_tokens_cache_read],
      ['vanilla_total_tokens_cache_creation', vanilla.total_tokens_cache_creation],
      ['vanilla_total_tokens_cache_creation_5m', vanilla.total_tokens_cache_creation_5m],
      ['vanilla_total_tokens_cache_creation_1h', vanilla.total_tokens_cache_creation_1h],
      ['circuit_total_cost_usd_reported', circuit.total_cost_usd_reported],
      ['circuit_total_cost_usd_computed', circuit.total_cost_usd_computed],
      ['vanilla_total_cost_usd_reported', vanilla.total_cost_usd_reported],
      ['vanilla_total_cost_usd_computed', vanilla.total_cost_usd_computed],
      ['circuit_usage_missing_count', circuit.usage_missing_count],
      ['vanilla_usage_missing_count', vanilla.usage_missing_count],
      ['circuit_cost_divergence_flag_count', circuit.cost_divergence_flag_count],
      ['vanilla_cost_divergence_flag_count', vanilla.cost_divergence_flag_count],
      ['circuit_price_table_miss_count', circuit.price_table_miss_count],
      ['vanilla_price_table_miss_count', vanilla.price_table_miss_count],
      ['circuit_claim_parse_failure_count', circuit.claim_parse_failure_count],
      ['vanilla_claim_parse_failure_count', vanilla.claim_parse_failure_count],
      // Circuit-only relay tallies (the vanilla arm has no relays; its null
      // sums drop out of collectMetrics). These mark when the committed token
      // and dollar totals are undercounts.
      ['circuit_total_relays_failed', circuit.total_relays_failed],
      ['circuit_total_relays_missing_usage', circuit.total_relays_missing_usage],
      ['circuit_total_envelopes_missing_reported_cost', circuit.total_envelopes_missing_reported_cost],
      ['vanilla_total_envelopes_missing_reported_cost', vanilla.total_envelopes_missing_reported_cost],
    ]),
  };
}

// Inverse of isoForPath() for the timestamp prefix of a result dir name:
// "2026-06-11T05-00-35-157Z-held-out" -> "2026-06-11T05:00:35.157Z".
export function isoFromPathTimestamp(stamp: string): string | undefined {
  const match = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return undefined;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

const HEX_40 = /^[0-9a-f]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function poison(value: string, where: string): string[] {
  const out: string[] = [];
  if (value.includes('/Users/') || value.includes('/home/')) {
    out.push(`${where}: contains an absolute home path`);
  }
  if (/[\n\r]/.test(value)) out.push(`${where}: contains a newline`);
  if (/prompt/i.test(value)) out.push(`${where}: contains "prompt"`);
  return out;
}

function validateStringMap(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null) return [`${label}: must be an object`];
  const out: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      out.push(`${label}.${key}: must be a string`);
      continue;
    }
    out.push(...poison(raw, `${label}.${key}`));
  }
  return out;
}

function validateNumberMap(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null) return [`${label}: must be an object`];
  const out: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      out.push(`${label}.${key}: must be a finite number`);
    }
  }
  return out;
}

export function validateLedgerEntry(entry: unknown, label: string): string[] {
  if (typeof entry !== 'object' || entry === null) return [`${label}: not an object`];
  const e = entry as Record<string, unknown>;
  const problems: string[] = [];

  if (e.schema_version !== LEDGER_SCHEMA_VERSION) {
    problems.push(`${label}: schema_version must be ${LEDGER_SCHEMA_VERSION}`);
  }
  if (typeof e.eval_id !== 'string' || e.eval_id.length === 0) {
    problems.push(`${label}: eval_id is required`);
  }
  if (typeof e.ran_at !== 'string' || Number.isNaN(Date.parse(e.ran_at))) {
    problems.push(`${label}: ran_at must be a parseable date`);
  } else if (!ISO_UTC.test(e.ran_at)) {
    problems.push(`${label}: ran_at must be ISO 8601 UTC (…Z)`);
  }
  if (typeof e.repo_commit !== 'string' || !HEX_40.test(e.repo_commit)) {
    problems.push(`${label}: repo_commit must be 40-char lowercase hex`);
  }
  if (typeof e.model !== 'string' || e.model.length === 0) {
    problems.push(`${label}: model is required`);
  }

  // Poison-scan the required string fields too, not just the maps.
  for (const key of ['eval_id', 'ran_at', 'repo_commit', 'model'] as const) {
    const raw = e[key];
    if (typeof raw === 'string') problems.push(...poison(raw, `${label}.${key}`));
  }

  problems.push(...validateStringMap(e.descriptors, `${label}.descriptors`));
  problems.push(...validateNumberMap(e.metrics, `${label}.metrics`));

  return problems;
}
