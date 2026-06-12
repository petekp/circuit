// Shared assembly helpers for relay shape-hint instructions.
//
// `shapeInstruction` prefixes a rendered JSON skeleton with the canonical
// opening line; `mechanicalTail` appends the parse/validate contract every
// schema hint must carry. The `relay-prompt-hygiene` test enforces three of
// those clauses (no code fences, no surrounding prose, JSON.parse) across
// every registered hint, so flow authors reach for these bookends and keep
// only their task-specific guidance as authored prose. Keeping the contract
// text in one place is what lets it stay identical across flows.
//
// `reportPath` is optional: pass it when a step writes to a single stable
// path (most flows) and omit it when the path is step-numbered or otherwise
// ambiguous, so the tail never cites a path the worker can't trust.

export function shapeInstruction(skeleton: string): string {
  return `Respond with a single raw JSON object whose top-level shape is exactly: ${skeleton}`;
}

export function mechanicalTail(schema: string, reportPath?: string): string {
  const validation =
    reportPath === undefined
      ? `The runtime parses your response with JSON.parse, rejects verdicts the schema does not allow, and validates the full report body against ${schema}.`
      : `The runtime parses your response with JSON.parse, rejects verdicts the schema does not allow, and validates the full report body against ${schema} before writing ${reportPath}.`;
  return [
    'Do not include extra top-level keys.',
    'Do not wrap the JSON in Markdown code fences.',
    'Do not include any prose before or after the JSON object.',
    validation,
  ].join(' ');
}
