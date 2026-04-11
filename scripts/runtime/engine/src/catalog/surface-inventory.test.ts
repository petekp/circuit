import {
  chmodSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getInstalledFileInventory } from "./surface-inventory.js";
import type { Catalog } from "./types.js";

const SAMPLE_CATALOG: Catalog = [
  {
    dir: "build",
    entryModes: ["default"],
    kind: "workflow",
    purpose: "Build things.",
    skillDescription: "Build things. More detail.",
    skillName: "build",
    slug: "build",
    version: "2026-04-08",
  },
];

function writeFixture(root: string): void {
  mkdirSync(resolve(root, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(root, "commands"), { recursive: true });
  mkdirSync(resolve(root, "hooks"), { recursive: true });
  mkdirSync(resolve(root, "schemas"), { recursive: true });
  mkdirSync(resolve(root, "scripts", "relay"), { recursive: true });
  mkdirSync(resolve(root, "scripts", "runtime", "bin"), { recursive: true });
  mkdirSync(resolve(root, "scripts", "runtime", "generated"), { recursive: true });
  mkdirSync(resolve(root, "skills", "build"), { recursive: true });

  writeFileSync(
    resolve(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "circuit", version: "0.3.0" }, null, 2),
    "utf-8",
  );
  writeFileSync(resolve(root, "hooks", "hooks.json"), '{"hooks":{}}\n', "utf-8");
  writeFileSync(resolve(root, "schemas", "event.schema.json"), "{}\n", "utf-8");
  writeFileSync(resolve(root, "scripts", "relay", "dispatch.sh"), "#!/usr/bin/env bash\n", "utf-8");
  chmodSync(resolve(root, "scripts", "relay", "dispatch.sh"), 0o755);
  writeFileSync(resolve(root, "scripts", "runtime", "bin", "dispatch.js"), "#!/usr/bin/env node\n", "utf-8");
  chmodSync(resolve(root, "scripts", "runtime", "bin", "dispatch.js"), 0o755);
  writeFileSync(resolve(root, "scripts", "sync-to-cache.sh"), "#!/usr/bin/env bash\n", "utf-8");
  chmodSync(resolve(root, "scripts", "sync-to-cache.sh"), 0o755);
  writeFileSync(resolve(root, "scripts", "verify-install.sh"), "#!/usr/bin/env bash\n", "utf-8");
  chmodSync(resolve(root, "scripts", "verify-install.sh"), 0o755);
  writeFileSync(
    resolve(root, "skills", "build", "SKILL.md"),
    [
      "# Build",
      "",
      "<!-- BEGIN BUILD_CONTRACT -->",
      "<!-- END BUILD_CONTRACT -->",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(resolve(root, "circuit.config.example.yaml"), "dispatch: {}\n", "utf-8");
}

function makeFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), "circuit-surface-inventory-"));
  writeFixture(root);
  return root;
}

describe("getInstalledFileInventory", () => {
  it("builds inventory for a valid repo surface", () => {
    const root = makeFixture();

    const inventory = getInstalledFileInventory(root, SAMPLE_CATALOG);
    const paths = inventory.map((file) => file.path);

    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain(".claude-plugin/public-commands.txt");
    expect(paths).toContain("commands/build.md");
    expect(paths).toContain("scripts/runtime/generated/prompt-contracts.json");
    expect(paths).toContain("scripts/verify-install.sh");
  });

  it("throws when a required repo file seed path is missing", () => {
    const root = makeFixture();
    rmSync(resolve(root, "scripts", "verify-install.sh"));

    expect(() => getInstalledFileInventory(root, SAMPLE_CATALOG)).toThrowError(
      "catalog-compiler: missing repo installed-surface seed path(s): scripts/verify-install.sh",
    );
  });

  it("throws when a required repo directory seed path is missing", () => {
    const root = makeFixture();
    rmSync(resolve(root, "scripts", "runtime", "bin"), { force: true, recursive: true });

    expect(() => getInstalledFileInventory(root, SAMPLE_CATALOG)).toThrowError(
      "catalog-compiler: missing repo installed-surface seed path(s): scripts/runtime/bin",
    );
  });

  it("reports missing repo seed paths in deterministic sorted order", () => {
    const root = makeFixture();
    rmSync(resolve(root, "scripts", "verify-install.sh"));
    rmSync(resolve(root, "scripts", "runtime", "bin"), { force: true, recursive: true });

    expect(() => getInstalledFileInventory(root, SAMPLE_CATALOG)).toThrowError(
      "catalog-compiler: missing repo installed-surface seed path(s): scripts/runtime/bin, scripts/verify-install.sh",
    );
  });
});
