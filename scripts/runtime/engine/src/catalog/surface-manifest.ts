/**
 * Owns surface-manifest entry projection, assembly, and rendering.
 * It does not walk the filesystem directly or decide which files are stale shims.
 */

import {
  getPublicCommandIds,
  getPublicCommandProjection,
  isPublicEntry,
} from "./public-surface.js";
import { getInstalledFileInventory, getPluginMetadata } from "./surface-inventory.js";
import type { Catalog, SurfaceManifest, SurfaceManifestEntry } from "./types.js";

function projectSurfaceManifestEntries(catalog: Catalog): SurfaceManifestEntry[] {
  return [...catalog]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((entry) => {
      if (!isPublicEntry(entry)) {
        return {
          kind: entry.kind,
          public: false,
          slug: entry.slug,
        };
      }

      return {
        kind: entry.kind,
        public: true,
        publicCommand: getPublicCommandProjection(entry),
        slug: entry.slug,
      };
    });
}

export function buildSurfaceManifest(repoRoot: string, catalog: Catalog): SurfaceManifest {
  return {
    entries: projectSurfaceManifestEntries(catalog),
    files: getInstalledFileInventory(repoRoot, catalog),
    plugin: getPluginMetadata(repoRoot),
    public_commands: getPublicCommandIds(catalog),
    schema_version: "1",
  };
}

export function renderSurfaceManifest(repoRoot: string, catalog: Catalog): string {
  return `${JSON.stringify(buildSurfaceManifest(repoRoot, catalog), null, 2)}\n`;
}
