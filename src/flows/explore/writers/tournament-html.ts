// Explore tournament HTML projector.
//
// Emits HTML only when the run produces a typed option grid the operator
// would benefit from comparing visually — i.e. a tournament that has
// reached a finalized decision. All operator-controlled strings are
// HTML-escaped at render time.

import { type Intent, card, chip, verdictBanner } from '../../../shared/html/components.js';
import {
  MAX_BULLET_LEN,
  MAX_PROMPT_LEN,
  escapeHtml,
  renderPage,
  truncate,
} from '../../../shared/html/page.js';
import type {
  HtmlAutoResolution,
  HtmlProjector,
  JsonObject,
} from '../../../shared/html/projector.js';
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

function renderOptionCard(
  option: ExploreDecisionOption,
  isRecommended: boolean,
  isSelected: boolean,
): string {
  // selected wins over recommended when both are true: the operator's own
  // choice should dominate the system's suggestion in the visual hierarchy.
  const intent: Intent = isSelected ? 'positive' : isRecommended ? 'info' : 'neutral';
  const badge = isSelected
    ? { text: 'Selected', intent: 'positive' as const }
    : isRecommended
      ? { text: 'Recommended', intent: 'info' as const }
      : undefined;

  const tradeoffsMarkup = option.tradeoffs
    .map((tradeoff) => `<li>${escapeHtml(truncate(tradeoff, MAX_BULLET_LEN))}</li>`)
    .join('\n          ');
  const evidenceMarkup = option.evidence_refs.map((ref) => chip(ref)).join('\n          ');

  const bodyHtml = `      <p class="summary">${escapeHtml(option.summary)}</p>
      <div>
        <p class="section-label">Tradeoffs</p>
        <ul class="tradeoffs">
          ${tradeoffsMarkup}
        </ul>
      </div>
      <div>
        <p class="section-label">Evidence</p>
        <div class="evidence">
          ${evidenceMarkup}
        </div>
      </div>
      <div class="actions">
        <button class="copy primary" data-prompt="${escapeHtml(truncate(option.best_case_prompt, MAX_PROMPT_LEN))}">Copy as prompt</button>
      </div>`;

  return card({
    intent,
    eyebrow: option.id,
    title: option.label,
    ...(badge === undefined ? {} : { badge }),
    bodyHtml,
  });
}

function renderTournamentVerdictBanner(
  review: ExploreTournamentReviewType,
  decisionOptions: ExploreDecisionOptions,
  decision: ExploreDecision,
): string {
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
  return verdictBanner({
    intent: verdictIntent(review.verdict),
    badgeText: 'Selected',
    mainHtml: `<strong>${escapeHtml(selectedLabel)}</strong> · ${escapeHtml(decision.decision)}`,
    aside: confidenceText(review.confidence),
  });
}

function renderTournamentDetails(
  review: ExploreTournamentReviewType,
  decision: ExploreDecision,
): string {
  const sections: string[] = [];
  sections.push(`<p><strong>Comparison.</strong> ${escapeHtml(review.comparison)}</p>`);
  if (review.objections.length > 0) {
    const items = review.objections
      .map((item) => `<li>${escapeHtml(truncate(item, MAX_BULLET_LEN))}</li>`)
      .join('');
    sections.push(`<p><strong>Objections.</strong></p><ul>${items}</ul>`);
  }
  if (review.missing_evidence.length > 0) {
    const items = review.missing_evidence
      .map((item) => `<li>${escapeHtml(truncate(item, MAX_BULLET_LEN))}</li>`)
      .join('');
    sections.push(`<p><strong>Missing evidence.</strong></p><ul>${items}</ul>`);
  }
  if (review.tradeoff_question.length > 0) {
    sections.push(
      `<p><strong>Tradeoff question.</strong> ${escapeHtml(review.tradeoff_question)}</p>`,
    );
  }
  sections.push(`<p><strong>Rationale.</strong> ${escapeHtml(decision.rationale)}</p>`);
  if (decision.residual_risks.length > 0) {
    const items = decision.residual_risks
      .map((item) => `<li>${escapeHtml(truncate(item, MAX_BULLET_LEN))}</li>`)
      .join('');
    sections.push(`<p><strong>Residual risks.</strong></p><ul>${items}</ul>`);
  }
  sections.push(`<p><strong>Next action.</strong> ${escapeHtml(decision.next_action)}</p>`);
  return sections.join('\n      ');
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

function renderAutoResolutions(records: readonly HtmlAutoResolution[] | undefined): string {
  if (records === undefined || records.length === 0) return '';
  const items = records
    .map((record) => `<li>${escapeHtml(autoResolutionLine(record))}</li>`)
    .join('');
  return `
  <section>
    <h2>Auto-resolutions</h2>
    <ul>${items}</ul>
  </section>
`;
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

  const cards = decisionOptions.options
    .map((option) =>
      renderOptionCard(option, option.id === recommendedId, option.id === selectedId),
    )
    .join('\n\n');

  const banner = renderTournamentVerdictBanner(tournamentReview, decisionOptions, decision);
  const detailsBody = renderTournamentDetails(tournamentReview, decision);
  const autoResolutions = renderAutoResolutions(ctx.autoResolutions);

  const bodyHtml = `${banner}

  <div class="grid">
${cards}
  </div>

${autoResolutions}

  <details>
    <summary>Tournament reasoning &middot; why this recommendation?</summary>
    <div class="body">
      ${detailsBody}
    </div>
  </details>
`;

  return renderPage({
    title: `${decisionOptions.decision_question} · Circuit Explore`,
    metaLine: `Explore · ${ctx.flowId} · ${ctx.runId}`,
    headline: decisionOptions.decision_question,
    subtitle,
    bodyHtml,
    footerLeft: `circuit · explore · ${ctx.runId}`,
    footerRight: decisionOptions.recommendation_basis,
  });
};
