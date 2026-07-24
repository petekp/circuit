export const RUNTIME_GIT_OPERATIONS = [
  'status',
  'staged_diff',
  'unstaged_diff',
  'staged_diff_stat',
  'unstaged_diff_stat',
  'resolve_target',
  'target_diff',
  'target_diff_stat',
  'hidden_index_flags',
  'staged_changed_gitlinks',
  'unstaged_changed_gitlinks',
  'untracked_files',
] as const;

export const RUNTIME_GIT_HARDENED_CONFIG = Object.freeze([
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null',
  'color.ui=false',
  'color.diff=false',
  'diff.external=',
  'interactive.diffFilter=',
  'credential.helper=',
  'core.sshCommand=false',
  'protocol.allow=never',
  'protocol.file.allow=never',
  'protocol.ext.allow=never',
  'submodule.recurse=false',
] as const);

export type RuntimeGitOperation = (typeof RUNTIME_GIT_OPERATIONS)[number];

export type RuntimeGitTarget =
  | {
      readonly kind: 'commit';
      readonly ref: string;
    }
  | {
      readonly kind: 'range';
      readonly base: string;
      readonly head: string;
      readonly dots: '..' | '...';
    };

/**
 * A repository-relative narrowing of a Git read. The strings are plain paths
 * or globs; the pathspec magic that turns an exclusion into `:(exclude)path`
 * is added here, once, so no caller has to hand-build one.
 */
export type RuntimeGitPathScope = {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
};

const RUNTIME_GIT_SCOPE_PATH_PATTERN = /^[A-Za-z0-9._@+*?[\]/-]+$/u;
const MAX_RUNTIME_GIT_SCOPE_PATHS = 32;
const MAX_RUNTIME_GIT_SCOPE_PATH_LENGTH = 200;

function runtimeGitScopePathProblem(value: unknown, label: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return `Git path scope ${label} entries must be non-empty strings.`;
  }
  if (value.length > MAX_RUNTIME_GIT_SCOPE_PATH_LENGTH) {
    return `Git path scope ${label} entry is too long.`;
  }
  if (!RUNTIME_GIT_SCOPE_PATH_PATTERN.test(value)) {
    return `Git path scope ${label} entry ${JSON.stringify(value)} is not a plain repository path.`;
  }
  if (value.startsWith('/') || value.startsWith('-') || value.split('/').includes('..')) {
    return `Git path scope ${label} entry ${JSON.stringify(value)} must stay inside the repository.`;
  }
  return undefined;
}

/**
 * Validate a path scope that crossed a process boundary. The reader that runs
 * Git re-checks it rather than trusting the caller: a pathspec is an argument
 * to a command, and a scope arriving as `-x` or `:(attr:...)` would be one the
 * operator never asked for.
 */
export function runtimeGitPathScopeProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Git path scope must be an object.';
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'include' && key !== 'exclude') {
      return `Unknown Git path scope field ${JSON.stringify(key)}.`;
    }
  }
  if (!Array.isArray(record.include) || !Array.isArray(record.exclude)) {
    return 'Git path scope include and exclude must both be arrays.';
  }
  if (record.include.length === 0 && record.exclude.length === 0) {
    return 'Git path scope must name at least one path.';
  }
  if (record.include.length + record.exclude.length > MAX_RUNTIME_GIT_SCOPE_PATHS) {
    return 'Git path scope names too many paths.';
  }
  for (const entry of record.include) {
    const problem = runtimeGitScopePathProblem(entry, 'include');
    if (problem !== undefined) return problem;
  }
  for (const entry of record.exclude) {
    const problem = runtimeGitScopePathProblem(entry, 'exclude');
    if (problem !== undefined) return problem;
  }
  return undefined;
}

export function runtimeGitPathspecs(scope: RuntimeGitPathScope | undefined): readonly string[] {
  if (scope === undefined) return Object.freeze([]);
  return Object.freeze([...scope.include, ...scope.exclude.map((path) => `:(exclude)${path}`)]);
}

