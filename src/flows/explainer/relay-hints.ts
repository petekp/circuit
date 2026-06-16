// Explainer flow relay shape hints.
//
// Hand-written rather than rendered from Zod (like explore's): the renderer
// cannot reproduce the six-key rubric_model_judgments enumeration (its object
// type collapses to "<key>"), so a mechanical conversion would regress
// guidance. Only the two relay-channel contracts (tournament-proposal,
// hardening) need hints; every other report is compose/checkpoint/verification.

import type { SchemaShapeHint } from '../registries/shape-hints/types.js';

export const explainerTournamentProposalShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'explainer.tournament-proposal@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "accept", "concept_id": "<the concept id named in this branch title>", "concept_label": "<concept label>", "case_summary": "<strongest evidence-backed case for THIS concept>", "fidelity_evidence": ["<O:N or outline citation proving it teaches the real driver>"], "risks": ["<risk>"], "next_action": "<the single next action if this concept is chosen>", "rubric_model_judgments": { "fidelity": "<pass|concern|fail>", "memetic_potential": "<pass|concern|fail>", "entertainment": "<pass|concern|fail>", "cross_audience_reach": "<pass|concern|fail>", "build_feasibility": "<pass|concern|fail>", "novelty": "<pass|concern|fail>" } }',
    'Argue for the concept named in this branch, conceived through its persona lens. Make the strongest evidence-backed case for THIS concept only; do not compare the others. Cite the lossless outline (O:N) to prove the concept teaches the actual driver the paper is about, never the seductive wrong one. Set every rubric_model_judgments value from your own judgment of the six criteria; runtime checks may later veto fidelity (must cite outline evidence) or build_feasibility (must name a next action), so do not encode runtime signals yourself.',
    'Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object. The runtime parses your response with JSON.parse and validates the full body against explainer.tournament-proposal@v1 before writing the branch report.',
  ].join(' '),
};

export const explainerHardeningShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'explainer.hardening@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "<recommend|no-clear-winner|needs-operator>", "recommended_concept_id": "<one concept id, or null>", "teaches_right_driver": <true|false>, "banned_phrase_findings": [{ "phrase": "<phrase that signals the wrong driver>", "present": <true|false>, "note": "<why it is a fidelity risk, with an O:N anchor>" }], "objections": ["<objection>"], "confidence": "<low|medium|high>" }',
    'You are the adversarial fidelity reviewer over the surviving tournament concepts. The danger protagonist is always the seductive wrong driver, never the honest one. Pressure-test each survivor: does it foreground the real mechanism the paper teaches, or the easy-to-misread surface story? Set teaches_right_driver false and verdict no-clear-winner or needs-operator if any recommended concept teaches the wrong driver or leans on a banned phrase. Use recommend only when one concept is faithful and clearly strongest.',
    'Use empty arrays when there are no findings or objections. Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object. The runtime parses your response with JSON.parse and validates the full body against explainer.hardening@v1 before writing reports/explainer/hardening.json.',
  ].join(' '),
};
