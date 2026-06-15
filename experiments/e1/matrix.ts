// E1 variant matrix — generalize "one task, two shapes" to a {tasks × variants}
// grid. The single comparison (compare.ts) contrasts exactly two grains on one
// task; the matrix is the reusable shape behind the whole exploration program:
// many tasks, many variant columns, one comparable cell each, a baseline-relative
// delta per task, and a cross-variant rollup.
//
// Pure aggregation over the same `VariantRecord` the single-pair lane already
// produces — no clock, no IO — so the fixture lane proves it without spending a
// cent. `generated_at` is supplied by the caller to stay deterministic.

import { costRatio } from './compare.ts';
import type { ComparisonDelta, ExperimentComparison, VariantRecord, Verdict } from './types.ts';

// A matrix column: a free-form variant label bound to a flow + extra args. The
// canonical grains ('holistic' = fix, 'separated' = build --depth high) are the
// two-column case; the grid accepts any labels, so a later experiment adds a
// variant by appending a spec rather than touching the aggregator.
export interface MatrixVariantSpec {
  readonly variant_label: string;
  readonly flow_id: string;
  readonly extra_args: readonly string[];
}

// One run placed at a grid coordinate. `record` is the same normalized record the
// single-pair lane emits; `variant_label` is the matrix column (it equals
// record.variant_id for the canonical grains, but the matrix does not require
// that, so >2 columns are expressible).
export interface MatrixCell {
  readonly task_id: string;
  readonly variant_label: string;
  readonly record: VariantRecord;
}

// One non-baseline column's standing on a task, relative to that task's baseline
// column. `cost_ratio_vs_baseline` is other/baseline by total spend, meaningful
// only when `cost_ratio_basis` is a real meter.
export interface MatrixVariantDelta {
  readonly variant_label: string;
  readonly verdict: Verdict;
  readonly false_fixed: boolean;
  readonly checkpoint_blocked: boolean;
  readonly cost_ratio_vs_baseline: number;
  readonly cost_ratio_basis: ComparisonDelta['cost_ratio_basis'];
}

// One row of the grid: a task, the cells across every column, and the deltas of
// each non-baseline column against the baseline. `all_agree` is true when every
// column reached the same verdict (the boring, uninteresting outcome — a row
// where it is false is where the experiment found something).
export interface MatrixTaskRow {
  readonly task_id: string;
  readonly baseline_label: string;
  readonly cells: readonly MatrixCell[];
  readonly variant_deltas: readonly MatrixVariantDelta[];
  readonly all_agree: boolean;
}

// A column's standing across every task it ran. Counts are honest tallies; the
// mean cost is reported with its meter, and `cost_meter` is 'mixed' when the
// column's runs metered in different units (so the mean is not summed across
// incomparable meters).
export interface MatrixVariantSummary {
  readonly variant_label: string;
  readonly flow_id: string;
  readonly runs: number;
  readonly passed: number;
  readonly degraded: number;
  readonly failed: number;
  readonly false_fixed: number;
  readonly checkpoint_blocked: number;
  readonly mean_cost: number;
  readonly cost_meter: 'usd' | 'tokens' | 'none' | 'mixed';
  readonly mean_steps: number;
}

export interface ExperimentMatrix {
  readonly schema_version: 1;
  readonly mode: 'live' | 'fixture';
  readonly generated_at: string;
  readonly tasks: readonly string[];
  readonly variants: readonly string[];
  readonly rows: readonly MatrixTaskRow[];
  readonly summaries: readonly MatrixVariantSummary[];
}

export interface MatrixMeta {
  readonly mode: 'live' | 'fixture';
  readonly generated_at: string;
}

// A run is checkpoint-blocked when the flow paused for a human and never
// reached a terminal result. The engine surfaces this as a non-complete process
// outcome of `checkpoint_waiting`, which the extractor carries onto
// `quality_signal.flow_outcome`. `build` halts here under headless execution;
// the checkpoint-aware runner answers it with `circuit resume
// --checkpoint-choice continue`, so a terminal record should never carry this
// outcome. It remaining set means a resume failed to clear the gate.
function isCheckpointBlocked(record: VariantRecord): boolean {
  return record.quality_signal.flow_outcome === 'checkpoint_waiting';
}

// Keyed on the cell's column label (not the record's grain id), so two columns
// that share a flow but differ in args still get distinct deltas.
function variantDelta(baseline: VariantRecord, other: MatrixCell): MatrixVariantDelta {
  const { ratio, basis } = costRatio(baseline.cost, other.record.cost);
  return {
    variant_label: other.variant_label,
    verdict: other.record.verdict,
    false_fixed: other.record.quality_signal.false_fixed,
    checkpoint_blocked: isCheckpointBlocked(other.record),
    cost_ratio_vs_baseline: ratio,
    cost_ratio_basis: basis,
  };
}

