import { join } from 'node:path';
import {
  HISTORY_AUTHORITY_NOTICE,
  type HistoryMemoryEffectV1 as HistoryMemoryEffect,
  HistoryMemoryEffectV1,
  type HistoryMemoryMergeV1,
  type MemoryEffectArmV1,
  type MemoryEffectComparisonV1,
  type MemoryEffectItemV1,
  type MemoryFlowContrastV1,
  type MemoryMergeEffectStatusV1,
  type MemoryMergeInputV1,
  type MemoryMergeOutcomeCountV1,
  type MemoryMergeRunLinkageV1,
  type RunEnvelopeOutcome,
} from '../../schemas/index.js';
import { writeJsonAtomic } from '../../shared/atomic-io.js';
import { isFailureOutcome } from '../../shared/outcome.js';
import { HISTORY_MEMORY_EFFECT_FILE, type HistoryPaths } from './indexer.js';
import { type BuildMemoryMergeReportOptions, buildMemoryMergeReport } from './memory-merge.js';

// The conservative, honesty-preserving defaults (Slice 2 D3/D5). MIN_ARM_SIZE is
// the floor distinguishing "literally one observation" from "a minimal repeated
// signal", not a claim of statistical adequacy. MARGIN must clear a near-unanimous
// split at the floor, so correlated_* is reachable only by a clean separation.
export const DEFAULT_MIN_ARM_SIZE = 2;
export const DEFAULT_MARGIN = 0.5;

export interface MemoryEffectGates {
  readonly minArmSize: number;
  readonly margin: number;
}

export interface BuildMemoryEffectReportOptions extends BuildMemoryMergeReportOptions {
  readonly minArmSize?: number;
  readonly margin?: number;
}

// The Slice 1 group_key for a linkage input: content_id when content-addressed,
// else the unresolved:<memory_input_id> fallback. Re-derived here (the linkage
// does not persist group_key) using the exact rule Slice 1's grouper used, so a
// cohort partitions on group_key — keeping distinct unhashed source docs distinct
// rather than merging every null-content item of a flow into one bucket.
function groupKeyOf(input: MemoryMergeInputV1): string {
  return input.content_id ?? `unresolved:${input.memory_input_id}`;
}

function groupsUsedBy(linkage: MemoryMergeRunLinkageV1): ReadonlySet<string> {
  return new Set(linkage.memory_inputs.map(groupKeyOf));
}

// Build one arm from a run set. Each run counts once (deduped by run_id). Rates
// are exact count/size; an empty arm carries rate 0 and empty arrays.
function buildArm(runs: readonly MemoryMergeRunLinkageV1[]): MemoryEffectArmV1 {
  const outcomeByRun = new Map<string, RunEnvelopeOutcome>();
  for (const run of runs) outcomeByRun.set(run.run_id, run.outcome);

  let complete = 0;
  let adverse = 0;
  let neutral = 0;
  const counts = new Map<RunEnvelopeOutcome, number>();
  for (const outcome of outcomeByRun.values()) {
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    if (outcome === 'complete') complete += 1;
    else if (isFailureOutcome(outcome)) adverse += 1;
    else neutral += 1; // needs_attention | handoff — counted, neither success nor failure
  }

  const size = outcomeByRun.size;
  const outcomeCounts: MemoryMergeOutcomeCountV1[] = [...counts.entries()]
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((left, right) => left.outcome.localeCompare(right.outcome));

  return {
    run_ids: [...outcomeByRun.keys()].sort(),
    size,
    complete_count: complete,
    adverse_count: adverse,
    neutral_count: neutral,
    outcome_counts: outcomeCounts,
    complete_rate: size === 0 ? 0 : complete / size,
    adverse_rate: size === 0 ? 0 : adverse / size,
  };
}

function fixed(value: number): string {
  return value.toFixed(2);
}

