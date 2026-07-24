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
  ReviewResolvedTarget,
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

type ReviewTarget = ReviewResolvedTarget;

type ReviewTargetParseResult =
  | { readonly ok: true; readonly target: ReviewTarget; readonly assumed?: boolean }
  | { readonly ok: false; readonly reason: string };

type DirectPinnedTarget =
  | Extract<RuntimeGitPinnedTarget, { readonly kind: 'range' }>
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

// --- Review target selection ---------------------------------------------
//
// The grammar recognises explicit target forms only: staged/unstaged, a
// commit, a range, or material supplied inline. Everything else falls back
// to the current working tree and says so. Refusing ordinary phrasings like
// "code review please" costs more than reviewing the obvious thing and
// naming the assumption out loud.
//
// Malformed *explicit* forms still fail closed, but they fail when the
// target is resolved against the repository, not when it is phrased.

const REVIEW_LEAD = String.raw`(?:review|inspect|audit|check|analyze)`;

const PULL_REQUEST_UNSUPPORTED_REASON =
  'Review cannot fetch a pull request. Check out the PR branch locally, then review the working tree or an explicit range such as main...HEAD.';

const PATH_SUBSET_UNSUPPORTED_REASON =
  'Review cannot pin a subset of paths as its evidence. Review the whole working tree, a commit, or a range instead, and name the paths you care about in the goal so the reviewer concentrates there.';

function normalizeReviewQuotes(scope: string): string {
  return scope.replace(/[’‘]/gu, "'").replace(/[“”]/gu, '"');
}

/**
 * Blank out quoted, fenced and blockquoted spans so material the operator
 * pasted for review cannot be mistaken for a target selection. Masking keeps
 * the original offsets so match positions stay meaningful.
 */
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

