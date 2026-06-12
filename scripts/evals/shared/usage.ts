// Token and dollar accounting for eval arms (charter instrument 1).
//
// Two capture seams feed one normalized shape:
//   - vanilla arm: the `--output-format json` envelope on stdout;
//   - circuit arm: `usage` blocks on relay.completed entries in the run
//     folder's trace.ndjson, joined to relay.started for the role.
//
// Cost comes in two fields per the charter: cost_usd_reported (the CLI's own
// figure) and cost_usd_computed (per-model tokens priced against the committed
// table at evals/ledger/prices/<date>.json). Divergence above 5 percent of
// the larger figure flags stale bookkeeping without failing the run. The
// table resolves model ids by longest-prefix match and an unknown id leaves
// computed cost absent rather than guessing.
//
// Cost integrity is layered: a single capture unit (envelope) either prices
// completely or not at all, while arm-level sums may be partial but always
// travel with the counters that mark the gap (relays_missing_usage,
// relays_failed, envelopes_missing_reported_cost, price_table_miss).
//
// Everything here is tolerant: a timed-out run has no envelope, a connector
// may emit no usage, an old trace predates the usage field. Those paths
// return undefined / mark usage_present false instead of throwing.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson } from './json.ts';

type JsonRecord = Record<string, any>;

export type ModelUsageEntry = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd_reported?: number;
};

// One capture unit: a vanilla envelope or a single relay subprocess. The TTL
// split lives here (not per model) because that is the only level the CLI
// reports it at; cost computation apportions per envelope, where the split is
// most local, before summing.
export type UsageEnvelope = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  cost_usd_reported?: number;
  models: ModelUsageEntry[];
};

export type ModelPrice = {
  input: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  output: number;
};

export type PriceTable = {
  schema_version: number;
  as_of: string;
  models: Record<string, ModelPrice>;
};

export const COST_DIVERGENCE_THRESHOLD = 0.05;

// ---------------------------------------------------------------------------
// Vanilla seam: the --output-format json envelope.

export type VanillaEnvelope = {
  result_text: string;
  usage: UsageEnvelope;
};

// Returns undefined for anything that does not end in a claude CLI result
// envelope (plain-text stdout from a legacy run, partial output from a
// timeout). Stray bytes BEFORE the envelope (host warnings, wrapper noise)
// are tolerated by scanning '{' starts from the end of stdout for a
// parseable object with type "result"; escaped JSON inside the envelope's
// result string can never satisfy that scan, so the hit is always the
// envelope itself. Trailing bytes after the envelope are not tolerated (the
// CLI writes it last); a truncated envelope returns undefined rather than
// risking a nested object being mistaken for the result event. The caller
// decides what a missing envelope means; for a run that requested the
// envelope, no JSON found in the raw stdout is a trustworthy claim (see
// parseVanillaEnvelopeClaim in fix-vs-vanilla/scoring.ts).
export function parseVanillaEnvelope(stdout: string): VanillaEnvelope | undefined {
  const text = stdout.trim();
  const starts: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{') starts.push(index);
  }
  for (const start of starts.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const envelope = parsed as JsonRecord;
    if (envelope.type !== 'result') continue;
    return {
      result_text: typeof envelope.result === 'string' ? envelope.result : '',
      usage: normalizeUsage(envelope),
    };
  }
  return undefined;
}

