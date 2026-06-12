// Goal flow relay shape hints.
//
// The literal JSON shape for each instruction is rendered from the step's
// Zod report schema via `renderShapeSkeleton`, so the skeleton can never
// drift from the schema and mutable fields render as placeholders rather
// than baked-in example values. The gate and gate-pass hints both render
// the GoalGate schema: a gate pass is bound as goal.gate-pass@v1 but shares
// the goal.gate@v1 body validator, so its skeleton (and the schema field
// inside it) stays goal.gate@v1 by construction.

import { renderShapeSkeleton } from '../registries/shape-hints/from-zod.js';
import { mechanicalTail, shapeInstruction } from '../registries/shape-hints/instruction-helpers.js';
import type { SchemaShapeHint } from '../registries/shape-hints/types.js';
import { GoalClarifiedTask, GoalGate } from './reports.js';

export const goalClarifiedTaskShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'goal.clarified-task@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(GoalClarifiedTask)),
    'Borrow only the useful Goal prompt ingredients: outcome, proof, constraints, boundaries, iteration policy, and blocked stop condition.',
    'Do not include adversarial review instructions, two-clean-review language, or medium-or-above finding ceremony; Goal gate steps own that later.',
    'Do not claim completion. Do not select or invent dynamic child flows. Preserve the operator request and keep the clarified prompt compact.',
    'Use verdict ask only when missing information makes the Goal unsafe or impossible to verify. Use verdict stop only when this is not a durable, checkable Goal-shaped task.',
    mechanicalTail('goal.clarified-task@v1'),
  ].join(' '),
};

export const goalGateShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'goal.gate@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(GoalGate)),
    'Blocking findings are severities critical, high, or medium. Any blocking finding must set verdict to blocked, clean_streak to 0, and next_route to recover.',
    'A gate-pass verdict must have no blocking findings. Use next_route close only when clean_streak is at least 2. Use run-next-gate-pass when this pass is clean but another clean pass is still required.',
    'The passes array must include every clean pass counted by clean_streak. If a prior gate report is present, copy its passes and append the current pass before using next_route close.',
    mechanicalTail('goal.gate@v1'),
  ].join(' '),
};

export const goalGatePassShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'goal.gate-pass@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(GoalGate)),
    'The report is bound as goal.gate-pass@v1, but the JSON schema field remains goal.gate@v1 so both gate passes share the same body validator.',
    'Blocking findings are severities critical, high, or medium. Any blocking finding must set verdict to blocked, clean_streak to 0, and next_route to recover.',
    'A gate-pass verdict must have no blocking findings. Use next_route run-next-gate-pass when this pass is clean but another clean pass is still required.',
    'The passes array must include one object for each clean pass counted by clean_streak.',
    mechanicalTail('goal.gate@v1'),
  ].join(' '),
};