function looksLikeReviewSubsetPath(value: string): boolean {
  const cleaned = value
    .trim()
    .replace(/^[<("'`]+/u, '')
    .replace(/[>"'`),.;:!?]+$/u, '');
  if (cleaned.length === 0 || /^https?:\/\//iu.test(cleaned)) return false;
  return (
    looksLikeReviewPath(cleaned) ||
    /^\.[A-Za-z0-9_-]+$/u.test(cleaned) ||
    /[*?[\]]/u.test(cleaned) ||
    /^(?:\.\.\/)+[^\s]+$/u.test(cleaned) ||
    /^(?:apps?|assets?|build|changelogs?|config(?:uration)?|dist|docs?|examples?|fixtures?|generated|lib|lockfiles?|migrations?|node_modules|packages?|scripts?|snapshots?|sources?|src|tests?|vendor)\/?$/iu.test(
      cleaned,
    )
  );
}

// --- inline supplied material (the `goal` target kind) --------------------

type SuppliedReviewMaterialClassification =
  | { readonly kind: 'supplied' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'none' };

function topLevelReviewMaterialTail(scope: string): string | undefined {
  const firstLead = new RegExp(String.raw`\b${REVIEW_LEAD}\b`, 'iu').exec(scope);
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

// --- explicit target forms ------------------------------------------------

function namesPullRequest(scope: string): boolean {
  if (/\b(?:prs?|pull\s+requests?)\b/iu.test(scope)) return true;
  if (/https?:\/\/\S*\/pull\/\d{1,7}\b/iu.test(scope)) return true;
  return new RegExp(
    String.raw`\b${REVIEW_LEAD}\s+(?:(?:the|this|that|my|our)\s+)?#\d{1,7}\b`,
    'iu',
  ).test(scope);
}

/**
 * Words that show up on both sides of a prose ellipsis. A range is an
 * explicit form, so a false positive here would fail a run closed on
 * ordinary phrasing. Refuse to read these as refs.
 */
const RANGE_FILLER_WORDS = new Set([
  'and',
  'anything',
  'especially',
  'everything',
  'focus',
  'including',
  'it',
  'maybe',
  'now',
  'ok',
  'okay',
  'or',
  'perhaps',
  'please',
  'so',
  'something',
  'that',
  'then',
  'these',
  'this',
  'those',
  'wait',
  'well',
  'what',
]);

function rangeTargetFromToken(token: string): ReviewTarget | undefined {
  const withoutSentencePunctuation = token.replace(/[,;:!?]+$/u, '');
  const cleaned =
    withoutSentencePunctuation.endsWith('.') && !withoutSentencePunctuation.endsWith('..')
      ? withoutSentencePunctuation.slice(0, -1)
      : withoutSentencePunctuation;
  const separator = cleaned.includes('...') ? '...' : '..';
  const separatorIndex = cleaned.indexOf(separator);
  if (separatorIndex < 0) return undefined;
  const base = cleaned.slice(0, separatorIndex);
  const head = cleaned.slice(separatorIndex + separator.length);
  if (base.length === 0 || head.length === 0) return undefined;
  if (!isSafeReviewRef(base) || !isSafeReviewRef(head)) return undefined;
  if (RANGE_FILLER_WORDS.has(base.toLowerCase()) || RANGE_FILLER_WORDS.has(head.toLowerCase())) {
    return undefined;
  }
  return { kind: 'range', base, head, dots: separator };
}

function parseRangeForm(scope: string): ReviewTarget | undefined {
  for (const match of scope.matchAll(
    /(?<=^|[\s(["'])(?<token>[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,240}\.{2,3}[A-Za-z0-9][A-Za-z0-9._/@+~^-]{0,240})/gu,
  )) {
    const token = match.groups?.token;
    if (token === undefined) continue;
    const target = rangeTargetFromToken(token);
    if (target !== undefined) return target;
  }
  return undefined;
}

const LATEST_COMMIT_PATTERN =
  /\b(?:(?:the|my|our)\s+)?(?:latest|last|most\s+recent)\s+commit\b|\bwhat\s+i\s+just\s+committed\b|\b(?:the\s+)?commit\s+i\s+just\s+made\b|\bwhat\s+changed\s+in\s+(?:the\s+)?last\s+commit\b/iu;

function parseCommitForm(scope: string): ReviewTargetParseResult | undefined {
  const keyword = /\b(?:commit|revision|rev)\s+(?:at\s+)?(?<ref>[^\s,;:!?)"'`]{1,240})/iu.exec(
    scope,
  )?.groups?.ref;
  if (keyword !== undefined) {
    const ref = keyword.replace(/[.,;:!?)"'`]+$/u, '');
    if (ref.length > 0 && !ref.includes('..')) {
      if (!isSafeReviewRef(ref)) {
        return {
          ok: false,
          reason: `Review target names an unusable commit ref: ${ref}. Use a commit id, a tag, a branch name, or HEAD.`,
        };
      }
      return { ok: true, target: { kind: 'commit', ref } };
    }
  }
  if (LATEST_COMMIT_PATTERN.test(scope)) {
    return { ok: true, target: { kind: 'commit', ref: HEAD_COMMIT_REF } };
  }
  const head = /(?<=^|[\s(["'])(?<ref>HEAD(?:[~^]\d*)*)(?=$|[\s,;:!?)\]"'`])/u.exec(scope)?.groups
    ?.ref;
  if (head !== undefined) return { ok: true, target: { kind: 'commit', ref: head } };
  return undefined;
}

function parseWorkingTreeForm(scope: string): ReviewTarget | undefined {
  const staged = /\bstaged\b/iu.test(scope);
  const unstaged = /\b(?:unstaged|not[- ]staged)\b/iu.test(scope);
  if (staged && unstaged) {
    return { kind: 'working_tree', mode: 'all', explicit: true };
  }
  if (unstaged) return { kind: 'working_tree', mode: 'unstaged', explicit: true };
  if (staged) return { kind: 'working_tree', mode: 'staged', explicit: true };
  if (
    /\b(?:working[- ]tree|worktree|uncommitted\s+(?:changes?|work|files?)|current\s+diff)\b/iu.test(
      scope,
    )
  ) {
    return { kind: 'working_tree', mode: 'all', explicit: true };
  }
  return undefined;
}

function namesPathSubset(scope: string): boolean {
  const pathOnly =
    /^\s*(?:review|inspect|audit|check|analyze)\s+(?:(?:only|the|this|my|our|current)\s+)*(?:(?:file|code|plan|report)\s*(?:(?:in|at|from)\s+|:\s*)?)?(?<path>\S+)(?<suffix>[\s\S]*)$/iu.exec(
      scope,
    );
  const path = pathOnly?.groups?.path;
  if (path !== undefined && looksLikeReviewPath(path)) {
    const suffix = (pathOnly?.groups?.suffix ?? '').trim();
    if (
      suffix.length === 0 ||
      /^[.!?]$/u.test(suffix) ||
      /^(?:,?\s*(?:for|with|especially)\b|,?\s+and\s+(?:focus|check|inspect|look|pay|prioritize|verify)\b)/iu.test(
        suffix,
      )
    ) {
      return true;
    }
  }
  const scoped =
    /\b(?:only|just|limited\s+to|restricted\s+to|scoped\s+to|confined\s+to|except|excluding|ignoring|omitting|skipping|other\s+than|(?:changes?|diffs?|files?)\s+(?:in|under|below|within))\s+(?:the\s+)?(?<path>[^\s,;.!?]+)/iu.exec(
      scope,
    )?.groups?.path;
  return scoped !== undefined && looksLikeReviewSubsetPath(scoped);
}

export function parseReviewTarget(scope: string): ReviewTargetParseResult {
  const normalizedScope = normalizeReviewQuotes(scope);
  const suppliedMaterial = classifySuppliedReviewMaterial(normalizedScope);
  if (suppliedMaterial.kind === 'supplied') {
    return { ok: true, target: { kind: 'goal' } };
  }
  if (suppliedMaterial.kind === 'malformed') {
    return { ok: false, reason: suppliedMaterial.reason };
  }

  // Everything below reads target selection from prose, so pasted literals
  // must not vote.
  const authorityScope = maskReviewLiteralData(normalizedScope);

  if (namesPullRequest(authorityScope)) {
    return { ok: false, reason: PULL_REQUEST_UNSUPPORTED_REASON };
  }

  const range = parseRangeForm(authorityScope);
  if (range !== undefined) return { ok: true, target: range };

  const commit = parseCommitForm(authorityScope);
  if (commit !== undefined) return commit;

  const workingTree = parseWorkingTreeForm(authorityScope);
  if (workingTree !== undefined) return { ok: true, target: workingTree };

  if (namesPathSubset(authorityScope)) {
    return { ok: false, reason: PATH_SUBSET_UNSUPPORTED_REASON };
  }

  return {
    ok: true,
    target: { kind: 'working_tree', mode: 'all', explicit: false },
    assumed: true,
  };
}

export function reviewScopeRequiresGitEvidence(scope: string): boolean {
  const parsed = parseReviewTarget(scope);
  if (!parsed.ok) return true;
  return parsed.target.kind !== 'goal';
}

function reviewTargetLabel(
  target: Exclude<ReviewTarget, { readonly kind: 'goal' | 'working_tree' }>,
): string {
  if (target.kind === 'commit') return `commit ${target.ref}`;
  return `range ${target.base}${target.dots}${target.head}`;
}

function runtimeTarget(target: ReviewTarget): RuntimeGitTarget | undefined {
  if (target.kind === 'goal' || target.kind === 'working_tree') return undefined;
  if (target.kind === 'commit') return { kind: 'commit', ref: target.ref };
  return { kind: 'range', base: target.base, head: target.head, dots: target.dots };
}

function resolveTargetArgs(target: RuntimeGitTarget): readonly string[] {
  if (target.kind === 'commit') {
    return ['rev-parse', '--verify', '--end-of-options', `${target.ref}^{commit}`];
  }
  return [
    'rev-parse',
    '--revs-only',
    '--end-of-options',
    `${target.base}^{commit}..${target.head}^{commit}`,
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

function pinnedTargetMatches(target: RuntimeGitTarget, pinned: RuntimeGitPinnedTarget): boolean {
  if (target.kind !== pinned.kind) return false;
  if (target.kind === 'range' && pinned.kind === 'range') return target.dots === pinned.dots;
  return true;
}

async function resolveTarget(
  projectRoot: string,
  target: RuntimeGitTarget,
  reader?: RuntimeGitReader,
  directContext?: DirectGitContext,
): Promise<RuntimeGitPinnedTarget> {
  if (reader === undefined) {
    const result = runGit(projectRoot, resolveTargetArgs(target), {}, directContext);
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

function targetUnavailableMessage(
  target: Exclude<ReviewTarget, { readonly kind: 'goal' | 'working_tree' }>,
): string {
  return `Review target unavailable: ${reviewTargetLabel(target)} could not be read from this repository.`;
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
}> {
  const requestTarget = runtimeTarget(target);
  if (requestTarget === undefined) {
    throw new Error('Review target unavailable: the requested Git target could not be prepared.');
  }
  const pinnedTarget = await resolveTarget(projectRoot, requestTarget, reader, directContext);
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
  return { targetDiff, targetDiffStat: diffStat.stdout, pinnedTarget };
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
      ...(targetEvidence.pinnedTarget.kind === 'commit'
        ? { target_commit: targetEvidence.pinnedTarget.commit }
        : {
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
      target,
      evidence,
      maxUntrackedFiles: MAX_UNTRACKED_FILES,
      ...(parsedTarget.assumed === true ? { assumedTarget: true } : {}),
    });
  },
};
