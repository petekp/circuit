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
    'The selected Review target is authoritative. Review sees only the captured evidence in this prompt. Evaluate findings only against the selected diff or content in the intake. Do not read repository files, run tools, substitute another Git view, working-tree layer, commit, range, or PR, or report unrelated issues. If the selected evidence is missing or incomplete, say so and never claim that the target has no issues.',
    'Match the question to the evidence. When the intake carries a diff, review the change: judge what it does to the code around it, and do not report pre-existing conditions it did not introduce. When the intake carries whole file contents instead of a diff, review the code as it stands: the file is the subject, none of it is necessarily new, and every finding should name what is wrong now rather than what changed. Never describe a snapshot as if it were a change, or a change as if it were the whole file.',
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
