// Node.js version guard for the circuit CLI entry point.
//
// This file is deliberately plain, widely-compatible JavaScript. Its whole job
// is to print a legible error BEFORE circuit loads any modern code, so it must
// parse and run on whatever (possibly too-old) Node the operator has. Keep it
// dependency-free and avoid syntax newer than the floor it is meant to catch:
// no optional chaining, no nullish coalescing, no top-level await.

/** The minimum Node.js the circuit runtime supports (see package.json engines). */
export const REQUIRED_NODE = { major: 22, minor: 18 };

// Node's unflagged built-in TypeScript type-stripping — which circuit's `.ts`
// entry points require — arrived on the 22.x LTS line at 22.18, but on the
// 23.x "Current" line not until 23.6. A Node in the 23.0–23.5 window clears a
// naive "newer major is fine" check yet still crashes on the first `.ts` import
// with a raw, illegible error. Map the per-major floor so the guard names the
// real fix instead of letting that crash through.
const TYPE_STRIPPING_FLOOR_BY_MAJOR = { 23: 6 };

/**
 * Return a legible error string when `currentVersion` is below `required`, or
 * undefined when it satisfies the floor. An unparseable version returns
 * undefined on purpose: a guard that cannot read the running version must not
 * block a run it has no evidence is unsupported.
 *
 * @param {string} currentVersion e.g. process.versions.node ("22.17.0")
 * @param {{ major: number, minor: number }} required
 * @returns {string | undefined}
 */
export function nodeVersionError(currentVersion, required) {
  const parts = String(currentVersion).split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return undefined;
  }
  if (major > required.major) {
    // A newer major clears the floor, but some lines only gained unflagged
    // `.ts` stripping mid-release; below that per-major floor a `.ts` import
    // still crashes even though the major looks new enough.
    const lineFloor = TYPE_STRIPPING_FLOOR_BY_MAJOR[major];
    if (lineFloor !== undefined && minor < lineFloor) {
      return `circuit needs Node.js's built-in TypeScript support, which on the Node.js ${major}.x line arrived in ${major}.${lineFloor}, but you are running Node.js ${currentVersion}.\nUpgrade to Node.js ${major}.${lineFloor} or newer, or use the ${required.major}.${required.minor}+ LTS line, then run circuit again.\n`;
    }
    return undefined;
  }
  if (major === required.major && minor >= required.minor) {
    return undefined;
  }
  return `circuit requires Node.js ${required.major}.${required.minor} or newer, but you are running Node.js ${currentVersion}.\nUpgrade Node.js (https://nodejs.org) and run circuit again.\n`;
}

/**
 * Print the version error and exit(1) when the running Node is too old. A no-op
 * on a supported Node, so it is safe to call unconditionally at startup.
 *
 * @returns {void}
 */
export function assertNodeVersion() {
  const message = nodeVersionError(process.versions.node, REQUIRED_NODE);
  if (message !== undefined) {
    process.stderr.write(message);
    process.exit(1);
  }
}
