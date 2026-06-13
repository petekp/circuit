// Root-cause fix: the comparator orders numeric parts left to right, and the
// update banner's newest-release path now sorts with that same comparator
// instead of the default string ordering. Every objective check passes too.

// Release version ordering. Versions are dotted numerics like "1.10.2";
// ordering compares the numeric value of each part, left to right.

// Comparator for the release notes dropdown: negative when `a` is older
// than `b`, positive when newer, zero when equal.
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// Newest release in an unordered list; the update banner shows this.
export function newestVersion(versions) {
  return [...versions].sort(compareVersions).at(-1);
}
