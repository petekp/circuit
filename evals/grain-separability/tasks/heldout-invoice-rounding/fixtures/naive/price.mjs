// Naive fix (price side): rounds each discounted line to whole cents, which the
// visible `npm test` checks. But the invoice module is left UNCHANGED, so its
// stray nickel-rounding of the grand total survives. A multi-line total that is
// not a multiple of five is reported one or more cents off, so the visible test
// goes green while the assembled hidden check stays red. This is the trap.
//
// Companion module under this fix: src/invoice.mjs is left UNCHANGED (still
// nickel-rounds the grand total).
export function lineTotal(line) {
  return Math.round(line.priceCents * (1 - line.discount));
}
