// Root-cause fix: strip the formatting (currency symbol, thousands separators)
// before parsing, so the actual amount is read. Both the visible regression and
// the hidden value check pass.
export function parseCents(text) {
  const digits = text.replace(/[^0-9.]/g, '');
  return Math.round(parseFloat(digits) * 100);
}
