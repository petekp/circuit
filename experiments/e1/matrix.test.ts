import { describe, expect, it } from 'vitest';
import { renderFixtureMatrix } from './matrix-fixture.ts';
import { renderMatrixJson, renderMatrixMarkdown } from './matrix-report.ts';
import {
  type ExperimentMatrix,
  type MatrixCell,
  type MatrixVariantSpec,
  buildMatrix,
  comparisonToCells,
} from './matrix.ts';
import type { ExperimentComparison, VariantCost, VariantId, VariantRecord } from './types.ts';

function cost(total: number, unit: VariantCost['unit'] = 'usd'): VariantCost {
  return { per_role: { implementer: total }, total, unit, partial: false };
}

function record(
  overrides: Partial<VariantRecord> & Pick<VariantRecord, 'variant_id'>,
): VariantRecord {
  return {
    flow_id: overrides.variant_id === 'holistic' ? 'fix' : 'build',
    worktree_path: '/tmp/x',
    verdict: 'pass',
    quality_signal: {
      objective_passed: true,
      flow_claimed_done: true,
      false_fixed: false,
      flow_outcome: null,
      run_verdict: 'accept',
      checks_evaluated: 1,
      checks_failed: 0,
      missing_evidence_count: 0,
    },
    evidence_refs: [],
    cost: cost(1),
    steps: 1,
    wall_time_ms: 1000,
    failure_seam: null,
    changed_files: [],
    ...overrides,
  };
}

function cell(
  taskId: string,
  variantId: VariantId,
  overrides: Partial<VariantRecord> = {},
): MatrixCell {
  return {
    task_id: taskId,
    variant_label: variantId,
    record: record({ variant_id: variantId, ...overrides }),
  };
}

const SPECS: readonly MatrixVariantSpec[] = [
  { variant_label: 'holistic', flow_id: 'fix', extra_args: [] },
  { variant_label: 'separated', flow_id: 'build', extra_args: ['--depth', 'high'] },
];

const META = { mode: 'fixture' as const, generated_at: '2026-06-14T00:00:00.000Z' };

describe('buildMatrix', () => {
  it('lays out tasks (row order = first appearance) and variants (spec order)', () => {
    const matrix = buildMatrix(
      SPECS,
      [
        cell('task-b', 'holistic'),
        cell('task-b', 'separated'),
        cell('task-a', 'separated'),
        cell('task-a', 'holistic'),
      ],
      META,
    );
    expect(matrix.tasks).toEqual(['task-b', 'task-a']);
    expect(matrix.variants).toEqual(['holistic', 'separated']);
    expect(matrix.rows).toHaveLength(2);
    // Cells within a row are reordered to the spec/column order.
    expect(matrix.rows[0]?.cells.map((c) => c.variant_label)).toEqual(['holistic', 'separated']);
  });

  it('computes a baseline-relative cost ratio per non-baseline column', () => {
    const matrix = buildMatrix(
      SPECS,
      [cell('t', 'holistic', { cost: cost(0.5) }), cell('t', 'separated', { cost: cost(2.0) })],
      META,
    );
    const row = matrix.rows[0];
    expect(row?.baseline_label).toBe('holistic');
    expect(row?.variant_deltas).toHaveLength(1);
    expect(row?.variant_deltas[0]?.cost_ratio_vs_baseline).toBeCloseTo(4, 5);
    expect(row?.variant_deltas[0]?.cost_ratio_basis).toBe('usd');
  });

  it('marks a row that disagrees across variants (all_agree false)', () => {
    const matrix = buildMatrix(
      SPECS,
      [cell('t', 'holistic', { verdict: 'pass' }), cell('t', 'separated', { verdict: 'fail' })],
      META,
    );
    expect(matrix.rows[0]?.all_agree).toBe(false);
  });

  it('flags a checkpoint-blocked cell via flow_outcome', () => {
    const blocked = cell('t', 'separated', {
      verdict: 'degraded',
      quality_signal: {
        ...record({ variant_id: 'separated' }).quality_signal,
        objective_passed: false,
        flow_claimed_done: false,
        flow_outcome: 'checkpoint_waiting',
      },
      cost: { per_role: {}, total: 0, unit: 'none', partial: true },
    });
    const matrix = buildMatrix(SPECS, [cell('t', 'holistic'), blocked], META);
    expect(matrix.rows[0]?.variant_deltas[0]?.checkpoint_blocked).toBe(true);
    const separated = matrix.summaries.find((s) => s.variant_label === 'separated');
    expect(separated?.checkpoint_blocked).toBe(1);
    // An unmetered ('none') run leaves the column's cost meter at 'none'.
    expect(separated?.cost_meter).toBe('none');
  });

  it('rolls up per-variant tallies across multiple tasks', () => {
    const matrix = buildMatrix(
      SPECS,
      [
        cell('t1', 'holistic', { cost: cost(1) }),
        cell('t1', 'separated', { verdict: 'fail', cost: cost(2) }),
        cell('t2', 'holistic', { cost: cost(3) }),
        cell('t2', 'separated', { verdict: 'pass', cost: cost(4) }),
      ],
      META,
    );
    const holistic = matrix.summaries.find((s) => s.variant_label === 'holistic');
    const separated = matrix.summaries.find((s) => s.variant_label === 'separated');
    expect(holistic?.runs).toBe(2);
    expect(holistic?.passed).toBe(2);
    expect(holistic?.mean_cost).toBeCloseTo(2, 5); // (1 + 3) / 2
    expect(separated?.passed).toBe(1);
    expect(separated?.failed).toBe(1);
    expect(separated?.mean_cost).toBeCloseTo(3, 5); // (2 + 4) / 2
  });

  it('reports a mixed cost meter when a column metered in different units', () => {
    const matrix = buildMatrix(
      SPECS,
      [
        cell('t1', 'holistic', { cost: cost(1, 'usd') }),
        cell('t1', 'separated', { cost: cost(1, 'usd') }),
        cell('t2', 'holistic', { cost: cost(5000, 'tokens') }),
        cell('t2', 'separated', { cost: cost(1, 'usd') }),
      ],
      META,
    );
    const holistic = matrix.summaries.find((s) => s.variant_label === 'holistic');
    expect(holistic?.cost_meter).toBe('mixed');
    expect(holistic?.mean_cost).toBe(0);
  });

  it('rejects a matrix with fewer than two columns', () => {
    expect(() =>
      buildMatrix([SPECS[0] as MatrixVariantSpec], [cell('t', 'holistic')], META),
    ).toThrow(/at least two/);
  });

  it('rejects a matrix with no cells', () => {
    expect(() => buildMatrix(SPECS, [], META)).toThrow(/at least one task/);
  });
});

