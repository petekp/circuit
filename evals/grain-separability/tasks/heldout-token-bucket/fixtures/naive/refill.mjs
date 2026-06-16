// Under the naive fix this module is left UNCHANGED from the shipped repo: the
// elapsed-time off-by-one survives, so a steady earned rate is still
// under-credited and the assembled hidden check fails.
export function refill(bucket, now) {
  const elapsed = now - bucket.last - 1;
  const accrued = Math.floor(elapsed / 10);
  const tokens = Math.min(bucket.capacity, bucket.tokens + Math.max(0, accrued));
  return { ...bucket, tokens, last: now };
}
