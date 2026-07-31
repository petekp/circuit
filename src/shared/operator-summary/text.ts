// Text-projection helpers used across per-flow summary projectors.
//
// Two categories:
//   - small primitives (sentence, plural, capitalized, withoutFinalPunctuation)
//     that mostly enforce surface conventions
//   - friendly-* projections that translate machine-shaped values
//     (status enums, summary prefixes, run-result framing) into operator-
//     readable phrases

export function plural(count: number, singular: string, pluralText = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralText}`;
}

export function capitalized(value: string): string {
  const first = value[0];
  if (first === undefined) return value;
  return `${first.toUpperCase()}${value.slice(1)}`;
}

export function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

export function withoutFinalPunctuation(value: string): string {
  return value.replace(/[.!?]\s*$/, '');
}

export function friendlyRunNote(flowId: string, summary: string): string {
  const match = /^([a-z-]+) v[\d.]+ closed (\d+) step\(s\) for goal ".+"\.$/.exec(summary);
  if (match !== null) {
    return `Completed ${match[2]} ${capitalized(flowId)} steps for this goal.`;
  }
  return summary;
}

export function friendlyResultSummary(summary: string): string {
  return summary
    .replace(/^(?:Build|Fix|Review|Explore|Pursuits?) result for .+?:\s*/, '')
    .replace(/^Explore '[\s\S]*?':\s*/, '')
    .replace(/^Explore .+?:\s*/, '');
}

export function friendlyReviewStatus(status: string): string {
  if (status === 'accept') return 'accepted';
  if (status === 'accept-with-fixes') return 'requested follow-up fixes';
  if (status === 'accept-with-fold-ins') return 'accepted with follow-up notes';
  if (status === 'release-approved') return 'approved for release';
  if (status === 'release-with-followups') return 'approved with follow-ups';
  if (status === 'release-blocked') return 'blocked from release';
  return status;
}

export function friendlyVerificationStatus(status: string): string {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  return status;
}

// Fix's regression rerun proves the change is relevant to the bug: a command
// failed before the fix and passes after. The run now tries for that on every
// goal, running the project's own check before the fix when the goal named no
// repro, so 'cleared' is reachable by default. It still lands on 'deferred'
// when that check was already passing beforehand, and a 'passed' verification
// alone does not mean the change did the thing. These phrases say so plainly.
export function friendlyRegressionStatus(status: string): string {
  if (status === 'cleared') return 'reproduced before the fix and cleared after';
  if (status === 'deferred')
    return 'no failing-then-passing evidence was captured, so nothing here shows the change is what fixed the bug';
  if (status === 'still-failing') return 'the regression command still fails after the fix';
  return status;
}

// Fix's domain outcome taxonomy ('fixed', 'partial', 'not-reproduced', ...)
// collides with the run-level vocabulary on words like 'partial' that read as
// "incomplete" to a casual operator. The phrases below describe the *change*
// the run produced rather than parroting the schema enum value.
export function friendlyFixOutcome(outcome: string): string {
  if (outcome === 'fixed') return 'fix complete';
  if (outcome === 'partial') return 'fix applied with follow-ups';
  if (outcome === 'not-reproduced') return 'could not reproduce the issue';
  if (outcome === 'failed') return 'fix attempt failed verification';
  if (outcome === 'stopped') return 'fix stopped';
  if (outcome === 'handoff') return 'fix handed off';
  return outcome;
}
