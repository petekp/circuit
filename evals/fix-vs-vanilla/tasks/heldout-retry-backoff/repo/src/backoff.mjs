// Backoff schedule. `delayFor` returns how long to wait, in milliseconds, before
// the next try. Attempts are 1-indexed, so the first gap should be the base delay
// and each later gap should double.
//
// Bug: the exponent uses the raw attempt number, so the very first gap is already
// doubled and the whole schedule is one step too large. The retry loop indexes
// this schedule by attempt, so the loop count and the delay schedule have to
// agree for the recorded backoff to be right.
const BASE_MS = 10;

export function delayFor(attempt) {
  return BASE_MS * 2 ** attempt;
}
