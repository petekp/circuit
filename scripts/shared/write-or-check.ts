import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Shared write-or-verify primitive for the generation scripts under scripts/.
// The same body was duplicated verbatim (apart from the regenerate hint) in
// scripts/release/shared.ts and scripts/schemas/emit-yaml-schemas.ts; hoisting
// it here keeps the drift-check semantics (byte comparison, exact console
// lines) identical across every emitter. `regenerateHint` is the
// caller-specific tail of the error message, e.g. "run npm run
// emit-yaml-schemas". scripts/flows/emit.ts deliberately keeps its own
// message-driven variant and does not use this.
export function writeOrCheck(
  relPath: string,
  content: string,
  check: boolean,
  options: { readonly projectRoot: string; readonly regenerateHint: string },
): void {
  const abs = resolve(options.projectRoot, relPath);
  if (check) {
    if (!existsSync(abs)) {
      throw new Error(`${relPath} is missing; ${options.regenerateHint}`);
    }
    const current = readFileSync(abs, 'utf8');
    if (current !== content) {
      throw new Error(`${relPath} drifted; ${options.regenerateHint}`);
    }
    console.log(`✓ ${relPath} is in sync`);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  console.log(`emitted ${relPath}`);
}
