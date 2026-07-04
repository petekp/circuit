import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Version reporting shared by `circuit version` and the interactive shell
// header. Lives in its own leaf so the shell never has to import the router.

const DEFAULT_DEV_VERSION = '0.0.0-dev';

export function readSourceVersion(): string {
  // Marketplace-safe by build-time replacement: build-plugin-runtime.ts
  // emits the bundled CLI with CIRCUIT_VERSION inlined as a literal,
  // so this function returns the build-time version in every marketplace
  // install and never reaches the path-resolution branches below. The
  // fileURLToPath candidate is only ever exercised in a source-tree
  // checkout where the env var is unset.
  if (process.env.CIRCUIT_VERSION !== undefined) return process.env.CIRCUIT_VERSION;
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), '../../plugins/version.json'),
    resolve(process.cwd(), 'plugins/version.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.length > 0) return raw.version;
    } catch {
      // Keep version reporting useful when the repo manifest is unavailable.
    }
  }
  return DEFAULT_DEV_VERSION;
}
