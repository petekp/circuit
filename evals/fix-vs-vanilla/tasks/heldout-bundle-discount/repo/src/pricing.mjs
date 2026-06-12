// Price after subtracting a coupon amount.
export function finalPrice(price, amountOff) {
  return price - amountOff;
}

// Same, for an item sold inside a bundle.
export function bundlePrice(price, amountOff) {
  return price - amountOff;
}
