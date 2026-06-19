// Clamp a requested page index into the valid range [0, pageCount - 1].
export function clampPage(index, pageCount) {
  return Math.min(index, pageCount);
}
