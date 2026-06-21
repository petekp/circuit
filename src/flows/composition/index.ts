// Flow-shape composition (experimental, default-OFF).
//
// Public surface of the composer. Importing this module is inert: nothing here
// runs unless a caller invokes composeFlow. The stable task-aware assembler and
// the eight built-ins do not import it, so their compiled output is unaffected
// (proven by the equivalence + drift tests). Integration behind the experimental
// flag wires it into the assembler; until then it is reachable only from the
// eval harness and tests.

export {
  composeFlow,
  keyFor,
  RESEARCH_THEN_BUILD,
  GOAL_THEN_FIX,
  GOAL_CLARIFY_THEN_FIX,
  FANOUT_PARALLEL_BUILD,
  BUILD_LINEAR_FULL,
  type CompositionRole,
  type CompositionRoleSet,
  type CompositionWall,
  type ComposeOutcome,
  type ComposedSelection,
  type FanoutBranchRole,
  type RelayRole,
} from './composer.js';
export {
  deriveActualMenu,
  entryIsRegisteredFor,
  type MenuEntry,
  type ExecutionKind,
} from './actual-menu.js';
export {
  evaluateValidity,
  evaluateRunnability,
  evaluateNovelty,
  evaluateSensibility,
  evaluateTopology,
  blockSequence,
  outputIsReadableContract,
  type ValidityVerdict,
  type RunnabilityVerdict,
  type RunnabilityAbort,
  type NoveltyVerdict,
  type SensibilityVerdict,
  type TopologyVerdict,
  type TopologyBackEdge,
  type TopologyBranch,
  type SequenceStep,
} from './evaluate.js';
export { BLOCK_INTENT, blockIntent, type BlockIntent, type IntentState } from './intent.js';
