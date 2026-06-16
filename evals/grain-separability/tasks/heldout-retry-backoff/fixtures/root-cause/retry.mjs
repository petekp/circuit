// Root-cause fix (2 of 2): the loop honors the full max-attempts budget and
// records a delay only between tries, not after the last one. Paired with the
// backoff fix, the assembled retry uses every attempt and records the right
// schedule, so the visible test and the assembled hidden check both pass.
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
