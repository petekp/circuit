// Review intake compose writer.
//
// Emits the requested review scope plus the local working-tree evidence the
// reviewer needs to audit current changes. The CLI supplies projectRoot from
// its cwd, so Codex/Claude/generic-shell hosts all collect the same evidence
// before the reviewer relay is called.

import { spawnSync } from 'node:child_process';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  type GitHubRepositoryIdentity,
  githubPullRequestMergeRefsFromGitConfig,
  githubRepositoriesFromGitConfig,
  githubRepositoryKey,
  parseGitHubRemoteUrl,
} from '../../../shared/github-repository.js';
import {
  RUNTIME_GIT_HARDENED_CONFIG,
  type RuntimeGitOperation,
  type RuntimeGitPinnedTarget,
  type RuntimeGitReadRequest,
  type RuntimeGitReader,
  type RuntimeGitTarget,
  runtimeGitSpawnErrorAllowsPartialOutput,
  runtimeGitTextIsValidUtf8,
} from '../../../shared/runtime-git-reader.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import type {
  ReviewEvidence,
  ReviewEvidenceText,
  ReviewUntrackedContentPolicy,
  ReviewUntrackedFileEvidence,
} from '../reports.js';
import { projectReviewIntake } from './intake-projection.js';

const MAX_DIFF_CHARS = 120_000;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_FILE_CHARS = 20_000;
const MAX_GIT_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_DIFF_BUFFER_BYTES = Math.max(MAX_DIFF_CHARS * 4, 1024 * 1024);
const MAX_UNTRACKED_FILE_BYTES = MAX_UNTRACKED_FILE_CHARS + 1;
const DIRECT_GIT_TIMEOUT_MS = 30_000;
const HEAD_COMMIT_REF = 'HEAD';
const SAFE_REVIEW_REF_PATTERN = /^[A-Za-z0-9._/@+~^-]{1,120}$/u;

type GitResult =
  | { ok: true; stdout: string; truncated_by_buffer: boolean }
  | {
      ok: false;
      reason: string;
    };

type DirectGitConfiguration =
  | {
      readonly ok: true;
      readonly overrides: readonly string[];
      readonly auditedConfig: string;
    }
  | { readonly ok: false; readonly reason: string };

type DirectGitRepository = {
  readonly workTree: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly safeDirectories: readonly string[];
};

type DirectGitContext = DirectGitRepository & {
  readonly overrides: readonly string[];
  readonly auditedConfig: string;
};

type ReviewTarget =
  | {
      readonly kind: 'goal';
    }
  | {
      readonly kind: 'working_tree';
      readonly mode: 'all' | 'staged' | 'unstaged';
      readonly explicit: boolean;
    }
  | { readonly kind: 'commit'; readonly ref: string }
  | {
      readonly kind: 'range';
      readonly base: string;
      readonly head: string;
      readonly dots: '..' | '...';
    }
  | {
      readonly kind: 'pull_request';
      readonly number: number;
      readonly repository?: GitHubRepositoryIdentity;
    };

type ReviewTargetParseResult =
  | { readonly ok: true; readonly target: ReviewTarget }
  | { readonly ok: false; readonly reason: string };

type DirectPinnedTarget =
  | Exclude<RuntimeGitPinnedTarget, { readonly kind: 'commit' }>
  | {
      readonly kind: 'commit';
      readonly commit: string;
      readonly parent_commit: string | null;
    };

function truncateText(text: string, maxChars: number): ReviewEvidenceText {
  if (!runtimeGitTextIsValidUtf8(text)) {
    throw new Error('Review evidence text is not valid UTF-8.');
  }
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const lastIncluded = text.charCodeAt(end - 1);
  const firstExcluded = text.charCodeAt(end);
  if (
    lastIncluded >= 0xd800 &&
    lastIncluded <= 0xdbff &&
    firstExcluded >= 0xdc00 &&
    firstExcluded <= 0xdfff
  ) {
    end -= 1;
  }
  const prefix = text.slice(0, end);
  return {
    text: `${prefix}\n[truncated ${text.length - end} characters]`,
    truncated: true,
  };
}

function decodeBoundedUtf8(sample: Buffer, sourceContinues: boolean): string {
  const maximumTrim = sourceContinues ? Math.min(3, sample.length) : 0;
  for (let trimmedBytes = 0; trimmedBytes <= maximumTrim; trimmedBytes += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        sample.subarray(0, sample.length - trimmedBytes),
      );
    } catch {
      // A bounded read may end partway through one UTF-8 character. Only the
      // final three bytes can belong to that incomplete character.
    }
  }
  throw new Error('file content is not valid UTF-8');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function outputToString(output: string | Buffer | Uint8Array | null | undefined): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  return Buffer.from(output).toString('utf8');
}

function decodeGitOutput(output: string | Buffer | Uint8Array | null | undefined): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') {
    if (!runtimeGitTextIsValidUtf8(output)) {
      throw new Error('Git output is not valid UTF-8.');
    }
    return output;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(output);
}

function directGitEnvironment(
  options: { readonly readGlobalConfig?: boolean } = {},
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  return {
    ...inherited,
    GIT_ATTR_NOSYSTEM: '1',
    ...(options.readGlobalConfig === true ? {} : { GIT_CONFIG_GLOBAL: '/dev/null' }),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    PAGER: 'cat',
  };
}

function safeDirectoryArgs(values: readonly string[]): string[] {
  return values.flatMap((value) => ['-c', `safe.directory=${value}`]);
}

function readGlobalSafeDirectories(): readonly string[] {
  const result = spawnSync(
    'git',
    ['config', '--global', '--no-includes', '--null', '--get-all', 'safe.directory'],
    {
      encoding: 'utf8',
      env: directGitEnvironment({ readGlobalConfig: true }),
      maxBuffer: MAX_GIT_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: DIRECT_GIT_TIMEOUT_MS,
    },
  );
  const stdout = outputToString(result.stdout);
  const stderr = outputToString(result.stderr).trim();
  if (result.error !== undefined) {
    throw new Error(`Git safe.directory lookup failed: ${result.error.message}`);
  }
  if (result.status === 1 && stdout.length === 0 && stderr.length === 0) return Object.freeze([]);
  if (result.status !== 0) {
    throw new Error(
      stderr.length > 0
        ? `Git safe.directory lookup failed: ${stderr}`
        : `Git safe.directory lookup exited with status ${result.status ?? 'unknown'}.`,
    );
  }
  const values = stdout.split('\0');
  if (values.at(-1) === '') values.pop();
  return Object.freeze(
    values.filter(
      (value) => !value.includes('\n') && !value.includes('\r') && !value.includes('*'),
    ),
  );
}

function directGitConfiguration(repository: DirectGitRepository): DirectGitConfiguration {
  const hardenedArgs = RUNTIME_GIT_HARDENED_CONFIG.flatMap((value) => ['-c', value]);
  const result = spawnSync(
    'git',
    [
      '--no-pager',
      '--no-optional-locks',
      `--git-dir=${repository.gitDir}`,
      `--work-tree=${repository.workTree}`,
      ...hardenedArgs,
      ...safeDirectoryArgs(repository.safeDirectories),
      'config',
      '--null',
      '--list',
      '--no-includes',
    ],
    {
      cwd: repository.workTree,
      encoding: 'utf8',
      env: directGitEnvironment(),
      maxBuffer: MAX_GIT_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: DIRECT_GIT_TIMEOUT_MS,
    },
  );
  const stderr = outputToString(result.stderr).trim();
  if (result.error !== undefined) {
    return {
      ok: false,
      reason: `Git configuration audit failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason:
        stderr.length > 0
          ? `Git configuration audit failed: ${stderr}`
          : `Git configuration audit exited with status ${result.status ?? 'unknown'}.`,
    };
  }

  const auditedConfig = outputToString(result.stdout);
  const overrides = new Set<string>();
  for (const entry of auditedConfig.split('\0')) {
    if (entry.length === 0) continue;
    const separator = entry.indexOf('\n');
    const key = (separator === -1 ? entry : entry.slice(0, separator)).toLowerCase();
    if (key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))) {
      return {
        ok: false,
        reason: 'Git configuration includes are not supported for Review evidence.',
      };
    }
    if (/^filter\..+\.(clean|process|smudge)$/u.test(key)) overrides.add(`${key}=`);
    if (/^filter\..+\.required$/u.test(key)) overrides.add(`${key}=false`);
    if (/^diff\..+\.(command|textconv)$/u.test(key)) overrides.add(`${key}=`);
  }
  return {
    ok: true,
    overrides: Object.freeze([...overrides].sort()),
    auditedConfig,
  };
}

function gitDirectoryFromMarker(markerPath: string): string | undefined {
  let markerStat: ReturnType<typeof lstatSync>;
  try {
    markerStat = lstatSync(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Git repository marker could not be inspected: ${errorMessage(error)}`);
  }
  if (markerStat.isDirectory() || markerStat.isSymbolicLink()) {
    try {
      return realpathSync(markerPath);
    } catch (error) {
      throw new Error(`Git repository marker could not be resolved: ${errorMessage(error)}`);
    }
  }
  if (!markerStat.isFile() || markerStat.size > 4_096) {
    throw new Error('Git repository marker has an unsupported shape.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== markerStat.dev ||
      openedStat.ino !== markerStat.ino ||
      openedStat.size !== markerStat.size
    ) {
      throw new Error('Git repository marker changed while it was inspected.');
    }
    const bytes = Buffer.alloc(openedStat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) {
      throw new Error('Git repository marker could not be read completely.');
    }
    const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/u.exec(bytes.toString('utf8'));
    if (match?.[1] === undefined) {
      throw new Error('Git repository marker contains invalid data.');
    }
    return realpathSync(resolve(dirname(markerPath), match[1]));
  } catch (error) {
    throw new Error(`Git repository marker could not be read safely: ${errorMessage(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function workTreeFromGitDirectory(requestedDirectory: string, gitDir: string): string {
  let current = requestedDirectory;
  while (true) {
    const markerPath = join(current, '.git');
    if (gitDirectoryFromMarker(markerPath) === gitDir) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    'Git workspace discovery could not match the selected directory to its repository metadata.',
  );
}

function prepareDirectGitContext(projectRoot: string): DirectGitContext {
  let requestedDirectory: string;
  try {
    requestedDirectory = realpathSync(projectRoot);
  } catch (error) {
    throw new Error(`Git workspace could not be resolved: ${errorMessage(error)}`);
  }
  const safeDirectories = readGlobalSafeDirectories();
  const hardenedArgs = RUNTIME_GIT_HARDENED_CONFIG.flatMap((value) => ['-c', value]);
  const result = spawnSync(
    'git',
    [
      '--no-pager',
      '--no-optional-locks',
      ...hardenedArgs,
      ...safeDirectoryArgs(safeDirectories),
      'rev-parse',
      '--path-format=absolute',
      '--absolute-git-dir',
      '--git-common-dir',
    ],
    {
      cwd: requestedDirectory,
      encoding: 'utf8',
      env: directGitEnvironment(),
      maxBuffer: MAX_GIT_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: DIRECT_GIT_TIMEOUT_MS,
    },
  );
  const stderr = outputToString(result.stderr).trim();
  if (result.error !== undefined) {
    throw new Error(`Git workspace discovery failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      stderr.length > 0
        ? `Git workspace discovery failed: ${stderr}`
        : `Git workspace discovery exited with status ${result.status ?? 'unknown'}.`,
    );
  }
  const paths = outputToString(result.stdout)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (paths.length !== 2 || paths.some((value) => value.includes('\0') || !isAbsolute(value))) {
    throw new Error('Git workspace discovery returned invalid repository paths.');
  }
  let workTree: string;
  let gitDir: string;
  let commonDir: string;
  try {
    gitDir = realpathSync(paths[0] as string);
    commonDir = realpathSync(paths[1] as string);
    workTree = workTreeFromGitDirectory(requestedDirectory, gitDir);
  } catch (error) {
    throw new Error(`Git repository paths could not be resolved: ${errorMessage(error)}`);
  }
  if (!insideProject(workTree, requestedDirectory)) {
    throw new Error('Git workspace discovery returned a worktree outside the requested directory.');
  }
  const repository: DirectGitRepository = {
    workTree,
    gitDir,
    commonDir,
    safeDirectories,
  };
  const configuration = directGitConfiguration(repository);
  if (!configuration.ok) throw new Error(configuration.reason);
  return Object.freeze({
    ...repository,
    overrides: configuration.overrides,
    auditedConfig: configuration.auditedConfig,
  });
}

