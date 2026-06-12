import type { SchemaShapeHint } from '../registries/shape-hints/types.js';

export const goalClarifiedTaskShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'goal.clarified-task@v1',
  instruction: [
    'Respond with a single raw JSON object for goal.clarified-task@v1 whose top-level shape is exactly:',
    '{ "schema": "goal.clarified-task@v1", "verdict": "continue|ask|stop", "original_request": "...", "target": { "kind": "flow", "id": "goal" }, "guide_id": "goal-v1", "clarified_prompt": "...", "objective": "...", "desired_outcome": "...", "proof_needed": [{ "kind": "command|report|review|source|checkpoint", "description": "...", "required": true }], "constraints": [], "scope": { "in_bounds": [], "out_of_bounds": [] }, "assumptions": [], "missing_information": [], "iteration_policy": [], "stop_conditions": [], "suggested_parts": [] }',
    'Borrow only the useful Goal prompt ingredients: outcome, proof, constraints, boundaries, iteration policy, and blocked stop condition.',
    'Do not include adversarial review instructions, two-clean-review language, or medium-or-above finding ceremony; Goal gate steps own that later.',
    'Do not claim completion. Do not select or invent dynamic child flows. Preserve the operator request and keep the clarified prompt compact.',
    'Use verdict ask only when missing information makes the Goal unsafe or impossible to verify. Use verdict stop only when this is not a durable, checkable Goal-shaped task.',
    'Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object. The runtime parses your response with JSON.parse and validates the full report body against goal.clarified-task@v1.',
  ].join(' '),
};

export const goalGateShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'goal.gate@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "schema": "goal.gate@v1", "verdict": "gate-pass|blocked", "clean_streak": 0, "required_passes": 2, "blocking_findings": [], "low_findings": [], "passes": [], "next_route": "run-next-gate-pass|recover|close" }',
    'Blocking findings are severities critical, high, or medium. Any blocking finding must set verdict to blocked, clean_streak to 0, and next_route to recover.',
    'A gate-pass verdict must have no blocking findings. Use next_route close only when clean_streak is at least 2. Use run-next-gate-pass when this pass is clean but another clean pass is still required.',
    'The passes array must include every clean pass counted by clean_streak. If a prior gate report is present, copy its passes and append the current pass before using next_route close.',
    'Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object. The runtime parses your response with JSON.parse and validates the full report body against goal.gate@v1.',
  ].join(' '),
};

export const goalGatePassShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'goal.gate-pass@v1',
  instruction: [
    'Respond with a single raw JSON object for goal.gate-pass@v1 whose top-level shape is exactly:',
    '{ "schema": "goal.gate@v1", "verdict": "gate-pass|blocked", "clean_streak": 0, "required_passes": 2, "blocking_findings": [], "low_findings": [], "passes": [], "next_route": "run-next-gate-pass|recover|close" }',
    'The report is bound as goal.gate-pass@v1, but the JSON schema field remains goal.gate@v1 so both gate passes share the same body validator.',
    'Blocking findings are severities critical, high, or medium. Any blocking finding must set verdict to blocked, clean_streak to 0, and next_route to recover.',
    'A gate-pass verdict must have no blocking findings. Use next_route run-next-gate-pass when this pass is clean but another clean pass is still required.',
    'The passes array must include one object for each clean pass counted by clean_streak.',
    'Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object. The runtime parses your response with JSON.parse and validates the full report body against goal.gate@v1.',
  ].join(' '),
};
