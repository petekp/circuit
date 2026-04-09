import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./schema.js";

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf-8");
}

describe("surface boundary regressions", () => {
  it("treats docs/examples as repo-only rather than shipped install surface", () => {
    const manifest = JSON.parse(
      read("scripts/runtime/generated/surface-manifest.json"),
    ) as { files: Array<{ path: string }> };

    expect(manifest.files.map((file) => file.path)).not.toContain("docs/examples/gemini-dispatch.sh");
  });

  it("keeps repo-only narrative docs out of the shipped surface manifest", () => {
    const manifest = JSON.parse(
      read("scripts/runtime/generated/surface-manifest.json"),
    ) as { files: Array<{ path: string }> };

    const filePaths = manifest.files.map((file) => file.path);
    expect(filePaths.some((path) => path.startsWith("docs/"))).toBe(false);
    expect(filePaths.some((path) => path.startsWith("assets/"))).toBe(false);
    expect(filePaths).not.toContain("README.md");
    expect(filePaths).not.toContain("ARCHITECTURE.md");
    expect(filePaths).not.toContain("CIRCUITS.md");
    expect(filePaths).not.toContain("CUSTOM-CIRCUITS.md");
  });

  it("keeps the engine workspace and runtime node_modules out of the shipped surface manifest", () => {
    const manifest = JSON.parse(
      read("scripts/runtime/generated/surface-manifest.json"),
    ) as { files: Array<{ path: string }> };

    const filePaths = manifest.files.map((file) => file.path);
    expect(filePaths.some((path) => path.startsWith("scripts/runtime/engine/"))).toBe(false);
    expect(filePaths.some((path) => path.startsWith("scripts/runtime/node_modules/"))).toBe(false);
  });
});
