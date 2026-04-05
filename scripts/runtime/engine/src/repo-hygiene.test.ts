import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const THIS_DIR =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = resolve(THIS_DIR, "../../../..");
const SKIP_DIRS = new Set([
  ".claude",
  ".circuitry",
  ".git",
  ".pytest_cache",
  ".relay",
  "dist",
  "node_modules",
]);
const ALLOWED_CONTENT_PATHS = new Set([
  "scripts/runtime/engine/src/repo-hygiene.test.ts",
  "CONTRIBUTING.md",        // mentions pytest/tox as example repo-declared commands
  "skills/review/SKILL.md", // lists pytest as example repo-declared verification tool
]);
const CONTENT_PATTERNS = [
  /\bpython(?:3)?\b/i,
  /\bpyyaml\b/i,
  /\bpip(?:3)?\b/i,
  /\bpytest\b/i,
  /__pycache__/,
  /\.pyc\b/i,
  /\.py\b/i,
];

async function collectPythonTraces(
  currentPath: string,
  relativePath = "",
): Promise<string[]> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const traces: string[] = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const nextRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const nextPath = resolve(currentPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        traces.push(nextRelative);
        continue;
      }
      traces.push(...(await collectPythonTraces(nextPath, nextRelative)));
      continue;
    }

    const extension = extname(entry.name);
    if (extension === ".py" || extension === ".pyc") {
      traces.push(nextRelative);
      continue;
    }

    if (ALLOWED_CONTENT_PATHS.has(nextRelative)) {
      continue;
    }

    const contents = await readFile(nextPath);
    if (contents.includes(0)) {
      continue;
    }

    const text = contents.toString("utf-8");
    if (CONTENT_PATTERNS.some((pattern) => pattern.test(text))) {
      traces.push(nextRelative);
    }
  }

  return traces;
}

describe("repo hygiene", () => {
  it("contains no Python-related files or references outside exempted directories", async () => {
    const traces = await collectPythonTraces(REPO_ROOT);
    expect(traces).toEqual([]);
  });
});
