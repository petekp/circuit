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
    }
  | {
      readonly operation: 'target_diff' | 'target_diff_stat';
      readonly projectRoot: string;
      readonly target: RuntimeGitPinnedTarget;
    }
  | {
      readonly operation: Exclude<
        RuntimeGitOperation,
        'resolve_target' | 'target_diff' | 'target_diff_stat'
      >;
      readonly projectRoot: string;
      readonly target?: never;
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
