// Explore tournament HTML projector.
//
// Emits HTML only when the run produces a typed option grid the operator
// would benefit from comparing visually — i.e. a tournament that has
// reached a finalized decision. Rendered with the shared report
// components; all operator-controlled strings pass through t().

import { MAX_PROMPT_LEN } from '../../../shared/html/page.js';
import type {
  HtmlAutoResolution,
  HtmlProjector,
  JsonObject,
} from '../../../shared/html/projector.js';
import { t } from '../../../shared/html/react-page.js';
import {
  BulletList,
  CardGrid,
  ChipRow,
  type Intent,
  ReportCard,
  SectionLabel,
  Summary,
  VerdictBanner,
  renderReportPage,
} from '../../../shared/html/report-components.js';
import { Button } from '../../../shared/html/ui/button.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../../shared/html/ui/collapsible.js';
import {
  ExploreDecision,
  type ExploreDecisionOption,
  ExploreDecisionOptions,
  ExploreTournamentReview,
  type ExploreTournamentReview as ExploreTournamentReviewType,
} from '../reports.js';

function stringField(report: JsonObject | undefined, key: string): string | undefined {
  const value = report?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function verdictIntent(verdict: ExploreTournamentReviewType['verdict']): Intent {
  if (verdict === 'recommend') return 'info';
  if (verdict === 'no-clear-winner') return 'attention';
  return 'attention';
}

function confidenceText(confidence: ExploreTournamentReviewType['confidence']): string {
  return `${confidence} confidence`;
}

function OptionCard({
  option,
  isRecommended,
  isSelected,
}: {
  readonly option: ExploreDecisionOption;
  readonly isRecommended: boolean;
  readonly isSelected: boolean;
}) {
  // selected wins over recommended when both are true: the operator's own
  // choice should dominate the system's suggestion in the visual hierarchy.
  const intent: Intent = isSelected ? 'positive' : isRecommended ? 'info' : 'neutral';
  const badge = isSelected
    ? { text: 'Selected', intent: 'positive' as const }
    : isRecommended
      ? { text: 'Recommended', intent: 'info' as const }
      : undefined;

  return (
    <ReportCard
      intent={intent}
      eyebrow={option.id}
      title={option.label}
      {...(badge === undefined ? {} : { badge })}
    >
      <Summary text={option.summary} />
      <div>
        <SectionLabel>Tradeoffs</SectionLabel>
        <BulletList items={option.tradeoffs} />
      </div>
      <div>
        <SectionLabel>Evidence</SectionLabel>
        <ChipRow items={option.evidence_refs} />
      </div>
      <div className="pt-0.5">
        <Button size="sm" data-prompt={t(option.best_case_prompt, MAX_PROMPT_LEN)}>
          Copy as prompt
        </Button>
      </div>
    </ReportCard>
  );
}

function TournamentVerdictBanner({
  review,
  decisionOptions,
  decision,
}: {
  readonly review: ExploreTournamentReviewType;
  readonly decisionOptions: ExploreDecisionOptions;
  readonly decision: ExploreDecision;
}) {
  // The banner narrates the decision, so the bolded name is the selected
  // option. Bolding the reviewer's recommendation next to a decision
  // sentence that names a different option would read as the page
  // disagreeing with itself; the recommendation keeps its own lane on the
  // option cards and in the review details. The intent still reflects the
  // review verdict, so a selection made against an ambivalent review stays
  // visually cautious.
  const selectedOption = decisionOptions.options.find(
    (option) => option.id === decision.selected_option_id,
  );
  const selectedLabel = selectedOption?.label ?? decision.selected_option_label;
  return (
    <VerdictBanner
      intent={verdictIntent(review.verdict)}
      badgeText="Selected"
      main={
        <>
          <strong>{t(selectedLabel, MAX_PROMPT_LEN)}</strong> ·{' '}
          {t(decision.decision, MAX_PROMPT_LEN)}
        </>
      }
      aside={confidenceText(review.confidence)}
    />
  );
}

function TournamentDetails({
  review,
  decision,
}: {
  readonly review: ExploreTournamentReviewType;
  readonly decision: ExploreDecision;
}) {
  return (
    <>
      <p>
        <strong>Comparison.</strong> {t(review.comparison, MAX_PROMPT_LEN)}
      </p>
      {review.objections.length === 0 ? null : (
        <>
          <p>
            <strong>Objections.</strong>
          </p>
          <BulletList items={review.objections} />
        </>
      )}
      {review.missing_evidence.length === 0 ? null : (
        <>
          <p>
            <strong>Missing evidence.</strong>
          </p>
          <BulletList items={review.missing_evidence} />
        </>
      )}
      {review.tradeoff_question.length === 0 ? null : (
        <p>
          <strong>Tradeoff question.</strong> {t(review.tradeoff_question, MAX_PROMPT_LEN)}
        </p>
      )}
      <p>
        <strong>Rationale.</strong> {t(decision.rationale, MAX_PROMPT_LEN)}
      </p>
      {decision.residual_risks.length === 0 ? null : (
        <>
          <p>
            <strong>Residual risks.</strong>
          </p>
          <BulletList items={decision.residual_risks} />
        </>
      )}
      <p>
        <strong>Next action.</strong> {t(decision.next_action, MAX_PROMPT_LEN)}
      </p>
    </>
  );
}

function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  return value.toFixed(3).replace(/\.?0+$/, '');
}

function formatSignedScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${formatScore(value)}`;
}

function autoResolutionLine(record: HtmlAutoResolution): string {
  const label = record.checkpoint_label ?? record.checkpoint_id;
  const vetoText =
    record.runtime_veto_effect === 'none' ? 'no runtime vetoes' : record.runtime_veto_effect;
  return `${label}: ${record.resolved_value} selected by policy highest-score (aggregate score ${formatScore(record.winning_score)}; margin ${formatSignedScore(record.margin)} over runner-up; ${vetoText}).`;
}

function AutoResolutions({ records }: { readonly records: readonly HtmlAutoResolution[] }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2.5 text-lg font-semibold tracking-tight">Auto-resolutions</h2>
      <BulletList items={records.map(autoResolutionLine)} />
    </section>
  );
}

type ExploreHtmlPayload = {
  readonly decisionOptions: ExploreDecisionOptions;
  readonly tournamentReview: ExploreTournamentReviewType;
  readonly decision: ExploreDecision;
};

function loadHtmlPayload(
  flowReport: JsonObject | undefined,
  readEvidenceReportById: (reportId: string) => JsonObject | undefined,
): ExploreHtmlPayload | undefined {
  // HTML emits only when the tournament reached a finalized decision. A
  // checkpoint_waiting outcome that has set selected_option_id but not yet
  // written decision.json must NOT trigger HTML — the operator deserves a
  // surface that matches the actual run state.
  const snapshot = isObject(flowReport?.verdict_snapshot) ? flowReport.verdict_snapshot : undefined;
  if (stringField(snapshot, 'decision_verdict') !== 'decided') return undefined;

  const optionsRaw = readEvidenceReportById('explore.decision-options');
  const reviewRaw = readEvidenceReportById('explore.tournament-review');
  const decisionRaw = readEvidenceReportById('explore.decision');
  if (optionsRaw === undefined || reviewRaw === undefined || decisionRaw === undefined) {
    return undefined;
  }

  const optionsParsed = ExploreDecisionOptions.safeParse(optionsRaw);
  const reviewParsed = ExploreTournamentReview.safeParse(reviewRaw);
  const decisionParsed = ExploreDecision.safeParse(decisionRaw);
  if (!optionsParsed.success || !reviewParsed.success || !decisionParsed.success) return undefined;

  return {
    decisionOptions: optionsParsed.data,
    tournamentReview: reviewParsed.data,
    decision: decisionParsed.data,
  };
}

export const exploreTournamentProjector: HtmlProjector = (ctx) => {
  const payload = loadHtmlPayload(ctx.flowReport, ctx.readEvidenceReportById);
  if (payload === undefined) return undefined;

  const { decisionOptions, tournamentReview, decision } = payload;
  const recommendedId = tournamentReview.recommended_option_id;
  const selectedId = decision.selected_option_id;

  const subtitle = `${decisionOptions.options.length} options surfaced. Tournament review: ${tournamentReview.verdict.replace(/-/g, ' ')} (${tournamentReview.confidence} confidence).`;

  return renderReportPage({
    title: `${decisionOptions.decision_question} · Circuit Explore`,
    metaLine: `Explore · ${ctx.flowId} · ${ctx.runId}`,
    headline: decisionOptions.decision_question,
    subtitle,
    footerLeft: `circuit · explore · ${ctx.runId}`,
    footerRight: decisionOptions.recommendation_basis,
    children: (
      <>
        <TournamentVerdictBanner
          review={tournamentReview}
          decisionOptions={decisionOptions}
          decision={decision}
        />
        <CardGrid>
          {decisionOptions.options.map((option) => (
            <OptionCard
              key={option.id}
              option={option}
              isRecommended={option.id === recommendedId}
              isSelected={option.id === selectedId}
            />
          ))}
        </CardGrid>
        {ctx.autoResolutions === undefined || ctx.autoResolutions.length === 0 ? null : (
          <AutoResolutions records={ctx.autoResolutions} />
        )}
        <Collapsible className="mt-8 rounded-lg border bg-card px-5 py-4">
          <CollapsibleTrigger className="text-sm font-medium text-muted-foreground hover:text-foreground">
            Tournament reasoning · why this recommendation?
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2.5 pt-4 text-sm leading-relaxed">
            <TournamentDetails review={tournamentReview} decision={decision} />
          </CollapsibleContent>
        </Collapsible>
      </>
    ),
  });
};
