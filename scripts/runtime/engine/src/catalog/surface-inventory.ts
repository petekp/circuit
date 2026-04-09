/**
 * Owns repo-time installed inventory projection, generated-file inclusion, and plugin metadata.
 * It does not implement raw file walking, hashing, or executable-bit detection primitives.
 */

import { readFileSync } from "node:fs";
import { posix as posixPath, resolve } from "node:path";

import { getPublicEntries, renderCommandShim, renderPublicCommandsFile } from "./public-surface.js";
import {
  collectSurfaceFiles,
  isExecutableFile,
  sha256File,
  sha256Text,
} from "./surface-fs.js";
import {
  SURFACE_MANIFEST_PATH,
  listInstalledSurfaceSeedPaths,
  shouldIgnoreInstalledPath,
} from "./surface-roots.js";
import type { Catalog, SurfaceManifestFile } from "./types.js";

interface GeneratedInventoryProjection {
  content: string;
  executable: boolean;
}

function assertNoMissingRepoSeedPaths(missingSeedPaths: readonly string[]): void {
  if (missingSeedPaths.length === 0) {
    return;
  }

  throw new Error(
    `catalog-compiler: missing repo installed-surface seed path(s): ${
      [...missingSeedPaths].sort().join(", ")
    }`,
  );
}

function listInstalledFiles(repoRoot: string): string[] {
  const result = collectSurfaceFiles({
    ignoreRelativePath: shouldIgnoreInstalledPath,
    rootDir: repoRoot,
    seedPaths: listInstalledSurfaceSeedPaths("repo"),
  });

  assertNoMissingRepoSeedPaths(result.missingSeedPaths);
  return result.files;
}

function buildGeneratedInventoryProjections(
  catalog: Catalog,
): Map<string, GeneratedInventoryProjection> {
  const projections = new Map<string, GeneratedInventoryProjection>();

  projections.set(".claude-plugin/public-commands.txt", {
    content: renderPublicCommandsFile(catalog),
    executable: false,
  });

  for (const entry of getPublicEntries(catalog)) {
    projections.set(posixPath.join("commands", `${entry.slug}.md`), {
      content: renderCommandShim(entry),
      executable: false,
    });
  }

  return projections;
}

export function getPluginMetadata(repoRoot: string): { name: string; version: string } {
  const pluginJsonPath = resolve(repoRoot, ".claude-plugin", "plugin.json");
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf-8")) as Record<string, unknown>;
  const name = pluginJson.name;
  const version = pluginJson.version;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`catalog-compiler: ${pluginJsonPath} -- plugin.name must be a non-empty string`);
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(`catalog-compiler: ${pluginJsonPath} -- plugin.version must be a non-empty string`);
  }

  return { name, version };
}

export function getInstalledFileInventory(repoRoot: string, catalog: Catalog): SurfaceManifestFile[] {
  const projections = buildGeneratedInventoryProjections(catalog);
  const files = new Set(listInstalledFiles(repoRoot));
  for (const relativePath of projections.keys()) {
    files.add(relativePath);
  }
  const inventory: SurfaceManifestFile[] = [];

  for (const relativePath of [...files].sort()) {
    if (relativePath === SURFACE_MANIFEST_PATH || shouldIgnoreInstalledPath(relativePath)) {
      continue;
    }

    const generated = projections.get(relativePath);
    if (generated) {
      inventory.push({
        executable: generated.executable,
        path: relativePath,
        sha256: sha256Text(generated.content),
      });
      continue;
    }

    const absolutePath = resolve(repoRoot, relativePath);
    inventory.push({
      executable: isExecutableFile(absolutePath),
      path: relativePath,
      sha256: sha256File(absolutePath),
    });
  }

  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}