// Build one row from a task's cells. The baseline is the first column in
// `variantOrder` that the task actually ran; deltas are every other column
// against it.
function buildRow(
  taskId: string,
  cells: readonly MatrixCell[],
  variantOrder: readonly string[],
): MatrixTaskRow {
  const ordered = variantOrder
    .map((label) => cells.find((cell) => cell.variant_label === label))
    .filter((cell): cell is MatrixCell => cell !== undefined);
  if (ordered.length === 0) {
    throw new Error(`matrix row for task '${taskId}' has no cells`);
  }

  const baseline = ordered[0] as MatrixCell;
  const variantDeltas = ordered.slice(1).map((cell) => variantDelta(baseline.record, cell));
  const verdicts = new Set(ordered.map((cell) => cell.record.verdict));

  return {
    task_id: taskId,
    baseline_label: baseline.variant_label,
    cells: ordered,
    variant_deltas: variantDeltas,
    all_agree: verdicts.size === 1,
  };
}

function summariseVariant(
  spec: MatrixVariantSpec,
  cells: readonly MatrixCell[],
): MatrixVariantSummary {
  const mine = cells.filter((cell) => cell.variant_label === spec.variant_label);
  const records = mine.map((cell) => cell.record);
  const runs = records.length;

  const meters = new Set(records.map((record) => record.cost.unit));
  const meteredUnits = [...meters].filter((unit) => unit !== 'none');
  let costMeter: MatrixVariantSummary['cost_meter'];
  let meanCost = 0;
  if (meteredUnits.length === 0) {
    costMeter = 'none';
  } else if (meteredUnits.length === 1) {
    costMeter = meteredUnits[0] as 'usd' | 'tokens';
    const metered = records.filter((record) => record.cost.unit === costMeter);
    meanCost = metered.reduce((sum, record) => sum + record.cost.total, 0) / metered.length;
  } else {
    // The column metered in more than one unit across its runs; a single mean
    // would sum incomparable meters, so report 'mixed' and leave it at zero.
    costMeter = 'mixed';
  }

  const meanSteps = runs === 0 ? 0 : records.reduce((sum, record) => sum + record.steps, 0) / runs;

  return {
    variant_label: spec.variant_label,
    flow_id: spec.flow_id,
    runs,
    passed: records.filter((record) => record.verdict === 'pass').length,
    degraded: records.filter((record) => record.verdict === 'degraded').length,
    failed: records.filter((record) => record.verdict === 'fail').length,
    false_fixed: records.filter((record) => record.quality_signal.false_fixed).length,
    checkpoint_blocked: records.filter((record) => isCheckpointBlocked(record)).length,
    mean_cost: meanCost,
    cost_meter: costMeter,
    mean_steps: meanSteps,
  };
}

// Assemble a full matrix from a flat list of cells and the column specs (whose
// order fixes the column order and the per-row baseline). Task row order follows
// first appearance in `cells`.
export function buildMatrix(
  specs: readonly MatrixVariantSpec[],
  cells: readonly MatrixCell[],
  meta: MatrixMeta,
): ExperimentMatrix {
  if (specs.length < 2) {
    throw new Error(`a matrix needs at least two variant columns; got ${specs.length}`);
  }

  const variantOrder = specs.map((spec) => spec.variant_label);
  const taskOrder: string[] = [];
  for (const cell of cells) {
    if (!taskOrder.includes(cell.task_id)) taskOrder.push(cell.task_id);
  }
  if (taskOrder.length === 0) {
    throw new Error('a matrix needs at least one task with cells');
  }

  const rows = taskOrder.map((taskId) =>
    buildRow(
      taskId,
      cells.filter((cell) => cell.task_id === taskId),
      variantOrder,
    ),
  );
  const summaries = specs.map((spec) => summariseVariant(spec, cells));

  return {
    schema_version: 1,
    mode: meta.mode,
    generated_at: meta.generated_at,
    tasks: taskOrder,
    variants: variantOrder,
    rows,
    summaries,
  };
}

// Project a single-pair `ExperimentComparison` (what the live two-variant runner
// emits per task) into matrix cells. Pure, so the live matrix runner is just a
// loop over tasks around this and `buildMatrix`. The variant label is the
// record's own grain id.
export function comparisonToCells(comparison: ExperimentComparison): MatrixCell[] {
  return comparison.variants.map((record) => ({
    task_id: comparison.task_id,
    variant_label: record.variant_id,
    record,
  }));
}
