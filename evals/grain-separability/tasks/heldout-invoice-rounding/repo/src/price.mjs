// Per-line pricing. A line has a whole-cent unit price and a discount fraction.
// `lineTotal` is the amount this line contributes to the invoice, in cents.
//
// Bug: the discounted line value is returned with its sub-cent remainder intact
// instead of being rounded to whole cents. The invoice module then applies its
// own rounding to the grand total, so the two rounding steps disagree and the
// total drifts by cents. Both modules have to settle on the same rounding
// contract: round each line to whole cents, then sum.
export function lineTotal(line) {
  return line.priceCents * (1 - line.discount);
}
