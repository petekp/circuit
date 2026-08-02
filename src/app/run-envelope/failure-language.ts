// Translating an engine failure reason into a sentence a person can act on.
//
// The failure surface leads with the run's own account of what killed it,
// which is right: the alternative was a generic "could not close with the
// required process evidence" that told nobody anything. But the account it
// leads with is the engine's trace reason, written for diagnosis:
//
//   route 'retry' for step 'synthesize-step' exhausted max_attempts=2
//
// Routes and max_attempts are schematic concepts. An operator reading that has
// to know how flows are wired before the sentence means anything, and even
// then it does not say what to do.
//
// The trace wording stays exactly as it is. It is quoted by dozens of test
// assertions and several flow dossiers, and it is the right level of detail
// for someone reading a trace. This module only changes the sentence a person
// reads on the way past.
//
// Anything unrecognized is passed through untouched. A half-translated reason
// is worse than the engine's own words, and an unrecognized reason is usually
// already plain (a connector sign-out, a refusal) because those are authored
// for people in the first place.

// Matches the reason built in run-transition.ts and graph-runner.ts. The
// optional tail is the recovery suffix: the last thing that actually went
// wrong, and the most actionable part of the whole sentence.
const EXHAUSTED_ATTEMPTS =
  /^route '[^']+' for step '([^']+)' exhausted max_attempts=(\d+)(?:; last recovery reason: (.+))?$/s;

function timesTried(attempts: number): string {
  if (attempts === 1) return 'once';
  return `${attempts} times`;
}

/**
 * The failure sentence to show an operator, given the engine's reason.
 *
 * Returns the input unchanged when it does not match a known engine-vocabulary
 * shape.
 */
export function operatorFailureSentence(reason: string): string {
  const exhausted = EXHAUSTED_ATTEMPTS.exec(reason);
  if (exhausted === null) return reason;
  const [, stepId, attemptsText, lastReason] = exhausted;
  const attempts = Number(attemptsText);
  if (stepId === undefined || !Number.isFinite(attempts) || attempts < 1) return reason;
  const base = `The '${stepId}' step ran out of attempts: it was tried ${timesTried(attempts)} and never passed.`;
  const last = lastReason?.trim();
  return last === undefined || last === '' ? base : `${base} The last problem was: ${last}`;
}
