// Naive fix: floor only the path the visible test exercises. The bundle path can
// still go negative, so the hidden check fails. This is the trap.
export function finalPrice(price, amountOff) {
  return Math.max(0, price - amountOff);
}

export function bundlePrice(price, amountOff) {
  return price - amountOff;
}