// The D5 verdict rule, self-contained and unit-testable in isolation. minArmSize
// is an explicit parameter (not a closed-over free variable). Evaluated in strict
// precedence order, so the result is a single enum value with no ambiguity.
export function classifyEffect(
  comparison: {
    readonly used_arm: {
      readonly size: number;
      readonly complete_rate: number;
      readonly adverse_rate: number;
    };
    readonly comparable_arm: {
      readonly size: number;
      readonly complete_rate: number;
      readonly adverse_rate: number;
    };
    readonly complete_rate_delta: number;
    readonly adverse_rate_delta: number;
  },
  margin: number,
  minArmSize: number,
): { effect_status: MemoryMergeEffectStatusV1; effect_note: string } {
  const { used_arm, comparable_arm, complete_rate_delta, adverse_rate_delta } = comparison;

  if (used_arm.size < minArmSize || comparable_arm.size < minArmSize) {
    return {
      effect_status: 'not_enough_data',
      effect_note: `min_arm_size gate: used arm (n=${used_arm.size}) or comparable arm (n=${comparable_arm.size}) is below the minimum arm size of ${minArmSize}; a verdict requires both arms to reach the floor.`,
    };
  }
  if (complete_rate_delta >= margin && adverse_rate_delta <= 0) {
    return {
      effect_status: 'correlated_positive',
      effect_note: `correlated_positive: the used arm closed complete ${fixed(complete_rate_delta)} more often (>= margin ${fixed(margin)}) and was no worse on aborts (adverse delta ${fixed(adverse_rate_delta)} <= 0).`,
    };
  }
  if (complete_rate_delta <= -margin || adverse_rate_delta >= margin) {
    return {
      effect_status: 'correlated_negative',
      effect_note: `correlated_negative: the used arm closed complete ${fixed(complete_rate_delta)} (<= -margin ${fixed(margin)}) or aborted ${fixed(adverse_rate_delta)} more (>= margin ${fixed(margin)}).`,
    };
  }
  return {
    effect_status: 'unresolved',
    effect_note: `unresolved: both arms reached the floor of ${minArmSize}, but the separation (complete delta ${fixed(complete_rate_delta)}, adverse delta ${fixed(adverse_rate_delta)}) is within the margin ${fixed(margin)}.`,
  };
}

function buildComparison(
  usedArm: MemoryEffectArmV1,
  comparableArm: MemoryEffectArmV1,
  margin: number,
  minArmSize: number,
): MemoryEffectComparisonV1 {
  const completeRateDelta = usedArm.complete_rate - comparableArm.complete_rate;
  const adverseRateDelta = usedArm.adverse_rate - comparableArm.adverse_rate;
  const { effect_status, effect_note } = classifyEffect(
    {
      used_arm: usedArm,
      comparable_arm: comparableArm,
      complete_rate_delta: completeRateDelta,
      adverse_rate_delta: adverseRateDelta,
    },
    margin,
    minArmSize,
  );
  return {
    used_arm: usedArm,
    comparable_arm: comparableArm,
    complete_rate_delta: completeRateDelta,
    adverse_rate_delta: adverseRateDelta,
    effect_status,
    effect_note,
  };
}

function countStatus(
  statuses: readonly MemoryMergeEffectStatusV1[],
  status: MemoryMergeEffectStatusV1,
): number {
  return statuses.filter((value) => value === status).length;
}

