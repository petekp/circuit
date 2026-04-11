/**
 * Catalog generator. Reads a Catalog and updates generated surfaces.
 * Block targets patch inline marker blocks. File targets write whole-file output.
 * Throws on missing or malformed markers (never silently skips).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { patchGeneratedBlock } from "./surface-text.js";
import type { Catalog, GenerateResult, GenerateTarget } from "./types.js";

interface GenerateOptions {
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
}

interface PendingWrite {
  content: string;
  filePath: string;
}

function readTargetContent(readFile: (path: string) => string, filePath: string): string {
  try {
    return readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

export function computeTargetContent(
  catalog: Catalog,
  target: GenerateTarget,
  currentContent: string,
): string {
  if ("blockName" in target) {
    return patchGeneratedBlock(
      currentContent,
      target.blockName,
      target.render(catalog),
      target.filePath,
    );
  }

  return target.render(catalog);
}

export function collectPendingWrites(
  catalog: Catalog,
  targets: GenerateTarget[],
  opts?: Pick<GenerateOptions, "readFile">,
): PendingWrite[] {
  const readFile = opts?.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const pendingWrites: PendingWrite[] = [];
  const stagedContents = new Map<string, string>();

  for (const target of targets) {
    const currentContent = stagedContents.has(target.filePath)
      ? stagedContents.get(target.filePath)!
      : readTargetContent(readFile, target.filePath);
    const nextContent = computeTargetContent(catalog, target, currentContent);

    if (nextContent !== currentContent) {
      stagedContents.set(target.filePath, nextContent);
      pendingWrites.push({ content: nextContent, filePath: target.filePath });
    }
  }

  return pendingWrites;
}

export function generate(
  catalog: Catalog,
  targets: GenerateTarget[],
  opts?: GenerateOptions,
): GenerateResult {
  const writeFile = opts?.writeFile ?? ((path: string, content: string) => {
    writeFileSync(path, content, "utf-8");
  });
  const pendingWrites = collectPendingWrites(catalog, targets, opts);

  for (const pendingWrite of pendingWrites) {
    mkdirSync(dirname(pendingWrite.filePath), { recursive: true });
    writeFile(pendingWrite.filePath, pendingWrite.content);
  }

  return {
    patchedFiles: pendingWrites.map((pendingWrite) => pendingWrite.filePath),
  };
}
