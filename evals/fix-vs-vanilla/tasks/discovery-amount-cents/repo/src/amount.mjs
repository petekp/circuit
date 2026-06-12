// Parse a formatted money amount like "$1,234.50" into a whole number of cents.
export function parseCents(text) {
  return Math.round(parseFloat(text) * 100);
}
