import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../schema.js";
import {
  INSTALLED_SURFACE_ROOTS,
  REPO_ONLY_SURFACE_ROOTS,
  SURFACE_MANIFEST_PATH,
  getInstalledSurfacePathPattern,
  listInstalledSurfaceRoots,
  listInstalledSurfaceSeedPaths,
  shouldIgnoreInstalledPath,
} from "./surface-roots.js";

describe("surface-roots owner", () => {
  it("owns the installed roots, repo-only roots, and manifest path", () => {
    expect(INSTALLED_SURFACE_ROOTS).toEqual([
      ".claude-plugin",
      "commands",
      "hooks",
      "schemas",
      "scripts",
      "skills",
      "circuit.config.example.yaml",
    ]);
    expect(REPO_ONLY_SURFACE_ROOTS).toEqual([
      "README.md",
      "ARCHITECTURE.md",
      "CIRCUITS.md",
      "CUSTOM-CIRCUITS.md",
      "docs",
      "assets",
    ]);
    expect(SURFACE_MANIFEST_PATH).toBe("scripts/runtime/generated/surface-manifest.json");
    expect(listInstalledSurfaceRoots()).toEqual([...INSTALLED_SURFACE_ROOTS]);
    expect(listInstalledSurfaceSeedPaths("installed")).toEqual([...INSTALLED_SURFACE_ROOTS]);
    expect(listInstalledSurfaceSeedPaths("repo")).toEqual([
      ".claude-plugin",
      "commands",
      "hooks",
      "schemas",
      "skills",
      "circuit.config.example.yaml",
      "scripts/sync-to-cache.sh",
      "scripts/verify-install.sh",
      "scripts/relay",
      "scripts/runtime/bin",
      "scripts/runtime/generated",
    ]);
  });

  it("owns ignored-path policy and the schema path allowlist", () => {
    expect(shouldIgnoreInstalledPath("scripts/runtime/bin/.vite/results.json")).toBe(true);
    expect(shouldIgnoreInstalledPath("scripts/runtime/bin/dispatch.js")).toBe(false);
    expect(getInstalledSurfacePathPattern()).toBe(
      "^(\\.claude-plugin|commands|hooks|schemas|scripts|skills)(?:/[^/].*)?$|^circuit\\.config\\.example\\.yaml$",
    );
  });

  it("keeps the schema path pattern exactly synced to the owner", () => {
    const schema = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "schemas/surface-manifest.schema.json"), "utf-8"),
    ) as {
      $defs: {
        file: {
          properties: {
            path: {
              pattern: string;
            };
          };
        };
      };
    };

    expect(schema.$defs.file.properties.path.pattern).toBe(getInstalledSurfacePathPattern());
  });
});
