// Build flow relay shape hints.
//
// The literal JSON shape for each instruction is rendered from the step's
// Zod report schema via `renderShapeSkeleton`; field-level placeholders come
// from `.describe()` calls in `reports.ts`. Authors keep the task-specific
// guidance and the shared mechanical tail as authored prose.

import { renderShapeSkeleton } from '../registries/shape-hints/from-zod.js';
import { mechanicalTail, shapeInstruction } from '../registries/shape-hints/instruction-helpers.js';
import type { SchemaShapeHint } from '../registries/shape-hints/types.js';
import { BuildContext, BuildImplementation, BuildReview } from './reports.js';

export const buildContextShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'build.context@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(BuildContext)),
    "Read the relevant source and tests before planning. This step is read-only by intent: do not edit files, write files, or run commands that modify the checkout. Scale the breadth of your reading to the run's stated depth (provided to you): at low depth read just the directly implicated files; at high depth map the surrounding modules, callers, and local conventions. sources must contain at least one entry; observations must contain at least one entry. Use an empty open_questions array only when nothing remains unresolved. Every observation must be grounded in the cited sources - do not invent details the sources do not support.",
    'In anticipated_file_extensions, predict the file extensions the implementer will likely touch based on what you read (for example .ts and .test.ts for a typed code change with tests). Use the implementation file types, not every file you read. Use an empty array only when the read gives no confident prediction. This list is advisory: it scopes and warns, it does not bind the implementer.',
    'In slices, decompose the change into an ordered list of independently-verifiable units of implementation work - each a concrete step a worker implements and verification can confirm before the next begins - ordered so each builds on the last. Do NOT include global gates such as "verification passes" or "review completes"; those are not units of work. Give each slice a stable id (slice-1, slice-2, ...) and its own anticipated_file_extensions. Keep the list short: prefer the fewest slices that make the work safely incremental, and use a single slice (or an empty array) when the change is one indivisible unit. At high depth the engine implements and verifies these one at a time; at lower depths the change runs in a single pass regardless.',
    'In guardrails, capture the negative space of the change. Put in non_goals the things the operator said the change must NOT do - boundaries drawn from the goal and brief, not invented. Put in invariants the properties the change must preserve, grounded in what you read (a contract, a data shape, an ordering, a safety property). Both default to empty arrays: declare a guardrail only when it is real and specific, never a generic "do not break anything". These carry forward to the plan and the reviewer checks the change against them.',
    'In allowed_touch_area, name the paths this change is allowed to touch, proposed from what you read - either a directory subtree ending in "/" (for example "src/flows/build/", which covers everything beneath it) or an exact repo-relative file path. Include every place a correct change legitimately needs to reach: the source it edits, the tests that cover it, and any generated output it regenerates. State the allowed area positively; do not list off-limits files. After the build the engine compares the files actually changed - proven from git, not self-reported - against this area, and a change that reaches outside it cannot finish clean. Because the implementer is held to this without trimming the work to fit, leave the array empty whenever you cannot scope the change with confidence: an empty area turns the check off rather than guessing a box.',
    'Include recommended_power ONLY when the relay context states the power dial is auto; omit the key entirely otherwise. When you do include it, judge from the codebase read how strong a model the downstream implementation and review need: "low" for a small localized change with good test coverage, "high" for a wide, subtle, or weakly-tested change, "medium" between. One short rationale sentence.',
    mechanicalTail('build.context@v1', 'reports/build/context.json'),
  ].join(' '),
};

export const buildImplementationShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'build.implementation@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(BuildImplementation)),
    'Make the smallest behaviorally scoped change that satisfies the requested goal. Do not broaden semantics, normalize data, or add extra behavior just because tests still pass.',
    'The plan may carry guardrails: non_goals (things this change must NOT do) and invariants (properties it must preserve). Stay inside the non_goals and preserve every invariant. These are advisory to you here, but the reviewer checks the finished change against them, so a violation will surface as a finding.',
    "When the request names a current slice (its id and intent), implement ONLY that slice's unit of work - the smallest change that satisfies that slice's intent - and leave later slices for their own turn. When no current slice is named, implement the whole plan in one pass. Report changed_files cumulatively: every file changed so far across all slices, not only this slice's files.",
    "The plan's anticipated_file_extensions (and the current slice's, when named) list the file types the grounding read expects to touch. Treat them as an advisory starting scope, not a hard limit: if the real change needs other file types, make the change and report the files you actually touched.",
    'The plan may also carry allowed_touch_area: the paths the grounding read predicted this change should reach. It is advisory to you, not a cage - implement what the slice and goal actually require and report every file you really changed. After you finish, the engine compares your git-proven changes against that area; reaching outside it does not fail the build but surfaces for a human to confirm, so do not pad the change with edits it does not need, and do not trim a necessary change just to stay inside the predicted box.',
    'Use an empty changed_files array only when no file changed. Evidence must contain at least one item.',
    'When the thin envelope you were handed is missing a specific named slice of an upstream report you genuinely need to do the work, you may ask for it through context_request: name one parent step and one dotted field, and request only the slice you are truly missing - never reflexively, and never an everything ask. If the slice you need is not available to pull, say so honestly in your evidence and proceed on the context you have; do not invent what you could not read.',
    mechanicalTail('build.implementation@v1', 'reports/build/implementation.json'),
  ].join(' '),
};

export const buildReviewShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'build.review@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(BuildReview)),
    'Review the change against the requested scope, not just against passing tests. Flag behavior that broadens semantics beyond the goal even when verification passes.',
    'alignment is required. Set scope_adherence by judging the finished change against the brief: within_scope when it does only what the goal asked, exceeds_scope when it reaches beyond. Add one non_goals entry per non_goal the plan declared and one invariants entry per invariant, each restating the plan\'s text with a status and concrete evidence; use empty arrays only when the plan declared none. If you set scope_adherence to exceeds_scope, or mark any non_goal violated or any invariant violated, the verdict cannot be "accept" and you must include at least one finding that explains the breach.',
    "You are also given a git-proven touch_area report: the files the change actually modified and whether they stayed inside the plan's allowed_touch_area. Treat it as ground truth about what was physically touched - more reliable than the implementer's self-reported file list - and let it inform your scope_adherence judgment and your evidence. The engine enforces that boundary separately at close, so your job here is the semantic call, not to re-run the boundary check.",
    'Use an empty findings array only with verdict "accept". Verdicts "accept-with-fixes" and "reject" must include at least one finding. Use an empty file_refs array when a finding has no file-specific reference.',
    mechanicalTail('build.review@v1', 'reports/build/review.json'),
  ].join(' '),
};
