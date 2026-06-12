// Standalone review flow relay shape hint.
//
// The audit step does not register a typed report under
// writes.report (only request_path / receipt_path / result_path), so
// this hint cannot key off step.writes.report.schema. It matches by
// the structural shape of the relay step instead: reviewer role
// plus the NO_ISSUES_FOUND/ISSUES_FOUND check verdicts that mirror the
// review.relay-result body shape.

import type { StructuralShapeHint } from '../registries/shape-hints/types.js';

export const reviewRelayShapeHint: StructuralShapeHint = {
  kind: 'structural',
  id: 'review.relay-result@structural',
  match(step) {
    return (
      step.role === 'reviewer' &&
      step.check.pass.includes('NO_ISSUES_FOUND') &&
      step.check.pass.includes('ISSUES_FOUND')
    );
  },
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "<one-of-accepted-verdicts>", "findings": [{ "severity": "<critical|high|medium|low>", "id": "<stable finding id>", "text": "<finding text>", "file_refs": ["<file:line reference>"] }], "assessment": "<plain-language paragraph>", "verification": ["<step you performed>"], "confidence_limitations": ["<gap that limits certainty>"] }',
    'Audit the strongest claims in the material under review first: confirm each asserted outcome is backed by evidence you can see, and flag claims of completion, safety, or readiness that the cited evidence does not actually support.',
    'Calibrate severity to impact: critical for a defect that breaks the stated goal or ships a falsehood, high for a real bug or unsupported claim worth fixing before anyone relies on the result, medium for a material gap or risk worth surfacing, low for a minor or cosmetic note. Do not inflate a low note into a blocking finding, and do not bury a real defect as low.',
    'Use an empty findings array when there are no issues: { "verdict": "NO_ISSUES_FOUND", "findings": [], "assessment": "...", "verification": ["..."], "confidence_limitations": ["..."] }.',
    'Use an empty file_refs array when a finding has no file-specific reference.',
    'The assessment field is REQUIRED on every verdict, including NO_ISSUES_FOUND. State plainly what you checked and what you concluded; do not return a bare verdict.',
    'The verification array is your self-report of concrete steps you took: files inspected, commands run, evidence cross-referenced. Include at least one entry on every verdict so the operator can audit the review.',
    'The confidence_limitations array names anything that limits certainty: out-of-scope files, omitted untracked content, areas you did not inspect, assumptions you had to make. Use an empty array only when coverage was complete.',
    'Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse, rejects verdicts the schema does not allow, and the close step validates findings, assessment, verification, and confidence_limitations before writing reports/review-result.json.',
  ].join(' '),
};
