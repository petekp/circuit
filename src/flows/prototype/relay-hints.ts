import type { SchemaShapeHint } from '../registries/shape-hints/types.js';

export const prototypeArtifactShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'prototype.artifact@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "<accept|blocked>", "summary": "<what prototype files were created or why blocked>", "prototype_root": "<project-relative prototype directory>", "created_files": ["<project-relative path under prototype_root>"], "entry_points": ["<project-relative path under prototype_root>"], "preview_instructions": "<how to inspect locally>", "known_limitations": ["<honest limitation>"], "evidence": ["<file or check evidence>"], "claim_limits": ["not production", "not deployed"] }',
    'Create only disposable prototype files under the prototype_root from the plan. Do not edit production application code, generated host packages, or release metadata.',
    'Use verdict "accept" only when the entry points and created files exist under prototype_root. Use verdict "blocked" when you cannot create the artifact, and still report any evidence you gathered.',
    'Do not claim deployment, production readiness, provider behavior, model behavior, branch previews, screenshots, or hosted URLs. Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse, rejects verdicts the schema does not allow, validates the full report body against prototype.artifact@v1, and verifies reported artifact paths before writing the final Prototype result.',
  ].join(' '),
};

export const prototypeVariantArtifactShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'prototype.variant-artifact@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "<accept|blocked>", "variant_id": "<the assigned variant_id>", "variant_label": "<the assigned label>", "summary": "<what this variant created or why blocked>", "prototype_root": "<shared prototype root>", "variant_root": "<prototype_root/variants/variant_id>", "created_files": ["<project-relative path under variant_root>"], "entry_points": ["<project-relative path under variant_root>"], "preview_instructions": "<how to inspect locally>", "known_limitations": ["<honest limitation>"], "evidence": ["<file or check evidence>"], "rubric_model_judgments": { "evidence_rigor": "<pass|concern|fail>", "actionability": "<pass|concern|fail>", "coverage_adequacy": "<pass|concern|fail>", "scope_discipline": "<pass|concern|fail>", "honest_calibration": "<pass|concern|fail>", "project_specificity": "<pass|concern|fail>", "insight_density": "<pass|concern|fail>", "branch_distinctness": "<pass|concern|fail>" }, "claim_limits": ["not production", "not deployed"] }',
    'Create only disposable prototype files under variant_root. Do not edit production application code, generated host packages, release metadata, or sibling variants.',
    'Use verdict "accept" only when the entry points and created files exist under variant_root. Use verdict "blocked" when you cannot create the artifact, and still report any evidence you gathered.',
    'Do not claim deployment, production readiness, provider behavior, model behavior, branch previews, screenshots, or hosted URLs. The provider/model comparison evidence is captured by the runtime trace, not by this report.',
    'The runtime parses your response with JSON.parse and validates the full report body against prototype.variant-artifact@v1.',
    'Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
  ].join(' '),
};

export const prototypeVariantReviewShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'prototype.variant-review@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "<recommend|no-clear-winner|needs-operator>", "recommended_variant_id": "<variant id from the aggregate>", "comparison_summary": "<plain-language comparison grounded in the variant reports>", "strengths": [{ "variant_id": "<variant id>", "note": "<specific strength>" }], "risks": ["<risk or limitation>"], "missing_evidence": ["<missing evidence, if any>"], "confidence": "<low|medium|high>" }',
    'Compare only the local prototype artifacts, verification report, provider evidence report, and aggregate evidence. Do not claim any provider or model actually ran unless the provider evidence report captured it from relay.started trace entries.',
    'The runtime parses your response with JSON.parse and validates the full report body against prototype.variant-review@v1.',
    'Do not claim deployment, production readiness, branch previews, screenshots, hosted URLs, or production fitness. Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
  ].join(' '),
};
