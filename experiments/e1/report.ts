// E1 report rendering. Pure: turns an `ExperimentComparison` into the JSON
// artifact and the one-page markdown side-by-side. No IO.

import type { ExperimentComparison, VariantCost, VariantRecord } from './types.ts';

export function renderJson(comparison: ExperimentComparison): string {
  return `${JSON.stringify(comparison, null, 2)}\n`;
}

function costCell(cost: VariantCost): string {
  if (cost.unit === 'none') return 'n/a (no usage)';
  const suffix = cost.partial ? ' *(partial)*' : '';
  if (cost.unit === 'usd') return `$${cost.total.toFixed(2)}${suffix}`;
  return `${cost.total} tok${suffix}`;
}

function perRoleCell(cost: VariantCost): string {
  const roles = Object.keys(cost.per_role);
  if (roles.length === 0) return '—';
  const unit = cost.unit === 'usd' ? '$' : '';
  return roles
    .map((role) => {
      const value = cost.per_role[role] ?? 0;
      return `${role} ${unit}${cost.unit === 'usd' ? value.toFixed(2) : value}`;
    })
    .join('<br>');
}

function verdictCell(record: VariantRecord): string {
  if (record.quality_signal.false_fixed) return '**fail** — false-fix ⚠️';
  if (record.verdict === 'pass') return 'pass ✅';
  if (record.verdict === 'degraded') return 'degraded';
  return '**fail**';
}

function seamCell(record: VariantRecord): string {
  if (record.failure_seam === null) return '—';
  const { step_id, contract, reason } = record.failure_seam;
  return `\`${step_id}\` / \`${contract}\`: ${reason}`;
}

function evidenceCell(record: VariantRecord): string {
  if (record.evidence_refs.length === 0) return '—';
  return `${record.evidence_refs.length} refs`;
}

export function renderMarkdown(comparison: ExperimentComparison): string {
  const holistic = comparison.variants.find((v) => v.variant_id === 'holistic');
  const separated = comparison.variants.find((v) => v.variant_id === 'separated');
  if (holistic === undefined || separated === undefined) {
    throw new Error('renderMarkdown requires both a holistic and a separated variant');
  }

  const rows: Array<[string, (r: VariantRecord) => string]> = [
    ['flow', (r) => `\`${r.flow_id}\``],
    ['verdict (vs done_when)', verdictCell],
    ['flow self-claim', (r) => (r.quality_signal.flow_claimed_done ? 'claimed done' : 'no claim')],
    ['cost (total)', (r) => costCell(r.cost)],
    ['cost (per role)', (r) => perRoleCell(r.cost)],
    ['steps', (r) => String(r.steps)],
    ['wall time', (r) => `${(r.wall_time_ms / 1000).toFixed(1)}s`],
    ['checks failed', (r) => String(r.quality_signal.checks_failed ?? '—')],
    ['evidence', evidenceCell],
    ['changed files', (r) => (r.changed_files.length > 0 ? r.changed_files.join('<br>') : '—')],
    ['failure seam', seamCell],
  ];

  const header = `| metric | holistic (\`${holistic.flow_id}\`) | separated (\`${separated.flow_id}\`) |`;
  const divider = '| --- | --- | --- |';
  const body = rows
    .map(([label, cell]) => `| ${label} | ${cell(holistic)} | ${cell(separated)} |`)
    .join('\n');

  const ratioLine =
    comparison.delta.cost_ratio_basis === 'unavailable'
      ? 'cost ratio: **n/a** (an arm recorded no usage, or the meters differ)'
      : `cost ratio (separated / holistic): **${comparison.delta.cost_ratio.toFixed(2)}x** (${comparison.delta.cost_ratio_basis})`;

  const modeBanner =
    comparison.mode === 'fixture'
      ? '> **Mode: fixture** — rendered from recorded/synthetic run folders. No model budget was spent. Numbers illustrate the measurement loop; they are not a live result.'
      : '> **Mode: live** — produced from real flow runs that spent model budget.';

  return `# E1 comparison — one task, two shapes

${modeBanner}

- **task:** \`${comparison.task_id}\`
- **base ref:** \`${comparison.base_ref}\`
- **generated:** ${comparison.generated_at}
- **done_when:** ${comparison.done_when}

## Side by side

${header}
${divider}
${body}

## Delta

- verdict match: **${comparison.delta.verdict_match ? 'yes' : 'no'}**
- ${ratioLine}
- ${comparison.delta.notes}
`;
}
