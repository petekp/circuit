import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderCommandShim, renderPublicCommandsFile } from "./public-surface.js";
import { renderSurfaceManifest } from "./surface-manifest.js";
import type { Catalog } from "./types.js";
import { verifyInstalledSurface } from "./verify-installed-surface.js";

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
  {
    dir: "handoff",
    kind: "utility",
    skillDescription: "Save session state.",
    skillName: "handoff",
    slug: "handoff",
  },
  {
    dir: "workers",
    kind: "adapter",
    skillDescription: "Internal adapter.",
    skillName: "workers",
    slug: "workers",
  },
];

function writeFixture(root: string): void {
  mkdirSync(resolve(root, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(root, "commands"), { recursive: true });
  mkdirSync(resolve(root, "hooks"), { recursive: true });
  mkdirSync(resolve(root, "schemas"), { recursive: true });
  mkdirSync(resolve(root, "scripts/relay"), { recursive: true });
  mkdirSync(resolve(root, "scripts/runtime/bin"), { recursive: true });
  mkdirSync(resolve(root, "scripts/runtime/generated"), { recursive: true });
  mkdirSync(resolve(root, "skills/build"), { recursive: true });
  mkdirSync(resolve(root, "skills/handoff"), { recursive: true });
  mkdirSync(resolve(root, "skills/workers"), { recursive: true });

  writeFileSync(
    resolve(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "circuit", version: "0.3.0" }, null, 2),
    "utf-8",
  );
  writeFileSync(
    resolve(root, ".claude-plugin/marketplace.json"),
    JSON.stringify({ slug: "circuit" }, null, 2),
    "utf-8",
  );
  writeFileSync(
    resolve(root, ".claude-plugin/public-commands.txt"),
    renderPublicCommandsFile(SAMPLE_CATALOG),
    "utf-8",
  );

  writeFileSync(resolve(root, "commands/build.md"), renderCommandShim(SAMPLE_CATALOG[0]), "utf-8");
  writeFileSync(resolve(root, "commands/handoff.md"), renderCommandShim(SAMPLE_CATALOG[1]), "utf-8");

  writeFileSync(resolve(root, "hooks/hooks.json"), '{"hooks":{}}\n', "utf-8");
  writeFileSync(resolve(root, "hooks/session-start.sh"), "#!/usr/bin/env bash\necho start\n", "utf-8");
  chmodSync(resolve(root, "hooks/session-start.sh"), 0o755);

  writeFileSync(resolve(root, "schemas/event.schema.json"), "{}\n", "utf-8");
  writeFileSync(resolve(root, "schemas/state.schema.json"), "{}\n", "utf-8");
  writeFileSync(resolve(root, "schemas/surface-manifest.schema.json"), "{}\n", "utf-8");

  writeFileSync(resolve(root, "scripts/relay/dispatch.sh"), "#!/usr/bin/env bash\necho dispatch\n", "utf-8");
  chmodSync(resolve(root, "scripts/relay/dispatch.sh"), 0o755);
  writeFileSync(resolve(root, "scripts/runtime/bin/dispatch.js"), "#!/usr/bin/env node\n", "utf-8");
  chmodSync(resolve(root, "scripts/runtime/bin/dispatch.js"), 0o755);
  writeFileSync(resolve(root, "scripts/sync-to-cache.sh"), "#!/usr/bin/env bash\n", "utf-8");
  chmodSync(resolve(root, "scripts/sync-to-cache.sh"), 0o755);
  writeFileSync(resolve(root, "scripts/verify-install.sh"), "#!/usr/bin/env bash\n", "utf-8");
  chmodSync(resolve(root, "scripts/verify-install.sh"), 0o755);

  writeFileSync(resolve(root, "skills/build/SKILL.md"), "# Build\n", "utf-8");
  writeFileSync(resolve(root, "skills/build/circuit.yaml"), "id: build\n", "utf-8");
  writeFileSync(resolve(root, "skills/handoff/SKILL.md"), "# Handoff\n", "utf-8");
  writeFileSync(resolve(root, "skills/workers/SKILL.md"), "# Workers\n", "utf-8");
  writeFileSync(resolve(root, "circuit.config.example.yaml"), "dispatch: {}\n", "utf-8");

  writeFileSync(
    resolve(root, "scripts/runtime/generated/surface-manifest.json"),
    renderSurfaceManifest(root, SAMPLE_CATALOG),
    "utf-8",
  );
}

function makeFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), "circuit-installed-surface-"));
  writeFixture(root);
  return root;
}

function overwriteManifest(
  root: string,
  update: (manifest: {
    entries: Array<Record<string, unknown>>;
    files: Array<Record<string, unknown>>;
    public_commands: string[];
  }) => void,
): void {
  const manifestPath = resolve(root, "scripts/runtime/generated/surface-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    entries: Array<Record<string, unknown>>;
    files: Array<Record<string, unknown>>;
    public_commands: string[];
  };
  update(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

describe("verifyInstalledSurface", () => {
  it("passes in repo mode for a matching repo surface", () => {
    const root = makeFixture();

    expect(verifyInstalledSurface({ mode: "repo", pluginRoot: root })).toEqual({
      errors: [],
      ok: true,
    });
  });

  it("passes in installed mode for an exact installed surface", () => {
    const root = makeFixture();

    expect(verifyInstalledSurface({ mode: "installed", pluginRoot: root })).toEqual({
      errors: [],
      ok: true,
    });
  });

  it("fails when the manifest is missing", () => {
    const root = makeFixture();
    rmSync(resolve(root, "scripts/runtime/generated/surface-manifest.json"));

    const result = verifyInstalledSurface({ mode: "repo", pluginRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("missing shipped manifest scripts/runtime/generated/surface-manifest.json");
  });

  it("fails when the manifest is invalid JSON", () => {
    const root = makeFixture();
    writeFileSync(resolve(root, "scripts/runtime/generated/surface-manifest.json"), "{\n", "utf-8");

    const result = verifyInstalledSurface({ mode: "repo", pluginRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("invalid shipped manifest");
  });

  it("fails closed on installed top-level root drift", () => {
    const root = makeFixture();
    mkdirSync(resolve(root, "docs"));

    const result = verifyInstalledSurface({ mode: "installed", pluginRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("installed top-level surface drift");
  });

  it("fails when a shipped file is missing from disk", () => {
    const root = makeFixture();
    rmSync(resolve(root, "commands/build.md"));

    const result = verifyInstalledSurface({ mode: "repo", pluginRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("missing shipped file commands/build.md");
  });

  it("fails on file hash drift", () => {
    const root = makeFixture();
    writeFileSync(resolve(root, "commands/build.md"), "# Drifted\n", "utf-8");

    const result = verifyInstalledSurface({ mode: "repo", pluginRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("sha256 mismatch for commands/build.md");
  });

  it("fails on executable-bit drift", () => {
    const root = makeFixture();
    chmodSync(resolve(root, "hooks/session-start.sh"), 0o644);

    const result = verifyInstalledSurface({ mode: "repo", pluginRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("executable-bit mismatch for hooks/session-start.sh");
  });

  it("fails when manifest public_commands drift from public entries", () => {
    const root = makeFixture();
    overwriteManifest(root, (manifest) => {
      manifest.public_commands = ["build"];
    });

    const result = verifyInstalledSurface({ mode: "repo", pluginRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("manifest public_commands do not match public entry inventory");
  });
});
