// Release version ordering. Versions are dotted numerics like "1.10.2";
// ordering compares the numeric value of each part, left to right.

// Comparator for the release notes dropdown: negative when `a` is older
// than `b`, positive when newer, zero when equal.
export function compareVersions(a, b) {
  return a === b ? 0 : (a < b ? -1 : 1);
}

// Newest release in an unordered list; the update banner shows this.
export function newestVersion(versions) {
  return [...versions].sort().at(-1);
}
