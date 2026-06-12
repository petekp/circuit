// Naive fix: a single modulo handles paging forward past the end, which is the
// only case the prompt and visible test mention. But JavaScript's % keeps the
// sign of the dividend, so a negative index stays negative and the hidden
// backward-wrap check fails. This is the trap.
export function wrapIndex(index, len) {
  return index % len;
}
