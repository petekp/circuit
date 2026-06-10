import { resolve } from 'node:path';

// Path-suffix guard shared by the plugin cache/refresh scripts. This was
// duplicated verbatim in scripts/plugins/sync-cache-core.ts and
// scripts/plugins/refresh-local.ts; hoisting it here keeps a single source of
// truth for "does this absolute path end with these segments", which both
// scripts use to refuse operating on caches outside the expected package path.
export function pathEndsWithSegments(path: string, suffix: readonly string[]): boolean {
  const parts = resolve(path)
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts.length < suffix.length) return false;
  return suffix.every((segment, index) => parts[parts.length - suffix.length + index] === segment);
}
