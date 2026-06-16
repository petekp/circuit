// Token-bucket limiter. `allow` refills the bucket to `now`, then admits a
// request that costs `cost` tokens if the bucket can pay for it.
//
// Bug: the threshold uses a strict greater-than, so a request that costs exactly
// the tokens on hand is rejected even though the bucket can cover it. The refill
// module under-credits a steady earned rate, so admitting a sustained rate needs
// both this threshold and the refill math corrected together.
import { refill as defaultRefill } from './refill.mjs';

export function allow(bucket, now, cost, refillFn = defaultRefill) {
  const refilled = refillFn(bucket, now);
  if (refilled.tokens > cost) {
    return { ok: true, bucket: { ...refilled, tokens: refilled.tokens - cost } };
  }
  return { ok: false, bucket: refilled };
}
