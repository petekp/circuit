// Invoice totalling. Sums the line totals into a grand total, in cents.
//
// Bug: the grand total is rounded to the nearest five cents, a stray rounding
// step that does not belong here. Combined with the per-line module not rounding
// its lines, the two rounding steps disagree and the total drifts. The fix is to
// settle on one rounding contract: each line rounds to whole cents (in price.mjs)
// and the invoice reports the exact cent sum of those rounded lines (here).
export function invoiceTotal(lines, lineTotalFn) {
  const sum = lines.reduce((acc, line) => acc + lineTotalFn(line), 0);
  return Math.round(sum / 5) * 5;
}
