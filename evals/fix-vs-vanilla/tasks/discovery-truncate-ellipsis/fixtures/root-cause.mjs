// Root-cause fix: only cut when the string actually exceeds the limit, so a
// string that already fits is returned untouched. Both the visible regression
// and the short-string guard pass.
export function truncate(str, max) {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}
