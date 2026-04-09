#!/usr/bin/env node
/**
 * CLI entry point for catalog-compiler.
 *
 * Usage:
 *   node catalog-compiler.js generate [--check]
 *   node catalog-compiler.js catalog
 *
 * Exits 0 on success, 1 on error.
 */

import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extract } from "../catalog/extract.js";
import { getGenerateTargets, pruneStaleCommandShims } from "../catalog/generate-targets.js";
import { collectPendingWrites, generate } from "../catalog/generate.js";

const MODULE_DIR =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

function findRepoRoot(): string {
  let dir = MODULE_DIR;
  for (let index = 0; index < 10; index++) {
    if (existsSync(resolve(dir, "skills"))) {
      return dir;
    }

    const parent = resolve(dir, "..");
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return resolve(MODULE_DIR, "..", "..", "..", "..");
}

function main(): number {
  const subcommand = process.argv[2];
  const extraArgs = process.argv.slice(3);
  const checkMode = extraArgs.includes("--check");

  if (!subcommand || !["generate", "catalog"].includes(subcommand)) {
    process.stderr.write("Usage: catalog-compiler <generate|catalog> [--check]\n");
    return 1;
  }

  if (subcommand === "catalog" && checkMode) {
    process.stderr.write("catalog-compiler: --check is only supported for generate\n");
    return 1;
  }

  const unknownArgs = extraArgs.filter((arg) => arg !== "--check");
  if (unknownArgs.length > 0) {
    process.stderr.write(`catalog-compiler: unknown option(s): ${unknownArgs.join(", ")}\n`);
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
      process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
      return 0;
    }

    const targets = getGenerateTargets(repoRoot, catalog);
    const staleShimPaths = pruneStaleCommandShims(repoRoot, catalog);

    if (checkMode) {
      const pendingWrites = collectPendingWrites(catalog, targets);

      for (const filePath of staleShimPaths) {
        process.stdout.write(`stale-remove: ${filePath}\n`);
      }
      for (const pendingWrite of pendingWrites) {
        process.stdout.write(`stale-write: ${pendingWrite.filePath}\n`);
      }

      if (pendingWrites.length === 0 && staleShimPaths.length === 0) {
        process.stdout.write("generated surfaces are up to date\n");
        return 0;
      }

      process.stderr.write(
        'catalog-compiler: generated surfaces are stale. Run "node scripts/runtime/bin/catalog-compiler.js generate"\n',
      );
      return 1;
    }

    const result = generate(catalog, targets);
    for (const filePath of staleShimPaths) {
      rmSync(filePath);
      process.stdout.write(`removed: ${filePath}\n`);
    }
    for (const filePath of result.patchedFiles) {
      process.stdout.write(`patched: ${filePath}\n`);
    }

    if (result.patchedFiles.length === 0 && staleShimPaths.length === 0) {
      process.stdout.write("all generated surfaces up to date\n");
    }

    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exit(main());
