/**
 * Owns raw installed-surface filesystem facts: recursive file collection, hashing, top-level
 * listings, and executable-bit detection.
 * It does not know about Catalog entries, surface manifests, verifier policy, or reporter output.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { posix as posixPath, resolve } from "node:path";

export interface CollectSurfaceFilesOptions {
  ignoreRelativePath?: (relativePath: string) => boolean;
  rootDir: string;
  seedPaths: readonly string[];
}

export interface CollectSurfaceFilesResult {
  files: string[];
  missingSeedPaths: string[];
}

function sha256(value: Buffer | string, encoding?: BufferEncoding): string {
  const hash = createHash("sha256");
  if (typeof value === "string") {
    if (encoding) {
      hash.update(value, encoding);
    } else {
      hash.update(value);
    }
  } else {
    hash.update(value);
  }
  return hash.digest("hex");
}

function walkSurfaceFiles(
  absolutePath: string,
  relativePath: string,
  files: string[],
  ignoreRelativePath?: (relativePath: string) => boolean,
): void {
  if (ignoreRelativePath?.(relativePath)) {
    return;
  }

  const stat = lstatSync(absolutePath);
  if (stat.isDirectory()) {
    for (const child of readdirSync(absolutePath).sort()) {
      walkSurfaceFiles(
        resolve(absolutePath, child),
        posixPath.join(relativePath, child),
        files,
        ignoreRelativePath,
      );
    }
    return;
  }

  if (stat.isFile()) {
    files.push(relativePath);
  }
}

export function collectSurfaceFiles(
  options: CollectSurfaceFilesOptions,
): CollectSurfaceFilesResult {
  const files: string[] = [];
  const missingSeedPaths: string[] = [];

  for (const relativePath of options.seedPaths) {
    const absolutePath = resolve(options.rootDir, relativePath);
    if (!existsSync(absolutePath)) {
      missingSeedPaths.push(relativePath);
      continue;
    }

    walkSurfaceFiles(
      absolutePath,
      relativePath,
      files,
      options.ignoreRelativePath,
    );
  }

  return {
    files: files.sort(),
    missingSeedPaths,
  };
}

export function sha256Text(content: string): string {
  return sha256(content, "utf-8");
}

export function sha256File(filePath: string): string {
  return sha256(readFileSync(filePath));
}

export function isExecutableFile(filePath: string): boolean {
  return (statSync(filePath).mode & 0o111) !== 0;
}

export function listTopLevelEntries(rootDir: string): string[] {
  return readdirSync(rootDir).sort();
}
