#!/usr/bin/env node
// Node-floor shim for the Codex host wrapper.
//
// The real wrapper is circuit.ts. A host that runs `node circuit.ts` on a Node
// below the TypeScript floor (22.18) fails at parse time with
// ERR_UNKNOWN_FILE_EXTENSION, before the friendly version gate inside circuit.ts
// can run. This shim is plain JavaScript, so it parses on any supported Node,
// checks the version first, and only then imports the TypeScript wrapper.
//
// It avoids module-system-specific syntax (no static import/export, no require,
// no import.meta) so it behaves identically whether the installed plugin
// resolves a bare .js as CommonJS or ESM. The floor below must match
// package.json `engines.node` and bin/node-version-guard.js.
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
import('./circuit.ts').catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
