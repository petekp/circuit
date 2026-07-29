// Standalone review flow relay instruction.
//
// The audit step fans out one reviewer per unit and registers
// `review.unit-verdict@v1` on the relay channel, so the
// runtime converts that Zod schema to JSON Schema and hands it to the
// connector's structured-output flag (claude-code's `--json-schema`, codex's
// `--output-schema`). The response SHAPE is therefore enforced by the CLI on
// those connectors, and by the runtime Zod parse on every connector.
//
// What stays in prose is what a schema cannot express: which evidence is
// authoritative, how to read it, and how to grade what you find. The shape
// paragraph stays too, because a custom connector has no structured-output
// flag and the prompt is the only steering it gets.

export const reviewRelayInstruction: string = [
  'Respond with a single raw JSON object whose top-level shape is exactly:',
  '{ "unit_id": "<the unit id named in your task>", "verdict": "<one-of-accepted-verdicts>", "findings": [{ "severity": "<critical|high|medium|low>", "id": "<stable finding id>", "text": "<finding text>", "file_refs": ["<file:line reference>"] }], "assessment": "<plain-language paragraph>", "verification": ["<step you performed>"], "confidence_limitations": ["<gap that limits certainty>"] }',
  "Your task names the unit you are reviewing. Copy that id into unit_id exactly. A large target is split into units and reviewed a unit at a time, and the id is how your answer is attributed to the part you were shown; an answer under another unit's id is rejected. Review the evidence in this prompt and nothing else: other units exist, you cannot see them, and they are not your subject.",
  'The selected Review target is authoritative. Review sees only the captured evidence in this prompt. Evaluate findings only against the selected diff or content in the intake. Do not read repository files, run tools, substitute another Git view, working-tree layer, commit, range, or PR, or report unrelated issues. If the selected evidence is missing or incomplete, say so and never claim that the target has no issues.',
  'Match the question to the evidence. When the intake carries a diff, review the change: judge what it does to the code around it, and do not report pre-existing conditions it did not introduce. When the intake carries whole file contents instead of a diff, review the code as it stands: the file is the subject, none of it is necessarily new, and every finding should name what is wrong now rather than what changed. Never describe a snapshot as if it were a change, or a change as if it were the whole file.',
  'Audit the strongest claims in the material under review first: confirm each asserted outcome is backed by evidence you can see, and flag claims of completion, safety, or readiness that the cited evidence does not actually support.',
  'Calibrate severity to impact: critical for a defect that breaks the stated goal or ships a falsehood, high for a real bug or unsupported claim worth fixing before anyone relies on the result, medium for a material gap or risk worth surfacing, low for a minor or cosmetic note. Do not inflate a low note into a blocking finding, and do not bury a real defect as low.',
  'Use an empty findings array when there are no issues: { "unit_id": "...", "verdict": "NO_ISSUES_FOUND", "findings": [], "assessment": "...", "verification": ["..."], "confidence_limitations": ["..."] }.',
  'Use an empty file_refs array when a finding has no file-specific reference.',
  'The assessment field is REQUIRED on every verdict, including NO_ISSUES_FOUND. State plainly what you checked and what you concluded; do not return a bare verdict.',
  'The verification array is your self-report of how you worked the evidence in this prompt: which relayed diffs or files you read, and what you cross-referenced against what. You have no repository, no shell, and no tools here, so never claim to have opened a file, run a command, or executed a test. Include at least one entry on every verdict so the operator can see how the review was done.',
  'The confidence_limitations array names anything that limits certainty: out-of-scope files, omitted untracked content, areas you did not inspect, assumptions you had to make. Use an empty array only when coverage was complete.',
  'Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
  'The runtime parses your response with JSON.parse and validates it against the review.unit-verdict@v1 schema at this step; an extra key, a missing field, or a verdict the schema does not allow is rejected and you are asked again. Only a response that validates reaches the close step, which writes reports/review-result.json.',
].join(' ');
