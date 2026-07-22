export const RUNTIME_GIT_OPERATIONS = [
  'status',
  'staged_diff',
  'unstaged_diff',
  'staged_diff_stat',
  'untracked_files',
  'submodules',
] as const;

export type RuntimeGitOperation = (typeof RUNTIME_GIT_OPERATIONS)[number];

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
}

/**
 * A run-scoped, read-only Git capability. The implementation is bound to the
 * trusted project root, so callers choose only from the fixed operation roster.
 */
export interface RuntimeGitReader {
  readonly read: (request: {
    readonly operation: RuntimeGitOperation;
    readonly projectRoot: string;
  }) => Promise<RuntimeGitReadResult>;
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
