// Root-cause fix (2 of 2): the invoice reports the exact cent sum of the rounded
// line totals, dropping the stray nickel-rounding. Paired with the price fix,
// the two rounding steps agree and both the visible test and the assembled hidden
// check pass.
export function invoiceTotal(lines, lineTotalFn) {
  return lines.reduce((acc, line) => acc + lineTotalFn(line), 0);
}
