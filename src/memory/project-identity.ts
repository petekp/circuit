import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { Config, ProjectId } from '../schemas/index.js';
import { writeJsonAtomic } from '../shared/atomic-io.js';
import { sha256Hex } from '../shared/connector-relay.js';
import { projectConfigPath, runsRoot } from '../shared/control-plane-paths.js';
import {
  MEMORY_MANIFEST_FILE,
  type ProjectStoreOptions,
  resolveProjectStorePaths,
} from './project-store.js';

// Project identity for self-auditing project memory (Slice 5, D1). Retrieval
// and storage both need a key that is stable across the worktrees and clones
// the working set spans, so the repo-root path is too fragile to be the key.
//
// Resolution order (first hit wins):
//   1. config  — an explicit `project_id` in `.circuit/config.yaml` (operator
//                 set; setting it makes inference never fire — the veto path).
//   2. git_remote — the normalized `origin` remote URL, hashed to a short id
//                 (stable across worktrees/clones of the same repo).
//   3. runs_base — only when there is no remote AND no config: the absolute
//                 runs-base path, hashed, accompanied by a loud
//                 `project_id_unstable` warning that project memory will not be
//                 shared across worktrees.
export type ProjectIdSource = 'config' | 'git_remote' | 'runs_base';

export interface ProjectIdWarning {
  readonly code: 'project_id_unstable';
  readonly message: string;
}

export interface ResolvedProjectId {
  readonly projectId: string;
  readonly source: ProjectIdSource;
  readonly warnings: readonly ProjectIdWarning[];
}

export interface ResolveProjectIdOptions extends ProjectStoreOptions {
  // Test/alternate-host seam: a pre-read config override (wins, like a parsed
  // `.circuit/config.yaml#project_id`). When omitted the resolver reads
  // `.circuit/config.yaml` itself.
  readonly configProjectId?: string;
  // Test seam: a pre-resolved git remote URL (or null for "no remote"). When
  // omitted the resolver shells out to `git remote get-url origin`.
  readonly gitRemoteUrl?: string | null;
}

// Hash a stable basis to a short, path-safe id. The git_remote and runs_base
// ids share the same hashing so a future cross-worktree shared store keys
// identically regardless of which fallback produced the id.
function hashedId(prefix: string, basis: string): string {
  return `proj-${prefix}-${sha256Hex(basis).slice(0, 16)}`;
}

// Normalize a git remote URL so SSH and HTTPS clones of one repo hash to one
// id: lowercase, strip a scheme + userinfo, strip a trailing `.git`, and
// collapse the `git@host:owner/repo` SSH form to `host/owner/repo`.
export function normalizeGitRemoteUrl(url: string): string {
  let normalized = url.trim().toLowerCase();
  // SSH scp-like form: git@github.com:owner/repo.git
  const scpMatch = normalized.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpMatch) {
    normalized = `${scpMatch[1]}/${scpMatch[2]}`;
  } else {
    // URL form: strip scheme and any userinfo before the host.
    normalized = normalized.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/]+@/, '');
  }
  normalized = normalized.replace(/\.git$/, '').replace(/\/+$/, '');
  return normalized;
}

function readConfigProjectId(repoRoot: string): string | undefined {
  const configPath = projectConfigPath(repoRoot);
  if (!existsSync(configPath)) return undefined;
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(configPath, 'utf8'));
  } catch {
    // A malformed project config is the runtime config loader's problem to
    // surface, not the identity resolver's; fall through to inference.
    return undefined;
  }
  const parsed = Config.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data.project_id;
}

function readGitRemoteUrl(repoRoot: string): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return url.length === 0 ? null : url;
  } catch {
    // No git, no remote, or a non-repo directory: fall through to runs-base.
    return null;
  }
}

export function resolveProjectId(options: ResolveProjectIdOptions = {}): ResolvedProjectId {
  const paths = resolveProjectStorePaths(options);
  const repoRoot = paths.repoRoot;

  // 1. Explicit config override wins (operator authority; veto path).
  const configProjectId = options.configProjectId ?? readConfigProjectId(repoRoot);
  if (configProjectId !== undefined) {
    return {
      projectId: ProjectId.parse(configProjectId),
      source: 'config',
      warnings: [],
    };
  }

  // 2. Git remote origin, normalized and hashed (stable across worktrees).
  const gitRemoteUrl =
    options.gitRemoteUrl === undefined ? readGitRemoteUrl(repoRoot) : options.gitRemoteUrl;
  if (gitRemoteUrl !== null && gitRemoteUrl.trim().length > 0) {
    return {
      projectId: hashedId('r', normalizeGitRemoteUrl(gitRemoteUrl)),
      source: 'git_remote',
      warnings: [],
    };
  }

  // 3. Runs-base fallback, with a loud instability warning.
  const runsBase = runsRoot(repoRoot);
  return {
    projectId: hashedId('p', runsBase),
    source: 'runs_base',
    warnings: [
      {
        code: 'project_id_unstable',
        message:
          'project identity falls back to the local runs-base path (no git remote, no project_id in .circuit/config.yaml); project memory will not be shared across worktrees or clones. Set project_id in .circuit/config.yaml to stabilize it.',
      },
    ],
  };
}

export interface MemoryManifest {
  readonly project_id: string;
  readonly source: ProjectIdSource;
}

// Stamp the resolved identity into `.circuit/memory/manifest.json` as provenance
// (and as the key a future cross-worktree shared store would use). The projectId
// is NOT stored per-record; it lives here once. Atomic tmp+rename + re-parse,
// the Slice 1 write discipline. Idempotent: re-stamping the same identity is a
// no-op rewrite.
export function stampMemoryManifest(
  resolved: ResolvedProjectId,
  options: ProjectStoreOptions = {},
): string {
  const paths = resolveProjectStorePaths(options);
  const manifest: MemoryManifest = { project_id: resolved.projectId, source: resolved.source };
  // Re-read to confirm the bytes round-trip before the rename commits.
  writeJsonAtomic(paths.manifestPath, manifest, { validate: (raw) => JSON.parse(raw) });
  return paths.manifestPath;
}

export function readMemoryManifest(options: ProjectStoreOptions = {}): MemoryManifest | undefined {
  const paths = resolveProjectStorePaths(options);
  if (!existsSync(paths.manifestPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(paths.manifestPath, 'utf8')) as Partial<MemoryManifest>;
    if (typeof raw.project_id !== 'string' || typeof raw.source !== 'string') return undefined;
    return { project_id: raw.project_id, source: raw.source as ProjectIdSource };
  } catch {
    return undefined;
  }
}

export { MEMORY_MANIFEST_FILE };
