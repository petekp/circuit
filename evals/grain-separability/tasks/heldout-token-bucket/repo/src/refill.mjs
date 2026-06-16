// Token-bucket refill. A bucket earns one token every 10 time units, up to its
// capacity. `refill` advances the bucket's clock to `now` and credits the tokens
// earned in between.
//
// Bug: the elapsed-time math subtracts one unit before dividing, so the bucket
// earns one fewer token than it should whenever the gap is an exact multiple of
// the rate. The limiter that reads these tokens carries its own boundary bug, so
// the two have to be corrected together for a steady earned rate to be admitted.
export function refill(bucket, now) {
  const elapsed = now - bucket.last - 1;
  const accrued = Math.floor(elapsed / 10);
  const tokens = Math.min(bucket.capacity, bucket.tokens + Math.max(0, accrued));
  return { ...bucket, tokens, last: now };
}
