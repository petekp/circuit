// Sweep fanout-worker relay shape hint.
//
// Each partition unit is handed to one implementer worker via a fanout branch
// whose report_schema is sweep.unit-fix@v1. Without an explicit shape hint the
// worker receives only its fix_prompt goal and produces a free-form body the
// strict SweepUnitFix schema then rejects, aborting the branch. This hint tells
// the worker the exact JSON to emit so a REAL run's workers report a typed fix.
//
// The judge tail's shape is NOT defined here: it is bound to the built-in
// converge.judgment@v1 contract, which fix-until-green's convergeJudgmentRelayShapeHint
// already covers globally (it keys on the bound contract, not a flow id). Sweep
// must not re-register that hint — buildStructuralHintList throws on a duplicate
// id — so Sweep registers only this worker hint and inherits the judge hint.

import type { SchemaShapeHint } from '../registries/shape-hints/types.js';

export const sweepUnitFixShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'sweep.unit-fix@v1',
  instruction: [
    'You are one worker in a wave clearing a backlog of one mechanical finding. Your goal names a single file and the findings to clear in it. Fix the underlying cause of every finding in that file. Change only that file.',
    'Do not add suppression directives (no eslint-disable, no @ts-ignore/@ts-expect-error, no equivalent) and do not edit the project config to hide the finding. Both are audited separately and will keep the run red — a suppressed finding is a failed fix, not a passed one.',
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "unit_id": "<the unit id this branch was assigned>", "verdict": "<fixed|partial|blocked>", "changed_files": ["<repo-relative path you edited>"], "rule_fixed": "<the rule id you cleared>", "evidence": "<what you changed and why it clears the findings>" }',
    'Set unit_id to the exact unit id named in your assignment; the runtime rejects a report whose unit_id is not the unit you were given. Use verdict "fixed" when you cleared every finding in the file, "partial" when you cleared some, and "blocked" only when you could change nothing (a blocked worker leaves its findings for the next wave). A "fixed" or "partial" verdict MUST list at least one changed file; a "blocked" verdict lists none.',
    'Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse and validates the full body against sweep.unit-fix@v1 before writing your branch report. The wave does not trust your verdict to decide whether the backlog is clear — a pinned re-scan does that — so report honestly.',
  ].join(' '),
};