// The pure core. Builds (group_key, flow_id) cohorts and per-flow on/off cohorts
// from merge.linkages, classifies each via the D5 rule, rolls up the summary, and
// carries merge.warnings forward. No I/O. generated_at/runs_base are taken from
// the merge report so the effect report shares the merge's logical timestamp.
export function aggregateMemoryEffect(
  merge: HistoryMemoryMergeV1,
  gates: MemoryEffectGates,
): HistoryMemoryEffect {
  if (!(gates.margin > 0 && gates.margin <= 1)) {
    throw new Error(`margin must satisfy 0 < margin <= 1 (received ${gates.margin})`);
  }
  if (!(Number.isInteger(gates.minArmSize) && gates.minArmSize >= 1)) {
    throw new Error(`minArmSize must be an integer >= 1 (received ${gates.minArmSize})`);
  }

  // Group every linkage by its (narrowed) flow_id. A linkage missing flow_id is
  // skipped — a compile-time guard for the schema-optional field that the real
  // Slice 1 reader never trips (it always derives a flow_id), so it emits no
  // user-facing warning (an unreachable warning would be dead branch dressing).
  const runsByFlow = new Map<string, MemoryMergeRunLinkageV1[]>();
  for (const linkage of merge.linkages) {
    const flowId = linkage.flow_id;
    if (flowId === undefined) continue;
    const bucket = runsByFlow.get(flowId);
    if (bucket === undefined) runsByFlow.set(flowId, [linkage]);
    else bucket.push(linkage);
  }

  // Enrichment lookup: group_key -> representative kind/source_ref/content_id from
  // the Slice 1 memory_items (every used group has an item there).
  const enrichment = new Map<
    string,
    {
      content_id: string | null;
      kind?: MemoryEffectItemV1['kind'];
      source_ref?: MemoryEffectItemV1['source_ref'];
    }
  >();
  for (const item of merge.memory_items) {
    enrichment.set(item.group_key, {
      content_id: item.content_id,
      ...(item.kind === undefined ? {} : { kind: item.kind }),
      ...(item.source_ref === undefined ? {} : { source_ref: item.source_ref }),
    });
  }

  // Enumerate the (group_key, flow_id) cohorts: every group used by >=1 run of a
  // flow. Keyed with a NUL separator so the two parts cannot collide.
  const cohorts = new Map<string, { groupKey: string; flowId: string }>();
  for (const linkage of merge.linkages) {
    const flowId = linkage.flow_id;
    if (flowId === undefined || !linkage.memory_used) continue;
    for (const input of linkage.memory_inputs) {
      const groupKey = groupKeyOf(input);
      cohorts.set(`${groupKey}\u0000${flowId}`, { groupKey, flowId });
    }
  }

  const itemEffects: MemoryEffectItemV1[] = [];
  for (const { groupKey, flowId } of cohorts.values()) {
    const flowRuns = runsByFlow.get(flowId) ?? [];
    const usedRuns = flowRuns.filter((run) => groupsUsedBy(run).has(groupKey));
    const comparableRuns = flowRuns.filter((run) => !groupsUsedBy(run).has(groupKey));
    const comparison = buildComparison(
      buildArm(usedRuns),
      buildArm(comparableRuns),
      gates.margin,
      gates.minArmSize,
    );
    const enr = enrichment.get(groupKey);
    const contentId = enr ? enr.content_id : groupKey.startsWith('unresolved:') ? null : groupKey;
    itemEffects.push({
      content_id: contentId,
      group_key: groupKey,
      flow_id: flowId,
      ...(enr?.kind === undefined ? {} : { kind: enr.kind }),
      ...(enr?.source_ref === undefined ? {} : { source_ref: enr.source_ref }),
      comparison,
    });
  }
  itemEffects.sort(
    (left, right) =>
      left.group_key.localeCompare(right.group_key) || left.flow_id.localeCompare(right.flow_id),
  );

  const flowContrasts: MemoryFlowContrastV1[] = [];
  for (const [flowId, flowRuns] of [...runsByFlow.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    const onRuns = flowRuns.filter((run) => run.memory_used);
    if (onRuns.length === 0) continue;
    const offRuns = flowRuns.filter((run) => !run.memory_used);
    const comparison = buildComparison(
      buildArm(onRuns),
      buildArm(offRuns),
      gates.margin,
      gates.minArmSize,
    );
    flowContrasts.push({ flow_id: flowId, comparison });
  }

  const itemStatuses = itemEffects.map((item) => item.comparison.effect_status);
  const contrastStatuses = flowContrasts.map((contrast) => contrast.comparison.effect_status);

  return HistoryMemoryEffectV1.parse({
    api_version: 'history-memory-effect-v1',
    schema_version: 1,
    generated_at: merge.generated_at,
    runs_base: merge.runs_base,
    authority_notice: HISTORY_AUTHORITY_NOTICE,
    min_arm_size: gates.minArmSize,
    margin: gates.margin,
    source_run_count: merge.run_count,
    source_envelope_count: merge.envelope_count,
    source_memory_run_count: merge.memory_run_count,
    item_effects: itemEffects,
    flow_contrasts: flowContrasts,
    summary: {
      items_total: itemEffects.length,
      items_not_enough_data: countStatus(itemStatuses, 'not_enough_data'),
      items_unresolved: countStatus(itemStatuses, 'unresolved'),
      items_correlated_positive: countStatus(itemStatuses, 'correlated_positive'),
      items_correlated_negative: countStatus(itemStatuses, 'correlated_negative'),
      flow_contrasts_total: flowContrasts.length,
      flow_contrasts_not_enough_data: countStatus(contrastStatuses, 'not_enough_data'),
      flow_contrasts_unresolved: countStatus(contrastStatuses, 'unresolved'),
      flow_contrasts_correlated_positive: countStatus(contrastStatuses, 'correlated_positive'),
      flow_contrasts_correlated_negative: countStatus(contrastStatuses, 'correlated_negative'),
    },
    warnings: merge.warnings,
  });
}

// Rebuild the Slice 1 merge report in-process and aggregate it, so a stale or
// absent persisted memory-merge.v1.json cannot desync the two reports.
export function buildMemoryEffectReport(
  options: BuildMemoryEffectReportOptions = {},
): HistoryMemoryEffect {
  const { minArmSize, margin, ...mergeOptions } = options;
  const merge = buildMemoryMergeReport(mergeOptions);
  return aggregateMemoryEffect(merge, {
    minArmSize: minArmSize ?? DEFAULT_MIN_ARM_SIZE,
    margin: margin ?? DEFAULT_MARGIN,
  });
}

// Persist under <index-dir>/memory-effect.v1.json (atomic tmp+rename, re-parsed
// to validate before the rename commits) — identical discipline to Slice 1.
export function writeMemoryEffectReport(report: HistoryMemoryEffect, paths: HistoryPaths): string {
  const outPath = join(paths.indexDir, HISTORY_MEMORY_EFFECT_FILE);
  writeJsonAtomic(outPath, report, {
    validate: (raw) => HistoryMemoryEffectV1.parse(JSON.parse(raw) as unknown),
  });
  return outPath;
}
