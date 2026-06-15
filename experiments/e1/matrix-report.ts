// E1 matrix report rendering. Pure: turns an `ExperimentMatrix` into the JSON
// artifact and a one-page markdown grid (tasks down, variants across) plus a
// per-variant rollup. No IO.

import type {
  ExperimentMatrix,
  MatrixCell,
  MatrixTaskRow,
  MatrixVariantSummary,
} from './matrix.ts';

export function renderMatrixJson(matrix: ExperimentMatrix): string {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

function verdictCell(cell: MatrixCell | undefined): string {
  if (cell === undefined) return '·';
  const record = cell.record;
  if (record.quality_signal.false_fixed) return 'fail (false-fix ⚠️)';
  if (record.quality_signal.flow_outcome === 'checkpoint_waiting') return 'degraded (checkpoint)';
  if (record.verdict === 'pass') return 'pass ✅';
  if (record.verdict === 'degraded') return 'degraded';
  return 'fail';
}

function costSuffix(cell: MatrixCell | undefined): string {
  if (cell === undefined) return '';
  const cost = cell.record.cost;
  if (cost.unit === 'none') return '';
  if (cost.unit === 'usd') return ` · $${cost.total.toFixed(2)}`;
  return ` · ${cost.total} tok`;
}

function gridRow(row: MatrixTaskRow, variants: readonly string[]): string {
  const cells = variants.map((label) => {
    const cell = row.cells.find((candidate) => candidate.variant_label === label);
    return `${verdictCell(cell)}${costSuffix(cell)}`;
  });
  const flag = row.all_agree ? '' : ' ⚑';
  return `| \`${row.task_id}\`${flag} | ${cells.join(' | ')} |`;
}

function meanCostText(summary: MatrixVariantSummary): string {
  if (summary.cost_meter === 'none') return 'n/a';
  if (summary.cost_meter === 'mixed') return 'mixed meters';
  if (summary.cost_meter === 'usd') return `$${summary.mean_cost.toFixed(2)}`;
  return `${Math.round(summary.mean_cost)} tok`;
}

function summaryRow(summary: MatrixVariantSummary): string {
  const honesty = summary.false_fixed > 0 ? ` (${summary.false_fixed} false-fix)` : '';
  const blocked =
    summary.checkpoint_blocked > 0 ? ` (${summary.checkpoint_blocked} checkpoint)` : '';
  return `| \`${summary.variant_label}\` (\`${summary.flow_id}\`) | ${summary.passed}/${summary.runs} | ${summary.degraded}${blocked} | ${summary.failed}${honesty} | ${meanCostText(summary)} | ${summary.mean_steps.toFixed(1)} |`;
}

export function renderMatrixMarkdown(matrix: ExperimentMatrix): string {
  const modeBanner =
    matrix.mode === 'fixture'
      ? '> **Mode: fixture** — rendered from recorded/synthetic run folders. No model budget was spent.'
      : '> **Mode: live** — produced from real flow runs that spent model budget.';

  const gridHeader = `| task | ${matrix.variants.map((label) => `${label}`).join(' | ')} |`;
  const gridDivider = `| --- | ${matrix.variants.map(() => '---').join(' | ')} |`;
  const gridBody = matrix.rows.map((row) => gridRow(row, matrix.variants)).join('\n');

  const summaryHeader = '| variant | pass rate | degraded | failed | mean cost | mean steps |';
  const summaryDivider = '| --- | --- | --- | --- | --- | --- |';
  const summaryBody = matrix.summaries.map(summaryRow).join('\n');

  const disagreements = matrix.rows.filter((row) => !row.all_agree).length;
  const agreementLine =
    disagreements === 0
      ? 'All tasks agreed across variants (no grain difference surfaced).'
      : `${disagreements} of ${matrix.rows.length} task(s) disagreed across variants (⚑) — where grain mattered.`;

  return `# E1 variant matrix — ${matrix.tasks.length} task(s) × ${matrix.variants.length} variant(s)

${modeBanner}

- **generated:** ${matrix.generated_at}
- **tasks:** ${matrix.tasks.map((task) => `\`${task}\``).join(', ')}
- **variants:** ${matrix.variants.map((variant) => `\`${variant}\``).join(', ')}

## Grid (verdict vs done_when · cost)

${gridHeader}
${gridDivider}
${gridBody}

${agreementLine}

## Per-variant rollup

${summaryHeader}
${summaryDivider}
${summaryBody}
`;
}
