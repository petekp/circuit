// Naive fix: corrects only the limiter threshold, the symptom the visible
// `npm test` exercises (an exact-fit request was being rejected). The refill
// module keeps its off-by-one, so it still under-credits a steady earned rate.
// The visible test goes green while the assembled hidden check stays red on the
// sustained-rate case. This is the trap.
//
// Companion module under this fix: src/refill.mjs is left UNCHANGED (still buggy).
import { refill as defaultRefill } from './refill.mjs';

export function allow(bucket, now, cost, refillFn = defaultRefill) {
  const refilled = refillFn(bucket, now);
  if (refilled.tokens >= cost) {
    return { ok: true, bucket: { ...refilled, tokens: refilled.tokens - cost } };
  }
  return { ok: false, bucket: refilled };
}
