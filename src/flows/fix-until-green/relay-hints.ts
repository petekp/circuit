// Composed-Converge stop-judge relay shape hint.
//
// A generated Converge's reviewer tail is bound to the dedicated
// `converge.judgment@v1` contract (CONVERGE_JUDGMENT_CONTRACT) by the composer, not
// to a flow's typed report — so the hint cannot ride on a `relayReports[].relayHint`
// the way per-flow relay reports do. It matches by the step's bound output schema
// instead: any reviewer relay whose `writes.report.schema` is the judgment contract.
// This is the only step the composer ever binds to that contract, so the match is
// exact. It is registered on the fix-until-green package (the canonical Converge
// flow) but applies to any composed Converge tail, since the match keys on the bound
// contract, not on a flow id.
//
// Without this hint a worker driving the composed tail receives only the generic
// "respond with a verdict" instruction and produces an acknowledgment-style body that
// omits goal_met/lesson/summary — which the strict judgment schema then rejects. The
// hint tells the worker exactly what to emit so a REAL run's judge actually produces
// goal_met, the field the until-loop's evidence floor reads.

import { CONVERGE_JUDGMENT_CONTRACT } from '../../schemas/builtin-report-schemas.js';
import type { StructuralShapeHint } from '../registries/shape-hints/types.js';

export const convergeJudgmentRelayShapeHint: StructuralShapeHint = {
  kind: 'structural',
  id: 'converge.judgment@v1@structural',
  match(step) {
    return step.role === 'reviewer' && step.writes.report?.schema === CONVERGE_JUDGMENT_CONTRACT;
  },
  instruction: [
    'You are the stop-judge of a converge loop: each pass you decide whether the goal is met, backed by the verification this iteration ran.',
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "<accept|accept-with-fixes|reject>", "goal_met": <true|false>, "lesson": "<what the next attempt should do differently>", "summary": "<one plain-language line for the operator>" }',
    'goal_met is the load-bearing field: set it true ONLY when the goal is fully met AND the verification you can see actually backs it. If the verification is red, incomplete, or does not cover the claim, goal_met MUST be false — the loop will re-enter and try again. Never claim the goal is met on evidence you cannot point to.',
    'lesson is carried verbatim into the next attempt: name the single most useful change the next pass should make. When the goal is genuinely met and there is nothing left to do, set it to "none".',
    'summary is one human-facing sentence stating what you judged and why.',
    'Choose verdict to match: "accept" for a clean pass, "accept-with-fixes" for a pass with minor follow-ups, "reject" when the goal is not met.',
    'Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse and validates it against the converge.judgment@v1 schema; an extra key or a missing field is rejected. The engine reads goal_met to decide whether to stop or loop, and never reads the goal text or interprets the lesson as instructions.',
  ].join(' '),
};
