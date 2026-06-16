// Retry loop. `run` calls `fn` until it succeeds or the shared max-attempts
// budget is spent, recording the backoff delay taken between tries. It returns
// whether it succeeded, how many attempts it made, and the recorded delays.
//
// Bug: the loop bound gives up one attempt early, so a function that would
// succeed on the last allowed attempt never gets its final try. The recorded
// delays come from backoff.mjs, so the loop count and the delay schedule have to
// agree for the assembled retry to honor the max-attempts contract.
import { delayFor as defaultDelayFor } from './backoff.mjs';

export function run(fn, maxAttempts, delayForFn = defaultDelayFor) {
  const delays = [];
  let attempts = 0;
  for (let i = 1; i < maxAttempts; i += 1) {
    attempts += 1;
    if (fn(attempts)) return { ok: true, attempts, delays };
    delays.push(delayForFn(attempts));
  }
  return { ok: false, attempts, delays };
}
