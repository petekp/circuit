// Pursue flow relay shape hints.
//
// These skeletons stay hand-written rather than rendered from Zod via
// `renderShapeSkeleton` (as goal/build/fix do): the renderer cannot
// reproduce the per-bucket status pinning (each of completed/skipped/blocked/
// failed shares one item schema, so the renderer shows the full status enum
// in every bucket instead of the fixed status that bucket expects), so a
// mechanical migration would regress guidance.

import type { SchemaShapeHint } from '../registries/shape-hints/types.js';

export const pursuitBatchShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'pursuit.batch@v1',
  instruction: [
    'Respond with a single raw JSON object for pursuit.batch@v1.',
    'Shape: { "verdict": "<accept|partial|blocked>", "summary": "<plain summary>", "serialized_execution": true, "completed": [{ "pursuit_id": "<id>", "status": "completed", "summary": "<what happened>", "evidence": ["<evidence>"] }], "skipped": [{ "pursuit_id": "<id>", "status": "skipped", "summary": "<why skipped>", "evidence": [] }], "blocked": [{ "pursuit_id": "<id>", "status": "blocked", "summary": "<why blocked>", "evidence": [] }], "failed": [{ "pursuit_id": "<id>", "status": "failed", "summary": "<why failed>", "evidence": [] }], "actual_touch_set": { "paths": ["<changed or inspected project-relative path>"], "symbols": ["<symbol>"], "commands": ["<command>"], "generated_outputs": ["<generated output path>"] }, "proof_evidence": ["<evidence>"] }.',
    'Execute code-changing work serially. Do not run parallel code-writing agents. If a pursuit cannot be safely completed serially, put it in blocked rather than guessing.',
    'Keep estimated touch sets separate from actual touch sets. actual_touch_set must describe what really changed or was materially inspected during this batch.',
    'Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse and validates the full report body against pursuit.batch@v1.',
  ].join(' '),
};

export const pursuitReviewShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'pursuit.review@v1',
  instruction: [
    'Respond with a single raw JSON object for pursuit.review@v1.',
    'Shape: { "verdict": "<clean|needs-followup|blocked>", "summary": "<review summary>", "findings": [{ "severity": "<critical|high|medium|low>", "text": "<finding text>", "file_refs": ["<file:line>"] }] }.',
    'Review whether the batch followed the pursuit contract, serialized code-changing work, preserved the difference between estimated and actual touch sets, and surfaced skipped or blocked pursuits honestly.',
    'Use verdict "clean" only when there are no findings. Use "needs-followup" only for low-severity findings. Use "blocked" when any finding is medium, high, or critical so the flow closes honestly as blocked instead of reporting completion.',
    'Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse and validates the full report body against pursuit.review@v1.',
  ].join(' '),
};
