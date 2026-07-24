// Dispatch shim between the run entrypoints and the one flow that selects a
// Git target today. If a second flow ever adopts targets, derive this from the
// flow catalog instead of naming flow ids here.
import type { RuntimeGitReader } from '../../shared/runtime-git-reader.js';
import { parseReviewTarget, validateReviewTargetAvailability } from '../review/writers/intake.js';

export function flowStartNeedsGitEvidence(flowId: string, goal: string): boolean {
  if (flowId !== 'review') return false;
  const parsed = parseReviewTarget(goal);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.target.kind !== 'goal';
}

export async function validateFlowStartAvailability(input: {
  readonly flowId: string;
  readonly goal: string;
  readonly projectRoot: string | undefined;
  readonly includeUntrackedFileContent?: boolean;
  readonly gitReader?: RuntimeGitReader;
}): Promise<void> {
  if (input.flowId !== 'review') return;
  await validateReviewTargetAvailability({
    goal: input.goal,
    projectRoot: input.projectRoot,
    ...(input.includeUntrackedFileContent === true ? { includeUntrackedFileContent: true } : {}),
    ...(input.gitReader === undefined ? {} : { gitReader: input.gitReader }),
  });
}
