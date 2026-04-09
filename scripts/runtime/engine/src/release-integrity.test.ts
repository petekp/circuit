import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./schema.js";

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf-8");
}

describe("release integrity", () => {
  it("does not ship a public workers shim", () => {
    expect(existsSync(resolve(REPO_ROOT, "commands/workers.md"))).toBe(false);
  });

  it("keeps workers out of machine-owned public command inventories", () => {
    expect(read(".claude-plugin/public-commands.txt")).not.toContain("workers");
    const manifest = JSON.parse(read("scripts/runtime/generated/surface-manifest.json")) as {
      entries: Array<{ kind: string; public: boolean; slug: string }>;
      public_commands: string[];
    };

    expect(manifest.public_commands).not.toContain("workers");
    expect(manifest.entries.find((entry) => entry.slug === "workers")).toMatchObject({
      kind: "adapter",
      public: false,
      slug: "workers",
    });
  });

  it("does not advertise /circuit:workers in user-facing public docs", () => {
    expect(read("README.md")).not.toContain("/circuit:workers");
    expect(read("CIRCUITS.md")).not.toContain("/circuit:workers");
    expect(read("CUSTOM-CIRCUITS.md")).not.toContain("/circuit:workers");
  });
});
