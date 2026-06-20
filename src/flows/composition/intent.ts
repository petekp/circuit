// Flow-shape composition (experimental, default-OFF): per-block INTENT.
//
// The block catalog (FLOW_BLOCK_DEFINITIONS) describes each block's CONTRACT
// surface — the typed inputs it reads and the output it produces. That is
// enough for the fail-closed gates to prove a flow is wire-valid, but it is not
// enough to prove the flow MAKES SENSE: contracts can close while the intents
// behind them do not belong in that order (e.g. a review before any change
// exists). This module adds the missing layer — a small, additive,
// catalog-independent map of each block's semantic PRE/POST-conditions, stated
// as state tokens rather than contracts. It is read only by the experimental
// composer + its sensibility checker; the eight built-ins and the block catalog
// are untouched, so nothing here can change a shipped flow.
//
// The tokens are a deliberately tiny controlled vocabulary describing the
// research-then-build family the Phase 0 milestone targets. Phase 1 broadens
// the vocabulary as it broadens block coverage.

import type { FlowBlockId } from '../../schemas/flow-blocks.js';

// The controlled vocabulary of semantic states a block can require (pre) or
// establish (post). Kept small on purpose: a token is added only when a block
// genuinely depends on a state an earlier block establishes.
export type IntentState =
  | 'task-framed' // the operator task is captured as a brief
  | 'context-gathered' // relevant code/context has been collected
  | 'diagnosed' // a root cause / analysis exists
  | 'plan-formed' // a strategy/plan of attack exists
  | 'change-made' // an implementation change has been produced
  | 'change-verified' // the change has been run through verification
  | 'change-reviewed' // the change has been independently audited
  | 'decision-made' // an operator decision has been recorded
  | 'result-emitted'; // a terminal result/handoff has been composed

export interface BlockIntent {
  // One-line operator-readable role of the block in a flow.
  readonly role: string;
  // States that must already hold for this block to make sense. Satisfied by an
  // upstream block's postconditions or by the flow's initial state.
  readonly precondition: readonly IntentState[];
  // States this block establishes for downstream blocks.
  readonly postcondition: readonly IntentState[];
}

// Phase 0 enrichment: the blocks the research-then-build milestone composes,
// plus the close-adjacent blocks needed to terminate a flow. Each entry is
// additive metadata; none of it is consulted by the stable assembler or the
// gates.
export const BLOCK_INTENT: Partial<Record<FlowBlockId, BlockIntent>> = {
  frame: {
    role: 'Capture the task boundary as a brief',
    precondition: [],
    postcondition: ['task-framed'],
  },
  'review-intake': {
    role: 'Capture the review scope as a brief',
    precondition: [],
    postcondition: ['task-framed'],
  },
  clarify: {
    // The frame analog for an ambiguous ask: clarify reads the raw operator
    // intake (catalog input task.intake@v1 — no prior brief) and turns it into a
    // precise task, so its precondition is empty and it establishes the same
    // 'task-framed' state `frame` and `goal` do. A flow that opens with clarify
    // (a vague bug report) instead of frame therefore still closes its intent.
    role: 'Clarify an ambiguous request into a precise task',
    precondition: [],
    postcondition: ['task-framed'],
  },
  'gather-context': {
    role: 'Collect the code and context the task touches',
    precondition: ['task-framed'],
    postcondition: ['context-gathered'],
  },
  diagnose: {
    role: 'Find the root cause / analyze the problem',
    precondition: ['task-framed'],
    postcondition: ['diagnosed'],
  },
  plan: {
    role: 'Form a strategy before acting',
    precondition: ['task-framed'],
    postcondition: ['plan-formed'],
  },
  act: {
    role: 'Make the implementation change',
    precondition: ['task-framed'],
    postcondition: ['change-made'],
  },
  'run-verification': {
    // Precondition is 'task-framed', NOT 'change-made': the catalog uses
    // run-verification both AFTER a change (fix/build verify steps) and BEFORE
    // one (build-baseline captures a pre-change snapshot; a gather-then-verify
    // flow checks the existing suite). 'change-made' would be a false universal.
    // The post-change ordering, where it applies, is carried by the CONTRACT
    // layer instead: a verification that means to check a change reads
    // change.evidence, which only an upstream act produces.
    role: 'Run verification — of a change just made, or of the existing state',
    precondition: ['task-framed'],
    postcondition: ['change-verified'],
  },
  review: {
    // Precondition is 'task-framed', NOT 'change-made': the built-in `review`
    // flow audits pre-existing code (frame -> review -> close) with no in-flow
    // change at all. Requiring 'change-made' would reject that real pattern.
    // When a review means to audit a change, its CONTRACT (reads change.evidence
    // + verification.result) ties it to the upstream act, not its intent.
    role: 'Independently audit a change, or the existing code',
    precondition: ['task-framed'],
    postcondition: ['change-reviewed'],
  },
  'human-decision': {
    role: 'Pause for an operator go/no-go',
    precondition: ['task-framed'],
    postcondition: ['decision-made'],
  },
  goal: {
    // The sub-run analog of `frame`: instead of a brief, it captures the task as
    // a goal CONTRACT a child flow can be delegated against. It establishes the
    // same 'task-framed' state `frame` does, so a downstream close/verify/review
    // precondition is satisfied whether the flow opened with a brief or a goal.
    role: 'Capture the task as a goal contract for delegation',
    precondition: [],
    postcondition: ['task-framed'],
  },
  'goal-child-run': {
    // Delegates the whole task to a child flow and is admitted back only through
    // the child's result verdict. It needs the goal framed (the contract the
    // delegation rides on) but establishes no UNIVERSAL downstream state: the
    // child may fix (change made + verified), build, explore (no change), or
    // review, so claiming any one post-state would be a false universal — the same
    // reasoning that keeps run-verification/review preconditions minimal. What the
    // child produced is carried by the CONTRACT layer (its result_path), which the
    // terminal close consumes, not by an intent token.
    role: 'Delegate the task to a child flow and admit its verdict',
    precondition: ['task-framed'],
    postcondition: [],
  },
  'close-with-evidence': {
    role: 'Compose the terminal result with evidence',
    precondition: ['task-framed'],
    postcondition: ['result-emitted'],
  },
  handoff: {
    role: 'Persist a handoff for a later session',
    precondition: ['task-framed'],
    postcondition: ['result-emitted'],
  },
};

export function blockIntent(blockId: FlowBlockId): BlockIntent | undefined {
  return BLOCK_INTENT[blockId];
}