function runGit(
  projectRoot: string,
  args: readonly string[],
  options: { readonly maxBufferBytes?: number; readonly allowPartialStdout?: boolean } = {},
  preparedContext?: DirectGitContext,
): GitResult {
  let context: DirectGitContext;
  try {
    context = preparedContext ?? prepareDirectGitContext(projectRoot);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  const currentConfiguration = directGitConfiguration(context);
  if (!currentConfiguration.ok) return currentConfiguration;
  if (currentConfiguration.auditedConfig !== context.auditedConfig) {
    return {
      ok: false,
      reason: 'Git configuration changed while Review evidence was being collected.',
    };
  }
  const hardenedArgs = [...RUNTIME_GIT_HARDENED_CONFIG, ...context.overrides].flatMap((value) => [
    '-c',
    value,
  ]);
  const result = spawnSync(
    'git',
    [
      '--no-pager',
      '--no-optional-locks',
      `--git-dir=${context.gitDir}`,
      `--work-tree=${context.workTree}`,
      ...hardenedArgs,
      ...safeDirectoryArgs(context.safeDirectories),
      ...args,
    ],
    {
      cwd: context.workTree,
      env: directGitEnvironment(),
      maxBuffer: options.maxBufferBytes ?? MAX_GIT_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: DIRECT_GIT_TIMEOUT_MS,
    },
  );
  let stdout: string;
  try {
    stdout = decodeGitOutput(result.stdout);
  } catch {
    return {
      ok: false,
      reason: `git ${args.join(' ')} returned output that is not valid UTF-8.`,
    };
  }
  const stderr = outputToString(result.stderr).trim();

  if (result.error !== undefined) {
    if (
      options.allowPartialStdout === true &&
      stdout.length > 0 &&
      runtimeGitSpawnErrorAllowsPartialOutput(result.error)
    ) {
      return { ok: true, stdout, truncated_by_buffer: true };
    }
    return { ok: false, reason: `git ${args.join(' ')} failed: ${result.error.message}` };
  }

  if (result.status !== 0) {
    const reason = stderr.length > 0 ? stderr : `exited with status ${result.status ?? 'unknown'}`;
    return { ok: false, reason: `git ${args.join(' ')} failed: ${reason}` };
  }

  return { ok: true, stdout, truncated_by_buffer: false };
}

async function readGit(
  reader: RuntimeGitReader,
  operation: Exclude<RuntimeGitOperation, 'resolve_target'>,
  projectRoot: string,
  target?: RuntimeGitPinnedTarget,
): Promise<GitResult> {
  const request: RuntimeGitReadRequest =
    operation === 'target_diff' || operation === 'target_diff_stat'
      ? {
          operation,
          projectRoot,
          target:
            target ??
            (() => {
              throw new Error(`Git ${operation} requires an immutable target.`);
            })(),
        }
      : {
          operation: operation as Exclude<
            RuntimeGitOperation,
            'resolve_target' | 'target_diff' | 'target_diff_stat'
          >,
          projectRoot,
        };
  const result = await reader.read(request);
  if (result.operation !== operation) {
    return { ok: false, reason: `Git reader returned ${result.operation} for ${operation}.` };
  }
  if (!runtimeGitTextIsValidUtf8(result.stdout)) {
    return {
      ok: false,
      reason: `Git ${operation} output is not valid UTF-8 and cannot be reviewed safely.`,
    };
  }
  if (!result.cleanup_confirmed) {
    return { ok: false, reason: `Git ${operation} cleanup could not be confirmed.` };
  }
  if (!result.ok) {
    const reason = result.stderr.trim();
    return {
      ok: false,
      reason: reason.length === 0 ? `Git ${operation} failed.` : reason,
    };
  }
  if (result.truncated) {
    const partialDiffAllowed =
      (operation === 'staged_diff' ||
        operation === 'unstaged_diff' ||
        operation === 'target_diff') &&
      result.stdout.length > 0;
    if (partialDiffAllowed) {
      return { ok: true, stdout: result.stdout, truncated_by_buffer: true };
    }
    const reason = result.stderr.trim();
    return {
      ok: false,
      reason:
        reason.length === 0
          ? `Git ${operation} output was truncated before it could be verified.`
          : reason,
    };
  }
  return {
    ok: true,
    stdout: result.stdout,
    truncated_by_buffer: result.truncated,
  };
}

function isSafeReviewRef(value: string): boolean {
  return (
    SAFE_REVIEW_REF_PATTERN.test(value) &&
    !value.startsWith('-') &&
    !value.includes('..') &&
    !value.includes('@{')
  );
}

function normalizeUnambiguousReviewAliases(scope: string): string {
  return scope
    .replace(/^\s*((?:latest|last|current)\s+commit)\s+review(?=\s*[.!?]?\s*$)/iu, 'review $1')
    .replace(/\bwhat\s+i\s+just\s+committed\b/giu, 'latest commit')
    .replace(/\b(?:the\s+)?commit\s+i\s+just\s+made\b/giu, 'latest commit')
    .replace(/\b(?:(?:the|my|our)\s+)?most\s+recent\s+commit\b/giu, 'latest commit')
    .replace(/\bwhat\s+changed\s+in\s+(?:the\s+)?last\s+commit\b/giu, 'latest commit')
    .replace(/\bwhat(?:'s|\s+is)\s+staged\b/giu, 'staged changes')
    .replace(/\bwhat\s+i\s+staged\b/giu, 'staged changes')
    .replace(/\beverything\s+i\s+have\s+not\s+committed\b/giu, 'working tree changes')
    .replace(/\ball\s+uncommitted\s+files\b/giu, 'working tree changes');
}

function hasTargetSelectionSuffix(scope: string, mentionEnd: number): boolean {
  const suffix = scope.slice(mentionEnd).trimStart();
  if (suffix.length === 0) return true;
  if (/^[.!?](?:\s|$)/u.test(suffix)) return true;
  if (/^[,;:](?:\s|$)/u.test(suffix)) return true;
  return /^(?:only\b|for\b|with\b|especially\b|against\b|focus(?:ing)?(?:\s+on)?\b|(?:and|or|plus|then|as\s+well\s+as)\b|but\b|except\b|excluding\b|without\b|skip(?:ping)?\b|ignor(?:e|ing)\b|omit(?:ting)?\b|(?:leave|leaving)\s+out\b|save\s+for\b|other\s+than\b|versus\b|vs\.?\b|compared\s+(?:to|with)\b|through\b)/iu.test(
    suffix,
  );
}

function looksLikeReviewPath(value: string): boolean {
  const cleaned = value
    .replace(/^[<("'`]+/u, '')
    .replace(/[>"'`),.;:!?]+$/u, '')
    .replace(/[),.;:!?]+$/u, '');
  if (cleaned.length === 0 || cleaned.includes('..') || /^https?:\/\//iu.test(cleaned))
    return false;
  return (
    /(?:^|\/)(?:Dockerfile|LICENSE|Makefile|README)(?:\.[A-Za-z0-9_-]+)?$/u.test(cleaned) ||
    /(?:^|\/)[^/\s]+\.[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(cleaned) ||
    /^(?:\.{0,2}\/|\/)[^\s]+$/u.test(cleaned) ||
    /^[^/\s]+\/[^\s]+$/u.test(cleaned) ||
    /^(?:[^/\s]+\/)+$/u.test(cleaned)
  );
}

function looksLikeReviewSubsetPath(value: string, explicitPathKind = false): boolean {
  const cleaned = value
    .trim()
    .replace(/^[<("'`]+/u, '')
    .replace(/[>"'`),.;:!?]+$/u, '');
  if (cleaned.length === 0 || /^https?:\/\//iu.test(cleaned)) return false;
  return (
    explicitPathKind ||
    looksLikeReviewPath(cleaned) ||
    /^\.[A-Za-z0-9_-]+$/u.test(cleaned) ||
    /[*?[\]]/u.test(cleaned) ||
    /^(?:\.\.\/)+[^\s]+$/u.test(cleaned) ||
    /^(?:apps?|assets?|build|changelogs?|config(?:uration)?|dist|docs?|examples?|fixtures?|generated|lib|lockfiles?|migrations?|node_modules|packages?|scripts?|snapshots?|sources?|src|tests?|vendor)\/?$/iu.test(
      cleaned,
    )
  );
}

function isPathOnlyReviewRequest(scope: string): boolean {
  const match =
    /^\s*(?:review|inspect|audit|check|analyze)\s+(?:(?:only|the|this|my|our|current)\s+)*(?:(?:file|code|plan|report)\s*(?:(?:in|at|from)\s+|:\s*)?)?(?<path>\S+)(?<suffix>[\s\S]*)$/iu.exec(
      scope,
    );
  const path = match?.groups?.path;
  const suffix = match?.groups?.suffix ?? '';
  if (path === undefined || !looksLikeReviewPath(path)) return false;
  const trimmedSuffix = suffix.trim();
  if (trimmedSuffix.length === 0 || /^[.!?]$/u.test(trimmedSuffix)) return true;
  return /^(?:,?\s*(?:for|with|especially)\b|,?\s+and\s+(?:focus|check|inspect|look|pay|prioritize|verify)\b)/iu.test(
    trimmedSuffix,
  );
}

type SuppliedReviewMaterialClassification =
  | { readonly kind: 'supplied' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'none' };

function topLevelReviewMaterialTail(scope: string): string | undefined {
  const firstLead = /\b(?:review|inspect|audit|check|analyze)\b/iu.exec(scope);
  if (firstLead === null) return undefined;
  const clause = scope.slice(firstLead.index);
  const artifact =
    /^(?:review|inspect|audit|check|analyze)\s+(?:of\s+)?(?:(?:a|an|the|this|these|my|our|current|supplied|provided|following|below|attached|pasted|written|included|enclosed|draft|rollout|release|proposed|updated|final|technical|design|quoted)\s+){0,6}(?:artifact|brief|code|docs?|documentation|excerpt|file|instructions?|patch|plan|proposal|quotation|quote|report|request|snippet|spec(?:ification)?|text)\b(?<tail>[\s\S]*)$/iu.exec(
      clause,
    );
  if (artifact?.groups?.tail !== undefined) return artifact.groups.tail;
  const direct =
    /^(?:review|inspect|audit|check|analyze)\s*(?<tail>(?::|(?:—|--)\s|["`]|```|\r?\n)[\s\S]*)$/iu.exec(
      clause,
    );
  return direct?.groups?.tail;
}

function materialAfterBoundary(tail: string): string | undefined {
  const direct = tail.trimStart();
  if (/^(?:"|`|```)/u.test(direct)) return direct;
  const boundary = /:(?=\s|["'`[{\n\r]|$)|\r?\n|(?:^|\s)(?:—|--)(?=\s|$)/u.exec(tail);
  if (boundary === null) return undefined;
  return tail.slice(boundary.index + boundary[0].length).trimStart();
}

function closingUnescapedQuote(value: string, quote: '"' | "'" | '`'): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

function classifyReviewMaterialBody(body: string): SuppliedReviewMaterialClassification {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { kind: 'missing' };
  let material = trimmed;
  if (trimmed.startsWith('```')) {
    const openingLineEnd = trimmed.indexOf('\n');
    const closingFence = openingLineEnd < 0 ? -1 : trimmed.indexOf('```', openingLineEnd + 1);
    if (openingLineEnd < 0 || closingFence < 0) {
      return {
        kind: 'malformed',
        reason: 'Review supplied material has an unclosed code fence.',
      };
    }
    material = trimmed.slice(openingLineEnd + 1, closingFence).trim();
  } else {
    const opening = trimmed[0];
    if (opening === '"' || opening === "'" || opening === '`') {
      const closing = closingUnescapedQuote(trimmed, opening);
      if (closing < 0) {
        return {
          kind: 'malformed',
          reason: 'Review supplied material has an unclosed quote.',
        };
      }
      material = trimmed.slice(1, closing).trim();
    }
  }
  if (material.length === 0 || looksLikeReviewSubsetPath(material)) {
    return { kind: 'missing' };
  }
  return { kind: 'supplied' };
}

function classifySuppliedReviewMaterial(scope: string): SuppliedReviewMaterialClassification {
  const tail = topLevelReviewMaterialTail(scope);
  if (tail === undefined) return { kind: 'none' };
  const body = materialAfterBoundary(tail);
  if (body === undefined) return { kind: 'missing' };
  return classifyReviewMaterialBody(body);
}

function withoutNegatedReviewClauses(scope: string): string {
  return scope
    .replace(
      /\b(?:do\s+not|don't|never)\s+(?:review|inspect|audit|check|analyze)\b[^;.!?]*?(?=(?:\b(?:but|and(?:\s+instead)?|instead)\s+)(?:review|inspect|audit|check|analyze)\b|[;.!?]|$)/giu,
      ' ',
    )
    .replace(
      /\b(?:but|and(?:\s+instead)?|instead)\s+(?=(?:review|inspect|audit|check|analyze)\b)/giu,
      ' ',
    );
}

function maskReviewLiteralData(scope: string): string {
  const mask = (value: string): string => value.replace(/[^\r\n]/gu, ' ');
  return scope
    .replace(/```[\s\S]*?```/gu, mask)
    .replace(/"(?:\\.|[^"\\])*"/gu, mask)
    .replace(/(^|[\s([{:;,])'(?:\\.|[^'\\])*'/gmu, mask)
    .replace(/`(?:\\.|[^`\\])*`/gu, mask)
    .replace(/^[ \t]*>[^\r\n]*$/gmu, mask)
    .replace(/```[\s\S]*$/gu, mask)
    .replace(/"(?:\\.|[^"\\])*$/gu, mask)
    .replace(/`(?:\\.|[^`\\])*$/gu, mask);
}

export function reviewScopeHasSuppliedMaterial(scope: string): boolean {
  const normalizedScope = withImplicitReviewLead(
    normalizeUnambiguousReviewAliases(scope.replace(/[’‘]/gu, "'").replace(/[“”]/gu, '"')),
  );
  return (
    classifySuppliedReviewMaterial(withoutNegatedReviewClauses(normalizedScope)).kind === 'supplied'
  );
}

function hasTopLevelArtifactReviewSubject(scope: string): boolean {
  return topLevelReviewMaterialTail(scope) !== undefined;
}

function unsupportedReviewComparison(scope: string): string | undefined {
  for (const match of scope.matchAll(
    /\b(?:changes?|diffs?)\s+across\s+(?<base>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\s+and\s+(?<head>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\b/giu,
  )) {
    if (!hasAffirmativeReviewTargetLead(scope, match.index ?? 0)) continue;
    const base = match.groups?.base;
    const head = match.groups?.head;
    if (base !== undefined && head !== undefined) {
      return `Review target comparison is ambiguous. Use one explicit range such as ${base}...${head}.`;
    }
  }

  for (const match of scope.matchAll(
    /\b(?<base>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\s+(?:versus|vs\.?|compared\s+(?:to|with))\s+(?<head>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\b/giu,
  )) {
    if (!hasAffirmativeReviewTargetLead(scope, match.index ?? 0)) continue;
    const base = match.groups?.base;
    const head = match.groups?.head;
    if (base !== undefined && head !== undefined) {
      return `Review target comparison is ambiguous. Use one explicit range such as ${base}...${head}.`;
    }
  }

  for (const match of scope.matchAll(
    /\b(?:commit|revision|rev)\s+(?:at\s+)?(?<base>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\s+(?:through|thru)\s+(?:(?:commit|revision|rev)\s+)?(?<head>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\b/giu,
  )) {
    if (!hasAffirmativeReviewTargetLead(scope, match.index ?? 0)) continue;
    const base = match.groups?.base;
    const head = match.groups?.head;
    if (base !== undefined && head !== undefined) {
      return `Review target comparison is ambiguous. Use one explicit range such as ${base}...${head}.`;
    }
  }

  for (const match of scope.matchAll(
    /\b(?<left>(?:(?:latest|last|current)\s+commit|HEAD(?:[~^]\d*)?|(?:commit|revision|rev)\s+(?:at\s+)?[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120}|(?:pr|pull request)\s*#?\d{1,7}))\s+(?:versus|vs\.?|compared\s+to)\s+(?<right>(?:(?:latest|last|current)\s+commit|HEAD(?:[~^]\d*)?|(?:commit|revision|rev)\s+(?:at\s+)?[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120}|(?:pr|pull request)\s*#?\d{1,7}|[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120}))\b/giu,
  )) {
    if (!hasAffirmativeReviewTargetLead(scope, match.index ?? 0)) continue;
    return 'Review target comparison is ambiguous. Choose one complete target or use one explicit Git range.';
  }
  return undefined;
}

function hasUnsupportedPathSubset(scope: string): boolean {
  for (const match of scope.matchAll(
    /(?:^|[,;])\s*(?<path>"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s,;]+)\s+only(?=$|[\s,.;:!?])/giu,
  )) {
    if (!hasSelectedReviewTargetBefore(scope, match.index ?? 0)) continue;
    if (match.groups?.path !== undefined) return true;
  }

  for (const match of scope.matchAll(
    /(?:\b(?:but\s+)?(?:only|just)\s+(?:(?:in|from|for|of|under|within)\s+)?|\b(?:in|from|for|of|under|within)\s+|\b(?:confined|limited|restricted|scoped)\s+to\s+)(?:the\s+)?(?:(?<leading_kind>file|path|director(?:y|ies)|folders?)\s+)?(?<path>"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|\S+)(?:\s+(?<trailing_kind>file|path|director(?:y|ies)|folders?))?(?=$|[\s,.;:!?])/giu,
  )) {
    const matchEnd = (match.index ?? 0) + match[0].length;
    if (
      /^from\b/iu.test(match[0]) &&
      /^\s+to\s+[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120}\b/u.test(scope.slice(matchEnd))
    ) {
      continue;
    }
    if (!hasSelectedReviewTargetBefore(scope, match.index ?? 0)) continue;
    const path = match.groups?.path;
    const explicitPathKind =
      match.groups?.leading_kind !== undefined || match.groups?.trailing_kind !== undefined;
    if (path !== undefined && looksLikeReviewSubsetPath(path, explicitPathKind)) return true;
  }

  for (const match of scope.matchAll(
    /\b(?:review|inspect|audit|check|analyze)\s+(?:of\s+)?(?:(?:only|just|the|this|these|my|our|current)\s+)*(?:(?<leading_kind>file|path|director(?:y|ies)|folders?)\s+)?(?<path>"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|\S+)(?:\s+(?<trailing_kind>file|path|director(?:y|ies)|folders?))?\s+(?<link>in|from|of|at|under|within|between)\s+(?<target>[^;!?]+)(?=$|[;!?])/giu,
  )) {
    const path = match.groups?.path;
    const link = match.groups?.link?.toLowerCase();
    const target = match.groups?.target?.trim();
    if (path === undefined || link === undefined || target === undefined) continue;
    const explicitPathKind =
      match.groups?.leading_kind !== undefined || match.groups?.trailing_kind !== undefined;
    if (!looksLikeReviewSubsetPath(path, explicitPathKind)) continue;
    const targetScope =
      link === 'from' && /\bto\b/iu.test(target)
        ? `review changes from ${target}`
        : link === 'between' && /\band\b/iu.test(target)
          ? `review changes between ${target}`
          : `review ${target}`;
    const candidates = [
      parseRange(targetScope),
      parsePullRequestUrl(targetScope),
      parsePullRequestMention(targetScope),
      parseCommit(targetScope),
      parseWorkingTree(targetScope),
    ];
    if (
      candidates.some((candidate) => candidate?.ok === true && candidate.target.kind !== 'goal')
    ) {
      return true;
    }
  }
  return false;
}

function reviewTargetLabel(
  target: Exclude<ReviewTarget, { readonly kind: 'goal' | 'working_tree' }>,
): string {
  if (target.kind === 'commit') return target.ref;
  if (target.kind === 'range') return `${target.base}${target.dots}${target.head}`;
  return `PR #${target.number}`;
}

function sameRepository(
  left: GitHubRepositoryIdentity | undefined,
  right: GitHubRepositoryIdentity | undefined,
): boolean {
  return (
    left === undefined ||
    right === undefined ||
    githubRepositoryKey(left) === githubRepositoryKey(right)
  );
}

function sameReviewTarget(left: ReviewTarget, right: ReviewTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'goal' && right.kind === 'goal') return true;
  if (left.kind === 'working_tree' && right.kind === 'working_tree') {
    return left.mode === right.mode;
  }
  if (left.kind === 'commit' && right.kind === 'commit') return left.ref === right.ref;
  if (left.kind === 'range' && right.kind === 'range') {
    return left.base === right.base && left.head === right.head && left.dots === right.dots;
  }
  if (left.kind === 'pull_request' && right.kind === 'pull_request') {
    return left.number === right.number && sameRepository(left.repository, right.repository);
  }
  return false;
}

function deduplicateReviewTargets(targets: readonly ReviewTarget[]): ReviewTarget[] {
  const unique: ReviewTarget[] = [];
  for (const target of targets) {
    const index = unique.findIndex((candidate) => sameReviewTarget(candidate, target));
    if (index === -1) {
      unique.push(target);
      continue;
    }
    const existing = unique[index];
    if (
      existing?.kind === 'pull_request' &&
      target.kind === 'pull_request' &&
      existing.repository === undefined &&
      target.repository !== undefined
    ) {
      unique[index] = target;
    }
  }
  return unique;
}

function hasEarlierArtifactReviewSubject(prefix: string, leadIndex: number): boolean {
  return /\b(?:review|inspect|audit|check|analyze)\s+(?:(?:a|an|the|this|these|my|our|current|supplied)\s+){0,4}(?:brief|docs?|documentation|instructions?|plan|proposal|report|request|spec(?:ification)?|text)\b[\s\S]*$/iu.test(
    prefix.slice(0, leadIndex),
  );
}

function hasDirectReviewLead(scope: string, targetIndex: number): boolean {
  const prefix = scope.slice(0, targetIndex);
  const match =
    /\b(?:review|inspect|audit|check|analyze)\s+(?:(?:all|both|only|the|this|these|my|our|current|large)\s+){0,4}(?:(?:changes?|diffs?|files?|code)\s+(?:(?:in|from|for|of|at|on|introduced\s+by)\s+(?:the\s+)?)?)?[<(["']?\s*$/iu.exec(
      prefix,
    );
  return match !== null && !hasEarlierArtifactReviewSubject(prefix, match.index);
}

function hasNounReviewLead(scope: string, targetIndex: number): boolean {
  const prefix = scope.slice(0, targetIndex);
  const match =
    /\b(?:(?:a|the)\s+)?review\s+of\s+(?:(?:all|both|only|the|this|these|my|our|current|large)\s+){0,4}(?:(?:changes?|diffs?|files?|code)\s+(?:(?:in|from|for|of|at|on|introduced\s+by)\s+(?:the\s+)?)?)?[<(["']?\s*$/iu.exec(
      prefix,
    );
  return match !== null && !hasEarlierArtifactReviewSubject(prefix, match.index);
}

function beforeReviewTargetListConnector(scope: string, targetIndex: number): string | undefined {
  const prefix = scope.slice(0, targetIndex);
  const connector =
    /(?:(?:,\s*)?(?:and(?:\s+also)?|or|plus|then|as\s+well\s+as)|[,&+])\s*(?:(?:(?:all|both|only|the|this|these|my|our|current)\s+){0,4}(?:changes?|diffs?|files?|code)\s+(?:(?:in|from|for|of|at|on|introduced\s+by)\s+(?:the\s+)?)?)?$/iu.exec(
      prefix,
    );
  return connector === null ? undefined : prefix.slice(0, connector.index);
}

function isReviewTargetListSeparator(value: string): boolean {
  return /^\s*(?:(?:,\s*)?(?:and(?:\s+also)?|or|plus|then|as\s+well\s+as)|[,&+])\s*$/iu.test(value);
}

function continuesReviewTargetList(scope: string, targetIndex: number): boolean {
  const beforeConnector = beforeReviewTargetListConnector(scope, targetIndex);
  if (beforeConnector === undefined) return false;
  return /\b(?:review|inspect|audit|check|analyze)\b[^;.!?]*(?:\b(?:commit|revision|rev)\s+(?:at\s+)?\S+|\b(?:latest|last|current)\s+(?:commit|committed\s+changes?)\b|\b(?:pr|pull request)\s*#?\d{1,7}\b|\bHEAD(?:[~^]\d*)?\b|[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120}\.{2,3}[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120}|\b(?:changes?|diffs?)\s+(?:between\s+[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120}\s+and|from\s+[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120}\s+to)\s+[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120}|\b(?:(?:staged|unstaged|not[- ]staged|local|current)\s+(?:changes?|diffs?)|(?:working[- ]tree|worktree)))\s*$/iu.test(
    beforeConnector,
  );
}

function hasAffirmativeReviewTargetLead(scope: string, targetIndex: number): boolean {
  return (
    hasDirectReviewLead(scope, targetIndex) ||
    hasNounReviewLead(scope, targetIndex) ||
    continuesReviewTargetList(scope, targetIndex) ||
    continuesSelectedPullRequestUrl(scope, targetIndex)
  );
}

function continuesSelectedPullRequestUrl(scope: string, targetIndex: number): boolean {
  const beforeConnector = beforeReviewTargetListConnector(scope, targetIndex);
  if (beforeConnector === undefined) return false;
  const parsed = parsePullRequestUrl(beforeConnector);
  return parsed?.ok === true && parsed.target.kind === 'pull_request';
}

function parsePullRequestUrlCandidate(candidate: string): ReviewTargetParseResult {
  const cleaned = candidate.replace(/[.,;:]+$/u, '');
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//iu.test(cleaned) ? cleaned : `https://${cleaned}`);
  } catch {
    return { ok: false, reason: `Review target is not a valid GitHub PR URL: ${cleaned}` };
  }
  const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
  const numberText = parts[3];
  const suffix = parts.slice(4);
  const suffixIsSupported =
    suffix.length === 0 ||
    (suffix.length === 1 &&
      ['checks', 'commits', 'files'].includes(suffix[0]?.toLowerCase() ?? '')) ||
    (suffix.length === 2 &&
      suffix[0]?.toLowerCase() === 'commits' &&
      /^[0-9a-f]{7,64}$/iu.test(suffix[1] ?? ''));
  if (
    !['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase()) ||
    parts[2]?.toLowerCase() !== 'pull' ||
    numberText === undefined ||
    !/^\d{1,6}$/u.test(numberText) ||
    !suffixIsSupported
  ) {
    return { ok: false, reason: `Review target is not a valid GitHub PR URL: ${cleaned}` };
  }
  const number = Number.parseInt(numberText, 10);
  const owner = parts[0];
  const name = parts[1];
  const repository =
    owner === undefined || name === undefined
      ? undefined
      : parseGitHubRemoteUrl(`https://github.com/${owner}/${name}`);
  if (number < 1 || number > 999_999 || repository === undefined) {
    return { ok: false, reason: `Review target is not a valid GitHub PR URL: ${cleaned}` };
  }
  return { ok: true, target: { kind: 'pull_request', number, repository } };
}

function parsePullRequestUrl(scope: string): ReviewTargetParseResult | undefined {
  const targets: ReviewTarget[] = [];
  for (const match of scope.matchAll(
    /(?:^|[\s("'[<])(?<url>(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9.-]*github[A-Za-z0-9.-]*\/[^\s/"'`)]+\/[^\s/"'`)]+\/pull(?:\/[^\s)"'`>]*)?)/giu,
  )) {
    const candidate = match.groups?.url;
    if (candidate === undefined) continue;
    const candidateOffset = match[0].indexOf(candidate);
    const targetIndex = (match.index ?? 0) + Math.max(0, candidateOffset);
    const prefix = scope.slice(0, targetIndex);
    const followsSelectedPrNumber =
      /\b(?:review|inspect|audit|check|analyze)\b[^;.!?]*\b(?:pr|pull request)\s*#?\d{1,6}\s+(?:at|from|in)\s*$/iu.test(
        prefix,
      );
    const followsSelectedPrLabel =
      /\b(?:review|inspect|audit|check|analyze)\s+(?:(?:all|both|only|the|this|these|my|our|current)\s+){0,4}(?:(?:changes?|diffs?|files?|code)\s+(?:(?:in|from|for|of|at|on|introduced\s+by)\s+(?:the\s+)?)?)?(?:pr|pull request)\s*$/iu.test(
        prefix,
      );
    const continuesSelectedUrl =
      targets.length > 0 && beforeReviewTargetListConnector(scope, targetIndex) !== undefined;
    const continuesSelectedNamedTarget = continuesReviewTargetList(scope, targetIndex);
    if (
      !hasDirectReviewLead(scope, targetIndex) &&
      !followsSelectedPrNumber &&
      !followsSelectedPrLabel &&
      !continuesSelectedUrl &&
      !continuesSelectedNamedTarget
    ) {
      continue;
    }
    const parsed = parsePullRequestUrlCandidate(candidate);
    if (!parsed.ok) return parsed;
    targets.push(parsed.target);
  }
  const uniqueTargets = deduplicateReviewTargets(targets);
  if (uniqueTargets.length > 1) {
    return {
      ok: false,
      reason: 'Review target is ambiguous because the request names more than one PR.',
    };
  }
  const target = uniqueTargets[0];
  return target === undefined ? undefined : { ok: true, target };
}

function rangeTargetFromToken(token: string): ReviewTarget | undefined {
  const withoutSentencePunctuation = token.replace(/[,;:!?]+$/u, '');
  const cleaned =
    withoutSentencePunctuation.endsWith('.') && !withoutSentencePunctuation.endsWith('..')
      ? withoutSentencePunctuation.slice(0, -1)
      : withoutSentencePunctuation;
  const separator = cleaned.includes('...') ? '...' : '..';
  const separatorIndex = cleaned.indexOf(separator);
  const base = cleaned.slice(0, separatorIndex);
  const head = cleaned.slice(separatorIndex + separator.length);
  const looksLikeProseEllipsis =
    separator === '...' &&
    /^[A-Za-z]+$/u.test(base) &&
    /^[A-Za-z]+$/u.test(head) &&
    (['docs', 'notes', 'parser', 'plan', 'proposal', 'text'].includes(base.toLowerCase()) ||
      ['and', 'especially', 'focus', 'including', 'maybe', 'or', 'perhaps', 'then'].includes(
        head.toLowerCase(),
      ));
  if (looksLikeProseEllipsis || !isSafeReviewRef(base) || !isSafeReviewRef(head)) {
    return undefined;
  }
  return { kind: 'range', base, head, dots: separator };
}

function withImplicitReviewLead(scope: string): string {
  const trimmed = scope.trim();
  const startsWithBareTarget =
    /^(?:(?:pr|pull request)\s*#?\d{1,7}\b|(?:latest|last|current)\s+(?:commit|committed\s+changes?)\b|(?:last|previous|prior|past|latest|recent)\s+(?:(?:\d+|[A-Za-z-]+(?:\s+[A-Za-z-]+){0,2})\s+)?commits\b|HEAD(?:[~^]\d*)?(?=$|[\s,;:!?])|(?:commit|revision|rev)\s+(?:at\s+)?\S+|[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,240}\.{2,3}[A-Za-z0-9]|(?:staged|unstaged|not[- ]staged|local)\s+(?:changes?|diffs?|work)\b|(?:working[- ]tree|worktree)(?:\s+(?:changes?|diffs?|files?|code|work))?\b|(?:(?:everything|all(?:\s+(?:changes?|diffs?))?)\s+(?:in|on)\s+(?:the\s+)?(?:this|current)\s+branch|(?:this|current)\s+branch)\b)/iu.test(
      trimmed,
    );
  return startsWithBareTarget ? `review ${trimmed}` : scope;
}

function parseRange(scope: string): ReviewTargetParseResult | undefined {
  const targets: ReviewTarget[] = [];
  const naturalCandidates = [
    ...scope.matchAll(
      /\b(?:the\s+)?(?:changes?|diffs?)\s+between\s+(?<base>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\s+and\s+(?<head>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})(?=$|[\s)"'\].,;:!?])/giu,
    ),
    ...scope.matchAll(
      /\b(?:the\s+)?(?:changes?|diffs?)\s+from\s+(?<base>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\s+to\s+(?<head>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})(?=$|[\s)"'\].,;:!?])/giu,
    ),
  ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  let previousNaturalEnd: number | undefined;
  for (const match of naturalCandidates) {
    const targetIndex = match.index ?? 0;
    const betweenNaturalTargets =
      previousNaturalEnd === undefined ? '' : scope.slice(previousNaturalEnd, targetIndex);
    const continuesNaturalTarget =
      previousNaturalEnd !== undefined && isReviewTargetListSeparator(betweenNaturalTargets);
    if (
      !hasDirectReviewLead(scope, targetIndex) &&
      !continuesNaturalTarget &&
      !continuesReviewTargetList(scope, targetIndex) &&
      !continuesSelectedPullRequestUrl(scope, targetIndex)
    ) {
      continue;
    }
    const base = match.groups?.base;
    const head = match.groups?.head?.replace(/[.,;:!?]+$/u, '');
    if (
      base !== undefined &&
      head !== undefined &&
      isSafeReviewRef(base) &&
      isSafeReviewRef(head)
    ) {
      targets.push({ kind: 'range', base, head, dots: '...' });
      previousNaturalEnd = targetIndex + match[0].length;
    }
  }
  for (const match of scope.matchAll(
    /(?:^|[\s("'[])(?<token>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,240}\.{2,3}[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})(?=$|[\s)"'\].,])/gu,
  )) {
    const token = match.groups?.token;
    if (token === undefined) continue;
    const tokenOffset = match[0].indexOf(token);
    const targetIndex = (match.index ?? 0) + Math.max(0, tokenOffset);
    const hasAffirmativeLead =
      hasDirectReviewLead(scope, targetIndex) || hasNounReviewLead(scope, targetIndex);
    const prefix = scope.slice(0, targetIndex);
    const continuesAcceptedList =
      (targets.length > 0 && /\b(?:and|or|plus)\s*$/iu.test(prefix)) ||
      continuesReviewTargetList(scope, targetIndex) ||
      continuesSelectedPullRequestUrl(scope, targetIndex);
    if (!hasAffirmativeLead && !continuesAcceptedList) continue;
    const target = rangeTargetFromToken(token);
    if (target !== undefined) targets.push(target);
  }
  const uniqueTargets = deduplicateReviewTargets(targets);
  if (uniqueTargets.length > 1) {
    return {
      ok: false,
      reason: 'Review target is ambiguous because the request names more than one Git range.',
    };
  }
  const malformedRange =
    /(?:^|[\s("'[])(?<token>[A-Za-z0-9._/@+~^-]*\.{2,}[A-Za-z0-9._/@+~^-]*)(?=$|[\s)"'\].,])/u.exec(
      scope,
    )?.groups?.token;
  if (
    malformedRange !== undefined &&
    rangeTargetFromToken(malformedRange) === undefined &&
    /[A-Za-z0-9_/@+~^-]/u.test(malformedRange) &&
    !(malformedRange.includes('...') && /^[A-Za-z]+\.\.\.[A-Za-z]+$/u.test(malformedRange))
  ) {
    return { ok: false, reason: 'Review target contains a malformed Git range.' };
  }
  const target = uniqueTargets[0];
  return target === undefined ? undefined : { ok: true, target };
}

function parsePullRequestMention(scope: string): ReviewTargetParseResult | undefined {
  for (const match of scope.matchAll(
    /\b(?:pr|pull request)\s*(?<candidate>#[^\s,;:!?]+|\d+[^\s,;:!?]*)/giu,
  )) {
    if (!hasAffirmativeReviewTargetLead(scope, match.index ?? 0)) continue;
    const candidate = match.groups?.candidate?.replace(/[)"'\]>.,;:!?]+$/u, '');
    if (candidate === undefined) continue;
    const numberText = candidate.replace(/^#/u, '');
    const number = Number.parseInt(numberText, 10);
    if (!/^\d{1,7}$/u.test(numberText) || number < 1 || number > 999_999) {
      return { ok: false, reason: `Review target PR number is invalid: ${candidate}` };
    }
  }
  const numbers = [...scope.matchAll(/\b(?:pr|pull request)\s*#?(?<number>\d{1,7})\b/giu)]
    .filter((match) => hasAffirmativeReviewTargetLead(scope, match.index ?? 0))
    .map((match) => match.groups?.number)
    .filter((number): number is string => number !== undefined);
  const targets: ReviewTarget[] = [];
  for (const numberText of numbers) {
    const number = Number.parseInt(numberText, 10);
    if (number < 1 || number > 999_999) {
      return { ok: false, reason: `Review target PR number is invalid: ${numberText}` };
    }
    targets.push({ kind: 'pull_request', number });
  }
  const uniqueTargets = deduplicateReviewTargets(targets);
  if (uniqueTargets.length > 1) {
    return {
      ok: false,
      reason: 'Review target is ambiguous because the request names more than one PR.',
    };
  }
  const target = uniqueTargets[0];
  if (target !== undefined) {
    return { ok: true, target };
  }
  if (
    /\breview\s+(?:the\s+)?(?:pr|pull request)\s+(?:handling|integration|logic|parser|rendering|support)\b/iu.test(
      scope,
    )
  ) {
    return undefined;
  }
  if (
    /\b(?:review|inspect|audit|check|analyze)\s+(?:(?:all|both|the|this|these|my|our|current)\s+){0,4}(?:(?:changes?|diffs?|files?|code)\s+(?:(?:in|from|for|of|at|on|introduced\s+by)\s+(?:the\s+)?)?)?(?:pr|pull request)\s+[A-Za-z][A-Za-z-]*\b/iu.test(
      scope,
    )
  ) {
    return undefined;
  }
  if (
    /\b(?:review|inspect|audit|check|analyze)\s+(?:(?:all|both|the|this|these|my|our|current)\s+){0,4}(?:(?:changes?|diffs?|files?|code)\s+(?:(?:in|from|for|of|at|on|introduced\s+by)\s+(?:the\s+)?)?)?(?:pr|pull request)\s+(?:https?:\/\/)?(?:www\.)?github\.com\//iu.test(
      scope,
    )
  ) {
    return undefined;
  }
  if (
    /\b(?:review|inspect|audit|check|analyze)\s+(?:(?:all|both|the|this|these|my|our|current)\s+){0,4}(?:(?:changes?|diffs?|files?|code)\s+(?:(?:in|from|for|of|at|on|introduced\s+by)\s+(?:the\s+)?)?)?(?:pr|pull request)(?:\s*#|\s+\d+\S*|\b)/iu.test(
      scope,
    )
  ) {
    return { ok: false, reason: 'Review target contains a malformed PR number.' };
  }
  return undefined;
}

function withoutExcludedWorkingTreeTargets(scope: string): string {
  return scope.replace(
    /\b(?:ignore|exclude|excluding|skip|omit|except(?:\s+for)?|(?:do\s+not|don't|dont)\s+include|not(?:\s+including)?)\s+(?:the\s+)?(?:(?:my|our|current)\s+)?(?:(?:working[- ]tree|worktree)(?:\s+(?:changes?|diffs?))?|uncommitted\s+(?:changes?|diffs?|work|code)|(?:changes?|diffs?))\b/giu,
    ' ',
  );
}

function hasAffirmativeWorkingTreeMention(scope: string, pattern: RegExp): boolean {
  return [...scope.matchAll(pattern)].some((match) => {
    const targetIndex = match.index ?? 0;
    return (
      hasAffirmativeReviewTargetLead(scope, targetIndex) &&
      hasTargetSelectionSuffix(scope, targetIndex + match[0].length)
    );
  });
}

function parseWorkingTree(scope: string): ReviewTargetParseResult | undefined {
  const affirmativeWorkingTreeScope = withoutExcludedWorkingTreeTargets(scope);
  if (
    /\breview\s+(?:the\s+)?(?:working[- ]tree|worktree)\s+(?:behavior|handling|integration|logic|parser|parsing|support)\b/iu.test(
      affirmativeWorkingTreeScope,
    )
  ) {
    return undefined;
  }
  const workingTreeUnit = String.raw`(?:changes?|diffs?|files?|code|work|symlinks?)`;
  const reviewLead = String.raw`\b(?:review|inspect|audit|check|analyze)\s+(?:(?:all|the|only|both|my|our|current|large)\s+){0,4}`;
  const exclusionLead = String.raw`(?:excluding|without|except(?:\s+for)?|but\s+not|(?:but\s+)?(?:do\s+not|don't|dont)\s+include|(?:but\s+)?not\s+including)`;
  const selectsTrackedOnly =
    /\b(?:review|inspect|audit|check|analyze)\s+(?:only\s+tracked(?:\s+(?:changes?|diffs?|files?|code|work))?|tracked(?:\s+(?:changes?|diffs?|files?|code|work))?\s+only)(?=$|[.,;:!?])/iu.test(
      scope,
    );
  const workingTreeSelection = String.raw`(?:(?:(?:my|our|current|all)\s+)?(?:changes?|diffs?|files?|code|work)|(?:the\s+)?(?:working[- ]tree|worktree)(?:\s+(?:changes?|diffs?|files?))?|uncommitted\s+(?:changes?|diffs?|work|code))`;
  const excludesUntracked = new RegExp(
    String.raw`${reviewLead}${workingTreeSelection}[^;.!?]*?\b${exclusionLead}\s+(?:the\s+)?untracked(?:\s+(?:changes?|diffs?|files?|code|content|work))?\b`,
    'iu',
  ).test(scope);
  if (selectsTrackedOnly || excludesUntracked) {
    return {
      ok: false,
      reason:
        'Review cannot safely honor a tracked-only target because working-tree evidence includes untracked file metadata. Choose staged changes, unstaged changes, or the full working tree.',
    };
  }
  const excludesUnstaged =
    new RegExp(
      String.raw`\b${exclusionLead}\s+(?:the\s+)?unstaged(?:\s+(?:changes?|diffs?))?\b`,
      'iu',
    ).test(scope) || /,\s*not\s+unstaged(?:\s+(?:changes?|diffs?))?\b/iu.test(scope);
  const excludesStaged =
    new RegExp(
      String.raw`\b${exclusionLead}\s+(?:the\s+)?staged(?:\s+(?:changes?|diffs?))?\b`,
      'iu',
    ).test(scope) || /,\s*not\s+staged(?:\s+(?:changes?|diffs?))?\b/iu.test(scope);
  const hasBothWorkingTreeLayers = new RegExp(
    String.raw`${reviewLead}(?:(?:staged)(?:\s+${workingTreeUnit})?\s*(?:and|&|\+|plus)\s*(?:unstaged|not[- ]staged)|(?:unstaged|not[- ]staged)(?:\s+${workingTreeUnit})?\s*(?:and|&|\+|plus)\s*staged)\s+${workingTreeUnit}\b`,
    'iu',
  ).test(scope);
  const hasUnstaged =
    hasAffirmativeWorkingTreeMention(
      scope,
      /\b(?:unstaged|not[- ]staged)\s+(?:changes?|diffs?|files?|code|work|symlinks?)\b/giu,
    ) ||
    /\b(?:review|inspect|audit|check|analyze)\s+(?:(?:what\s+is|only)\s+)(?:unstaged|not[- ]staged)(?=$|[.;:!?])/iu.test(
      scope,
    );
  const withoutUnstagedPhrases = scope.replace(
    /\b(?:unstaged|not[- ]staged)\s+(?:changes?|diffs?)\b/giu,
    '',
  );
  const hasStaged =
    hasAffirmativeWorkingTreeMention(
      withoutUnstagedPhrases,
      /\b(?:staged|cached|index)\s+(?:changes?|diffs?|files?|code|work|symlinks?)\b/giu,
    ) ||
    /\b(?:review|inspect|audit|check|analyze)\s+(?:(?:what\s+is|only)\s+staged|(?:the\s+)?index)(?=$|[.;:!?])/iu.test(
      scope,
    ) ||
    /\b(?:review|inspect|audit|check|analyze)\s+staged\s+but\s+not\s+unstaged\b/iu.test(scope);
  const hasGeneralWorkingTree = hasAffirmativeWorkingTreeMention(
    affirmativeWorkingTreeScope,
    /\b(?:(?:all|my|our|current)\s+(?:changes?|diffs?|files?|code|work)|(?:changes?|diffs?))\b/giu,
  );
  if (excludesStaged && excludesUnstaged) {
    return {
      ok: false,
      reason: 'Review target excludes both staged and unstaged changes.',
    };
  }
  if (excludesUnstaged && hasStaged) {
    return { ok: true, target: { kind: 'working_tree', mode: 'staged', explicit: true } };
  }
  if (excludesStaged && hasUnstaged) {
    return { ok: true, target: { kind: 'working_tree', mode: 'unstaged', explicit: true } };
  }
  if (excludesStaged && hasGeneralWorkingTree) {
    return { ok: true, target: { kind: 'working_tree', mode: 'unstaged', explicit: true } };
  }
  if (excludesUnstaged && hasGeneralWorkingTree) {
    return { ok: true, target: { kind: 'working_tree', mode: 'staged', explicit: true } };
  }
  if (hasBothWorkingTreeLayers && !excludesStaged && !excludesUnstaged) {
    return { ok: true, target: { kind: 'working_tree', mode: 'all', explicit: true } };
  }
  if (hasStaged && hasUnstaged && !excludesStaged && !excludesUnstaged) {
    return { ok: true, target: { kind: 'working_tree', mode: 'all', explicit: true } };
  }
  if (hasUnstaged) {
    return { ok: true, target: { kind: 'working_tree', mode: 'unstaged', explicit: true } };
  }
  if (hasStaged) {
    return { ok: true, target: { kind: 'working_tree', mode: 'staged', explicit: true } };
  }
  const hasNamedUntrackedFile = hasAffirmativeWorkingTreeMention(
    affirmativeWorkingTreeScope,
    /\buntracked(?:\s+[^\s,.;:!?]+){0,3}\s+files?\b/giu,
  );
  const hasLocalChanges = hasAffirmativeWorkingTreeMention(
    affirmativeWorkingTreeScope,
    /\blocal\s+(?:changes?|diffs?|files?|code|work)\b/giu,
  );
  const hasExplicitWorkingTree = hasAffirmativeWorkingTreeMention(
    affirmativeWorkingTreeScope,
    /\b(?:working[- ]tree|worktree)(?:\s+(?:changes?|diffs?|files?|code|work))?\b/giu,
  );
  const hasUncommittedMaterial = hasAffirmativeWorkingTreeMention(
    affirmativeWorkingTreeScope,
    /\buncommitted\s+(?:changes?|diffs?|files?|work|code)\b/giu,
  );
  if (
    hasNamedUntrackedFile ||
    hasLocalChanges ||
    hasGeneralWorkingTree ||
    hasExplicitWorkingTree ||
    hasUncommittedMaterial
  ) {
    return { ok: true, target: { kind: 'working_tree', mode: 'all', explicit: true } };
  }
  return undefined;
}

function parseCommit(scope: string): ReviewTargetParseResult | undefined {
  const targets: ReviewTarget[] = [];
  for (const match of scope.matchAll(
    /\b(?:latest|last|current)\s+(?:commit|committed\s+changes?)\b/giu,
  )) {
    const targetIndex = match.index ?? 0;
    if (
      hasAffirmativeReviewTargetLead(scope, targetIndex) &&
      hasTargetSelectionSuffix(scope, targetIndex + match[0].length)
    ) {
      targets.push({ kind: 'commit', ref: HEAD_COMMIT_REF });
    }
  }
  for (const match of scope.matchAll(
    /\b(?:review|inspect|audit|check|analyze)\s+(?:the\s+)?(?:this\s+commit|changes?\s+in\s+this\s+commit)\b/giu,
  )) {
    const targetIndex = match.index ?? 0;
    if (hasTargetSelectionSuffix(scope, targetIndex + match[0].length)) {
      targets.push({ kind: 'commit', ref: HEAD_COMMIT_REF });
    }
  }

  let skippedSubjectMention = false;
  for (const match of scope.matchAll(/\b(?<kind>commit|revision|rev)\s+(?:at\s+)?(?<ref>\S+)/giu)) {
    const kind = match.groups?.kind?.toLowerCase();
    const explicitCommit = match.groups?.ref;
    if (explicitCommit === undefined) continue;
    if (!hasAffirmativeReviewTargetLead(scope, match.index ?? 0)) continue;
    const prefix = scope.slice(0, match.index);
    if (
      kind === 'commit' &&
      /\b(?:can|could|current|last|latest|may|might|must|should|this|to|will|would)\s+$/iu.test(
        prefix,
      )
    ) {
      continue;
    }
    const ref = explicitCommit.replace(/[.,;:!?]+$/u, '');
    const directSubjectMention =
      kind === 'commit' &&
      /^(?:behavior|code|handling|history|implementation|logic|message|parser|parsing|support|workflow)$/iu.test(
        ref,
      ) &&
      /\b(?:review|inspect|audit|check|analyze)\s+(?:the\s+)?$/iu.test(prefix);
    if (
      directSubjectMention ||
      !hasTargetSelectionSuffix(scope, (match.index ?? 0) + match[0].length)
    ) {
      skippedSubjectMention = true;
      continue;
    }
    if (!isSafeReviewRef(ref)) {
      return { ok: false, reason: `Review target contains an unsafe Git ref: ${ref}` };
    }
    targets.push({ kind: 'commit', ref });
  }

  for (const match of scope.matchAll(/\b(?<ref>HEAD(?:[~^]\d*)?)(?=$|[\s)"'\].,])/gu)) {
    if (!hasAffirmativeReviewTargetLead(scope, match.index ?? 0)) continue;
    const headRef = match.groups?.ref;
    const suffix = scope.slice((match.index ?? 0) + match[0].length);
    if (suffix.startsWith('..')) continue;
    if (!hasTargetSelectionSuffix(scope, (match.index ?? 0) + match[0].length)) {
      continue;
    }
    if (headRef !== undefined && isSafeReviewRef(headRef)) {
      targets.push({ kind: 'commit', ref: headRef });
    }
  }
  for (const match of scope.matchAll(/\b(?<ref>HEAD[^\s)"'\].,]*)/gu)) {
    if (!hasAffirmativeReviewTargetLead(scope, match.index ?? 0)) continue;
    const namedHead = match.groups?.ref;
    if (
      namedHead !== undefined &&
      !/^HEAD(?:[~^]\d*)?$/u.test(namedHead.replace(/[.,;:!?]+$/u, ''))
    ) {
      return { ok: false, reason: 'Review target contains a malformed HEAD ref.' };
    }
  }
  const uniqueTargets = deduplicateReviewTargets(targets);
  if (uniqueTargets.length > 1) {
    return {
      ok: false,
      reason: 'Review target is ambiguous because the request names more than one commit.',
    };
  }
  const target = uniqueTargets[0];
  if (target !== undefined) return { ok: true, target };
  if (!skippedSubjectMention && /\breview\s+(?:the\s+)?(?:commit|revision|rev)\b/iu.test(scope)) {
    return { ok: false, reason: 'Review target names a commit without a Git ref.' };
  }
  return undefined;
}

function parseBareBranch(scope: string): ReviewTargetParseResult | undefined {
  for (const match of scope.matchAll(
    /\b(?:review|inspect|audit|check|analyze)\s+(?:(?:(?:all\s+)?(?:changes?|diffs?)|everything)\s+(?:in|on)\s+(?:the\s+)?(?:this|current)\s+branch|(?:the\s+)?(?:this|current)\s+branch)\b/giu,
  )) {
    if (!hasTargetSelectionSuffix(scope, (match.index ?? 0) + match[0].length)) continue;
    return {
      ok: false,
      reason:
        'Review target names the current branch without a comparison base. Use an explicit range such as main...HEAD.',
    };
  }
  for (const match of scope.matchAll(/\bbranch\s+(?<ref>\S+)/giu)) {
    if (!hasAffirmativeReviewTargetLead(scope, match.index ?? 0)) continue;
    const branch = match.groups?.ref;
    if (branch === undefined) continue;
    const ref = branch.replace(/[.,;:!?]+$/u, '');
    if (/^(?:behavior|handling|integration|logic|parser|parsing|support)$/iu.test(ref)) {
      continue;
    }
    if (!hasTargetSelectionSuffix(scope, (match.index ?? 0) + match[0].length)) continue;
    if (!isSafeReviewRef(ref)) {
      return { ok: false, reason: `Review target contains an unsafe Git ref: ${ref}` };
    }
    return {
      ok: false,
      reason: `Review target names branch ${ref} without a comparison base. Use an explicit range such as main...${ref}.`,
    };
  }
  return undefined;
}

function hasSelectedReviewTargetBefore(scope: string, targetIndex: number): boolean {
  const prefix = scope.slice(0, targetIndex).trim();
  if (prefix.length === 0) return false;
  const candidates = [
    parseRange(prefix),
    parsePullRequestUrl(prefix),
    parsePullRequestMention(prefix),
    parseCommit(prefix),
    parseWorkingTree(prefix),
  ];
  return candidates.some((candidate) => candidate?.ok === true && candidate.target.kind !== 'goal');
}

function hasExplicitFileOrPathExclusion(scope: string): boolean {
  for (const match of scope.matchAll(
    /\b(?:except(?:\s+for)?|exclud(?:e|ing)|without|skip(?:ping)?|omit(?:ting)?|ignor(?:e|ing)|but\s+not|save\s+for|other\s+than|(?:but\s+)?(?:do\s+not|don't|dont)\s+(?:include|review|inspect|audit|check|analyze)|(?:leave|leaving)\s+out)\s+(?:the\s+)?(?<excluded>[^;!?]+)/giu,
  )) {
    if (!hasSelectedReviewTargetBefore(scope, match.index ?? 0)) continue;
    const excluded = match.groups?.excluded?.trim();
    if (excluded === undefined) continue;
    if (
      /^(?:generating|writing|running|creating|editing|changing|modifying|updating|producing|adding|removing)\b/iu.test(
        excluded,
      )
    ) {
      continue;
    }
    if (
      /^(?:(?:my|our|current)\s+)?(?:(?:working[- ]tree|worktree)(?:\s+(?:changes?|diffs?))?|uncommitted\s+(?:changes?|diffs?|work|code)|(?:staged|unstaged|not[- ]staged|untracked)(?:\s+(?:changes?|diffs?|files?|code|content|work))?|current\s+(?:changes?|diffs?))\b/iu.test(
        excluded,
      )
    ) {
      continue;
    }
    if (
      /(?:^|\s)(?:\.{0,2}\/|[^\s,]+\/[^\s,]*|[^\s,]+\.[A-Za-z0-9][A-Za-z0-9_-]*)(?=$|[\s,.)])/u.test(
        excluded,
      ) ||
      /\b(?:file|path|director(?:y|ies)|folders?)\b/iu.test(excluded) ||
      /\b(?:assets?|build|changelogs?|config(?:uration)?|dist|docs?|documentation|examples?|fixtures?|generated|lockfiles?|migrations?|node_modules|snapshots?|sources?|src|tests?|vendor)\b/iu.test(
        excluded,
      ) ||
      /\b(?:Dockerfile|LICENSE|Makefile|README)\b/iu.test(excluded)
    ) {
      return true;
    }
    // An explicit exclusion after a selected target is a scope restriction.
    // If Circuit cannot prove what the noun names, it must stop rather than
    // silently review the broader target.
    return true;
  }
  return false;
}

function hasMultipleReviewTargetClauses(scope: string): boolean {
  const clauses = scope
    .split(/\s*(?:;|\balongside\b|\btogether\s+with\b|\band\b)\s*/iu)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length < 2) return false;
  const targets = clauses.flatMap((clause) => {
    const normalizedClause = clause.replace(/^(?:and|also|plus)\s+/iu, '');
    const candidateScope = /^(?:review|inspect|audit|check|analyze)\b/iu.test(normalizedClause)
      ? normalizedClause
      : `review ${normalizedClause}`;
    return [
      parseRange(candidateScope),
      parsePullRequestUrl(candidateScope),
      parsePullRequestMention(candidateScope),
      parseCommit(candidateScope),
      parseWorkingTree(candidateScope),
    ].flatMap((result) => (result?.ok === true ? [result.target] : []));
  });
  const uniqueTargets = deduplicateReviewTargets(targets);
  if (uniqueTargets.every((target) => target.kind === 'working_tree')) return false;
  return uniqueTargets.length > 1;
}

export function parseReviewTarget(scope: string): ReviewTargetParseResult {
  const normalizedScope = withImplicitReviewLead(
    normalizeUnambiguousReviewAliases(scope.replace(/[’‘]/gu, "'").replace(/[“”]/gu, '"')),
  );
  const affirmativeScope = withoutNegatedReviewClauses(normalizedScope);
  const suppliedMaterial = classifySuppliedReviewMaterial(affirmativeScope);
  if (suppliedMaterial.kind === 'supplied') {
    return { ok: true, target: { kind: 'goal' } };
  }
  if (suppliedMaterial.kind === 'malformed') {
    return { ok: false, reason: suppliedMaterial.reason };
  }
  const authorityScope = maskReviewLiteralData(normalizedScope);
  const affirmativeAuthorityScope = maskReviewLiteralData(affirmativeScope);
  if (hasExplicitFileOrPathExclusion(authorityScope)) {
    return {
      ok: false,
      reason:
        'Review target uses a file or path exclusion that cannot be pinned safely. Choose one complete working tree, commit, range, or PR target.',
    };
  }
  if (hasUnsupportedPathSubset(authorityScope)) {
    return {
      ok: false,
      reason:
        'Review target uses a path subset that cannot be pinned safely. Choose one complete working tree, commit, range, or PR target.',
    };
  }
  if (isPathOnlyReviewRequest(affirmativeAuthorityScope)) {
    return {
      ok: false,
      reason:
        'A file path by itself is not Review evidence. Choose one complete working tree, commit, range, or PR target, or include the actual plan or report text in the request.',
    };
  }
  if (
    suppliedMaterial.kind === 'missing' ||
    hasTopLevelArtifactReviewSubject(affirmativeAuthorityScope)
  ) {
    return {
      ok: false,
      reason:
        'Review has no supplied source material. Choose one complete working tree, commit, range, or PR target, or include the actual plan, report, code, or text in the request.',
    };
  }
  const unsupportedComparison = unsupportedReviewComparison(affirmativeAuthorityScope);
  if (unsupportedComparison !== undefined) {
    return { ok: false, reason: unsupportedComparison };
  }
  if (hasMultipleReviewTargetClauses(affirmativeAuthorityScope)) {
    return {
      ok: false,
      reason:
        'Review target is ambiguous because the request names more than one code target. Choose one working tree, commit, range, or PR target.',
    };
  }
  if (
    /\b(?:review|inspect|audit|check|analyze)\s+(?:the\s+)?(?:(?:changes?|diffs?)\s+(?:in|from)\s+)?(?:last|previous|prior|past|latest|recent)\s+(?:(?:\d+|[A-Za-z-]+(?:\s+[A-Za-z-]+){0,2})\s+)?commits\b/iu.test(
      affirmativeAuthorityScope,
    )
  ) {
    return {
      ok: false,
      reason:
        'Review target names more than one commit without exact bounds. Use an explicit range such as HEAD~2...HEAD.',
    };
  }
  for (const match of affirmativeAuthorityScope.matchAll(
    /\b(?:prs?|pull requests?)\s*#?\d{1,7}\s*\/\s*(?:(?:pr|pull request)\s*)?#?\d{1,7}\b/giu,
  )) {
    if (
      (match.index ?? 0) !== 0 &&
      !hasAffirmativeReviewTargetLead(affirmativeAuthorityScope, match.index ?? 0)
    ) {
      continue;
    }
    return {
      ok: false,
      reason: 'Review target is ambiguous because the request names more than one PR.',
    };
  }
  for (const match of affirmativeAuthorityScope.matchAll(
    /\b(?:(?:commits|revisions|revs)\s+[A-Za-z0-9._@+~^-]+\s*\/\s*[A-Za-z0-9._@+~^-]+|(?:commit|revision|rev)\s+(?:[0-9a-f]{6,64}|HEAD(?:[~^]\d*)?)\s*\/\s*(?:(?:commit|revision|rev)\s+)?(?:[0-9a-f]{6,64}|HEAD(?:[~^]\d*)?)|(?:commit|revision|rev)\s+[A-Za-z0-9._@+~^-]+\s*\/\s*(?:commit|revision|rev)\s+[A-Za-z0-9._@+~^-]+)\b/giu,
  )) {
    if (
      (match.index ?? 0) !== 0 &&
      !hasAffirmativeReviewTargetLead(affirmativeAuthorityScope, match.index ?? 0)
    ) {
      continue;
    }
    return {
      ok: false,
      reason:
        'Review target is ambiguous because the request names more than one commit. Choose one commit or one explicit range.',
    };
  }
  const pluralCommitList =
    /\b(?:review|inspect|audit|check|analyze)\s+(?:both\s+)?(?:commits|revisions|revs)\s+(?<first>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\s+(?:and|or|plus)\s+(?<second>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\b/iu.exec(
      affirmativeAuthorityScope,
    )?.groups;
  const subjectWords = new Set([
    'behavior',
    'handling',
    'implementation',
    'logic',
    'parser',
    'parsing',
    'support',
  ]);
  const proseContinuationWords = new Set([
    'check',
    'concentrate',
    'ensure',
    'especially',
    'exclude',
    'excluding',
    'focus',
    'ignore',
    'inspect',
    'look',
    'omit',
    'pay',
    'prioritize',
    'skip',
    'verify',
  ]);
  for (const match of affirmativeAuthorityScope.matchAll(
    /\b(?:prs?|pull requests?)\s*#?\d{1,7}(?:\s*,\s*|\s*&\s*|\s*\+\s*|\s+(?:and|or|plus)\s+)#?\d{1,7}\b/giu,
  )) {
    if (!hasAffirmativeReviewTargetLead(affirmativeAuthorityScope, match.index ?? 0)) continue;
    return {
      ok: false,
      reason: 'Review target is ambiguous because the request names more than one PR.',
    };
  }
  for (const match of affirmativeAuthorityScope.matchAll(
    /\b(?:commits?|revisions?|revs?)\s+(?<first>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})(?:\s*,\s*|\s*&\s*|\s*\+\s*|\s+(?:and|or|plus)\s+)(?<second>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\b/giu,
  )) {
    if (!hasAffirmativeReviewTargetLead(affirmativeAuthorityScope, match.index ?? 0)) continue;
    const first = match.groups?.first;
    const second = match.groups?.second;
    if (second !== undefined && proseContinuationWords.has(second.toLowerCase())) {
      continue;
    }
    if (
      first !== undefined &&
      second !== undefined &&
      subjectWords.has(first.toLowerCase()) &&
      subjectWords.has(second.toLowerCase())
    ) {
      continue;
    }
    return {
      ok: false,
      reason:
        'Review target is ambiguous because the request names more than one commit. Choose one commit or one explicit range.',
    };
  }
  if (
    pluralCommitList?.first !== undefined &&
    pluralCommitList.second !== undefined &&
    !proseContinuationWords.has(pluralCommitList.second.toLowerCase()) &&
    (!subjectWords.has(pluralCommitList.first.toLowerCase()) ||
      !subjectWords.has(pluralCommitList.second.toLowerCase()))
  ) {
    return {
      ok: false,
      reason:
        'Review target is ambiguous because the request names more than one commit. Choose one commit or one explicit range.',
    };
  }
  if (
    /\b(?:review|inspect|audit|check|analyze)\s+(?:both\s+)?(?:prs|pull requests)\s+#?\d{1,7}\s+(?:and|or|plus)\s+#?\d{1,7}\b/iu.test(
      affirmativeAuthorityScope,
    )
  ) {
    return {
      ok: false,
      reason: 'Review target is ambiguous because the request names more than one PR.',
    };
  }
  if (
    /\b(?:review|inspect|audit|check|analyze)\s+(?:everything|all(?:\s+(?:code|changes?|diffs?))?)\s+(?:except|excluding)\s+(?:the\s+)?(?:commit|revision|rev|pr|pull request|branch|range|staged|unstaged|working[- ]tree|worktree)\b/iu.test(
      affirmativeAuthorityScope,
    )
  ) {
    return {
      ok: false,
      reason:
        'Review target uses an exclusion that cannot be pinned safely. Choose one explicit working tree, commit, range, or PR target.',
    };
  }
  if (
    /\b(?:review|inspect|audit|check|analyze)\b[^;.!?]*\b(?:since|after|before)\s+(?:the\s+)?(?:commit|revision|rev)\s+\S+/iu.test(
      affirmativeAuthorityScope,
    )
  ) {
    return {
      ok: false,
      reason:
        'Review target uses a relative commit comparison that cannot be pinned safely. Use an explicit range such as abc123...HEAD.',
    };
  }
  const specificResults = [
    parseRange(affirmativeAuthorityScope),
    parsePullRequestUrl(affirmativeAuthorityScope),
    parsePullRequestMention(affirmativeAuthorityScope),
    parseCommit(affirmativeAuthorityScope),
    parseBareBranch(affirmativeAuthorityScope),
  ].filter((result): result is ReviewTargetParseResult => result !== undefined);
  const workingTreeResult = parseWorkingTree(affirmativeAuthorityScope);
  const results = [
    ...specificResults,
    ...(workingTreeResult === undefined ? [] : [workingTreeResult]),
  ];
  const invalid = results.find((result) => !result.ok);
  if (invalid !== undefined) return invalid;
  const specificTargets = specificResults.flatMap((result) => (result.ok ? [result.target] : []));
  const workingTreeTargets = workingTreeResult?.ok === true ? [workingTreeResult.target] : [];
  const targets = deduplicateReviewTargets([...specificTargets, ...workingTreeTargets]);
  if (targets.length > 1) {
    return {
      ok: false,
      reason:
        'Review target is ambiguous because the request names more than one code target. Choose one working tree, commit, range, or PR target.',
    };
  }
  if (targets.length === 0) {
    const againstComparison =
      /\b(?:review|inspect|audit|check|analyze)\s+(?<base>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})\s+against\s+(?<head>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,120})(?=$|[\s)"'\],;:!?])/iu.exec(
        affirmativeAuthorityScope,
      )?.groups;
    const base = againstComparison?.base;
    const head = againstComparison?.head?.replace(/[.,;:!?]+$/u, '');
    if (
      base !== undefined &&
      head !== undefined &&
      isSafeReviewRef(base) &&
      isSafeReviewRef(head)
    ) {
      return {
        ok: false,
        reason: `Review target comparison is ambiguous. Use an explicit range such as ${base}...${head}.`,
      };
    }
    if (
      /\b(?:review|inspect|audit|check|analyze)\s+(?:the\s+)?(?:changes?|diffs?)\s+(?:from|to|between|against)\b/iu.test(
        affirmativeAuthorityScope,
      )
    ) {
      return {
        ok: false,
        reason:
          'Review target comparison is incomplete. Use one explicit range such as main...HEAD.',
      };
    }
    if (
      /\b(?:review|inspect|audit|check|analyze)\s+(?:(?:the|only|what\s+is)\s+)?(?:staged|unstaged|index|tracked|untracked)(?=$|[.,;:!?])/iu.test(
        affirmativeAuthorityScope,
      )
    ) {
      return {
        ok: false,
        reason:
          'Review target wording is incomplete. Choose staged changes, unstaged changes, or the full working tree.',
      };
    }
  }
  if (
    specificTargets.length === 0 &&
    workingTreeTargets.length === 0 &&
    /\b(?:(?:the|these)\s+(?:changes?|diffs?)|this\s+(?:change|diff))\b(?=$|[.,;:!?]|\s+(?:for|with|especially|focus(?:ing)?(?:\s+on)?)\b)/iu.test(
      affirmativeAuthorityScope,
    )
  ) {
    return {
      ok: true,
      target: { kind: 'working_tree', mode: 'all', explicit: true },
    };
  }
  const target = targets[0];
  if (target !== undefined) return { ok: true, target };
  return {
    ok: false,
    reason:
      'Review has no supplied source material. Choose one complete working tree, commit, range, or PR target, or include the actual plan, report, code, or text in the request.',
  };
}

export function reviewScopeRequiresGitEvidence(scope: string): boolean {
  const parsed = parseReviewTarget(scope);
  if (!parsed.ok) return true;
  return parsed.target.kind !== 'goal';
}

function runtimeTarget(target: ReviewTarget): RuntimeGitTarget | undefined {
  if (target.kind === 'goal' || target.kind === 'working_tree') return undefined;
  if (target.kind === 'commit') return { kind: 'commit', ref: target.ref };
  if (target.kind === 'range') {
    return { kind: 'range', base: target.base, head: target.head, dots: target.dots };
  }
  return {
    kind: 'pull_request',
    number: target.number,
    ...(target.repository === undefined
      ? {}
      : { repository: githubRepositoryKey(target.repository) }),
  };
}

function resolveTargetArgs(
  target: RuntimeGitTarget,
  pullRequestMergeRef?: string,
): readonly string[] {
  if (target.kind === 'commit') {
    return ['rev-parse', '--verify', '--end-of-options', `${target.ref}^{commit}`];
  }
  if (target.kind === 'range') {
    return [
      'rev-parse',
      '--revs-only',
      '--end-of-options',
      `${target.base}^{commit}..${target.head}^{commit}`,
    ];
  }
  if (pullRequestMergeRef === undefined) {
    throw new Error(
      `Review target unavailable: PR #${target.number} has no repository-bound local merge ref.`,
    );
  }
  return [
    'rev-parse',
    '--revs-only',
    '--end-of-options',
    `${pullRequestMergeRef}^{commit}`,
    `${pullRequestMergeRef}^1^{commit}..${pullRequestMergeRef}^2^{commit}`,
  ];
}

function resolvedObjectId(value: string | undefined, label: string): string {
  if (value === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new Error(`Review target unavailable: Git returned an invalid ${label}.`);
  }
  return value;
}

function parseResolvedTarget(target: RuntimeGitTarget, output: string): RuntimeGitPinnedTarget {
  const lines = output.trimEnd().split('\n');
  if (target.kind === 'commit') {
    if (lines.length !== 1) {
      throw new Error(
        `Review target unavailable: Git returned an invalid snapshot for commit ${target.ref}.`,
      );
    }
    return {
      kind: 'commit',
      commit: resolvedObjectId(lines[0], `commit id for ${target.ref}`),
    };
  }
  if (target.kind === 'range') {
    if (lines.length !== 2 || !lines[1]?.startsWith('^')) {
      throw new Error(
        `Review target unavailable: Git returned an invalid snapshot for range ${target.base}${target.dots}${target.head}.`,
      );
    }
    return {
      kind: 'range',
      base_commit: resolvedObjectId(
        lines[1].slice(1),
        `base commit id for ${target.base}${target.dots}${target.head}`,
      ),
      head_commit: resolvedObjectId(
        lines[0],
        `head commit id for ${target.base}${target.dots}${target.head}`,
      ),
      dots: target.dots,
    };
  }
  if (lines.length !== 3 || !lines[2]?.startsWith('^')) {
    throw new Error(
      `Review target unavailable: Git returned an invalid snapshot for PR #${target.number}.`,
    );
  }
  return {
    kind: 'pull_request',
    number: target.number,
    ...(target.repository === undefined ? {} : { repository: target.repository }),
    merge_commit: resolvedObjectId(lines[0], `merge commit id for PR #${target.number}`),
    base_commit: resolvedObjectId(lines[2].slice(1), `base commit id for PR #${target.number}`),
    head_commit: resolvedObjectId(lines[1], `head commit id for PR #${target.number}`),
  };
}

function pinnedTargetMatches(target: RuntimeGitTarget, pinned: RuntimeGitPinnedTarget): boolean {
  if (target.kind !== pinned.kind) return false;
  if (target.kind === 'range' && pinned.kind === 'range') return target.dots === pinned.dots;
  if (target.kind === 'pull_request' && pinned.kind === 'pull_request') {
    return target.number === pinned.number && target.repository === pinned.repository;
  }
  return true;
}

async function resolveTarget(
  projectRoot: string,
  target: RuntimeGitTarget,
  reader?: RuntimeGitReader,
  pullRequestMergeRef?: string,
  directContext?: DirectGitContext,
): Promise<RuntimeGitPinnedTarget> {
  if (reader === undefined) {
    const result = runGit(
      projectRoot,
      resolveTargetArgs(target, pullRequestMergeRef),
      {},
      directContext,
    );
    if (!result.ok) throw new Error(`Review target unavailable: ${result.reason}`);
    return parseResolvedTarget(target, result.stdout);
  }
  const result = await reader.read({
    operation: 'resolve_target',
    projectRoot,
    target,
  });
  if (result.operation !== 'resolve_target') {
    throw new Error(
      `Review target unavailable: Git reader returned ${result.operation} for resolve_target.`,
    );
  }
  if (!runtimeGitTextIsValidUtf8(result.stdout)) {
    throw new Error('Review target unavailable: Git target resolution output is not valid UTF-8.');
  }
  if (!result.cleanup_confirmed) {
    throw new Error('Review target unavailable: Git target resolution cleanup was not confirmed.');
  }
  if (result.truncated) {
    throw new Error(
      'Review target unavailable: Git target resolution was truncated before it could be verified.',
    );
  }
  if (!result.ok || result.resolved_target === undefined) {
    const reason = result.stderr.trim();
    throw new Error(
      `Review target unavailable: ${reason.length > 0 ? reason : 'Git could not resolve the requested target.'}`,
    );
  }
  if (!pinnedTargetMatches(target, result.resolved_target)) {
    throw new Error('Review target unavailable: Git resolved a different target shape.');
  }
  return result.resolved_target;
}

function rawCommitParent(output: string, commit: string): string | null {
  const header = output.split('\n\n', 1)[0] ?? '';
  const lines = header.split('\n');
  if (!/^(?:tree) (?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(lines[0] ?? '')) {
    throw new Error(
      `Review target unavailable: Git returned malformed raw commit data for ${commit}.`,
    );
  }
  const parents = lines
    .filter((line) => line.startsWith('parent '))
    .map((line) =>
      resolvedObjectId(line.slice('parent '.length), `parent commit id for ${commit}`),
    );
  return parents[0] ?? null;
}

function assertDirectGitMetadataSafe(context: DirectGitContext): void {
  for (const directory of new Set([context.gitDir, context.commonDir])) {
    for (const metadataPath of ['objects', 'objects/info', 'objects/pack']) {
      try {
        if (lstatSync(join(directory, metadataPath)).isSymbolicLink()) {
          throw new Error(
            `Review target unavailable: Git metadata path ${metadataPath} is a symbolic link.`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    for (const [metadataPath, message] of [
      [
        'objects/info/alternates',
        'Git object alternates can escape the selected repository and are not supported.',
      ],
      [
        'info/grafts',
        'Legacy Git graft metadata can rewrite commit ancestry and is not supported.',
      ],
    ] as const) {
      try {
        lstatSync(join(directory, metadataPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(
          `Review target unavailable: Git metadata path ${metadataPath} could not be checked. ${errorMessage(error)}`,
        );
      }
      throw new Error(`Review target unavailable: ${message}`);
    }
  }
}

function prepareDirectTarget(
  projectRoot: string,
  target: RuntimeGitPinnedTarget,
  directContext?: DirectGitContext,
): DirectPinnedTarget {
  if (target.kind !== 'commit') return target;
  const raw = runGit(projectRoot, ['cat-file', 'commit', target.commit], {}, directContext);
  if (!raw.ok) {
    throw new Error(
      `Review target unavailable: commit ${target.commit} could not be inspected. ${raw.reason}`,
    );
  }
  return {
    kind: 'commit',
    commit: target.commit,
    parent_commit: rawCommitParent(raw.stdout, target.commit),
  };
}

function targetDiffArgs(target: DirectPinnedTarget, stat = false): readonly string[] {
  const statArgs = stat ? ['--stat'] : [];
  if (target.kind === 'commit') {
    if (target.parent_commit !== null) {
      return [
        'diff',
        ...statArgs,
        '--no-ext-diff',
        '--no-textconv',
        '--submodule=short',
        '--ignore-submodules=none',
        `${target.parent_commit}^{commit}`,
        `${target.commit}^{commit}`,
        '--',
      ];
    }
    return [
      'show',
      '--format=',
      ...statArgs,
      '--no-ext-diff',
      '--no-textconv',
      '--submodule=short',
      '--ignore-submodules=none',
      '--root',
      `${target.commit}^{commit}`,
      '--',
    ];
  }
  if (target.kind === 'range') {
    return [
      'diff',
      ...statArgs,
      '--no-ext-diff',
      '--no-textconv',
      '--submodule=short',
      '--ignore-submodules=none',
      `${target.base_commit}${target.dots}${target.head_commit}`,
      '--',
    ];
  }
  return [
    'diff',
    ...statArgs,
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    `${target.base_commit}...${target.head_commit}`,
    '--',
  ];
}

function targetUnavailableMessage(
  target: Exclude<ReviewTarget, { readonly kind: 'goal' | 'working_tree' }>,
): string {
  const label = reviewTargetLabel(target);
  if (target.kind === 'pull_request') {
    return `Review target unavailable: PR #${target.number} is not available as a complete local snapshot. A checked-out PR head does not identify its base. Review an explicit range such as main...HEAD, or fetch the PR merge ref locally.`;
  }
  return `Review target unavailable: ${label} could not be read from this repository.`;
}

async function assertPullRequestRepository(
  projectRoot: string,
  target: Extract<ReviewTarget, { readonly kind: 'pull_request' }>,
  reader?: RuntimeGitReader,
  directContext?: DirectGitContext,
): Promise<{ readonly repository: string; readonly mergeRef?: string }> {
  const directConfiguration = reader === undefined ? directContext?.auditedConfig : undefined;
  const result =
    reader === undefined ? undefined : await readGit(reader, 'remote_repositories', projectRoot);
  if (
    (reader === undefined && directConfiguration === undefined) ||
    (result !== undefined && !result.ok)
  ) {
    throw new Error(
      `Review target unavailable: ${reviewTargetLabel(target)} repository identity could not be verified.`,
    );
  }
  const repositoryEntries =
    reader === undefined
      ? githubRepositoriesFromGitConfig(directConfiguration as string)
      : (result as Extract<GitResult, { readonly ok: true }>).stdout
          .split(/\r?\n/u)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
  const repositories = [...new Set(repositoryEntries)];
  const requested =
    target.repository === undefined ? undefined : githubRepositoryKey(target.repository);
  if (repositories.length === 0) {
    throw new Error(
      `Review target unavailable: ${reviewTargetLabel(target)} cannot be tied to a local GitHub repository because this workspace has no GitHub remote.`,
    );
  }
  if (requested !== undefined && !repositories.includes(requested)) {
    throw new Error(
      `Review target repository mismatch: ${requested} is not one of this workspace's configured GitHub repositories.`,
    );
  }
  if (requested === undefined && repositories.length > 1) {
    throw new Error(
      `Review target repository is ambiguous: this workspace has multiple GitHub repositories, so the local PR merge ref cannot be tied safely to ${requested ?? `PR #${target.number}`}. Review an explicit range such as main...HEAD instead.`,
    );
  }
  const repository = requested ?? repositories[0];
  if (repository === undefined) {
    throw new Error(
      `Review target unavailable: ${reviewTargetLabel(target)} repository identity could not be verified.`,
    );
  }
  if (reader !== undefined) return { repository };
  const mergeRefs = githubPullRequestMergeRefsFromGitConfig(
    directConfiguration as string,
    target.number,
  ).filter((candidate) => candidate.repository === repository);
  const mergeRef = mergeRefs[0]?.ref;
  if (mergeRefs.length !== 1 || mergeRef === undefined) {
    throw new Error(
      `Review target unavailable: ${reviewTargetLabel(target)} has no locally provable repository-bound merge ref. Fetch it into refs/circuit/${repository}/pull/${target.number}/merge with a matching remote fetch refspec, or review an explicit range such as main...HEAD.`,
    );
  }
  return { repository, mergeRef };
}

async function collectTargetEvidence(
  projectRoot: string,
  target: Exclude<ReviewTarget, { readonly kind: 'goal' | 'working_tree' }>,
  reader?: RuntimeGitReader,
  directContext?: DirectGitContext,
): Promise<{
  readonly targetDiff: ReviewEvidenceText;
  readonly targetDiffStat: string;
  readonly pinnedTarget: RuntimeGitPinnedTarget;
  readonly targetRepository?: string;
}> {
  const pullRequestProof =
    target.kind === 'pull_request'
      ? await assertPullRequestRepository(projectRoot, target, reader, directContext)
      : undefined;
  const requestTarget =
    target.kind === 'pull_request' && pullRequestProof !== undefined
      ? {
          kind: 'pull_request' as const,
          number: target.number,
          repository: pullRequestProof.repository,
        }
      : runtimeTarget(target);
  if (requestTarget === undefined) {
    throw new Error('Review target unavailable: the requested Git target could not be prepared.');
  }
  const pinnedTarget = await resolveTarget(
    projectRoot,
    requestTarget,
    reader,
    pullRequestProof?.mergeRef,
    directContext,
  );
  const evidenceResults =
    reader === undefined
      ? (() => {
          const directTarget = prepareDirectTarget(projectRoot, pinnedTarget, directContext);
          return {
            diff: runGit(
              projectRoot,
              targetDiffArgs(directTarget),
              {
                maxBufferBytes: MAX_DIFF_BUFFER_BYTES,
                allowPartialStdout: true,
              },
              directContext,
            ),
            diffStat: runGit(projectRoot, targetDiffArgs(directTarget, true), {}, directContext),
          };
        })()
      : {
          diff: await readGit(reader, 'target_diff', projectRoot, pinnedTarget),
          diffStat: await readGit(reader, 'target_diff_stat', projectRoot, pinnedTarget),
        };
  const { diff, diffStat } = evidenceResults;
  if (!diff.ok) {
    throw new Error(`${targetUnavailableMessage(target)} ${diff.reason}`);
  }
  if (!diffStat.ok) {
    throw new Error(`${targetUnavailableMessage(target)} ${diffStat.reason}`);
  }
  const targetDiff = gitDiffEvidence(diff);
  if (targetDiff.text.length === 0) {
    throw new Error(
      `Review target has no changes to inspect: ${reviewTargetLabel(target)} resolved successfully but produced an empty diff.`,
    );
  }
  return {
    targetDiff,
    targetDiffStat: diffStat.stdout,
    pinnedTarget,
    ...(pullRequestProof === undefined ? {} : { targetRepository: pullRequestProof.repository }),
  };
}

function gitDiffEvidence(result: GitResult): ReviewEvidenceText {
  if (!result.ok) return truncateText(result.reason, MAX_DIFF_CHARS);
  const truncated = truncateText(result.stdout, MAX_DIFF_CHARS);
  if (!result.truncated_by_buffer) return truncated;
  return {
    text: `${truncated.text}\n[truncated by the bounded Git reader]`,
    truncated: true,
  };
}

function printableStatus(status: string): string {
  if (!status.includes('\0')) return status;
  const entries = status.split('\0').filter((entry) => entry.length > 0);
  return entries.length === 0 ? '' : `${entries.join('\n')}\n`;
}

function insideProject(projectRoot: string, path: string): boolean {
  const rel = relative(projectRoot, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

type HiddenIndexFlag = {
  readonly tag: string;
  readonly path: string;
};

function hiddenIndexFlagsFromOutput(
  projectRoot: string,
  output: string,
): readonly HiddenIndexFlag[] {
  if (output.length === 0) return Object.freeze([]);
  if (!output.endsWith('\0')) {
    throw new Error('Review target unavailable: Git returned malformed hidden index flag output.');
  }
  const flags: HiddenIndexFlag[] = [];
  const seenPaths = new Set<string>();
  for (const entry of output.slice(0, -1).split('\0')) {
    const tag = entry[0];
    const path = entry.slice(2);
    if (
      tag === undefined ||
      !/^[HSMRCK?hsmrck]$/u.test(tag) ||
      entry[1] !== ' ' ||
      path.length === 0 ||
      isAbsolute(path) ||
      !insideProject(projectRoot, resolve(projectRoot, path)) ||
      seenPaths.has(path)
    ) {
      throw new Error(
        'Review target unavailable: Git returned malformed hidden index flag output.',
      );
    }
    seenPaths.add(path);
    const assumeUnchanged = /^[hsmrck]$/u.test(tag);
    const skipWorktree = tag === 'S' || tag === 's';
    if (assumeUnchanged || skipWorktree) flags.push({ tag, path });
  }
  return Object.freeze(flags);
}

async function inspectHiddenIndexFlags(
  projectRoot: string,
  reader?: RuntimeGitReader,
  directContext?: DirectGitContext,
): Promise<{
  readonly result: GitResult;
  readonly flags: readonly HiddenIndexFlag[];
}> {
  const result =
    reader === undefined
      ? runGit(projectRoot, ['ls-files', '-v', '-z', '--'], {}, directContext)
      : await readGit(reader, 'hidden_index_flags', projectRoot);
  if (!result.ok) {
    throw new Error(
      `Review target unavailable: hidden index flags could not be inspected. ${result.reason}`,
    );
  }
  return {
    result,
    flags: hiddenIndexFlagsFromOutput(projectRoot, result.stdout),
  };
}

function assertNoHiddenIndexFlags(flags: readonly HiddenIndexFlag[]): void {
  if (flags.length === 0) return;
  const paths = flags.map((flag) => JSON.stringify(flag.path)).join(', ');
  throw new Error(
    `Review target unavailable: tracked paths use assume-unchanged or skip-worktree and can hide working-tree changes: ${paths}. Clear those flags with git update-index --no-assume-unchanged or --no-skip-worktree, then retry Review.`,
  );
}

function changedGitlinkPathsFromRaw(projectRoot: string, output: string): readonly string[] {
  if (output.length === 0) return Object.freeze([]);
  if (!output.endsWith('\0')) {
    throw new Error(
      'Review target unavailable: Git returned malformed changed-gitlink output without a final NUL delimiter.',
    );
  }
  const tokens = output.slice(0, -1).split('\0');
  if (tokens.length % 2 !== 0) {
    throw new Error('Review target unavailable: Git returned malformed changed-gitlink output.');
  }
  const paths = new Set<string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const header = tokens[index];
    const path = tokens[index + 1];
    const match =
      /^:([0-7]{6}) ([0-7]{6}) (?:[0-9a-f]{40}|[0-9a-f]{64}) (?:[0-9a-f]{40}|[0-9a-f]{64}) ([ADMTUXB])$/u.exec(
        header ?? '',
      );
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      path === undefined ||
      path.length === 0 ||
      isAbsolute(path) ||
      !insideProject(projectRoot, resolve(projectRoot, path))
    ) {
      throw new Error('Review target unavailable: Git returned malformed changed-gitlink output.');
    }
    if (match[1] !== '160000' && match[2] !== '160000') continue;
    if (paths.has(path)) {
      throw new Error(
        `Review target unavailable: Git returned duplicate changed-gitlink path ${JSON.stringify(path)}.`,
      );
    }
    paths.add(path);
  }
  return Object.freeze([...paths].sort());
}

function readUntrackedFile(
  projectRoot: string,
  path: string,
  contentPolicy: ReviewUntrackedContentPolicy,
): ReviewUntrackedFileEvidence {
  const abs = resolve(projectRoot, path);
  if (!insideProject(projectRoot, abs)) {
    return { path, byte_length: 0, skipped_reason: 'path resolves outside project root' };
  }
  let pathStat: ReturnType<typeof lstatSync>;
  let canonicalProjectRoot: string;
  try {
    pathStat = lstatSync(abs);
    canonicalProjectRoot = realpathSync(projectRoot);
  } catch (err) {
    return { path, byte_length: 0, skipped_reason: `failed to inspect file: ${errorMessage(err)}` };
  }
  if (pathStat.isSymbolicLink()) {
    return { path, byte_length: pathStat.size, skipped_reason: 'symbolic link skipped' };
  }
  if (!pathStat.isFile()) {
    return { path, byte_length: pathStat.size, skipped_reason: 'not a regular file' };
  }

  let fd: number | undefined;
  try {
    const canonicalBeforeOpen = realpathSync(abs);
    if (!insideProject(canonicalProjectRoot, canonicalBeforeOpen)) {
      return {
        path,
        byte_length: pathStat.size,
        skipped_reason: 'path resolves outside project root',
      };
    }
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = fstatSync(fd);
    const pathAfterOpen = lstatSync(abs);
    const canonicalAfterOpen = realpathSync(abs);
    if (
      !openedStat.isFile() ||
      pathAfterOpen.isSymbolicLink() ||
      openedStat.dev !== pathAfterOpen.dev ||
      openedStat.ino !== pathAfterOpen.ino ||
      pathStat.dev !== openedStat.dev ||
      pathStat.ino !== openedStat.ino ||
      canonicalBeforeOpen !== canonicalAfterOpen ||
      !insideProject(canonicalProjectRoot, canonicalAfterOpen)
    ) {
      return {
        path,
        byte_length: openedStat.size,
        skipped_reason: 'file changed while evidence was being collected',
      };
    }
    if (contentPolicy === 'metadata-only') {
      return { path, byte_length: openedStat.size };
    }

    const byteLimit = Math.min(openedStat.size, MAX_UNTRACKED_FILE_BYTES);
    const bytes = Buffer.alloc(byteLimit);
    const bytesRead = readSync(fd, bytes, 0, byteLimit, 0);
    const afterReadStat = fstatSync(fd);
    const pathAfterRead = lstatSync(abs);
    if (
      afterReadStat.dev !== openedStat.dev ||
      afterReadStat.ino !== openedStat.ino ||
      afterReadStat.size !== openedStat.size ||
      pathAfterRead.isSymbolicLink() ||
      pathAfterRead.dev !== openedStat.dev ||
      pathAfterRead.ino !== openedStat.ino ||
      realpathSync(abs) !== canonicalAfterOpen
    ) {
      return {
        path,
        byte_length: afterReadStat.size,
        skipped_reason: 'file changed while evidence was being collected',
      };
    }
    const sample = bytes.subarray(0, bytesRead);
    if (sample.includes(0)) {
      return { path, byte_length: openedStat.size, skipped_reason: 'binary file skipped' };
    }
    let decoded: string;
    try {
      decoded = decodeBoundedUtf8(sample, openedStat.size > bytesRead);
    } catch {
      return {
        path,
        byte_length: openedStat.size,
        skipped_reason: 'file content is not valid UTF-8',
      };
    }
    const content = truncateText(decoded, MAX_UNTRACKED_FILE_CHARS);
    return {
      path,
      byte_length: openedStat.size,
      content:
        openedStat.size > bytesRead && !content.truncated
          ? { ...content, truncated: true }
          : content,
    };
  } catch (err) {
    return {
      path,
      byte_length: pathStat.size,
      skipped_reason: `failed to read file: ${errorMessage(err)}`,
    };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The evidence entry above is still useful even if closing a skipped
        // file descriptor fails after the read attempt.
      }
    }
  }
}

async function collectUntrackedFiles(
  projectRoot: string,
  contentPolicy: ReviewUntrackedContentPolicy,
  reader?: RuntimeGitReader,
  directContext?: DirectGitContext,
): Promise<{
  readonly count: number;
  readonly truncated: boolean;
  readonly files: ReviewUntrackedFileEvidence[];
}> {
  const listed =
    reader === undefined
      ? runGit(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z'], {}, directContext)
      : await readGit(reader, 'untracked_files', projectRoot);
  if (!listed.ok) {
    throw new Error(
      `Review target unavailable: untracked files could not be enumerated. ${listed.reason}`,
    );
  }
  if (listed.truncated_by_buffer) {
    throw new Error(
      'Review target unavailable: the untracked file listing was truncated before it could be verified.',
    );
  }
  const paths = listed.stdout.split('\0').filter((path) => path.length > 0);
  return {
    count: paths.length,
    truncated: listed.truncated_by_buffer || paths.length > MAX_UNTRACKED_FILES,
    files: paths
      .slice(0, MAX_UNTRACKED_FILES)
      .map((path) => readUntrackedFile(projectRoot, path, contentPolicy)),
  };
}

function sameGitResult(left: GitResult, right: GitResult): boolean {
  if (left.ok !== right.ok) return false;
  if (left.ok && right.ok) {
    return left.stdout === right.stdout && left.truncated_by_buffer === right.truncated_by_buffer;
  }
  return !left.ok && !right.ok && left.reason === right.reason;
}

function sameUntrackedEvidence(
  left: Awaited<ReturnType<typeof collectUntrackedFiles>>,
  right: Awaited<ReturnType<typeof collectUntrackedFiles>>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function collectReviewEvidence(
  projectRoot: string | undefined,
  options: {
    readonly includeUntrackedFileContent?: boolean;
    readonly target: ReviewTarget;
    readonly gitReader?: RuntimeGitReader;
  },
): Promise<ReviewEvidence> {
  const target = options.target;
  if (target.kind === 'goal') return { kind: 'goal' };
  if (projectRoot === undefined) {
    const targetLabel =
      target.kind === 'working_tree'
        ? `${target.mode === 'all' ? 'working tree' : target.mode} changes`
        : reviewTargetLabel(target);
    throw new Error(
      `Review target unavailable: ${targetLabel} cannot be read because the workspace root was not provided.`,
    );
  }
  const directContext =
    options.gitReader === undefined ? prepareDirectGitContext(projectRoot) : undefined;
  if (directContext !== undefined) assertDirectGitMetadataSafe(directContext);
  const evidenceRoot = directContext?.workTree ?? projectRoot;

  if (target.kind !== 'working_tree') {
    const targetEvidence = await collectTargetEvidence(
      evidenceRoot,
      target,
      options.gitReader,
      directContext,
    );
    return {
      kind: 'git-target',
      project_root: evidenceRoot,
      target_kind: target.kind,
      target_ref: reviewTargetLabel(target),
      ...(target.kind === 'range'
        ? {
            target_base_ref: target.base,
            target_head_ref: target.head,
          }
        : {}),
      ...(target.kind === 'pull_request'
        ? { target_repository: targetEvidence.targetRepository }
        : {}),
      ...(targetEvidence.pinnedTarget.kind === 'commit'
        ? { target_commit: targetEvidence.pinnedTarget.commit }
        : targetEvidence.pinnedTarget.kind === 'range'
          ? {
              target_base_commit: targetEvidence.pinnedTarget.base_commit,
              target_head_commit: targetEvidence.pinnedTarget.head_commit,
            }
          : {
              target_merge_commit: targetEvidence.pinnedTarget.merge_commit,
              target_base_commit: targetEvidence.pinnedTarget.base_commit,
              target_head_commit: targetEvidence.pinnedTarget.head_commit,
            }),
      target_diff: targetEvidence.targetDiff,
      target_diff_stat: targetEvidence.targetDiffStat,
    };
  }

  const emptyDiffResult: GitResult = { ok: true, stdout: '', truncated_by_buffer: false };
  const hiddenIndex = await inspectHiddenIndexFlags(evidenceRoot, options.gitReader, directContext);
  assertNoHiddenIndexFlags(hiddenIndex.flags);
  const readDiff = async (
    operation: 'staged_diff' | 'unstaged_diff',
    directArgs: readonly string[],
  ): Promise<GitResult> =>
    options.gitReader === undefined
      ? runGit(
          evidenceRoot,
          directArgs,
          {
            maxBufferBytes: MAX_DIFF_BUFFER_BYTES,
            allowPartialStdout: true,
          },
          directContext,
        )
      : await readGit(options.gitReader, operation, evidenceRoot);
  const readStat = async (
    operation: 'staged_diff_stat' | 'unstaged_diff_stat',
    directArgs: readonly string[],
  ): Promise<GitResult> =>
    options.gitReader === undefined
      ? runGit(evidenceRoot, directArgs, {}, directContext)
      : await readGit(options.gitReader, operation, evidenceRoot);
  const readChangedGitlinks = async (
    operation: 'staged_changed_gitlinks' | 'unstaged_changed_gitlinks',
    directArgs: readonly string[],
  ): Promise<GitResult> =>
    options.gitReader === undefined
      ? runGit(evidenceRoot, directArgs, {}, directContext)
      : await readGit(options.gitReader, operation, evidenceRoot);
  const stagedDiffArgs = [
    'diff',
    '--cached',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    '--',
  ] as const;
  const unstagedDiffArgs = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    '--',
  ] as const;
  const stagedChangedGitlinkArgs = [
    'diff',
    '--raw',
    '-z',
    '--no-abbrev',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
    '--cached',
    '--',
  ] as const;
  const unstagedChangedGitlinkArgs = [
    'diff',
    '--raw',
    '-z',
    '--no-abbrev',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
    '--',
  ] as const;
  const readStatus = async (): Promise<GitResult> =>
    options.gitReader === undefined
      ? runGit(evidenceRoot, ['status', '--short', '--ignore-submodules=none'], {}, directContext)
      : await readGit(options.gitReader, 'status', evidenceRoot);

  const status =
    target.mode === 'all'
      ? await readStatus()
      : { ok: true as const, stdout: '', truncated_by_buffer: false };
  if (!status.ok) {
    if (target.explicit) {
      throw new Error(`Review target unavailable: Git status could not be read. ${status.reason}`);
    }
    return { kind: 'unavailable', reason: status.reason };
  }
  const stagedResult =
    target.mode === 'unstaged' ? emptyDiffResult : await readDiff('staged_diff', stagedDiffArgs);
  const unstagedResult =
    target.mode === 'staged' ? emptyDiffResult : await readDiff('unstaged_diff', unstagedDiffArgs);
  if (target.explicit && !stagedResult.ok) {
    throw new Error(
      `Review target unavailable: staged changes could not be read. ${stagedResult.reason}`,
    );
  }
  if (target.explicit && !unstagedResult.ok) {
    throw new Error(
      `Review target unavailable: unstaged changes could not be read. ${unstagedResult.reason}`,
    );
  }
  const staged = gitDiffEvidence(stagedResult);
  const unstaged = gitDiffEvidence(unstagedResult);
  const stagedStat =
    target.mode === 'unstaged'
      ? { ok: true as const, stdout: '', truncated_by_buffer: false }
      : await readStat('staged_diff_stat', [
          'diff',
          '--stat',
          '--cached',
          '--no-ext-diff',
          '--no-textconv',
          '--submodule=short',
          '--ignore-submodules=none',
          '--',
        ]);
  const unstagedStat =
    target.mode === 'staged'
      ? { ok: true as const, stdout: '', truncated_by_buffer: false }
      : await readStat('unstaged_diff_stat', [
          'diff',
          '--stat',
          '--no-ext-diff',
          '--no-textconv',
          '--submodule=short',
          '--ignore-submodules=none',
          '--',
        ]);
  if (target.explicit && !stagedStat.ok) {
    throw new Error(
      `Review target unavailable: the staged change summary could not be read. ${stagedStat.reason}`,
    );
  }
  if (target.explicit && !unstagedStat.ok) {
    throw new Error(
      `Review target unavailable: the unstaged change summary could not be read. ${unstagedStat.reason}`,
    );
  }
  const stagedChangedGitlinks =
    target.mode === 'unstaged'
      ? emptyDiffResult
      : await readChangedGitlinks('staged_changed_gitlinks', stagedChangedGitlinkArgs);
  const unstagedChangedGitlinks =
    target.mode === 'staged'
      ? emptyDiffResult
      : await readChangedGitlinks('unstaged_changed_gitlinks', unstagedChangedGitlinkArgs);
  if (!stagedChangedGitlinks.ok) {
    throw new Error(
      `Review target unavailable: staged submodule gitlinks could not be inspected. ${stagedChangedGitlinks.reason}`,
    );
  }
  if (!unstagedChangedGitlinks.ok) {
    throw new Error(
      `Review target unavailable: unstaged submodule gitlinks could not be inspected. ${unstagedChangedGitlinks.reason}`,
    );
  }
  const submodulePaths = Object.freeze(
    [
      ...new Set([
        ...changedGitlinkPathsFromRaw(evidenceRoot, stagedChangedGitlinks.stdout),
        ...changedGitlinkPathsFromRaw(evidenceRoot, unstagedChangedGitlinks.stdout),
      ]),
    ].sort(),
  );

  const untrackedContentPolicy: ReviewUntrackedContentPolicy =
    options.includeUntrackedFileContent === true ? 'include-content' : 'metadata-only';
  const untracked =
    target.mode === 'all'
      ? await collectUntrackedFiles(
          evidenceRoot,
          untrackedContentPolicy,
          options.gitReader,
          directContext,
        )
      : { count: 0, truncated: false, files: [] };
  const confirmedStatus =
    target.mode === 'all'
      ? await readStatus()
      : { ok: true as const, stdout: '', truncated_by_buffer: false };
  const confirmedStagedResult =
    target.mode === 'unstaged' ? emptyDiffResult : await readDiff('staged_diff', stagedDiffArgs);
  const confirmedUnstagedResult =
    target.mode === 'staged' ? emptyDiffResult : await readDiff('unstaged_diff', unstagedDiffArgs);
  const confirmedStagedStat =
    target.mode === 'unstaged'
      ? emptyDiffResult
      : await readStat('staged_diff_stat', [
          'diff',
          '--stat',
          '--cached',
          '--no-ext-diff',
          '--no-textconv',
          '--submodule=short',
          '--ignore-submodules=none',
          '--',
        ]);
  const confirmedUnstagedStat =
    target.mode === 'staged'
      ? emptyDiffResult
      : await readStat('unstaged_diff_stat', [
          'diff',
          '--stat',
          '--no-ext-diff',
          '--no-textconv',
          '--submodule=short',
          '--ignore-submodules=none',
          '--',
        ]);
  const confirmedStagedChangedGitlinks =
    target.mode === 'unstaged'
      ? emptyDiffResult
      : await readChangedGitlinks('staged_changed_gitlinks', stagedChangedGitlinkArgs);
  const confirmedUnstagedChangedGitlinks =
    target.mode === 'staged'
      ? emptyDiffResult
      : await readChangedGitlinks('unstaged_changed_gitlinks', unstagedChangedGitlinkArgs);
  const confirmedUntracked =
    target.mode === 'all'
      ? await collectUntrackedFiles(
          evidenceRoot,
          untrackedContentPolicy,
          options.gitReader,
          directContext,
        )
      : { count: 0, truncated: false, files: [] };
  const confirmedHiddenIndex = await inspectHiddenIndexFlags(
    evidenceRoot,
    options.gitReader,
    directContext,
  );
  assertNoHiddenIndexFlags(confirmedHiddenIndex.flags);
  if (
    !sameGitResult(hiddenIndex.result, confirmedHiddenIndex.result) ||
    !sameGitResult(status, confirmedStatus) ||
    !sameGitResult(stagedResult, confirmedStagedResult) ||
    !sameGitResult(unstagedResult, confirmedUnstagedResult) ||
    !sameGitResult(stagedStat, confirmedStagedStat) ||
    !sameGitResult(unstagedStat, confirmedUnstagedStat) ||
    !sameGitResult(stagedChangedGitlinks, confirmedStagedChangedGitlinks) ||
    !sameGitResult(unstagedChangedGitlinks, confirmedUnstagedChangedGitlinks) ||
    !sameUntrackedEvidence(untracked, confirmedUntracked)
  ) {
    throw new Error(
      'Review target unavailable: the working tree changed while evidence was collected. Retry after the working tree settles.',
    );
  }

  const selectedTrackedContentAvailable = staged.text.length > 0 || unstaged.text.length > 0;
  const selectedUntrackedContentAvailable = untracked.files.some(
    (file) => (file.content?.text.length ?? 0) > 0,
  );
  const selectedContentAvailable =
    selectedTrackedContentAvailable || selectedUntrackedContentAvailable;
  if (
    target.mode === 'all' &&
    !selectedTrackedContentAvailable &&
    untracked.count > 0 &&
    untrackedContentPolicy === 'metadata-only'
  ) {
    throw new Error(
      'Review selected only untracked files, but their contents were not authorized for relay. After confirming those files are safe to share, retry with --include-untracked-content (or set include_untracked_content: true through MCP with explicit consent).',
    );
  }
  if (
    target.mode === 'all' &&
    !selectedContentAvailable &&
    untracked.files.some((file) => file.skipped_reason !== undefined)
  ) {
    const reasons = [
      ...new Set(
        untracked.files
          .map((file) => file.skipped_reason)
          .filter((reason): reason is string => reason !== undefined),
      ),
    ];
    throw new Error(
      `Review target has no usable content to inspect because selected untracked files could not be read safely: ${reasons.join('; ')}.`,
    );
  }
  if (target.explicit && !selectedContentAvailable) {
    throw new Error(
      `Review target has no changes to inspect: ${target.mode === 'all' ? 'working tree changes' : `${target.mode} changes`} are empty.`,
    );
  }

  const statSections = [
    ...(stagedStat.ok && stagedStat.stdout.length > 0 ? [`Staged:\n${stagedStat.stdout}`] : []),
    ...(unstagedStat.ok && unstagedStat.stdout.length > 0
      ? [`Unstaged:\n${unstagedStat.stdout}`]
      : []),
  ];
  const statFailures = [
    ...(!stagedStat.ok ? [stagedStat.reason] : []),
    ...(!unstagedStat.ok ? [unstagedStat.reason] : []),
  ];

  return {
    kind: 'git-working-tree',
    project_root: evidenceRoot,
    status_short: printableStatus(status.stdout),
    staged_diff: staged,
    unstaged_diff: unstaged,
    diff_stat: [...statSections, ...statFailures].join('\n'),
    target_kind: 'working_tree',
    target_mode: target.mode,
    untracked_file_count: untracked.count,
    untracked_files_truncated: untracked.truncated,
    untracked_content_policy: untrackedContentPolicy,
    untracked_files: untracked.files,
    ...(submodulePaths.length === 0 ? {} : { submodule_paths: [...submodulePaths] }),
  };
}

export async function validateReviewTargetAvailability(input: {
  readonly goal: string;
  readonly projectRoot: string | undefined;
  readonly includeUntrackedFileContent?: boolean;
  readonly gitReader?: RuntimeGitReader;
}): Promise<void> {
  const parsedTarget = parseReviewTarget(input.goal);
  if (!parsedTarget.ok) throw new Error(parsedTarget.reason);
  await collectReviewEvidence(input.projectRoot, {
    target: parsedTarget.target,
    ...(input.includeUntrackedFileContent === true ? { includeUntrackedFileContent: true } : {}),
    ...(input.gitReader === undefined ? {} : { gitReader: input.gitReader }),
  });
}

export const reviewIntakeComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'review.intake@v1',
  async build(context: ComposeBuildContext): Promise<unknown> {
    const parsedTarget = parseReviewTarget(context.goal);
    if (!parsedTarget.ok) throw new Error(parsedTarget.reason);
    const target = parsedTarget.target;
    const evidence = await collectReviewEvidence(context.projectRoot, {
      ...(context.evidencePolicy?.includeUntrackedFileContent === true
        ? { includeUntrackedFileContent: true }
        : {}),
      target,
      ...(context.gitReader === undefined ? {} : { gitReader: context.gitReader }),
    });
    return projectReviewIntake({
      scope: context.goal,
      evidence,
      maxUntrackedFiles: MAX_UNTRACKED_FILES,
    });
  },
};
