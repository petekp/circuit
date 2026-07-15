// Fix flow relay shape hints.
//
// The literal JSON shape for each instruction is rendered from the
// step's Zod report schema via `renderShapeSkeleton`. Field-level
// placeholders come from `.describe()` calls on the schema fields in
// `reports.ts` — that keeps the shape and its worker-facing
// description in one place. The renderer's output is then surrounded
// by the task-specific guidance and a small mechanical tail that
// reminds the worker of the parse/validate contract.

import { renderShapeSkeleton } from '../registries/shape-hints/from-zod.js';
import { mechanicalTail, shapeInstruction } from '../registries/shape-hints/instruction-helpers.js';
import type { SchemaShapeHint } from '../registries/shape-hints/types.js';
import { FixChange, FixContext, FixDiagnosis, FixReview } from './reports.js';

export const fixContextShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'fix.context@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(FixContext)),
    'Read the relevant source and tests before reporting context. This step is read-only by intent: do not edit files, write files, or run commands that modify the checkout. Include the files, commands, or notes that define the bug boundary and the proof commands the operator expects. sources must contain at least one entry; observations must contain at least one entry. Use an empty open_questions array only when nothing remains unresolved. Every observation must be grounded in the cited sources — do not invent details that the sources do not support.',
    mechanicalTail('fix.context@v1', 'reports/fix/context.json'),
  ].join(' '),
};

export const fixDiagnosisShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'fix.diagnosis@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(FixDiagnosis)),
    'Compare the failing behavior against the intended behavior before naming the cause. This step is read-only by intent: do not edit files, write files, or run commands that modify the checkout. Check whether the bug could have sibling edge cases, not only the first failing assertion. evidence must contain at least one entry (file:line, command result, or report reference that supports the cause), expressed as a JSON array of short distinct strings (one supporting fact per element). residual_uncertainty must be non-empty whenever reproduction_status is anything other than "reproduced" — if you could not cleanly reproduce the bug, name the unknowns honestly. Calibrate confidence to the evidence: do not claim "high" without direct reproduction or equivalent proof.',
    'Include recommended_power ONLY when the relay context states the power dial is auto; omit the key entirely otherwise. When you do include it, judge from the code you read how strong a model the downstream fix and review need: "low" for a small localized change with good test coverage, "high" for a wide, subtle, or weakly-tested change, "medium" between. One short rationale sentence.',
    mechanicalTail('fix.diagnosis@v1', 'reports/fix/diagnosis.json'),
  ].join(' '),
};

export const fixChangeShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'fix.change@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(FixChange)),
    'Make the smallest change that resolves the diagnosed cause and address every objective check named in the brief. Do not stop at the first green assertion if the brief names multiple formats, modes, or edge commands. Do not refactor adjacent code, broaden behavior, or address unrelated issues in the same edit. changed_files must contain at least one entry; evidence must contain at least one entry (test output, command result, or before/after observation that confirms the change works).',
    '`evidence` is a JSON array of short distinct strings — one observation per element. It is a schema field name, not a request for prose. Even on retry attempts where you are summarizing prior verification output, keep each observation as its own array element.',
    mechanicalTail('fix.change@v1', 'reports/fix/change.json'),
  ].join(' '),
};

export const fixReviewShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'fix.review@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(FixReview)),
    "Review the change against the diagnosed cause and the brief's success criteria, not just against passing verification. Look for missed edge cases, partially handled input variants, and changes that broaden semantics beyond the bug being fixed even when the regression test passes.",
    'Verdict "accept" is only for a clean review and must use an empty findings array. Any actionable finding must use verdict "accept-with-fixes" or "reject" and will route the work back for another implementation pass. Those rework verdicts must include at least one finding. Use an empty file_refs array when a finding has no file-specific reference.',
    mechanicalTail('fix.review@v1', 'reports/fix/review.json'),
  ].join(' '),
};
