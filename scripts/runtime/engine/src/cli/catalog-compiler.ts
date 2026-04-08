#!/usr/bin/env node
/**
 * CLI entry point for catalog-compiler.
 *
 * Usage:
 *   node catalog-compiler.js generate    # Patch marker blocks in target files
 *   node catalog-compiler.js catalog     # Emit catalog JSON to stdout
 *
 * Exits 0 on success, 1 on error.
 */

import { resolve, dirname } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extract } from "../catalog/extract.js";
import { generate } from "../catalog/generate.js";
import {
  getGenerateTargets,
  pruneStaleCommandShims,
} from "../catalog/surfaces.js";

const MODULE_DIR =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

function findRepoRoot(): string {
  let dir = MODULE_DIR;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "skills"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(MODULE_DIR, "..", "..", "..", "..");
}

function main(): number {
  const subcommand = process.argv[2];

  if (!subcommand || !["generate", "catalog"].includes(subcommand)) {
    process.stderr.write("Usage: catalog-compiler <generate|catalog>\n");
    return 1;
  }

  const repoRoot = findRepoRoot();
  const skillsDir = resolve(repoRoot, "skills");

  if (!existsSync(skillsDir)) {
    process.stderr.write(`Error: skills directory not found at ${skillsDir}\n`);
    return 1;
  }

  try {
    const catalog = extract(skillsDir);

    if (subcommand === "catalog") {
      process.stdout.write(JSON.stringify(catalog, null, 2) + "\n");
      return 0;
    }

    // generate
    const targets = getGenerateTargets(repoRoot, catalog);
    const result = generate(catalog, targets);
    const staleShimPaths = pruneStaleCommandShims(repoRoot, catalog);
    for (const path of staleShimPaths) {
      rmSync(path);
      process.stdout.write(`removed: ${path}\n`);
    }

    for (const file of result.patchedFiles) {
      process.stdout.write(`patched: ${file}\n`);
    }

    if (result.patchedFiles.length === 0 && staleShimPaths.length === 0) {
      process.stdout.write("all blocks up to date\n");
    }

    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

process.exit(main());
