// Root-cause fix: normalize the modulo back into range so it wraps in both
// directions. Forward and backward paging both land on a valid index, so every
// objective check passes.
export function wrapIndex(index, len) {
  return ((index % len) + len) % len;
}
