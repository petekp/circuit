/**
 * Shared schema helpers for the Circuit engine.
 *
 * Provides JSON-Schema loading, Ajv validator creation, and validation
 * for any module that needs Draft 2020-12 schema support (derive-state,
 * append-event, etc.).
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

function findRepoRoot(): string {
  let dir = MODULE_DIR;

  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "schemas"))) return dir;

    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return resolve(MODULE_DIR, "..", "..", "..", "..");
}

/** Resolve the repository root in both source and bundled runtime layouts. */
export const REPO_ROOT = findRepoRoot();

/**
 * Load a JSON-Schema file relative to the repository root.
 */
export function loadJsonSchema(relativePath: string): object {
  const fullPath = resolve(REPO_ROOT, relativePath);
  return JSON.parse(readFileSync(fullPath, "utf-8"));
}

/**
 * Create a pre-configured Ajv 2020-12 validator with format support.
 *
 * The @ts-expect-error directives below suppress CJS/ESM interop noise:
 * ajv and ajv-formats ship CJS; under Node16 moduleResolution TS sees
 * the default export as a namespace rather than a class/function, but
 * at runtime the constructor and function are available as expected.
 */
function createValidator() {
  // @ts-expect-error -- CJS/ESM interop: constructor exists at runtime
  const ajv = new Ajv2020({ allErrors: true });
  // @ts-expect-error -- CJS/ESM interop: function exists at runtime
  addFormats(ajv);
  return ajv;
}

/**
 * Validate data against a JSON-Schema.
 * Returns an array of human-readable error strings (empty = valid).
 */
export function validate(schema: object, data: object): string[] {
  const ajv = createValidator();
  const valid = ajv.validate(schema, data);
  if (valid) return [];
  return (ajv.errors ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => `${e.instancePath}: ${e.message ?? "unknown error"}`,
  );
}
