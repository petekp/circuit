// Node.js version guard for the circuit CLI entry point.
//
// This file is deliberately plain, widely-compatible JavaScript. Its whole job
// is to print a legible error BEFORE circuit loads any modern code, so it must
// parse and run on whatever (possibly too-old) Node the operator has. Keep it
// dependency-free and avoid syntax newer than the floor it is meant to catch:
// no optional chaining, no nullish coalescing, no top-level await.

/** The minimum Node.js the circuit runtime supports (see package.json engines). */
export const REQUIRED_NODE = { major: 22, minor: 18 };

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
