#!/usr/bin/env node
// Node-floor shim for the Claude SessionStart hook.
//
// The real hook is session-start.ts. A host that runs `node session-start.ts`
// on a Node below the TypeScript floor (22.18) fails at parse time with
// ERR_UNKNOWN_FILE_EXTENSION. This shim is plain JavaScript, so it parses on any
// supported Node, checks the version first, and only then imports the
// TypeScript hook. stdin is untouched, so the imported hook reads the host's
// hook-input JSON exactly as if it had been invoked directly.
//
// It avoids module-system-specific syntax (no static import/export, no require,
// no import.meta). The floor below must match package.json `engines.node` and
// bin/node-version-guard.js.
const MIN_MAJOR = 22;
const MIN_MINOR = 18;
const parts = String(process.versions.node).split('.');
const major = Number(parts[0]);
const minor = Number(parts[1]);
if (!Number.isNaN(major) && (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR))) {
  process.stderr.write(
    `error: Circuit requires Node.js ${MIN_MAJOR}.${MIN_MINOR} or newer. Current Node.js is ${process.versions.node}.\n`,
  );
  process.exit(1);
}
import('./session-start.ts').catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
