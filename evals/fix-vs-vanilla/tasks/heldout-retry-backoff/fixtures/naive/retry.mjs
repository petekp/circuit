// Naive fix: corrects the loop bound so the full max-attempts budget is honored,
// the symptom the visible `npm test` checks. But backoff.mjs is left UNCHANGED,
// so the recorded delay schedule stays one step too large. The visible test goes
// green while the assembled hidden check stays red on the delay schedule. This is
// the trap.
//
// Companion module under this fix: src/backoff.mjs is left UNCHANGED (the
// schedule is still one step too large).
import { delayFor as defaultDelayFor } from './backoff.mjs';

export function run(fn, maxAttempts, delayForFn = defaultDelayFor) {
  const delays = [];
  let attempts = 0;
  for (let i = 1; i <= maxAttempts; i += 1) {
    attempts += 1;
    if (fn(attempts)) return { ok: true, attempts, delays };
    if (attempts < maxAttempts) delays.push(delayForFn(attempts));
  }
  return { ok: false, attempts, delays };
}
