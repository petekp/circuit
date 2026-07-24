// Dispatch shim between the run entrypoints and the one flow that selects a
// Git target today. If a second flow ever adopts targets, derive this from the
// flow catalog instead of naming flow ids here.
//
// This is a parse-level gate only: it refuses a goal whose target cannot be
// read at all (two targets in one goal, a path subset, a pull request) before
// the entrypoint creates a run. Whether that target is *available* in this
// repository is answered once, by the intake step, using the evidence it is
// about to relay. Asking twice would read the whole diff twice and let the two
// answers disagree.
import { parseReviewTarget } from '../review/writers/intake.js';

export function validateFlowStartTarget(flowId: string, goal: string): void {
  if (flowId !== 'review') return;
  const parsed = parseReviewTarget(goal);
  if (!parsed.ok) throw new Error(parsed.reason);
}
