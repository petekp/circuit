// E1 comparison + delta. Pure functions over two normalized `VariantRecord`s.
// No clock, no IO — `generated_at` is supplied by the caller so this stays
// deterministic and testable.

import type { ComparisonDelta, ExperimentComparison, VariantCost, VariantRecord } from './types.ts';

export interface ComparisonMeta {
  readonly task_id: string;
  readonly done_when: string;
  readonly base_ref: string;
  readonly mode: 'live' | 'fixture';
  readonly generated_at: string;
}

// Cost is only divisible when both arms metered the same way and the
// denominator is non-zero. A usage-less arm (`none`) or a unit mismatch makes
// the ratio meaningless — say so rather than printing a fake number.
//
// Baseline-relative: `ratio` is `other.total / baseline.total`. Exported so the
// variant matrix (matrix.ts) reuses the exact same "when is a cost ratio
// meaningful" rule rather than re-deriving it.
export function costRatio(
  baseline: VariantCost,
  other: VariantCost,
): { ratio: number; basis: ComparisonDelta['cost_ratio_basis'] } {
  if (
    baseline.unit === other.unit &&
    (baseline.unit === 'usd' || baseline.unit === 'tokens') &&
    baseline.total > 0
  ) {
    return { ratio: other.total / baseline.total, basis: baseline.unit };
  }
  return { ratio: 0, basis: 'unavailable' };
}

function verdictPhrase(record: VariantRecord): string {
  if (record.quality_signal.false_fixed) return 'fail (false-fix: claimed done, objective fails)';
  return record.verdict;
}

function costPhrase(cost: VariantCost): string {
  if (cost.unit === 'none') return 'no usage recorded';
  if (cost.unit === 'usd') return `$${cost.total.toFixed(2)}${cost.partial ? ' (partial)' : ''}`;
  return `${cost.total} tokens${cost.partial ? ' (partial)' : ''}`;
}

export function computeDelta(holistic: VariantRecord, separated: VariantRecord): ComparisonDelta {
  const { ratio, basis } = costRatio(holistic.cost, separated.cost);
  const verdictMatch = holistic.verdict === separated.verdict;

  const ratioNote =
    basis === 'unavailable'
      ? 'cost ratio unavailable (an arm recorded no usage or the meters differ)'
      : `separated cost ${ratio.toFixed(2)}x holistic (${basis})`;

  const honesty: string[] = [];
  if (holistic.quality_signal.false_fixed) honesty.push('holistic false-fixed');
  if (separated.quality_signal.false_fixed) honesty.push('separated false-fixed');

  const notes = [
    `holistic (${holistic.flow_id}): ${verdictPhrase(holistic)} at ${costPhrase(holistic.cost)} in ${holistic.steps} steps`,
    `separated (${separated.flow_id}): ${verdictPhrase(separated)} at ${costPhrase(separated.cost)} in ${separated.steps} steps`,
    ratioNote,
    ...(honesty.length > 0 ? [honesty.join('; ')] : []),
  ].join('. ');

  return {
    verdict_match: verdictMatch,
    cost_ratio: ratio,
    cost_ratio_basis: basis,
    notes: `${notes}.`,
  };
}

function findVariant(
  records: readonly VariantRecord[],
  variantId: VariantRecord['variant_id'],
): VariantRecord {
  const found = records.find((record) => record.variant_id === variantId);
  if (found === undefined) {
    throw new Error(`comparison requires a '${variantId}' variant; none was provided`);
  }
  return found;
}

export function compareVariants(
  records: readonly VariantRecord[],
  meta: ComparisonMeta,
): ExperimentComparison {
  const holistic = findVariant(records, 'holistic');
  const separated = findVariant(records, 'separated');

  return {
    schema_version: 1,
    task_id: meta.task_id,
    done_when: meta.done_when,
    base_ref: meta.base_ref,
    mode: meta.mode,
    generated_at: meta.generated_at,
    // Stable order: holistic first, separated second.
    variants: [holistic, separated],
    delta: computeDelta(holistic, separated),
  };
}
