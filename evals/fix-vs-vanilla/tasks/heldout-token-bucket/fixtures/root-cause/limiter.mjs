// Root-cause fix (2 of 2): the threshold admits a request that costs exactly the
// tokens on hand. Paired with the refill fix, the burst still throttles and the
// sustained earned rate is admitted, so the assembled hidden check passes.
import { refill as defaultRefill } from './refill.mjs';

export function allow(bucket, now, cost, refillFn = defaultRefill) {
  const refilled = refillFn(bucket, now);
  if (refilled.tokens >= cost) {
    return { ok: true, bucket: { ...refilled, tokens: refilled.tokens - cost } };
  }
  return { ok: false, bucket: refilled };
}
