// Dispatch shim between the run entrypoints and the one flow that selects a
// Git target today. If a second flow ever adopts targets, derive this from the
// flow catalog instead of naming flow ids here.
//
// This is a parse-level gate only: it refuses a target that cannot be read at
// all (two targets in one goal, a pull request, malformed supplied material)
// before the entrypoint creates a run. Whether that target is *available* in
// this
// repository is answered once, by the intake step, using the evidence it is
// about to relay. Asking twice would read the whole diff twice and let the two
// answers disagree.
//
// The gate has to read the same input the intake writer reads. A named target
// wins outright there, and the prose parser is never consulted once one is
// present, so consulting it here would refuse runs the writer would have
// served: "review the PR I just pushed" with --target main...HEAD names a
// target Review can serve, and the words are only how the caller described it.
import { parseExplicitReviewTarget, parseReviewTarget } from '../review/writers/intake.js';

export function validateFlowStartTarget(
  flowId: string,
  goal: string,
  target?: string,
  // The project the run is about. A named target can be a path in it, so the
  // gate needs the same root the intake writer will read from, or it would
  // refuse a path the writer would have served.
  projectRoot?: string,
): void {
  if (flowId !== 'review') return;
  // Explicit but malformed still fails closed. The caller stated a target and
  // got it wrong, and guessing past that would review something they did not
  // ask for.
  const parsed =
    target === undefined
      ? parseReviewTarget(goal)
      : parseExplicitReviewTarget(target, projectRoot === undefined ? {} : { projectRoot });
  if (!parsed.ok) throw new Error(parsed.reason);
}
