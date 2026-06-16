// Under the naive fix this module is left UNCHANGED from the shipped repo: the
// stray nickel-rounding of the grand total survives, so a total that is not a
// multiple of five drifts and the assembled hidden check fails.
export function invoiceTotal(lines, lineTotalFn) {
  const sum = lines.reduce((acc, line) => acc + lineTotalFn(line), 0);
  return Math.round(sum / 5) * 5;
}
