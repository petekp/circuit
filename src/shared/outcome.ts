// Failure-outcome reconciliation across Circuit's two outcome vocabularies.
//
// Circuit carries two outcome enums that mean overlapping things:
//   - RunClosedOutcome  (schemas/trace-entry.ts): complete | aborted | handoff
//                        | stopped | escalated
//   - RunEnvelopeOutcome (schemas/run-envelope.ts): complete | needs_attention
//                        | blocked | failed | handoff
//
// History/recall code receives the raw `outcome` string from whichever source
// produced it (result.json outcome/status/verdict, the trace run.closed
// outcome, or a report body), so it sees a MIX of both vocabularies. The
// canonical RunClosedOutcome -> RunEnvelopeOutcome mapping the codebase already
// uses (mapChildOutcome, attemptOutcomeFromProjection) is:
//
//   complete  -> complete          (success)
//   handoff   -> handoff           (neutral)
//   stopped   -> needs_attention   (neutral: a deliberate pause)
//   aborted   -> failed            (FAILURE)
//   escalated -> blocked           (FAILURE)
//
// So the faithful failure set, expressed across both vocabularies, is the
// union below. `escalated` is included deliberately: it maps to `blocked` and
// is emitted for @escalate terminals (graph-runner.ts); omitting it would leave
// a latent variant of the recall miss this reconciliation exists to fix. See
// docs/ideas/memory-phase0-failure-legibility-spec.md.
const FAILURE_OUTCOMES: ReadonlySet<string> = new Set([
  'aborted',
  'escalated',
  'failed',
  'blocked',
]);

/**
 * True when an outcome string denotes a failure in EITHER outcome vocabulary.
 * Neutral outcomes (`stopped`, `handoff`, `needs_attention`) and `complete`
 * are not failures. `undefined` (no recorded outcome) is not a failure.
 */
export function isFailureOutcome(outcome: string | undefined): boolean {
  return outcome !== undefined && FAILURE_OUTCOMES.has(outcome);
}

// Outcomes a FLOW can report on its primary result that mean "the work did not
// cleanly succeed," even when the run itself reached @complete. A Fix, for
// example, can close @complete (its required process evidence, a passing
// verification command, is present) while its own result reports `partial`
// because the independent review was skipped. The run surface uses this set to
// qualify an otherwise-clean "Done" so a degraded flow result cannot read as an
// unqualified pass one layer up from the operator digest.
//
// This enumerates the DEGRADED words on purpose, not the clean ones: a flow
// outcome NOT in this set leaves the surface unchanged, so a clean success word
// (`fixed`, `complete`, `not-reproduced`) never false-qualifies a good run, and
// a future success word fails safe by reading as clean rather than degraded.
//
// Fix is the flow that actually reaches this path with a `complete` run outcome,
// because it does not bind its run outcome to its primary result. So its whole
// non-clean set must be covered: `partial`, `stopped`, `handoff`, and `failed`.
// (`handoff` means the work was paused back to the operator, not finished, so it
// is degraded here even though it is not a failure in the run-lifecycle sense
// above.) The remaining words cover the other flows defensively in case their
// bind logic ever changes.
const DEGRADED_COMPLETION_OUTCOMES: ReadonlySet<string> = new Set([
  'partial',
  'needs_attention',
  'failed',
  'blocked',
  'stopped',
  'handoff',
]);

/**
 * True when a flow's primary-result outcome word denotes a non-clean
 * completion that the run surface should name even though the run reached
 * @complete. `undefined` (no recorded flow outcome) is not degraded.
 */
export function isDegradedCompletionOutcome(outcome: string | undefined): boolean {
  return outcome !== undefined && DEGRADED_COMPLETION_OUTCOMES.has(outcome);
}
