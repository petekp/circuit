/**
 * Owns generated target registration and stale public-shim discovery.
 * It does not decide how public entries are projected or how manifest data is assembled.
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { getCatalogDocTargets } from "./catalog-doc-projections.js";
import {
  getPublicCommandIds,
  getPublicEntries,
  renderCommandShim,
  renderPublicCommandsFile,
} from "./public-surface.js";
import { renderSurfaceManifest } from "./surface-manifest.js";
import { SURFACE_MANIFEST_PATH } from "./surface-roots.js";
import type { Catalog, FileGenerateTarget, GenerateTarget } from "./types.js";

function getSurfaceFileTargets(repoRoot: string, catalog: Catalog): FileGenerateTarget[] {
  const commandTargets: FileGenerateTarget[] = getPublicEntries(catalog).map((entry) => ({
    filePath: resolve(repoRoot, "commands", `${entry.slug}.md`),
    render: () => renderCommandShim(entry),
  }));

  return [
    {
      filePath: resolve(repoRoot, ".claude-plugin", "public-commands.txt"),
      render: renderPublicCommandsFile,
    },
    ...commandTargets,
    {
      filePath: resolve(repoRoot, SURFACE_MANIFEST_PATH),
      render: (entries) => renderSurfaceManifest(repoRoot, entries),
    },
  ];
}

export function getGenerateTargets(repoRoot: string, catalog: Catalog): GenerateTarget[] {
  return [...getCatalogDocTargets(repoRoot), ...getSurfaceFileTargets(repoRoot, catalog)];
}

export function pruneStaleCommandShims(repoRoot: string, catalog: Catalog): string[] {
  const commandsDir = resolve(repoRoot, "commands");
  if (!existsSync(commandsDir)) {
    return [];
  }

  const expected = new Set(getPublicCommandIds(catalog).map((slug) => `${slug}.md`));
  const removed: string[] = [];

  for (const name of readdirSync(commandsDir).sort()) {
    if (!name.endsWith(".md")) {
      continue;
    }
    if (expected.has(name)) {
      continue;
    }

    removed.push(resolve(commandsDir, name));
  }

  return removed;
}
