// Per-flow operator-summary projector registry.
//
// Adding a new flow's projection is a single registry entry plus the
// projector function it references. Keep small projectors inline here; flows
// with substantial projection logic (currently: Explore) live in their own
// module and re-export through the registry.

import { exploreSummaryProjector } from './explore.js';
import {
  type JsonObject,
  arrayField,
  isObject,
  numberField,
  stringArrayField,
  stringField,
} from './json.js';
import type { SummaryProjection, SummaryProjector } from './projector.js';
import {
  capitalized,
  friendlyFixOutcome,
  friendlyRegressionStatus,
  friendlyResultSummary,
  friendlyReviewStatus,
  friendlyVerificationStatus,
  plural,
} from './text.js';

function flowSummaryDetail(flowReport: JsonObject | undefined): string | undefined {
  const summary = stringField(flowReport, 'summary');
  return summary === undefined ? undefined : `Result: ${friendlyResultSummary(summary)}`;
}

function firstLineSummary(text: string, max: number): string {
  // Strip leading markdown-active markers (bullets, headings, blockquotes,
  // code-fence backticks) so a finding text that starts with "- foo" cannot
  // produce a nested bullet when concatenated into the operator summary's
  // "- <detail>" rendering.
  const firstLine = (text.split(/\r?\n/, 1)[0] ?? '').replace(/^[\s>#*\-`|]+/, '').trim();
  if (firstLine.length === 0) return '(no text)';
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, Math.max(1, max - 1))}…`;
}

function reviewFindingDetails(report: JsonObject | undefined): string[] {
  const findings = arrayField(report, 'findings');
  if (findings.length === 0) {
    // Drop the bare "Findings: 0" line when the reviewer included an
    // assessment paragraph — the assessment carries the same "no issues"
    // information with context. Old reports without an assessment fall
    // back to the legacy line so the summary still names the count.
    return stringField(report, 'assessment') === undefined ? ['Findings: 0'] : [];
  }
  const lines: string[] = [];
  for (const finding of findings) {
    if (!isObject(finding)) continue;
    const severity = (stringField(finding, 'severity') ?? 'unknown').toUpperCase();
    const text = stringField(finding, 'text') ?? '(no text)';
    const fileRefs = stringArrayField(finding, 'file_refs');
    const summary = firstLineSummary(text, 140);
    const fileSuffix = fileRefs.length === 0 ? '' : ` — at ${fileRefs.join(', ')}`;
    lines.push(`[${severity}] ${summary}${fileSuffix}`);
  }
  return lines;
}

// Reviewer-supplied prose: the assessment paragraph, the verification steps
// they took, and any confidence limitations they flagged. Required on the
// relay/result schema so a CLEAN verdict cannot collapse to a bare count;
// rendered here so the operator sees what was checked even when there are
// no findings to list.
function reviewAssessmentDetails(report: JsonObject | undefined): string[] {
  const lines: string[] = [];
  const assessment = stringField(report, 'assessment');
  if (assessment !== undefined && assessment.trim().length > 0) {
    lines.push(`Assessment: ${assessment.trim()}`);
  }
  const verification = stringArrayField(report, 'verification')
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
  if (verification.length > 0) {
    lines.push(`Reviewer steps: ${verification.join('; ')}`);
  }
  const limitations = stringArrayField(report, 'confidence_limitations')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (limitations.length > 0) {
    lines.push(`Confidence limitations: ${limitations.join('; ')}`);
  }
  return lines;
}

function reviewEvidenceDetails(report: JsonObject | undefined): string[] {
  const evidenceSummary = isObject(report?.evidence_summary) ? report.evidence_summary : undefined;
  const kind = stringField(evidenceSummary, 'kind');
  if (kind === 'unavailable') {
    const message = stringField(evidenceSummary, 'message');
    return message === undefined ? [] : [`Review evidence: unavailable (${message})`];
  }
  if (kind !== 'git-working-tree') return [];

  const policy = stringField(evidenceSummary, 'untracked_content_policy');
  const count = numberField(evidenceSummary, 'untracked_file_count') ?? 0;
  const sampled = numberField(evidenceSummary, 'untracked_files_sampled') ?? 0;
  const truncated = evidenceSummary?.untracked_files_truncated === true;
  if (policy === 'include-content') {
    const suffix = truncated ? '; additional untracked files were not sampled' : '';
    return [
      `Untracked evidence: contents included for ${plural(sampled, 'file')} (${plural(count, 'untracked file')} found${suffix}).`,
    ];
  }
  if (policy === 'metadata-only' && count > 0) {
    const suffix = truncated ? '; additional untracked files were not sampled' : '';
    return [
      `Untracked evidence: paths and sizes only for ${plural(sampled, 'file')} (${plural(count, 'untracked file')} found${suffix}).`,
    ];
  }
  return [];
}

function hasEvidenceWarningKind(report: JsonObject | undefined, kind: string): boolean {
  return arrayField(report, 'evidence_warnings').some(
    (item) => isObject(item) && stringField(item, 'kind') === kind,
  );
}

const reviewProjector: SummaryProjector = ({ flowReport }) => {
  const verdict = stringField(flowReport, 'verdict') ?? 'review complete';
  const findings = arrayField(flowReport, 'findings').length;
  const scopeEmpty = hasEvidenceWarningKind(flowReport, 'scope_empty');
  const summaryDetail = flowSummaryDetail(flowReport);
  const assessmentDetails = reviewAssessmentDetails(flowReport);
  // Order: legacy result-summary line, assessment paragraph (the reviewer's
  // framing), the findings list, then verification + limitations + evidence.
  // Assessment lives in `assessmentDetails`; we splice the verification and
  // limitations entries between findings and evidence so the operator reads
  // conclusion → specifics → methodology → caveats → metadata.
  const [assessmentLine, ...verificationAndLimitations] = assessmentDetails;
  const details: string[] = [];
  if (summaryDetail !== undefined) details.push(summaryDetail);
  if (assessmentLine !== undefined) details.push(assessmentLine);
  details.push(...reviewFindingDetails(flowReport));
  details.push(...verificationAndLimitations);
  details.push(...reviewEvidenceDetails(flowReport));
  // When the reviewer had no source content to inspect, a CLEAN/0-findings
  // headline silently understates the scope limitation. Drop the verdict
  // reference (it is meaningless when scope is empty, and would read awkwardly
  // through the fallback if verdict were ever absent) and lead with the
  // scope-was-empty fact instead.
  const findingPhrase =
    verdict === 'CLEAN' && findings > 0
      ? `Low-severity notes: ${findings}.`
      : `Findings: ${findings}.`;
  const headline = scopeEmpty
    ? `Circuit: Review had no uncommitted source content to examine; committed history (HEAD~1) was not part of this review. ${findingPhrase}`
    : `Circuit: Review complete. Verdict: ${verdict}. ${findingPhrase}`;
  return {
    headline,
    details,
  } satisfies SummaryProjection;
};

function buildFixDetails(flowReport: JsonObject | undefined): string[] {
  const details: string[] = [];
  const summaryDetail = flowSummaryDetail(flowReport);
  if (summaryDetail !== undefined) details.push(summaryDetail);
  const verification = stringField(flowReport, 'verification_status');
  // Fall back to review_status the same way the headline projector does. When
  // review is skipped, the schema forbids a verdict, so reading only
  // review_verdict drops the Review line entirely and the surface reads as a
  // clean pass that mentions only verification. That launders a skipped (often
  // degraded) review into a silent omission.
  const review =
    stringField(flowReport, 'review_verdict') ?? stringField(flowReport, 'review_status');
  if (verification !== undefined) {
    details.push(`Verification: ${friendlyVerificationStatus(verification)}.`);
  }
  // Surface the regression rerun whenever it did not clear. On the default path
  // it defaults to 'deferred', so a 'passed' verification with a silent
  // regression status reads as relevance-proven when it is not. 'cleared' is
  // the only outcome that earns silence.
  const regression = stringField(flowReport, 'regression_rerun_status');
  if (regression !== undefined && regression !== 'cleared') {
    details.push(`Regression: ${friendlyRegressionStatus(regression)}.`);
  }
  if (review !== undefined) {
    // A skip carries a required reason. Surface it so a degraded skip (e.g. the
    // reviewer connector failed) is legible and cannot read as an intentional,
    // benign one.
    const skipReason =
      review === 'skipped' ? stringField(flowReport, 'review_skip_reason') : undefined;
    details.push(
      skipReason !== undefined
        ? `Review: ${friendlyReviewStatus(review)}. Reason: ${skipReason}`
        : `Review: ${friendlyReviewStatus(review)}.`,
    );
  }
  return details;
}

// Build-only scope rendering. The reviewer self-reports per-guardrail
// alignment; close.ts reconciles it against the plan's declared guardrails
// into build.result.scope. We surface that here so the operator can see, in
// the digest, whether the declared intent actually held — without opening the
// review file. Deviation-only by design: a clean run says nothing extra (the
// headline already carries "review accepted"); a gap is named loudly so an
// accept verdict can never silently launder a scope skip.
function hasScopeDeviation(flowReport: JsonObject | undefined): boolean {
  const scope = isObject(flowReport?.scope) ? flowReport.scope : undefined;
  if (scope === undefined) return false;
  return (
    stringField(scope, 'adherence') === 'exceeds_scope' ||
    stringArrayField(scope, 'violated_guardrails').length > 0 ||
    stringArrayField(scope, 'unassessed_guardrails').length > 0
  );
}

function buildScopeDetails(flowReport: JsonObject | undefined): string[] {
  const scope = isObject(flowReport?.scope) ? flowReport.scope : undefined;
  if (scope === undefined) return [];
  const details: string[] = [];
  if (stringField(scope, 'adherence') === 'exceeds_scope') {
    details.push('Scope: reviewer judged the change exceeds the stated scope.');
  }
  const violated = stringArrayField(scope, 'violated_guardrails');
  if (violated.length > 0) {
    details.push(`Guardrails violated: ${violated.join('; ')}.`);
  }
  const unassessed = stringArrayField(scope, 'unassessed_guardrails');
  if (unassessed.length > 0) {
    details.push(`Guardrails the reviewer did not assess: ${unassessed.join('; ')}.`);
  }
  return details;
}

// Build-only touch-area rendering. Unlike scope (which is the reviewer's
// self-report), this is a git-proven fact: the touch-area writer diffed the
// working tree against a baseline snapshot and compared the touched paths to
// the area the plan declared. We surface a deviation loudly so an accept
// verdict can never launder a change that reached outside its declared area.
// Deviation-only by design, same as scope: a contained change (or a run with
// no declared area, where containment is always 'within') says nothing extra.
function hasTouchAreaDeviation(flowReport: JsonObject | undefined): boolean {
  const touchArea = isObject(flowReport?.touch_area) ? flowReport.touch_area : undefined;
  if (touchArea === undefined) return false;
  return stringField(touchArea, 'containment') !== 'within';
}

function buildTouchAreaDetails(flowReport: JsonObject | undefined): string[] {
  const touchArea = isObject(flowReport?.touch_area) ? flowReport.touch_area : undefined;
  if (touchArea === undefined) return [];
  const containment = stringField(touchArea, 'containment');
  if (containment === 'out_of_bounds') {
    const paths = stringArrayField(touchArea, 'out_of_bounds_paths');
    const list = paths.length === 0 ? '(paths unavailable)' : paths.join('; ');
    return [`Touch area: the change modified files outside the planned area: ${list}.`];
  }
  if (containment === 'undetermined') {
    return [
      'Touch area: containment could not be verified — history moved during the run, or a file is hidden from git.',
    ];
  }
  return [];
}

function prototypeDetails(flowReport: JsonObject | undefined): string[] {
  const details: string[] = [];
  const summaryDetail = flowSummaryDetail(flowReport);
  if (summaryDetail !== undefined) details.push(summaryDetail);
  const mode = stringField(flowReport, 'mode');
  if (mode === 'model-comparison') {
    const selected = stringField(flowReport, 'selected_variant_id');
    const selectedLabel = stringField(flowReport, 'selected_variant_label');
    const admitted = numberField(flowReport, 'admitted_variant_count');
    const captured = numberField(flowReport, 'captured_provider_evidence_count');
    if (selected !== undefined) {
      details.push(
        `Selected variant: ${selectedLabel === undefined ? selected : `${selectedLabel} (${selected})`}.`,
      );
    }
    if (admitted !== undefined) details.push(`Admitted variants: ${admitted}.`);
    if (captured !== undefined) {
      details.push(`Captured relay selection evidence: ${captured}.`);
    }
  }
  const verification = stringField(flowReport, 'verification_status');
  if (verification !== undefined) {
    details.push(`Verification: ${friendlyVerificationStatus(verification)}.`);
  }
  const reviewNotes = arrayField(flowReport, 'checkpoint_comments').length;
  if (reviewNotes > 0) details.push(`Review notes: ${reviewNotes} captured.`);
  const root = stringField(flowReport, 'prototype_root');
  if (root !== undefined) details.push(`Prototype root: ${root}.`);
  const entryPoints = stringArrayField(flowReport, 'entry_points');
  if (entryPoints.length > 0) details.push(`Entry points: ${entryPoints.join(', ')}.`);
  const nextStep = stringField(flowReport, 'next_step');
  if (nextStep !== undefined) details.push(`Next step: ${nextStep}`);
  return details;
}

function goalArrayDetail(flowReport: JsonObject | undefined, field: string, label: string): string {
  const values = stringArrayField(flowReport, field);
  return `${label}: ${values.length === 0 ? 'none' : values.join('; ')}.`;
}

function goalEvidenceDetails(flowReport: JsonObject | undefined): string {
  const links = arrayField(flowReport, 'evidence_links')
    .filter(isObject)
    .map((link) => {
      const reportId = stringField(link, 'report_id') ?? 'report';
      const path = stringField(link, 'path') ?? '(missing path)';
      return `${reportId} -> ${path}`;
    });
  return `Checks: ${links.length === 0 ? 'none' : links.join('; ')}.`;
}

function goalGateDetail(flowReport: JsonObject | undefined): string {
  const gate = isObject(flowReport?.gate) ? flowReport.gate : undefined;
  const clean = numberField(gate, 'clean_streak') ?? 0;
  const required = numberField(gate, 'required_passes') ?? 2;
  const verdict = stringField(gate, 'final_verdict') ?? 'unknown';
  return `Safety review: ${clean}/${required} passes; final verdict ${verdict}.`;
}

function goalClaimDetails(flowReport: JsonObject | undefined, outcome: string): string[] {
  const proofLabel = outcome === 'complete' ? 'Proven' : 'Marked before final safety review';
  const weakLabel =
    outcome === 'complete' ? 'Still weak or missing' : 'Weak or missing before final safety review';
  return [
    goalArrayDetail(flowReport, 'proven_claims', proofLabel),
    goalArrayDetail(flowReport, 'missing_or_weak_claims', weakLabel),
  ];
}

// Fall back to the run-level outcome when the flow-result file is missing
// (e.g., the flow hit @stop before close-step ran). Defaulting to 'complete'
// would let the operator summary silently contradict result.json on any
// non-complete terminal path.
function flowOutcomeOrRunFallback(flowReport: JsonObject | undefined, runOutcome: string): string {
  return stringField(flowReport, 'outcome') ?? runOutcome;
}

const buildProjector: SummaryProjector = ({ flowReport, runOutcome }) => {
  const outcome = flowOutcomeOrRunFallback(flowReport, runOutcome);
  const verification = stringField(flowReport, 'verification_status') ?? 'unknown';
  const review = stringField(flowReport, 'review_verdict') ?? 'unknown';
  const headline = ((): string => {
    if (outcome === 'complete' && verification === 'passed' && review === 'accept') {
      return 'Circuit: Build complete. Change implemented, verification passed, review accepted.';
    }
    if (outcome === 'needs_attention' && verification === 'passed') {
      // needs_attention has two independent causes that can co-occur: the
      // reviewer asked for fixes (accept-with-fixes), and/or the change drifted
      // from declared scope (exceeds-scope, a violated guardrail, or a guardrail
      // left unassessed). These are orthogonal — an accept-with-fixes verdict
      // can ride alongside a scope deviation — so name every cause that holds.
      // A single-cause either/or would drop the scope skip from the skimmable
      // headline even though the detail lines below surface it.
      const causes: string[] = [];
      if (review === 'accept-with-fixes') causes.push('review requested fixes');
      if (hasScopeDeviation(flowReport)) causes.push('the change needs a scope follow-up');
      if (hasTouchAreaDeviation(flowReport)) {
        causes.push('the change reached outside the planned area');
      }
      const cause = causes.length > 0 ? causes.join(' and ') : 'review or scope needs a follow-up';
      return `Circuit: Build needs follow-up. Verification passed, but ${cause}.`;
    }
    return `Circuit: Build finished with outcome ${outcome}. Verification: ${friendlyVerificationStatus(verification)}. Review: ${friendlyReviewStatus(review)}.`;
  })();
  return {
    headline,
    details: [
      ...buildFixDetails(flowReport),
      ...buildScopeDetails(flowReport),
      ...buildTouchAreaDetails(flowReport),
    ],
  } satisfies SummaryProjection;
};

const prototypeProjector: SummaryProjector = ({ flowReport, runOutcome }) => {
  const outcome = flowOutcomeOrRunFallback(flowReport, runOutcome);
  const verification = stringField(flowReport, 'verification_status') ?? 'unknown';
  const checkpoint = stringField(flowReport, 'checkpoint_selection') ?? 'unknown';
  const mode = stringField(flowReport, 'mode');
  const headline = ((): string => {
    if (mode === 'model-comparison' && outcome === 'kept') {
      const selected = stringField(flowReport, 'selected_variant_label') ?? checkpoint;
      return `Circuit: Prototype model comparison verified and kept ${selected}.`;
    }
    if (outcome === 'kept') {
      return 'Circuit: Prototype verified and kept as local evidence.';
    }
    if (outcome === 'build_input_saved') {
      return 'Circuit: Prototype verified and saved as Build input.';
    }
    if (outcome === 'discarded') {
      return 'Circuit: Prototype verified and marked discarded.';
    }
    return `Circuit: Prototype finished with outcome ${outcome}. Verification: ${friendlyVerificationStatus(verification)}. Checkpoint: ${checkpoint}.`;
  })();
  return {
    headline,
    details: prototypeDetails(flowReport),
  } satisfies SummaryProjection;
};

const goalProjector: SummaryProjector = ({ flowReport, runOutcome }) => {
  const outcome = flowOutcomeOrRunFallback(flowReport, runOutcome);
  const gate = isObject(flowReport?.gate) ? flowReport.gate : undefined;
  const clean = numberField(gate, 'clean_streak') ?? 0;
  const required = numberField(gate, 'required_passes') ?? 2;
  const headline =
    outcome === 'complete'
      ? `Circuit: Goal complete. Evidence satisfied and safety review passed ${clean}/${required}.`
      : `Circuit: Goal finished with outcome ${outcome}. Safety review passed ${clean}/${required}.`;
  return {
    headline,
    details: [
      ...goalClaimDetails(flowReport, outcome),
      goalEvidenceDetails(flowReport),
      goalGateDetail(flowReport),
      goalArrayDetail(flowReport, 'recovery_history', 'Recovery'),
      goalArrayDetail(flowReport, 'rerun_commands', 'Next'),
    ],
  } satisfies SummaryProjection;
};

const fixProjector: SummaryProjector = ({ flowReport, runOutcome }) => {
  const outcome = flowOutcomeOrRunFallback(flowReport, runOutcome);
  const verification = stringField(flowReport, 'verification_status') ?? 'unknown';
  const review =
    stringField(flowReport, 'review_verdict') ??
    stringField(flowReport, 'review_status') ??
    'unknown';
  // Avoid "outcome partial" on the happy-with-followups path — the operator
  // reads that as "the fix was only partially applied", but Fix uses 'partial'
  // for "applied + verified, regression test deferred or review asked for
  // follow-ups." Render every Fix outcome through friendlyFixOutcome so the
  // headline never collides with run-level outcome vocabulary.
  const headline = `Circuit: ${capitalized(friendlyFixOutcome(outcome))}. Verification: ${friendlyVerificationStatus(verification)}. Review: ${friendlyReviewStatus(review)}.`;
  return {
    headline,
    details: buildFixDetails(flowReport),
  } satisfies SummaryProjection;
};

const pursueProjector: SummaryProjector = ({ flowReport, runOutcome }) => {
  const outcome = flowOutcomeOrRunFallback(flowReport, runOutcome);
  const total = numberField(flowReport, 'total_pursuits');
  const completed = numberField(flowReport, 'completed_count') ?? 0;
  const skipped = numberField(flowReport, 'skipped_count') ?? 0;
  const blocked = numberField(flowReport, 'blocked_count') ?? 0;
  const failed = numberField(flowReport, 'failed_count') ?? 0;
  const verification = stringField(flowReport, 'verification_status') ?? 'unknown';
  const review = stringField(flowReport, 'review_verdict') ?? 'unknown';
  const countPrefix =
    total === undefined
      ? ''
      : `${completed}/${total} ${total === 1 ? 'pursuit' : 'pursuits'} completed. `;
  const details = [
    `Code-changing work was serialized. Skipped: ${skipped}. Blocked: ${blocked}. Failed: ${failed}.`,
    `Verification: ${friendlyVerificationStatus(verification)}. Review: ${friendlyReviewStatus(review)}.`,
  ];
  const summaryDetail = flowSummaryDetail(flowReport);
  if (summaryDetail !== undefined) details.unshift(summaryDetail);
  return {
    headline: `Circuit: Pursue finished with outcome ${outcome}. ${countPrefix}Verification: ${friendlyVerificationStatus(verification)}.`,
    details,
  } satisfies SummaryProjection;
};

// Default projection used when no per-flow projector is registered. The
// resultSummary is the run-result summary string; the writer's overlay code
// adds run-note framing on top, so leaving details empty here keeps the
// shape symmetric across flows.
const defaultProjector: SummaryProjector = ({ resultSummary }) => ({
  headline: resultSummary,
  details: [],
});

export const SUMMARY_PROJECTORS: Partial<Record<string, SummaryProjector>> = {
  build: buildProjector,
  explore: exploreSummaryProjector,
  fix: fixProjector,
  goal: goalProjector,
  prototype: prototypeProjector,
  pursue: pursueProjector,
  review: reviewProjector,
};

export function projectSummary(input: Parameters<SummaryProjector>[0]): SummaryProjection {
  const projector = SUMMARY_PROJECTORS[input.flowId] ?? defaultProjector;
  return projector(input);
}
