// Atomic file writes for control-plane artifacts: stage to a sibling temp
// file, then rename over the target. Rename is atomic within a filesystem,
// so a concurrent reader sees either the old file or the new one, never a
// torn half-write. Writers that persist schema-validated artifacts pass a
// `validate` hook that re-reads the staged bytes before the rename commits,
// so a serialization defect can never land on disk.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AtomicWriteOptions {
  /**
   * Called with the staged file's bytes (re-read from disk) before the
   * rename commits. Throw to abort the write; the target is left untouched.
   */
  readonly validate?: (raw: string) => void;
}

export function writeTextAtomic(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${randomUUID()}.tmp`;
  writeFileSync(staging, contents);
  try {
    options.validate?.(readFileSync(staging, 'utf8'));
    renameSync(staging, path);
  } catch (error) {
    // Failed writes must not accumulate orphaned staging files next to the
    // target; nothing globs or cleans them up later.
    rmSync(staging, { force: true });
    throw error;
  }
}

/** Atomic write of `JSON.stringify(value, null, 2)` plus a trailing newline. */
export function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}