describe('comparisonToCells', () => {
  it('projects a single-pair comparison into one cell per variant', () => {
    const comparison: ExperimentComparison = {
      schema_version: 1,
      task_id: 'wrap',
      done_when: 'objective met',
      base_ref: 'base',
      mode: 'live',
      generated_at: META.generated_at,
      variants: [record({ variant_id: 'holistic' }), record({ variant_id: 'separated' })],
      delta: { verdict_match: true, cost_ratio: 1, cost_ratio_basis: 'usd', notes: '' },
    };
    const cells = comparisonToCells(comparison);
    expect(cells).toHaveLength(2);
    expect(cells.every((c) => c.task_id === 'wrap')).toBe(true);
    expect(cells.map((c) => c.variant_label)).toEqual(['holistic', 'separated']);
  });
});

describe('renderFixtureMatrix', () => {
  let matrix: ExperimentMatrix;

  it('builds the 1 task × 2 variant grid from bundled fixtures', () => {
    matrix = renderFixtureMatrix(META.generated_at);
    expect(matrix.tasks).toEqual(['heldout-wrap-index']);
    expect(matrix.variants).toEqual(['holistic', 'separated']);
    expect(matrix.rows).toHaveLength(1);
  });

  it('surfaces the recorded verdict disagreement (holistic pass vs separated false-fix)', () => {
    matrix = renderFixtureMatrix(META.generated_at);
    const row = matrix.rows[0];
    expect(row?.all_agree).toBe(false);
    const separated = row?.cells.find((c) => c.variant_label === 'separated');
    expect(separated?.record.quality_signal.false_fixed).toBe(true);
  });

  it('renders a markdown grid and round-trips through JSON', () => {
    matrix = renderFixtureMatrix(META.generated_at);
    const md = renderMatrixMarkdown(matrix);
    expect(md).toContain('E1 variant matrix');
    expect(md).toContain('heldout-wrap-index');
    expect(md).toContain('false-fix');
    expect(md).toContain('⚑'); // the disagreement marker
    const parsed = JSON.parse(renderMatrixJson(matrix)) as ExperimentMatrix;
    expect(parsed.schema_version).toBe(1);
    expect(parsed.summaries).toHaveLength(2);
  });
});
