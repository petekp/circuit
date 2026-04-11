/**
 * Owns repo-time installed inventory projection, generated-file inclusion, and plugin metadata.
 * It does not implement raw file walking, hashing, or executable-bit detection primitives.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { computeTargetContent } from "./generate.js";
import { getGenerateTargets } from "./generate-targets.js";
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

function readTargetContent(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function isInstalledSurfaceProjection(
  relativePath: string,
  installedSeedPaths: readonly string[],
): boolean {
  return installedSeedPaths.some((seedPath) =>
    relativePath === seedPath || relativePath.startsWith(`${seedPath}/`)
  );
}

function buildGeneratedInventoryProjections(
  repoRoot: string,
  catalog: Catalog,
): Map<string, GeneratedInventoryProjection> {
  const projections = new Map<string, GeneratedInventoryProjection>();
  const installedSeedPaths = listInstalledSurfaceSeedPaths("repo");
  const stagedContents = new Map<string, string>();

  for (const target of getGenerateTargets(repoRoot, catalog)) {
    const relativePath = relative(repoRoot, target.filePath).replace(/\\/g, "/");
    if (relativePath === SURFACE_MANIFEST_PATH) {
      continue;
    }
    if (shouldIgnoreInstalledPath(relativePath)) {
      continue;
    }
    if (!isInstalledSurfaceProjection(relativePath, installedSeedPaths)) {
      continue;
    }

    const currentContent = stagedContents.has(target.filePath)
      ? stagedContents.get(target.filePath)!
      : "blockName" in target
      ? readTargetContent(target.filePath)
      : "";
    const content = computeTargetContent(catalog, target, currentContent);

    stagedContents.set(target.filePath, content);
    projections.set(relativePath, { content, executable: false });
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
  const projections = buildGeneratedInventoryProjections(repoRoot, catalog);
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