// Normalizes a result event (stream-json terminal entry or json envelope)
// into a UsageEnvelope. The per-model modelUsage map is the true token total;
// the top-level usage block covers the main loop only but alone carries the
// cache-write TTL split.
export function normalizeUsage(resultEvent: JsonRecord): UsageEnvelope {
  const usage = (resultEvent.usage ?? {}) as JsonRecord;
  const cacheCreation = (usage.cache_creation ?? {}) as JsonRecord;
  const models: ModelUsageEntry[] = [];
  const modelUsage = resultEvent.modelUsage;
  if (modelUsage !== null && typeof modelUsage === 'object') {
    for (const [model, raw] of Object.entries(modelUsage as JsonRecord)) {
      if (raw === null || typeof raw !== 'object') continue;
      const m = raw as JsonRecord;
      const cost = finiteOrUndefined(m.costUSD);
      models.push({
        model: model.length === 0 ? 'unknown' : model,
        input_tokens: finiteOrZero(m.inputTokens),
        output_tokens: finiteOrZero(m.outputTokens),
        cache_read_tokens: finiteOrZero(m.cacheReadInputTokens),
        cache_creation_tokens: finiteOrZero(m.cacheCreationInputTokens),
        ...(cost === undefined ? {} : { cost_usd_reported: cost }),
      });
    }
  }
  const totals =
    models.length > 0
      ? {
          input_tokens: sumBy(models, (m) => m.input_tokens),
          output_tokens: sumBy(models, (m) => m.output_tokens),
          cache_read_tokens: sumBy(models, (m) => m.cache_read_tokens),
          cache_creation_tokens: sumBy(models, (m) => m.cache_creation_tokens),
        }
      : {
          input_tokens: finiteOrZero(usage.input_tokens),
          output_tokens: finiteOrZero(usage.output_tokens),
          cache_read_tokens: finiteOrZero(usage.cache_read_input_tokens),
          cache_creation_tokens: finiteOrZero(usage.cache_creation_input_tokens),
        };
  const reported = finiteOrUndefined(resultEvent.total_cost_usd);
  return {
    ...totals,
    cache_creation_5m_tokens: finiteOrZero(cacheCreation.ephemeral_5m_input_tokens),
    cache_creation_1h_tokens: finiteOrZero(cacheCreation.ephemeral_1h_input_tokens),
    ...(reported === undefined ? {} : { cost_usd_reported: reported }),
    models,
  };
}

// ---------------------------------------------------------------------------
// Circuit seam: relay usage from the run folder's trace.

export type RelayUsageRecord = {
  role: string;
  usage: UsageEnvelope;
};

export type CircuitRunUsage = {
  relays: RelayUsageRecord[];
  relay_count: number;
  relays_missing_usage: number;
  relays_failed: number;
};

// Reads <runFolder>/trace.ndjson and joins relay.completed usage blocks to
// relay.started roles on (step_id, attempt). Tolerant of missing files,
// unparseable lines, and usage-less entries: every relay.completed counts
// toward relay_count, the ones without usage are tallied, and attempts that
// crashed or timed out (relay.failed, which never reaches relay.completed)
// are tallied separately as relays_failed. Those failed attempts consumed
// tokens the connector could not capture, so the counter is what keeps that
// undercount from being silently absorbed.
export function readCircuitRunUsage(runFolder: string): CircuitRunUsage | undefined {
  const tracePath = resolve(runFolder, 'trace.ndjson');
  if (!existsSync(tracePath)) return undefined;
  const lines = readFileSync(tracePath, 'utf8').split('\n');
  const roleByKey = new Map<string, string>();
  const relays: RelayUsageRecord[] = [];
  let relayCount = 0;
  let missingUsage = 0;
  let failed = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let entry: JsonRecord;
    try {
      entry = JSON.parse(line) as JsonRecord;
    } catch {
      continue;
    }
    const key = `${String(entry.step_id)}#${String(entry.attempt)}`;
    if (entry.kind === 'relay.started' && typeof entry.role === 'string') {
      roleByKey.set(key, entry.role);
      continue;
    }
    if (entry.kind === 'relay.failed') {
      failed += 1;
      continue;
    }
    if (entry.kind !== 'relay.completed') continue;
    relayCount += 1;
    const usage = entry.usage;
    if (usage === null || usage === undefined || typeof usage !== 'object') {
      missingUsage += 1;
      continue;
    }
    const u = usage as JsonRecord;
    const relayCost = finiteOrUndefined(u.total_cost_usd_reported);
    const models: ModelUsageEntry[] = Array.isArray(u.models)
      ? u.models
          .filter((m: unknown): m is JsonRecord => m !== null && typeof m === 'object')
          .map((m: JsonRecord): ModelUsageEntry => {
            const modelCost = finiteOrUndefined(m.cost_usd_reported);
            const name = typeof m.model === 'string' ? m.model : '';
            return {
              model: name.length === 0 ? 'unknown' : name,
              input_tokens: finiteOrZero(m.input_tokens),
              output_tokens: finiteOrZero(m.output_tokens),
              cache_read_tokens: finiteOrZero(m.cache_read_tokens),
              cache_creation_tokens: finiteOrZero(m.cache_creation_tokens),
              ...(modelCost === undefined ? {} : { cost_usd_reported: modelCost }),
            };
          })
      : [];
    relays.push({
      role: roleByKey.get(key) ?? 'unknown',
      usage: {
        input_tokens: finiteOrZero(u.input_tokens),
        output_tokens: finiteOrZero(u.output_tokens),
        cache_read_tokens: finiteOrZero(u.cache_read_tokens),
        cache_creation_tokens: finiteOrZero(u.cache_creation_tokens),
        cache_creation_5m_tokens: finiteOrZero(u.cache_creation_5m_tokens),
        cache_creation_1h_tokens: finiteOrZero(u.cache_creation_1h_tokens),
        ...(relayCost === undefined ? {} : { cost_usd_reported: relayCost }),
        models,
      },
    });
  }
  return {
    relays,
    relay_count: relayCount,
    relays_missing_usage: missingUsage,
    relays_failed: failed,
  };
}