/**
 * Append a path scope to a Git argument list. Git needs the `--` separator
 * before pathspecs; some argument lists already carry one, so this adds it
 * only when it is missing. With no scope the arguments are returned unchanged,
 * which keeps an unscoped read byte-identical to what it was before scoping
 * existed.
 */
export function runtimeGitArgsWithPathScope(
  args: readonly string[],
  scope: RuntimeGitPathScope | undefined,
): readonly string[] {
  const specs = runtimeGitPathspecs(scope);
  if (specs.length === 0) return args;
  return args.at(-1) === '--' ? [...args, ...specs] : [...args, '--', ...specs];
}

export type RuntimeGitPinnedTarget =
  | {
      readonly kind: 'commit';
      readonly commit: string;
    }
  | {
      readonly kind: 'range';
      readonly base_commit: string;
      readonly head_commit: string;
      readonly dots: '..' | '...';
    };

export interface RuntimeGitReadResult {
  readonly schema_version: 1;
  readonly ok: boolean;
  readonly operation: RuntimeGitOperation;
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number | null;
  readonly truncated: boolean;
  readonly limit_bytes: number;
  readonly cleanup_confirmed: boolean;
  readonly resolved_target?: RuntimeGitPinnedTarget;
}

export type RuntimeGitReadRequest =
  | {
      readonly operation: 'resolve_target';
      readonly projectRoot: string;
      readonly target: RuntimeGitTarget;
      // Resolving a ref reads no paths, so a scope here would be meaningless.
      readonly paths?: never;
    }
  | {
      readonly operation: 'target_diff' | 'target_diff_stat';
      readonly projectRoot: string;
      readonly target: RuntimeGitPinnedTarget;
      readonly paths?: RuntimeGitPathScope;
    }
  | {
      readonly operation: Exclude<
        RuntimeGitOperation,
        'resolve_target' | 'target_diff' | 'target_diff_stat'
      >;
      readonly projectRoot: string;
      readonly target?: never;
      readonly paths?: RuntimeGitPathScope;
    };

/**
 * A run-scoped, read-only Git capability. The implementation is bound to the
 * trusted project root. Callers first resolve a symbolic Review target, then
 * use only the returned immutable commit ids for its diff and stat reads.
 */
export interface RuntimeGitReader {
  readonly read: (request: RuntimeGitReadRequest) => Promise<RuntimeGitReadResult>;
}

/**
 * Runtime Git results cross process and plugin boundaries as strings. Reject
 * malformed surrogate pairs, which only a broken encoder produces. A literal
 * U+FFFD is not rejected: it is a legal character that real source files
 * contain, and refusing it would refuse reviews of those files.
 */
export function runtimeGitTextIsValidUtf8(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/**
 * Node reports a synchronous child-process maxBuffer breach as ENOBUFS.
 * Only that error proves stdout is a bounded prefix. Timeouts and arbitrary
 * launch failures may also retain stdout, but that output is not trustworthy
 * enough to continue a Review.
 */
export function runtimeGitSpawnErrorAllowsPartialOutput(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { readonly code?: unknown }).code === 'ENOBUFS';
}

export function changedPathsFromRuntimeGitStatus(stdout: string): ReadonlySet<string> {
  const tokens = stdout.split('\0');
  const changed = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (entry === undefined || entry.length === 0) continue;
    if (entry.length < 4 || entry[2] !== ' ') {
      throw new Error('The bounded Git reader returned malformed status output.');
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length === 0) throw new Error('The bounded Git reader returned an empty path.');
    changed.add(path);
    if (status.includes('R') || status.includes('C')) {
      const previousPath = tokens[index + 1];
      if (previousPath === undefined || previousPath.length === 0) {
        throw new Error('The bounded Git reader returned a malformed rename entry.');
      }
      changed.add(previousPath);
      index += 1;
    }
  }
  return changed;
}
