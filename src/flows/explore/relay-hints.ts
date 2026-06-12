// Explore flow relay shape hints.

import type { SchemaShapeHint } from '../registries/shape-hints/types.js';

export const exploreComposeShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'explore.compose@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "<one-of-accepted-verdicts>", "subject": "<subject investigated>", "recommendation": "<primary conclusion or recommendation>", "success_condition_alignment": "<how the recommendation satisfies the brief success condition>", "supporting_aspects": [{ "aspect": "<analysis aspect name>", "contribution": "<how this aspect supports the recommendation>", "evidence_refs": ["<report path or file:line reference that supports this contribution>"] }] }',
    'Ground claims in the provided reports or files you inspect. If the evidence is thin, say so in the recommendation instead of inventing certainty. When asked to score or grade, include the rubric in the recommendation and cite the evidence refs behind the score.',
    'Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse, rejects verdicts the schema does not allow, and validates the full report body against explore.compose@v1 before writing reports/compose.json.',
  ].join(' '),
};

export const exploreReviewVerdictShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'explore.review-verdict@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "<accept|accept-with-fold-ins|reject>", "overall_assessment": "<review summary>", "objections": ["<blocking or follow-up objection>"], "missed_angles": ["<important angle not covered>"] }',
    'Use verdict "reject" when any objection is blocking: the compose routes back for one rework pass that reads this review, and a second reject stops the run. Use "accept-with-fold-ins" only for objections the operator can absorb without reworking the compose. A justified reject is a successful review.',
    'Use empty arrays when there are no objections or missed angles. Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'Audit the compose against the brief on these axes before deciding the verdict. Subject fidelity: the subject must match the brief; flag if it includes unrelated topics. Evidence groundedness: every evidence_ref must be a real path in the run; flag fabricated, missing, or unresolvable references. Internal consistency: the recommendation and supporting_aspects must not contradict each other or the verdict; flag self-negating or contradictory sentences. Epistemic calibration: confidence must match the evidence; flag overclaiming, false certainty, or assertions unsupported by the cited reports. Specifically flag mild readiness overclaims: if the compose says more proof, validation, repo inspection, or follow-up investigation is still needed, object to any claim that the result is enough, safe, or ready to proceed confidently or without follow-up. Success-condition alignment: the success_condition_alignment field must substantively explain how the recommendation satisfies the brief\'s success condition with specifics from the analysis; flag if it is generic, formulaic, vacuous, merely restates the brief, or could be pasted into any other compose unchanged ("This satisfies the brief." is the canonical failure).',
    'The runtime parses your response with JSON.parse, rejects verdicts the schema does not allow, and validates the full report body against explore.review-verdict@v1 before writing reports/review-verdict.json.',
  ].join(' '),
};

export const exploreTournamentProposalShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'explore.tournament-proposal@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "accept", "option_id": "<the generated option id for this branch>", "option_label": "<option label>", "case_summary": "<strongest case for this option>", "assumptions": ["<assumption>"], "evidence_refs": ["<report path or file:line reference>"], "risks": ["<risk>"], "next_action": "<next action if this option is selected>", "rubric_model_judgments": { "evidence_rigor": "<pass|concern|fail>", "actionability": "<pass|concern|fail>", "coverage_adequacy": "<pass|concern|fail>", "scope_discipline": "<pass|concern|fail>", "honest_calibration": "<pass|concern|fail>", "project_specificity": "<pass|concern|fail>", "insight_density": "<pass|concern|fail>", "branch_distinctness": "<pass|concern|fail>" } }',
    'Set every rubric_model_judgments value from your own judgment of the branch case. Runtime checks may later veto evidence_rigor, actionability, coverage_adequacy, or scope_discipline; do not try to encode runtime_signal yourself.',
    'Argue for the option named in the branch title. Set option_id to the branch option id named in the step id and title. Do not compare every option; make the strongest evidence-backed case for this branch. Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse and validates the full report body against explore.tournament-proposal@v1 before writing the branch report.',
  ].join(' '),
};

export const exploreTournamentReviewShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'explore.tournament-review@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "<recommend|no-clear-winner|needs-operator>", "recommended_option_id": "<one generated option id>", "comparison": "<comparative assessment>", "objections": ["<objection>"], "missing_evidence": ["<missing evidence>"], "tradeoff_question": "<specific choice the operator must make>", "confidence": "<low|medium|high>" }',
    'Use the proposal aggregate and source reports. Treat this as the stress review inside the Decision stage, not as a separate canonical Review stage. Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse and validates the full report body against explore.tournament-review@v1 before writing reports/tournament-review.json.',
  ].join(' '),
};
