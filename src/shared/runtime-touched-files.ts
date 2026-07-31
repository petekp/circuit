import {
  type RuntimeGitStateEntry,
  type RuntimeGitStateSnapshot,
  type RuntimeHiddenIndexFlag,
  type RuntimeTouchedFileStatus,
  RuntimeTouchedFilesProjection,
  type RuntimeTouchedFilesProjection as RuntimeTouchedFilesProjectionValue,
} from '../schemas/runtime-evidence.js';

export type {
  RuntimeGitStateEntry,
  RuntimeGitStateSnapshot,
  RuntimeHiddenIndexFlag,
  RuntimeTouchedFile,
  RuntimeTouchedFileStatus,
  RuntimeTouchedFilesProjection,
} from '../schemas/runtime-evidence.js';

export type ProjectRuntimeTouchedFilesOptions = {
  readonly baseline: RuntimeGitStateSnapshot;
  readonly post: RuntimeGitStateSnapshot;
  readonly workerDeclaredPaths?: readonly string[];
  readonly ignoredPathPrefixes?: readonly string[];
  readonly generatedSurfacePathPrefixes?: readonly string[];
  readonly protectedPathPrefixes?: readonly string[];
};

function isPathInPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function filterEntries(
  entries: readonly RuntimeGitStateEntry[],
  prefixes: readonly string[],
): RuntimeGitStateEntry[] {
  if (prefixes.length === 0) return [...entries];
  return entries.filter((entry) => !isPathInPrefix(entry.path, prefixes));
}

function filterHiddenFlags(
  flags: readonly RuntimeHiddenIndexFlag[],
  prefixes: readonly string[],
): RuntimeHiddenIndexFlag[] {
  if (prefixes.length === 0) return [...flags];
  return flags.filter((flag) => !isPathInPrefix(flag.path, prefixes));
}

function entriesByPath(
  entries: readonly RuntimeGitStateEntry[],
): Map<string, RuntimeGitStateEntry> {
  const map = new Map<string, RuntimeGitStateEntry>();
  for (const entry of entries) {
    map.set(entry.path, entry);
  }
  return map;
}

function hiddenPaths(flags: readonly RuntimeHiddenIndexFlag[]): Set<string> {
  return new Set(flags.map((flag) => flag.path));
}

function uniqueSorted(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function statusFromEntry(
  baseline: RuntimeGitStateEntry | undefined,
  post: RuntimeGitStateEntry | undefined,
): RuntimeTouchedFileStatus {
  if (post?.from !== undefined || post?.status_code.includes('R')) {
    return 'renamed';
  }
  if (post?.status_code.includes('D')) {
    return 'deleted';
  }
  if (
    baseline === undefined &&
    post !== undefined &&
    (post.status_code.includes('?') || post.status_code.includes('A'))
  ) {
    return 'added';
  }
  return 'modified';
}

function uniqueFlags(flags: readonly RuntimeHiddenIndexFlag[]): RuntimeHiddenIndexFlag[] {
  const seen = new Set<string>();
  const out: RuntimeHiddenIndexFlag[] = [];
  for (const flag of flags) {
    const key = `${flag.tag}\0${flag.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(flag);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.tag.localeCompare(b.tag));
}

export function projectRuntimeTouchedFiles(
  options: ProjectRuntimeTouchedFilesOptions,
): RuntimeTouchedFilesProjectionValue {
  const ignoredPathPrefixes = options.ignoredPathPrefixes ?? [];
  const baselineEntries = filterEntries(options.baseline.entries, ignoredPathPrefixes);
  const postEntries = filterEntries(options.post.entries, ignoredPathPrefixes);
  const baselineHiddenFlags = filterHiddenFlags(
    options.baseline.hidden_index_flags,
    ignoredPathPrefixes,
  );
  const postHiddenFlags = filterHiddenFlags(options.post.hidden_index_flags, ignoredPathPrefixes);

  const baselineByPath = entriesByPath(baselineEntries);
  const postByPath = entriesByPath(postEntries);
  const baselinePaths = new Set(baselineByPath.keys());
  const postPaths = new Set(postByPath.keys());
  const hiddenBaselinePaths = hiddenPaths(baselineHiddenFlags);

  const newDirt = [...postPaths].filter((path) => !baselinePaths.has(path));
  const baselineDirtyMutated = [...baselinePaths].filter((path) => {
    if (hiddenBaselinePaths.has(path)) return false;
    const before = baselineByPath.get(path);
    const after = postByPath.get(path);
    return before?.fingerprint !== after?.fingerprint;
  });

  const observed = uniqueSorted([...newDirt, ...baselineDirtyMutated]);
  const workerDeclared = uniqueSorted(
    (options.workerDeclaredPaths ?? []).filter(
      (path) => !isPathInPrefix(path, ignoredPathPrefixes),
    ),
  );
  const observedSet = new Set(observed);
  const workerDeclaredSet = new Set(workerDeclared);
  const undeclaredWorkerExtras = observed.filter((path) => !workerDeclaredSet.has(path));

  // A declared path that was already dirty when the run started and whose
  // content is byte-identical now was not touched by this run — but neither
  // was it invented. A prior run (or the operator) left it modified, the
  // worker read the working tree and took it for its own. Splitting that case
  // out keeps the overclaim gate pointed at real overclaims: a declared path
  // that was never dirty and is still clean stays a hard failure.
  //
  // The split only applies to a run that actually changed something. If
  // nothing was observed, every declaration stays in missing_worker_declared,
  // so "I fixed it" can never pass on zero work.
  const declaredNotObserved = workerDeclared.filter((path) => !observedSet.has(path));
  const declaredPreExistingDirt =
    observed.length === 0
      ? []
      : declaredNotObserved.filter((path) => {
          const before = baselineByPath.get(path);
          if (before === undefined || hiddenBaselinePaths.has(path)) return false;
          return before.fingerprint === postByPath.get(path)?.fingerprint;
        });
  const preExistingDirtSet = new Set(declaredPreExistingDirt);
  const missingWorkerDeclared = declaredNotObserved.filter((path) => !preExistingDirtSet.has(path));

  return RuntimeTouchedFilesProjection.parse({
    baseline_head_sha: options.baseline.head_sha,
    head_sha: options.post.head_sha,
    head_diverged: options.baseline.head_sha !== options.post.head_sha,
    files: observed.map((path) => {
      const baseline = baselineByPath.get(path);
      const post = postByPath.get(path);
      return {
        path,
        status: statusFromEntry(baseline, post),
        source: 'runtime_diff',
        generated_surface: isPathInPrefix(path, options.generatedSurfacePathPrefixes ?? []),
        protected: isPathInPrefix(path, options.protectedPathPrefixes ?? []),
        // Carry the rename/copy source so a path-containment consumer can check
        // both endpoints. This does NOT enter `observed` or the worker-claim
        // comparison above, so the change-set verdict (Fix) is unchanged.
        ...(post?.from === undefined ? {} : { from: post.from }),
      };
    }),
    worker_declared: workerDeclared,
    worker_claim_matches_runtime:
      undeclaredWorkerExtras.length === 0 && missingWorkerDeclared.length === 0,
    undeclared_worker_extras: undeclaredWorkerExtras,
    missing_worker_declared: missingWorkerDeclared,
    declared_pre_existing_dirt: declaredPreExistingDirt,
    baseline_dirty_mutated: uniqueSorted(baselineDirtyMutated),
    hidden_index_flags: uniqueFlags([...baselineHiddenFlags, ...postHiddenFlags]),
  });
}
