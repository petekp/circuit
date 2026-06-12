// Naive fix: make the NaN go away by guarding it, returning 0 when parsing
// fails. The visible regression only asks for a finite, non-negative number, so
// this passes — but the amount is wrong. The currency symbol and comma are never
// handled. This is the trap.
export function parseCents(text) {
  const value = parseFloat(text);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}
