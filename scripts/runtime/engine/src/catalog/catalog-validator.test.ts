import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, loadJsonSchema, validate } from "../schema.js";
import { extract } from "./extract.js";
import { getGenerateTargets, pruneStaleCommandShims } from "./generate-targets.js";
import { collectPendingWrites } from "./generate.js";
import { isAdapter, isPublicEntry, isWorkflow, getPublicCommandIds } from "./public-surface.js";
import { SURFACE_MANIFEST_PATH, getInstalledSurfacePathPattern } from "./surface-roots.js";

const skillsDir = resolve(REPO_ROOT, "skills");

describe("catalog control-plane invariants", () => {
  const catalog = extract(skillsDir);

  it("uses the exact workflow|utility|adapter taxonomy", () => {
    expect(new Set(catalog.map((entry) => entry.kind))).toEqual(
      new Set(["workflow", "utility", "adapter"]),
    );
  });

  it("classifies workers as a non-public adapter", () => {
    const workers = catalog.find((entry) => entry.slug === "workers");
    expect(workers).toBeDefined();
    expect(workers && isAdapter(workers)).toBe(true);
    expect(workers && isPublicEntry(workers)).toBe(false);
  });

  it("derives workflow slash identity from slug plus optional usage", () => {
    const run = catalog.find((entry) => entry.slug === "run");
    expect(run && isWorkflow(run)).toBe(true);
    expect(run).toMatchObject({
      entryUsage: "<task>",
      slug: "run",
    });
  });
});

describe("generated public surface", () => {
  const catalog = extract(skillsDir);

  it("commands/ exactly matches the generated public command surface", () => {
    const expected = new Set(getPublicCommandIds(catalog));
    const actualCommands = new Set(
      readdirSync(resolve(REPO_ROOT, "commands"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => name.replace(/\.md$/, "")),
    );
    const publicCommands = new Set(
      readFileSync(resolve(REPO_ROOT, ".claude-plugin/public-commands.txt"), "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );

    expect(actualCommands).toEqual(expected);
    expect(publicCommands).toEqual(expected);
  });

  it("all generated targets are fresh and there are no stale public shims", () => {
    expect(collectPendingWrites(catalog, getGenerateTargets(REPO_ROOT, catalog))).toEqual([]);
    expect(pruneStaleCommandShims(REPO_ROOT, catalog)).toEqual([]);
  });

  it("surface-manifest.json is checked in, schema-valid, and aligned to the catalog", () => {
    const manifestPath = resolve(REPO_ROOT, SURFACE_MANIFEST_PATH);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const schema = loadJsonSchema("schemas/surface-manifest.schema.json");

    expect(validate(schema, manifest)).toEqual([]);
    expect(manifest.public_commands).toEqual(getPublicCommandIds(catalog));
    expect(manifest.entries.map((entry: { slug: string }) => entry.slug)).toEqual(
      [...catalog].map((entry) => entry.slug),
    );
  });

  it("derives the schema path allowlist from the surface-roots owner", () => {
    const schema = loadJsonSchema("schemas/surface-manifest.schema.json") as {
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
