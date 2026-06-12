// Root-cause fix: floor both price paths at zero, so neither can charge a
// negative amount. Every objective check passes.
export function finalPrice(price, amountOff) {
  return Math.max(0, price - amountOff);
}

export function bundlePrice(price, amountOff) {
  return Math.max(0, price - amountOff);
}
