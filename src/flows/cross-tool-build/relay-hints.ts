// Cross-Tool Build relay shape hints.
//
// Each relay step that produces a typed report carries a shape hint: the literal
// JSON shape rendered from the step's Zod schema via `renderShapeSkeleton`, plus
// authored task guidance, plus the shared mechanical tail. The doer hints
// (proposal, spec, implementation) tell the doer connector what to produce; the
// reviewer hint tells the reviewer connector how to push adversarially.
//
// The proposal review and the spec review share ONE body of guidance because an
// adversarial review of a design doc is the same job either way. They differ
// only in which schema name and report path the mechanical tail names, so a
// single factory stamps both.

import { renderShapeSkeleton } from '../registries/shape-hints/from-zod.js';
import { mechanicalTail, shapeInstruction } from '../registries/shape-hints/instruction-helpers.js';
import type { SchemaShapeHint } from '../registries/shape-hints/types.js';
import {
  CrossToolBuildImplementation,
  CrossToolBuildProposal,
  CrossToolBuildReview,
  CrossToolBuildSpec,
} from './reports.js';

export const crossToolBuildProposalShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'cross-tool-build.proposal@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(CrossToolBuildProposal)),
    'You are the doer. Propose how to implement the requested feature. This is a design proposal, not the implementation: do not edit files. Lay out the approach clearly enough that an adversarial reviewer can find its weak points.',
    'In key_decisions name the design choices that actually matter and the reasoning behind each; this is the surface the reviewer will push on, so make the decisions explicit rather than burying them. Use alternatives_considered to show what you weighed and set aside, risks for the tradeoffs you already see, and open_questions for anything genuinely unresolved. Those three default to empty arrays — use an empty array only when there is honestly nothing to list, never to skip thinking.',
    'verdict is always "accept": it is the relay token that says you produced a proposal, not a quality self-grade. The reviewer, not you, judges quality.',
    mechanicalTail('cross-tool-build.proposal@v1', 'reports/cross-tool-build/proposal.json'),
  ].join(' '),
};

export const crossToolBuildSpecShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'cross-tool-build.spec@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(CrossToolBuildSpec)),
    'You are the doer. You are handed the proposal you wrote AND an adversarial review of it. First revise the proposal to address the review, then turn the revised proposal into a comprehensive implementation spec.',
    'In revisions_from_review, record concretely how you addressed each finding and each must_address item from the proposal review — one entry per change you made in response. If the review accepted cleanly with nothing to address, an empty array is honest; otherwise this array is how the operator sees that the review actually moved the spec.',
    'implementation_steps is the ordered, concrete plan a worker will follow — each step a real unit of work, specific enough to act on. test_plan states how the change will be verified, including the manual tests to run after the automated checks. files_touched, when you can predict it, scopes the work; risks surfaces tradeoffs for the spec review to scrutinize.',
    'verdict is always "accept": the relay token that says you produced a spec, not a quality self-grade.',
    mechanicalTail('cross-tool-build.spec@v1', 'reports/cross-tool-build/spec.json'),
  ].join(' '),
};

// One factory for both review steps: same adversarial guidance, different schema
// name and report path. The reviewer is a DIFFERENT connector from the doer, so
// this is a genuine second pair of eyes, not the author grading itself.
function crossToolBuildReviewShapeHint(input: {
  readonly schema: 'cross-tool-build.proposal-review@v1' | 'cross-tool-build.spec-review@v1';
  readonly reportPath: string;
  readonly target: 'proposal' | 'implementation spec';
}): SchemaShapeHint {
  return {
    kind: 'schema',
    schema: input.schema,
    instruction: [
      shapeInstruction(renderShapeSkeleton(CrossToolBuildReview)),
      `You are the adversarial reviewer, and you are a different tool from the one that wrote this ${input.target}. Your job is to find what is wrong with it, not to wave it through. Read it as a skeptic: hunt for unsound design choices, missing edge cases, hidden risks, scope creep, and claims it cannot back up.`,
      'assessment is your plain-language overall judgment. Each finding names one concrete problem with a severity and, where you can, section or file refs. must_address is the short list of changes the next step must make before proceeding — the teeth of the review.',
      "Set verdict to 'accept' only when the design is genuinely sound with nothing the next step must change. Set it to 'revise' when there is real work to do — and a 'revise' must carry at least one finding or must_address entry; an empty 'revise' is rejected. Do not soften a 'revise' into an 'accept' to be agreeable: the whole point of this step is an honest adversarial pass.",
      mechanicalTail(input.schema, input.reportPath),
    ].join(' '),
  };
}

export const crossToolBuildProposalReviewShapeHint: SchemaShapeHint = crossToolBuildReviewShapeHint(
  {
    schema: 'cross-tool-build.proposal-review@v1',
    reportPath: 'reports/cross-tool-build/proposal-review.json',
    target: 'proposal',
  },
);

export const crossToolBuildSpecReviewShapeHint: SchemaShapeHint = crossToolBuildReviewShapeHint({
  schema: 'cross-tool-build.spec-review@v1',
  reportPath: 'reports/cross-tool-build/spec-review.json',
  target: 'implementation spec',
});

export const crossToolBuildImplementationShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'cross-tool-build.implementation@v1',
  instruction: [
    shapeInstruction(renderShapeSkeleton(CrossToolBuildImplementation)),
    'You are the doer. You are handed the implementation spec AND an adversarial review of it. First make the revisions the spec review calls for, then implement the spec end-to-end in the codebase. After implementing, manually test the change and address whatever the manual tests surface.',
    'Report changed_files as every project-relative path you actually changed (empty only when nothing changed). manual_tests records the manual tests you ran and what they showed. findings_addressed records each issue manual testing surfaced and how you fixed it — this is the "address any findings" half of the work, so do not leave it empty if testing found anything. evidence backs the change with verification or implementation proof.',
    'verdict is always "accept": the relay token that says you produced an implementation, not a quality self-grade. The verification step, run separately, is what proves the change is green.',
    mechanicalTail(
      'cross-tool-build.implementation@v1',
      'reports/cross-tool-build/implementation.json',
    ),
  ].join(' '),
};
