import { card, verdictBanner } from '../../../shared/html/components.js';
import { escapeHtml, renderPage } from '../../../shared/html/page.js';
import type { HtmlProjector } from '../../../shared/html/projector.js';
import { ReviewResult, type ReviewResult as ReviewResultValue } from '../reports.js';

function severityIntent(severity: string): 'negative' | 'attention' | 'info' {
  if (severity === 'critical' || severity === 'high') return 'negative';
  if (severity === 'medium') return 'attention';
  return 'info';
}

function findingList(findings: ReviewResultValue['findings']): string {
  if (findings.length === 0) return '<p class="summary">No actionable findings.</p>';
  const items = findings
    .map((finding) => {
      const refs =
        finding.file_refs.length === 0
          ? ''
          : ` <span class="chip">${escapeHtml(finding.file_refs.join(', '))}</span>`;
      return `<li><strong>${escapeHtml(finding.severity.toUpperCase())}</strong>: ${escapeHtml(finding.text)}${refs}</li>`;
    })
    .join('');
  return `<ul class="tradeoffs">${items}</ul>`;
}

function stringList(items: readonly string[]): string {
  if (items.length === 0) return '<p class="summary">None.</p>';
  return `<ul class="tradeoffs">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function warningList(warnings: ReviewResultValue['evidence_warnings']): string {
  if (warnings.length === 0) return '<p class="summary">No evidence warnings.</p>';
  return `<ul class="tradeoffs">${warnings
    .map((warning) => {
      const path = warning.path === undefined ? '' : ` (${warning.path})`;
      return `<li><strong>${escapeHtml(warning.kind)}</strong>${escapeHtml(path)}: ${escapeHtml(warning.message)}</li>`;
    })
    .join('')}</ul>`;
}

function evidenceSummary(report: ReviewResultValue): string {
  const evidence = report.evidence_summary;
  if (evidence === undefined) return '<p class="summary">No evidence summary was recorded.</p>';
  if (evidence.kind === 'unavailable') {
    return `<p class="summary">${escapeHtml(evidence.message)}</p>`;
  }
  const sampled = `${evidence.untracked_files_sampled}/${evidence.untracked_file_count}`;
  const truncated = evidence.untracked_files_truncated ? 'yes' : 'no';
  return `<ul class="tradeoffs">
    <li>Untracked content policy: ${escapeHtml(evidence.untracked_content_policy)}</li>
    <li>Untracked files sampled: ${escapeHtml(sampled)}</li>
    <li>Untracked file list truncated: ${escapeHtml(truncated)}</li>
  </ul>`;
}

function shouldRenderHtml(report: ReviewResultValue): boolean {
  return (
    report.findings.length > 0 ||
    report.evidence_warnings.length > 0 ||
    report.confidence_limitations.length > 0
  );
}

export const reviewResultProjector: HtmlProjector = (ctx) => {
  const parsed = ReviewResult.safeParse(ctx.flowReport);
  if (!parsed.success) return undefined;
  const report = parsed.data;
  if (!shouldRenderHtml(report)) return undefined;

  const worstIntent = report.findings.reduce<'positive' | 'attention' | 'negative'>(
    (intent, finding) => {
      const findingIntent = severityIntent(finding.severity);
      if (findingIntent === 'negative') return 'negative';
      if (findingIntent === 'attention' && intent === 'positive') return 'attention';
      return intent;
    },
    report.verdict === 'CLEAN' ? 'positive' : 'attention',
  );

  const body = [
    verdictBanner({
      intent: worstIntent,
      badgeText: report.verdict,
      mainHtml: `<strong>${escapeHtml(report.scope)}</strong>`,
      aside: `${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}`,
    }),
    card({
      intent: worstIntent,
      eyebrow: 'Findings',
      title: 'Reviewer findings',
      bodyHtml: findingList(report.findings),
    }),
    // Method notes stay neutral: amber is reserved for findings that need
    // caution. Scope caveats keep a quiet badge so honesty about what was
    // not checked survives without painting a clean result as alarming.
    card({
      intent: 'neutral',
      eyebrow: 'Evidence',
      title: 'What was checked',
      bodyHtml: [
        `<p class="summary">${escapeHtml(report.assessment)}</p>`,
        '<p class="section-label">Verification</p>',
        stringList(report.verification),
        '<p class="section-label">Confidence limits</p>',
        stringList(report.confidence_limitations),
      ].join('\n'),
    }),
    card({
      intent: 'neutral',
      eyebrow: 'Caveats',
      title: 'Evidence caveats',
      ...(report.evidence_warnings.length > 0
        ? { badge: { text: 'Scope limited', intent: 'attention' as const } }
        : {}),
      bodyHtml: [warningList(report.evidence_warnings), evidenceSummary(report)].join('\n'),
    }),
  ].join('\n');

  return renderPage({
    title: 'Review result',
    metaLine: `Circuit · Review · ${ctx.runOutcome}`,
    headline: 'Review result',
    subtitle: report.assessment,
    bodyHtml: body,
    footerLeft: `Run ${ctx.runId}`,
    footerRight: 'reports/review-result.json',
  });
};
