// Review result HTML projector.
//
// Rendered with the shared report components; all operator-controlled
// strings pass through t().

import { MAX_BULLET_LEN, MAX_PROMPT_LEN } from '../../../shared/html/page.js';
import type { HtmlProjector } from '../../../shared/html/projector.js';
import { t } from '../../../shared/html/react-page.js';
import {
  BulletList,
  Chip,
  ReportCard,
  SectionLabel,
  Summary,
  VerdictBanner,
  renderReportPage,
} from '../../../shared/html/report-components.js';
import { ReviewResult, type ReviewResult as ReviewResultValue } from '../reports.js';

function severityIntent(severity: string): 'negative' | 'attention' | 'info' {
  if (severity === 'critical' || severity === 'high') return 'negative';
  if (severity === 'medium') return 'attention';
  return 'info';
}

function FindingList({ findings }: { readonly findings: ReviewResultValue['findings'] }) {
  if (findings.length === 0) return <Summary text="No actionable findings." />;
  return (
    <ul className="m-0 list-disc space-y-1.5 pl-4 text-[13px] leading-normal marker:text-muted-foreground/60">
      {findings.map((finding) => (
        <li key={`${finding.severity}:${finding.text}`}>
          <strong>{t(finding.severity.toUpperCase(), 40)}</strong>:{' '}
          {t(finding.text, MAX_BULLET_LEN)}
          {finding.file_refs.length === 0 ? null : (
            <>
              {' '}
              <Chip text={finding.file_refs.join(', ')} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function StringList({ items }: { readonly items: readonly string[] }) {
  if (items.length === 0) return <Summary text="None." />;
  return <BulletList items={items} />;
}

function WarningList({ warnings }: { readonly warnings: ReviewResultValue['evidence_warnings'] }) {
  if (warnings.length === 0) return <Summary text="No evidence warnings." />;
  return (
    <ul className="m-0 list-disc space-y-1.5 pl-4 text-[13px] leading-normal marker:text-muted-foreground/60">
      {warnings.map((warning) => (
        <li key={`${warning.kind}:${warning.message}`}>
          <strong>{t(warning.kind, 120)}</strong>
          {warning.path === undefined ? null : <> ({t(warning.path, MAX_BULLET_LEN)})</>}:{' '}
          {t(warning.message, MAX_BULLET_LEN)}
        </li>
      ))}
    </ul>
  );
}

function hasCompleteUntrackedReviewEvidence(report: ReviewResultValue): boolean {
  const evidence = report.evidence_summary;
  return (
    evidence?.kind === 'git-working-tree' &&
    evidence.target_mode === 'all' &&
    evidence.untracked_content_policy === 'include-content' &&
    evidence.untracked_file_count > 0 &&
    evidence.untracked_files_sampled === evidence.untracked_file_count &&
    !evidence.untracked_files_truncated
  );
}

function evidenceIsUnavailable(report: ReviewResultValue): boolean {
  if (report.evidence_summary?.kind === 'unavailable') return true;
  if (
    report.evidence_summary?.kind === 'git-target' &&
    !report.evidence_summary.target_diff_included
  ) {
    return true;
  }
  if (
    report.evidence_summary?.kind === 'git-working-tree' &&
    !report.evidence_summary.target_diff_included &&
    !hasCompleteUntrackedReviewEvidence(report)
  ) {
    return true;
  }
  return report.evidence_warnings.some(
    (warning) =>
      warning.kind === 'evidence_unavailable' ||
      warning.kind === 'target_unavailable' ||
      warning.kind === 'scope_empty',
  );
}

// Gaps in what Circuit actually selected. D2: untracked files relayed as
// metadata only are the default posture, so `untracked_file_content_omitted`
// is a stated limitation, not a gap, and never overrides the verdict banner.
const INCOMPLETE_EVIDENCE_WARNING_KINDS = new Set([
  'binary_content_not_inspected',
  'diff_truncated',
  'untracked_file_skipped',
  'submodule_content_not_inspected',
]);

function requestedUntrackedContent(report: ReviewResultValue): boolean {
  return (
    report.evidence_summary?.kind === 'git-working-tree' &&
    report.evidence_summary.untracked_content_policy === 'include-content'
  );
}

function evidenceIsIncomplete(report: ReviewResultValue): boolean {
  if (
    report.evidence_summary?.kind === 'git-target' &&
    report.evidence_summary.target_diff_truncated
  ) {
    return true;
  }
  if (
    report.evidence_summary?.kind === 'git-working-tree' &&
    report.evidence_summary.untracked_files_truncated &&
    requestedUntrackedContent(report)
  ) {
    return true;
  }
  return report.evidence_warnings.some(
    (warning) =>
      INCOMPLETE_EVIDENCE_WARNING_KINDS.has(warning.kind) ||
      (warning.kind === 'untracked_files_truncated' && requestedUntrackedContent(report)),
  );
}

function EvidenceSummary({ report }: { readonly report: ReviewResultValue }) {
  const evidence = report.evidence_summary;
  if (evidence === undefined) return <Summary text="No evidence summary was recorded." />;
  if (evidence.kind === 'goal') {
    return <Summary text="The stated goal was reviewed; no Git target was requested." />;
  }
  if (evidence.kind === 'unavailable') return <Summary text={evidence.message} />;
  if (evidence.kind === 'git-target') {
    return (
      <BulletList
        items={[
          `Review target: ${evidence.target_ref} (${evidence.target_kind})`,
          `Target diff included: ${evidence.target_diff_included ? 'yes' : 'no'}`,
          `Target diff truncated: ${evidence.target_diff_truncated ? 'yes' : 'no'}`,
        ]}
      />
    );
  }
  const sampled = `${evidence.untracked_files_sampled}/${evidence.untracked_file_count}`;
  const truncated = evidence.untracked_files_truncated ? 'yes' : 'no';
  return (
    <BulletList
      items={[
        `Review target: ${evidence.target_mode} working-tree changes`,
        `Target diff included: ${evidence.target_diff_included ? 'yes' : 'no'}`,
        `Untracked content policy: ${evidence.untracked_content_policy}`,
        `Untracked files sampled: ${sampled}`,
        `Untracked file list truncated: ${truncated}`,
      ]}
    />
  );
}

function shouldRenderHtml(report: ReviewResultValue): boolean {
  return (
    report.findings.length > 0 ||
    report.evidence_warnings.length > 0 ||
    report.confidence_limitations.length > 0 ||
    evidenceIsUnavailable(report) ||
    evidenceIsIncomplete(report)
  );
}

export const reviewResultProjector: HtmlProjector = (ctx) => {
  const parsed = ReviewResult.safeParse(ctx.flowReport);
  if (!parsed.success) return undefined;
  const report = parsed.data;
  if (!shouldRenderHtml(report)) return undefined;
  const evidenceUnavailable = evidenceIsUnavailable(report);
  const evidenceIncomplete = evidenceIsIncomplete(report);

  const worstIntent = report.findings.reduce<'positive' | 'attention' | 'negative'>(
    (intent, finding) => {
      const findingIntent = severityIntent(finding.severity);
      if (findingIntent === 'negative') return 'negative';
      if (findingIntent === 'attention' && intent === 'positive') return 'attention';
      return intent;
    },
    evidenceUnavailable || evidenceIncomplete || report.verdict !== 'CLEAN'
      ? 'attention'
      : 'positive',
  );

  return renderReportPage({
    title: 'Review result',
    metaLine: `Circuit · Review · ${ctx.runOutcome}`,
    headline: 'Review result',
    subtitle: report.assessment,
    footerLeft: `Run ${ctx.runId}`,
    footerRight: 'reports/review-result.json',
    children: (
      <>
        <VerdictBanner
          intent={worstIntent}
          badgeText={
            evidenceUnavailable
              ? 'EVIDENCE UNAVAILABLE'
              : evidenceIncomplete
                ? 'EVIDENCE INCOMPLETE'
                : report.outcome === 'stopped' || ctx.runOutcome === 'stopped'
                  ? 'REVIEW STOPPED'
                  : report.verdict
          }
          main={<strong>{t(report.scope, MAX_PROMPT_LEN)}</strong>}
          aside={`${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}`}
        />
        <div className="flex flex-col gap-4">
          <ReportCard intent={worstIntent} eyebrow="Findings" title="Reviewer findings">
            <FindingList findings={report.findings} />
          </ReportCard>
          {/* Method notes stay neutral: amber is reserved for findings that
              need caution. Scope caveats keep a quiet badge so honesty about
              what was not checked survives without painting a clean result
              as alarming. */}
          <ReportCard eyebrow="Evidence" title="What was checked">
            <Summary text={report.assessment} />
            <div>
              <SectionLabel>Verification</SectionLabel>
              <StringList items={report.verification} />
            </div>
            <div>
              <SectionLabel>Confidence limits</SectionLabel>
              <StringList items={report.confidence_limitations} />
            </div>
          </ReportCard>
          <ReportCard
            eyebrow="Caveats"
            title="Evidence caveats"
            {...(report.evidence_warnings.length > 0
              ? { badge: { text: 'Scope limited', intent: 'attention' as const } }
              : {})}
          >
            <WarningList warnings={report.evidence_warnings} />
            <EvidenceSummary report={report} />
          </ReportCard>
        </div>
      </>
    ),
  });
};