// ---------------------------------------------------------------------------
// Price table.

// Newest dated file wins; the directory is append-only by convention.
export function loadPriceTable(pricesDir: string): PriceTable | undefined {
  if (!existsSync(pricesDir)) return undefined;
  const files = readdirSync(pricesDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const newest = files[files.length - 1];
  if (newest === undefined) return undefined;
  return readJson<PriceTable>(resolve(pricesDir, newest));
}

// Longest-prefix match: an exact key wins; otherwise the longest key that the
// model id extends with a '-' segment (claude-haiku-4-5-20251001 hits
// claude-haiku-4-5 without claude-opus-4-5 ever matching claude-opus-4-55).
export function resolveModelPrice(
  table: PriceTable,
  modelId: string,
): ModelPrice | undefined {
  const exact = table.models[modelId];
  if (exact !== undefined) return exact;
  let bestKey: string | undefined;
  for (const key of Object.keys(table.models)) {
    if (!modelId.startsWith(`${key}-`)) continue;
    if (bestKey === undefined || key.length > bestKey.length) bestKey = key;
  }
  return bestKey === undefined ? undefined : table.models[bestKey];
}

export type ComputedCost = {
  cost_usd_computed?: number;
  price_table_misses: string[];
};

// Prices one envelope's per-model tokens. Cache-creation tokens apportion
// across the 5m/1h TTL prices in proportion to the envelope's own split; a
// creation count with no split information prices at the 1h rate (the CLI's
// default TTL). Any model id the table cannot resolve poisons the whole
// computed figure: a partial sum would read as a real cost and mislead. The
// same rule covers malformed price rows and any top-level tokens the models
// array does not account for (checked per token class, so a surplus in one
// class cannot hide a deficit in another); both count as a miss. The only
// $0 computed cost is a genuinely empty envelope.
export function computeEnvelopeCostUsd(
  envelope: UsageEnvelope,
  table: PriceTable,
): ComputedCost {
  const misses: string[] = [];
  // Unattributed tokens have no model id to price against; pricing only the
  // attributed share would undercount silently. In-repo writers derive the
  // totals from the models array, so legitimate captures never trip this;
  // it guards foreign or corrupted data.
  const unattributed =
    Math.max(0, envelope.input_tokens - sumBy(envelope.models, (m) => m.input_tokens)) +
    Math.max(0, envelope.output_tokens - sumBy(envelope.models, (m) => m.output_tokens)) +
    Math.max(0, envelope.cache_read_tokens - sumBy(envelope.models, (m) => m.cache_read_tokens)) +
    Math.max(
      0,
      envelope.cache_creation_tokens - sumBy(envelope.models, (m) => m.cache_creation_tokens),
    );
  if (unattributed > 0) misses.push('unknown');
  let total = 0;
  const splitTotal = envelope.cache_creation_5m_tokens + envelope.cache_creation_1h_tokens;
  const share5m = splitTotal > 0 ? envelope.cache_creation_5m_tokens / splitTotal : 0;
  for (const model of envelope.models) {
    const price = resolveModelPrice(table, model.model);
    if (price === undefined) {
      misses.push(model.model);
      continue;
    }
    const creation5m = model.cache_creation_tokens * share5m;
    const creation1h = model.cache_creation_tokens - creation5m;
    const modelCost =
      (model.input_tokens * price.input +
        model.output_tokens * price.output +
        model.cache_read_tokens * price.cache_read +
        creation5m * price.cache_write_5m +
        creation1h * price.cache_write_1h) /
      1_000_000;
    // A malformed price row (a rate missing or non-numeric) arithmetics to
    // NaN. That is a table problem, not a cost, so it counts as a miss.
    if (!Number.isFinite(modelCost)) {
      misses.push(model.model);
      continue;
    }
    total += modelCost;
  }
  if (misses.length > 0) return { price_table_misses: misses };
  return { cost_usd_computed: total, price_table_misses: [] };
}

// ---------------------------------------------------------------------------
// Arm-level rollup: the flat fields stamped into an ArmScore.

function sumEnvelopes(envelopes: readonly UsageEnvelope[]): UsageEnvelope {
  const merged: Record<string, ModelUsageEntry> = {};
  for (const envelope of envelopes) {
    for (const model of envelope.models) {
      const prior = merged[model.model];
      if (prior === undefined) {
        merged[model.model] = { ...model };
        continue;
      }
      const cost =
        prior.cost_usd_reported === undefined && model.cost_usd_reported === undefined
          ? undefined
          : (prior.cost_usd_reported ?? 0) + (model.cost_usd_reported ?? 0);
      merged[model.model] = {
        model: model.model,
        input_tokens: prior.input_tokens + model.input_tokens,
        output_tokens: prior.output_tokens + model.output_tokens,
        cache_read_tokens: prior.cache_read_tokens + model.cache_read_tokens,
        cache_creation_tokens: prior.cache_creation_tokens + model.cache_creation_tokens,
        ...(cost === undefined ? {} : { cost_usd_reported: cost }),
      };
    }
  }
  const reportedValues = envelopes
    .map((envelope) => envelope.cost_usd_reported)
    .filter((value): value is number => typeof value === 'number');
  return {
    input_tokens: sumBy(envelopes, (e) => e.input_tokens),
    output_tokens: sumBy(envelopes, (e) => e.output_tokens),
    cache_read_tokens: sumBy(envelopes, (e) => e.cache_read_tokens),
    cache_creation_tokens: sumBy(envelopes, (e) => e.cache_creation_tokens),
    cache_creation_5m_tokens: sumBy(envelopes, (e) => e.cache_creation_5m_tokens),
    cache_creation_1h_tokens: sumBy(envelopes, (e) => e.cache_creation_1h_tokens),
    ...(reportedValues.length === 0
      ? {}
      : { cost_usd_reported: sumBy(reportedValues, (value) => value) }),
    models: Object.values(merged).sort((a, b) => a.model.localeCompare(b.model)),
  };
}

function rollupCost(
  envelopes: readonly UsageEnvelope[],
  table: PriceTable | undefined,
): ComputedCost {
  if (table === undefined) return { price_table_misses: [] };
  const misses = new Set<string>();
  let total = 0;
  let complete = true;
  for (const envelope of envelopes) {
    const cost = computeEnvelopeCostUsd(envelope, table);
    if (cost.cost_usd_computed === undefined) {
      complete = false;
      for (const miss of cost.price_table_misses) misses.add(miss);
      continue;
    }
    total += cost.cost_usd_computed;
  }
  if (!complete || envelopes.length === 0) return { price_table_misses: [...misses].sort() };
  return { cost_usd_computed: total, price_table_misses: [] };
}

export type ArmUsageScore = JsonRecord & {
  usage_present: boolean;
};

// The vanilla arm passes one envelope; the circuit arm passes one per relay
// plus the role join. Flat numeric fields land in the ArmScore (and from
// there the aggregates and ledger); the nested by-role and per-model detail
// stays in summary.json for legibility.
export function buildArmUsageScore({
  envelopes,
  byRole,
  table,
  relayCount,
  relaysMissingUsage,
  relaysFailed,
}: {
  envelopes: readonly UsageEnvelope[];
  byRole?: ReadonlyMap<string, readonly UsageEnvelope[]>;
  table: PriceTable | undefined;
  relayCount?: number;
  relaysMissingUsage?: number;
  relaysFailed?: number;
}): ArmUsageScore {
  if (envelopes.length === 0) {
    return {
      usage_present: false,
      ...(relayCount === undefined ? {} : { relay_count: relayCount }),
      ...(relaysMissingUsage === undefined ? {} : { relays_missing_usage: relaysMissingUsage }),
      ...(relaysFailed === undefined ? {} : { relays_failed: relaysFailed }),
    };
  }
  const total = sumEnvelopes(envelopes);
  const computed = rollupCost(envelopes, table);
  const divergence = costDivergence(total.cost_usd_reported, computed.cost_usd_computed);
  // A capture unit with usage but no CLI-reported cost makes the summed
  // reported figure partial; the counter is what marks that, mirroring the
  // relays_missing_usage treatment of the token sums.
  const missingReportedCost = envelopes.filter(
    (envelope) => envelope.cost_usd_reported === undefined,
  ).length;
  const roles: JsonRecord = {};
  for (const [role, roleEnvelopes] of byRole ?? []) {
    const roleTotal = sumEnvelopes(roleEnvelopes);
    const roleCost = rollupCost(roleEnvelopes, table);
    roles[role] = {
      relay_count: roleEnvelopes.length,
      tokens_input: roleTotal.input_tokens,
      tokens_output: roleTotal.output_tokens,
      tokens_cache_read: roleTotal.cache_read_tokens,
      tokens_cache_creation: roleTotal.cache_creation_tokens,
      ...(roleTotal.cost_usd_reported === undefined
        ? {}
        : { cost_usd_reported: roleTotal.cost_usd_reported }),
      ...(roleCost.cost_usd_computed === undefined
        ? {}
        : { cost_usd_computed: roleCost.cost_usd_computed }),
    };
  }
  return {
    usage_present: true,
    tokens_input: total.input_tokens,
    tokens_output: total.output_tokens,
    tokens_cache_read: total.cache_read_tokens,
    tokens_cache_creation: total.cache_creation_tokens,
    tokens_cache_creation_5m: total.cache_creation_5m_tokens,
    tokens_cache_creation_1h: total.cache_creation_1h_tokens,
    ...(total.cost_usd_reported === undefined
      ? {}
      : { cost_usd_reported: total.cost_usd_reported }),
    ...(computed.cost_usd_computed === undefined
      ? {}
      : { cost_usd_computed: computed.cost_usd_computed }),
    price_table_miss: computed.price_table_misses.length > 0 || table === undefined,
    ...(computed.price_table_misses.length === 0
      ? {}
      : { price_table_misses: computed.price_table_misses }),
    ...divergence,
    envelopes_missing_reported_cost: missingReportedCost,
    ...(relayCount === undefined ? {} : { relay_count: relayCount }),
    ...(relaysMissingUsage === undefined ? {} : { relays_missing_usage: relaysMissingUsage }),
    ...(relaysFailed === undefined ? {} : { relays_failed: relaysFailed }),
    ...(Object.keys(roles).length === 0 ? {} : { usage_by_role: roles }),
    models: total.models,
  };
}

// Divergence is relative to the LARGER of the two figures: a symmetric
// denominator keeps the check alive when the CLI reports $0 against a
// nonzero computed cost, where a reported-relative ratio would divide by
// zero and go silent. Two genuinely-zero figures agree (pct 0).
function costDivergence(
  reported: number | undefined,
  computed: number | undefined,
): JsonRecord {
  if (reported === undefined || computed === undefined) {
    return { cost_divergence_flag: false };
  }
  const denominator = Math.max(reported, computed);
  if (denominator <= 0) {
    return { cost_divergence_pct: 0, cost_divergence_flag: false };
  }
  const pct = Math.abs(computed - reported) / denominator;
  return {
    cost_divergence_pct: pct,
    cost_divergence_flag: pct > COST_DIVERGENCE_THRESHOLD,
  };
}

// Groups circuit relay records into the byRole map buildArmUsageScore takes.
export function groupRelaysByRole(
  relays: readonly RelayUsageRecord[],
): Map<string, UsageEnvelope[]> {
  const out = new Map<string, UsageEnvelope[]>();
  for (const relay of relays) {
    const list = out.get(relay.role) ?? [];
    list.push(relay.usage);
    out.set(relay.role, list);
  }
  return out;
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}
