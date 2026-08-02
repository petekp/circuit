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
  runtimeGitArgsWithPathScope,
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
  ReviewPathScope,
  ReviewResolvedTarget,
  ReviewSnapshotFileEvidence,
  ReviewUntrackedContentPolicy,
  ReviewUntrackedFileEvidence,
} from '../reports.js';
import { rankDiffText } from './diff-ranking.js';
import {
  CODEBASE_UNIT_BUDGET,
  projectReviewIntake,
  reviewPathScopeLabel,
  reviewPathScopePaths,
} from './intake-projection.js';
import { declaredGeneratedMatcher, rankSnapshotPaths } from './snapshot-ranking.js';

const MAX_DIFF_CHARS = 120_000;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_FILE_CHARS = 20_000;
// Snapshot bounds. A snapshot no longer competes for one relay's budget: it is
// split into units and reviewed a unit at a time, so the binding limit is how
// many reviewers the audit step will run (24) times what one reviewer holds
// (12 files, 60k characters — CODEBASE_UNIT_BUDGET in intake-projection.ts).
// Whatever these leave out is reported as coverage the verdict does not stand
// on.
//
// The per-file cap is one unit: the largest file a reviewer can be handed is the
// largest file that fits in a reviewer, which is what the unit budget already
// says. Measured against a real tree rather than padded fixtures, the old 40k
// cap cut 39 of this repository's 1,138 hand-written source and test files, and
// the cut fell hardest on the files a review most wants read whole — the graph
// runner, the CLI entrypoint, the composer, this file. Twenty of those thirty
// nine fit inside a unit and were being truncated for no structural reason.
// The nineteen larger than a unit are still cut, and still say so: a file bigger
// than one reviewer needs splitting across units, which does not exist yet.
const MAX_SNAPSHOT_FILES = 288;
const MAX_SNAPSHOT_FILE_CHARS = CODEBASE_UNIT_BUDGET.maxCharsPerUnit;
const MAX_SNAPSHOT_TOTAL_CHARS = 1_440_000;
const MAX_GIT_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_DIFF_BUFFER_BYTES = Math.max(MAX_DIFF_CHARS * 4, 1024 * 1024);
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

/**
 * The target resolved and read cleanly and simply contains no changes. Kept
 * distinct from every other collection failure so the snapshot fallback fires
 * on an empty target and never on a Git error, which it would otherwise hide.
 */
class ReviewTargetEmptyError extends Error {}

type ReviewTargetParseResult =
  | {
      readonly ok: true;
      readonly target: ReviewTarget;
      readonly assumed?: boolean;
      // Narrowings the operator asked for that Review could not turn into a
      // path scope. The run still happens over the whole target; the report
      // names each one so a wider review is never mistaken for the requested
      // one.
      readonly scopeNotApplied?: readonly string[];
      // The goal named where to look but not which changes. If nothing has
      // changed at those paths, reviewing the code as it stands answers the
      // question the operator actually asked, so evidence collection switches
      // to a snapshot of these paths instead of reporting an empty target.
      readonly snapshotFallback?: ReviewPathScope;
      // The operator asked for the code as it stands but named nowhere to look,
      // so there is nothing to bound the read and this stays a change review.
      // Reported rather than dropped: the answer is about a diff, and the
      // question was not.
      readonly snapshotNotApplied?: boolean;
    }
  | { readonly ok: false; readonly reason: string };

type DirectPinnedTarget =
  | Extract<RuntimeGitPinnedTarget, { readonly kind: 'range' }>
  | {
      readonly kind: 'commit';
      readonly commit: string;
      readonly parent_commit: string | null;
    };

// `sourceByteLength` is for callers that only ever read a bounded sample of the
// source, so `text` is not the whole thing and the characters past `maxChars`
// cannot be counted from it. Without it, a file read that stops one character
// past the cap would tell the reviewer one character was dropped, whatever the
// file's real size. State the size that is actually known instead.
//
// `sampleIsPartial` covers the case where the sample never even reaches the cap.
// The read is bounded by bytes and the cap counts characters, so a file of
// wide characters can be cut a long way short and still hand back text under
// `maxChars`. Nothing about that text says it was cut, so the caller has to.
function truncateText(
  text: string,
  maxChars: number,
  sourceByteLength?: number,
  sampleIsPartial = false,
): ReviewEvidenceText {
  if (!runtimeGitTextIsValidUtf8(text)) {
    throw new Error('Review evidence text is not valid UTF-8.');
  }
  if (text.length <= maxChars) {
    if (!sampleIsPartial || sourceByteLength === undefined) return { text, truncated: false };
    return {
      text: `${text}\n[truncated: first ${text.length} characters of a ${sourceByteLength}-byte file]`,
      truncated: true,
    };
  }
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
  const marker =
    sourceByteLength === undefined
      ? `[truncated ${text.length - end} characters]`
      : `[truncated: first ${end} characters of a ${sourceByteLength}-byte file]`;
  return {
    text: `${prefix}\n${marker}`,
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
  paths?: ReviewPathScope,
): Promise<GitResult> {
  const scope = paths === undefined ? {} : { paths };
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
          ...scope,
        }
      : {
          operation: operation as Exclude<
            RuntimeGitOperation,
            'resolve_target' | 'target_diff' | 'target_diff_stat'
          >,
          projectRoot,
          ...scope,
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
// The grammar recognises explicit target forms: staged/unstaged, a commit, a
// range, or material supplied inline. Everything else falls back to the
// current working tree and says so. Refusing ordinary phrasings like "code
// review please" costs more than reviewing the obvious thing and naming the
// assumption out loud.
//
// A goal can also narrow the target to a set of paths ("only in src/",
// "except tests/", or a bare "review src/auth"). That narrowing rides along
// with whichever target the grammar picks and becomes a Git pathspec. A
// narrowing Review cannot express as a pathspec does not stop the run: the
// review covers the whole target and the report names what it could not
// apply.
//
// Malformed *explicit* forms still fail closed, but they fail when the
// target is resolved against the repository, not when it is phrased.

const REVIEW_LEAD = String.raw`(?:review|inspect|audit|check|analyze)`;

const PULL_REQUEST_UNSUPPORTED_REASON =
  'Review cannot fetch a pull request. Check out the PR branch locally, then review the working tree or an explicit range such as main...HEAD.';

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
  // The operator drew a supplied-material boundary and left it empty.
  | { readonly kind: 'empty' }
  | { readonly kind: 'supplied' }
  // No boundary, or a boundary whose body is really a path. Both fall
  // through to the rest of the grammar.
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
  if (trimmed.length === 0) return { kind: 'empty' };
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
  if (material.length === 0) return { kind: 'empty' };
  if (looksLikeReviewSubsetPath(material)) return { kind: 'missing' };
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
  if (LATEST_COMMIT_PATTERN.test(scope)) {
    return { ok: true, target: { kind: 'commit', ref: HEAD_COMMIT_REF } };
  }
  const keyword = /\b(?:commit|revision|rev)\s+(?:at\s+)?(?<ref>[^\s,;:!?)"'`]{1,240})/iu.exec(
    scope,
  )?.groups?.ref;
  if (keyword !== undefined) {
    const ref = keyword.replace(/[.,;:!?)"'`]+$/u, '');
    if (ref.length > 0) {
      if (!isSafeReviewRef(ref)) {
        return {
          ok: false,
          reason: `Review target names an unusable commit ref: ${ref}. Use a commit id, a tag, a branch name, or HEAD.`,
        };
      }
      return { ok: true, target: { kind: 'commit', ref } };
    }
  }
  return undefined;
}

// A bare "HEAD" is a commit target, but only once the working-tree forms have
// had their say: "review current changes against HEAD" names the working tree.
function parseBareHeadForm(scope: string): ReviewTarget | undefined {
  const head = /(?<=^|[\s(["'])(?<ref>HEAD(?:[~^]\d*)*)(?=$|[\s,;:!?)\]"'`])/u.exec(scope)?.groups
    ?.ref;
  return head === undefined ? undefined : { kind: 'commit', ref: head };
}

function parseWorkingTreeForm(scope: string): ReviewTarget | undefined {
  // "unstaged" and "not staged" contain "staged"; neither selects the index.
  const staged = /(?<!\bnot[- ])(?<![\w-])staged\b/iu.test(scope);
  const unstaged = /\b(?:unstaged|not[- ]staged)\b/iu.test(scope);
  if (staged && unstaged) {
    return { kind: 'working_tree', mode: 'all', explicit: true };
  }
  if (unstaged) return { kind: 'working_tree', mode: 'unstaged', explicit: true };
  if (staged) return { kind: 'working_tree', mode: 'staged', explicit: true };
  if (
    /\b(?:working[- ]tree|worktree|uncommitted\s+(?:changes?|work|files?)|current\s+(?:diff|changes?|work))\b/iu.test(
      scope,
    )
  ) {
    return { kind: 'working_tree', mode: 'all', explicit: true };
  }
  return undefined;
}

// A narrowing clause ("only in src/", "except tests/") has to be read before
// the rest of the grammar. "review latest commit only in src/foo.ts" names a
// commit, and reviewing that whole commit would silently review more than the
// operator asked for.
//
// Restriction narrows to something; exclusion carves something out. They are
// kept apart because restricting to "staged" is a target Review supports,
// while excluding "untracked" is not.
const RESTRICTION_LEAD_IN = String.raw`(?:only|just|limited\s+to|restricted\s+to|scoped\s+to|confined\s+to|(?:changes?|diffs?|files?)\s+(?:in|under|below|within))`;

// Longest alternatives first: "but do not review x" must not be consumed by
// the bare "but" branch, which would read "do" as the excluded path.
const EXCLUSION_LEAD_IN = String.raw`(?:except(?:\s+for)?|excluding|ignoring|omitting|skipping|leaving\s+out|apart\s+from|aside\s+from|other\s+than|but\s+(?:do\s+not|don't|never)\s+(?:review|include|inspect|read|look\s+at)|but(?:\s+not)?)`;

const NARROWING_CLAUSE_TAIL = String.raw`\s+(?:(?:in|inside|under|within|below)\s+)?(?:the\s+)?(?<path>[^\s,;!?]+)`;

const RESTRICTION_CLAUSE_PATTERN = new RegExp(
  String.raw`\b(?:${RESTRICTION_LEAD_IN})${NARROWING_CLAUSE_TAIL}`,
  'giu',
);

const EXCLUSION_CLAUSE_PATTERN = new RegExp(
  String.raw`\b(?:${EXCLUSION_LEAD_IN})${NARROWING_CLAUSE_TAIL}`,
  'giu',
);

/**
 * The same restriction with the narrowing word after the path: "review src/auth
 * only". English puts it either side and means the same thing, but only the
 * leading order was read, so this phrasing reviewed the entire working tree and
 * said nothing about having ignored the word. A wrong review, not a missing note.
 *
 * The token still has to look like a path to be used, which is what keeps
 * "review this only" and "review my changes only" from inventing a scope, and
 * what keeps a bare commit hash out: "review commit abc1234 only" leaves
 * "abc1234", which is no more path-like than any other word.
 */
const POSTFIX_RESTRICTION_CLAUSE_PATTERN =
  /(?<path>[^\s,;!?]+)\s+(?:only|alone|and\s+nothing\s+else)\b/giu;

/**
 * Range syntax survives the path test, because a pathspec may contain dots.
 * "review main...HEAD only" would then scope the range to a directory named
 * `main...HEAD` and review nothing at all, so refs are rejected up front.
 */
const RANGE_LIKE_TOKEN_PATTERN = /\.\./u;

/**
 * A narrowing that names a kind of code rather than a path: "only the
 * typescript files", "just the auth module". Review cannot turn these into a
 * pathspec, and it used to review the whole target and report nothing, so the
 * operator's words disappeared without trace.
 *
 * The category noun is what makes this safe to report. The restriction lead-ins
 * are ordinary English — "just review it", "but only if it looks risky" — and
 * quoting whichever word followed one of those would fill reports with warnings
 * about verbs and erode the ones worth reading. Requiring "<something> files",
 * "<something> module" and friends is what separates a stated subset from prose.
 */
const UNRESOLVED_SUBSET_PATTERN =
  /\b(?:only|just|limited\s+to|restricted\s+to|scoped\s+to|confined\s+to)\s+(?:the\s+)?(?<subset>[A-Za-z0-9._-]+(?:\s+[A-Za-z0-9._-]+)?\s+(?:files?|modules?|directory|directories|folders?|packages?|dirs?|tests?|code|components?|services?))\b/iu;

// A narrowing by class of change rather than by path: "except untracked files",
// "except the deleted ones". These are not pathspecs, so they are resolved
// against the target itself. Some are already true of the target Review picked,
// one narrows the working tree, and the rest it cannot express.
const EXCLUDED_CHANGE_CLASS_PATTERN = new RegExp(
  String.raw`\b${EXCLUSION_LEAD_IN}\s+(?:any\s+|all\s+|the\s+)?(?<changeClass>untracked|tracked|staged|unstaged|committed|new|deleted|renamed)\b`,
  'iu',
);

/**
 * Apply a change-class exclusion to the target it narrows, or return undefined
 * when Review cannot express it. Returning the target unchanged means the
 * exclusion was already true: a commit diff has no untracked files in it, so
 * "review the last commit except untracked" asks for nothing extra and should
 * not warn about a narrowing that was never needed.
 */
function targetWithoutChangeClass(
  target: ReviewTarget,
  changeClass: string,
): ReviewTarget | undefined {
  const name = changeClass.toLowerCase();
  if (target.kind === 'commit' || target.kind === 'range') {
    // A commit diff is committed, tracked content and nothing else.
    return name === 'untracked' || name === 'staged' || name === 'unstaged' ? target : undefined;
  }
  if (target.kind !== 'working_tree') return undefined;
  // The working tree never contains committed-only changes.
  if (name === 'committed') return target;
  if (name !== 'untracked') return undefined;
  // Only `all` reaches untracked files; the narrower modes already exclude them.
  return target.mode === 'all' ? { ...target, mode: 'tracked' } : target;
}

/**
 * Phrasings that ask about code as it stands rather than about a change to it.
 * Kept narrow on purpose: each one is unambiguous, because reading these into
 * a goal that meant "review my edits" would review the wrong thing. A goal
 * without one of these still reaches a snapshot when its diff turns out empty.
 */
const SNAPSHOT_REQUEST_PATTERN =
  /\b(?:as (?:it|they) stands?|as-is|current state|existing code|whole file|entire file|latent (?:issues?|bugs?|problems?|defects?))\b/iu;

/**
 * Phrasings that name the repository itself as the subject: "audit this
 * codebase", "review the whole repo", "review everything".
 *
 * These used to be invisible here, which meant they fell through to the
 * unnamed-goal default and the operator was told the goal named no target. It
 * named one. Circuit just cannot cover it in a single pass, and those are
 * different sentences to have to read.
 *
 * Deliberately does not match a bare "my code" or "my changes": those describe
 * the operator's edits, which is what the change review already does, and
 * saying a whole-codebase pass was unavailable would answer a question nobody
 * asked. "all the code" does match, because there the scope word is the point.
 */
const WHOLE_REPOSITORY_PATTERN =
  /\b(?:(?:whole|entire|full|complete|across the)\s+(?:repo|repository|codebase|code\s?base|project)|(?:this|the)\s+(?:repo|repository|codebase|code\s?base)\b|everything|all\s+(?:of\s+)?the\s+code\b)/iu;

const MAX_SCOPE_PATHS = 32;
const MAX_SCOPE_PATH_LENGTH = 200;
// Repository-relative path or glob. Excludes ':' so a token lifted from prose
// can never introduce pathspec magic, and excludes whitespace and backslashes
// so one token is always one pathspec.
const SAFE_SCOPE_PATH_PATTERN = /^[A-Za-z0-9._@+*?[\]/-]+$/u;

/**
 * Turn a path token lifted from prose into something Git can be handed as a
 * pathspec. Anything that could escape the repository or carry pathspec magic
 * comes back undefined, and the caller reports it as a narrowing it could not
 * apply rather than silently reviewing something else.
 */
function scopePathFromToken(value: string): string | undefined {
  const cleaned = value
    .trim()
    .replace(/^[<("'`]+/u, '')
    .replace(/[>"'`),.;:!?]+$/u, '');
  if (
    cleaned.length === 0 ||
    cleaned.length > MAX_SCOPE_PATH_LENGTH ||
    !SAFE_SCOPE_PATH_PATTERN.test(cleaned) ||
    cleaned.startsWith('/') ||
    cleaned.startsWith('-') ||
    cleaned.split('/').includes('..')
  ) {
    return undefined;
  }
  return cleaned;
}

/**
 * The next word, when the word right after a narrowing lead-in was not a path.
 *
 * English puts a word between the two more often than the lead-in list can
 * chase: "but skip tests/", "but ignore node_modules", "except maybe docs/".
 * The clause tail consumed that word as the path, it failed the path test, and
 * the real path one word later was never reached, so the narrowing vanished
 * without a trace in the report.
 *
 * This is a shape, not another phrasing. The vocabulary lists stay closed; what
 * widens is how far past a lead-in the path may sit, by exactly one word. The
 * path test is what keeps it honest: it wants a slash, an extension, a glob, or
 * a directory name Review already knows, so ordinary prose after an ordinary
 * "but" still yields nothing.
 */
function nextSubsetPathToken(trailing: string): string | undefined {
  return /^\s+(?<path>[^\s,;!?]+)/u.exec(trailing)?.groups?.path;
}

type ReviewScopeRequest = {
  readonly paths?: ReviewPathScope;
  // Resolved once the target is known, because whether Review can honour it
  // depends on what the target already covers.
  readonly excludedChangeClass?: { readonly phrase: string; readonly name: string };
  readonly notApplied: readonly string[];
};

const NO_REVIEW_SCOPE: ReviewScopeRequest = Object.freeze({ notApplied: Object.freeze([]) });

/**
 * Read the narrowing clauses out of a goal. "only in src/" restricts, "except
 * tests/" carves out, and both can appear in one goal. Every clause gets a
 * look: the first is often prose ("only in the parts that ..."), and a later
 * one can still name a real path.
 */
function extractReviewScope(scope: string): ReviewScopeRequest {
  const include: string[] = [];
  const exclude: string[] = [];
  const notApplied: string[] = [];
  const changeClassMatch = EXCLUDED_CHANGE_CLASS_PATTERN.exec(scope);
  const changeClassName = changeClassMatch?.groups?.changeClass;
  const excludedChangeClass =
    changeClassMatch === null || changeClassMatch === undefined || changeClassName === undefined
      ? undefined
      : { phrase: changeClassMatch[0].trim(), name: changeClassName };
  const collect = (
    pattern: RegExp,
    into: string[],
    options: { readonly rejectRefs?: boolean; readonly lookAhead?: boolean } = {},
  ): void => {
    for (const match of scope.matchAll(pattern)) {
      const matched = match.groups?.path;
      const token =
        matched !== undefined && !looksLikeReviewSubsetPath(matched) && options.lookAhead === true
          ? nextSubsetPathToken(scope.slice(match.index + match[0].length))
          : matched;
      if (token === undefined || !looksLikeReviewSubsetPath(token)) continue;
      if (options.rejectRefs === true && RANGE_LIKE_TOKEN_PATTERN.test(token)) continue;
      const path = scopePathFromToken(token);
      if (path === undefined) {
        notApplied.push(token.trim());
        continue;
      }
      if (!into.includes(path)) into.push(path);
    }
  };
  collect(RESTRICTION_CLAUSE_PATTERN, include, { lookAhead: true });
  collect(EXCLUSION_CLAUSE_PATTERN, exclude, { lookAhead: true });
  // Read after the leading forms so "review only src/auth" is already resolved
  // and this adds nothing; it exists for the goals the leading forms never saw.
  collect(POSTFIX_RESTRICTION_CLAUSE_PATTERN, include, { rejectRefs: true });
  // Only once every pattern above has had its say. "only the generated files"
  // reaches a real directory, and reporting that as unapplied would be the
  // opposite lie from the one this fixes.
  if (include.length === 0) {
    const subset = UNRESOLVED_SUBSET_PATTERN.exec(scope)?.groups?.subset;
    if (subset !== undefined) notApplied.push(subset.trim());
  }
  while (include.length + exclude.length > MAX_SCOPE_PATHS) {
    const dropped = exclude.length > include.length ? exclude.pop() : include.pop();
    if (dropped === undefined) break;
    notApplied.push(dropped);
  }
  const carve = excludedChangeClass === undefined ? {} : { excludedChangeClass };
  if (include.length === 0 && exclude.length === 0) {
    return notApplied.length === 0 && excludedChangeClass === undefined
      ? NO_REVIEW_SCOPE
      : { ...carve, notApplied };
  }
  return { paths: { include, exclude }, ...carve, notApplied };
}

// A bare path as the whole request: a verb, some optional throat-clearing, and
// somewhere to look. Written as parts because the vocabulary is the point, and
// a single expression this wide is unreadable.
const PATH_ONLY_REQUEST_PATTERN = new RegExp(
  [
    '^\\s*',
    // "review src/auth", "look at src/auth", "take a look at src/auth".
    '(?:review|inspect|audit|check|analyze|examine|(?:take\\s+a\\s+)?look\\s+at)\\s+',
    // "the", "my current", "the whole existing" — any run of these, or none.
    '(?:(?:only|the|this|my|our|current|existing|whole|entire|full)\\s+)*',
    // An optional noun for what is being pointed at, with the preposition that
    // usually follows it: "the code in src/auth", "the state of src/auth".
    '(?:(?:files?|code|plan|report|directory|dir|folder|module|package|contents?|state)\\s*',
    '(?:(?:in|at|from|of|under|within)\\s+|:\\s*)?)?',
    '(?<path>\\S+)(?<suffix>[\\s\\S]*)$',
  ].join(''),
  'iu',
);

// What may follow the path without changing what the request is about. A
// focusing clause ("for auth bugs") or a snapshot phrasing ("as it stands")
// still names the same path; anything else is a sentence Review has not
// understood, and guessing at it would review the wrong thing.
const PATH_ONLY_SUFFIX_PATTERN =
  /^(?:,?\s*(?:for|with|especially)\b|,?\s+and\s+(?:focus|check|inspect|look|pay|prioritize|verify)\b|,?\s*as[-\s](?:it|they)\s+stands?\b|,?\s*as[-\s]is\b)/iu;

// Read last: it competes with ordinary prose, so every explicit target form
// gets the first say.
function pathOnlyRequestPath(scope: string): string | undefined {
  const pathOnly = PATH_ONLY_REQUEST_PATTERN.exec(scope);
  const path = pathOnly?.groups?.path;
  if (path !== undefined && looksLikeReviewPath(path)) {
    const suffix = (pathOnly?.groups?.suffix ?? '').trim();
    if (suffix.length === 0 || /^[.!?]$/u.test(suffix) || PATH_ONLY_SUFFIX_PATTERN.test(suffix)) {
      return path;
    }
  }
  return undefined;
}

function withPathScope(target: ReviewTarget, paths: ReviewPathScope): ReviewTarget {
  switch (target.kind) {
    case 'working_tree':
      return { ...target, paths };
    case 'commit':
      return { ...target, paths };
    case 'range':
      return { ...target, paths };
    default:
      // Supplied material has no repository paths to scope.
      return target;
  }
}

function scopedParseResult(
  target: ReviewTarget,
  requested: ReviewScopeRequest,
  options: {
    readonly assumed?: boolean;
    readonly snapshotFallback?: ReviewPathScope;
    readonly snapshotNotApplied?: boolean;
  } = {},
): ReviewTargetParseResult {
  const scoped = requested.paths === undefined ? target : withPathScope(target, requested.paths);
  const carve = requested.excludedChangeClass;
  const narrowed = carve === undefined ? scoped : targetWithoutChangeClass(scoped, carve.name);
  const notApplied = [
    ...requested.notApplied,
    ...(carve !== undefined && narrowed === undefined ? [carve.phrase] : []),
  ];
  return {
    ok: true,
    target: narrowed ?? scoped,
    ...(options.assumed === true ? { assumed: true } : {}),
    ...(notApplied.length === 0 ? {} : { scopeNotApplied: notApplied }),
    ...(options.snapshotFallback === undefined
      ? {}
      : { snapshotFallback: options.snapshotFallback }),
    ...(options.snapshotNotApplied === true ? { snapshotNotApplied: true } : {}),
  };
}

/**
 * A request for the code itself rather than for a change to it. A change-class
 * carve-out cannot apply here, because there is no change to carve, so it is
 * reported as a narrowing Review did not apply rather than dropped.
 */
function snapshotParseResult(
  paths: ReviewPathScope,
  requested: ReviewScopeRequest,
): ReviewTargetParseResult {
  const carve = requested.excludedChangeClass;
  const notApplied = [...requested.notApplied, ...(carve === undefined ? [] : [carve.phrase])];
  return {
    ok: true,
    target: { kind: 'snapshot', paths },
    ...(notApplied.length === 0 ? {} : { scopeNotApplied: notApplied }),
  };
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
  if (suppliedMaterial.kind === 'empty') {
    return {
      ok: false,
      reason:
        'Review was asked to inspect supplied material, but the goal ends before any material appears. Paste the text to review, or name a commit, a range, staged, or unstaged.',
    };
  }

  // Everything below reads target selection from prose, so pasted literals
  // must not vote.
  const authorityScope = maskReviewLiteralData(normalizedScope);

  if (namesPullRequest(authorityScope)) {
    return { ok: false, reason: PULL_REQUEST_UNSUPPORTED_REASON };
  }

  // The narrowing clauses are read before the target grammar. "review latest
  // commit only in src/" names a commit and a scope, and reviewing the whole
  // commit would review more than the operator asked for.
  const requested = extractReviewScope(authorityScope);

  const range = parseRangeForm(authorityScope);
  const pinned: ReviewTargetParseResult | undefined =
    range === undefined ? parseCommitForm(authorityScope) : { ok: true, target: range };
  if (pinned !== undefined && !pinned.ok) return pinned;

  const workingTree = parseWorkingTreeForm(authorityScope);

  // Two explicit targets in one goal. Picking either one reviews something the
  // operator did not ask for, and there is no safe default between them.
  if (pinned !== undefined && workingTree !== undefined) {
    return {
      ok: false,
      reason:
        'Review pins one target per run, and this goal names two. Run it once for the commit or range, then again for the working tree.',
    };
  }

  if (pinned !== undefined) return scopedParseResult(pinned.target, requested);
  if (workingTree !== undefined) return scopedParseResult(workingTree, requested);

  const bareHead = parseBareHeadForm(authorityScope);
  if (bareHead !== undefined) return scopedParseResult(bareHead, requested);

  // "review src/auth" names what to look at, not which changes.
  const pathOnly = requested.paths === undefined ? pathOnlyRequestPath(authorityScope) : undefined;
  const pathOnlyPath = pathOnly === undefined ? undefined : scopePathFromToken(pathOnly);
  const scoped: ReviewScopeRequest =
    pathOnlyPath !== undefined
      ? { ...requested, paths: { include: [pathOnlyPath], exclude: [] } }
      : pathOnly === undefined
        ? requested
        : { ...requested, notApplied: [...requested.notApplied, pathOnly.trim()] };

  const assumedWorkingTree = { kind: 'working_tree', mode: 'all', explicit: false } as const;

  // Both branches below land on the change review because no path bounds the
  // read. Asking for the code as it stands is a question about something other
  // than a diff, so that does not get to arrive silently.
  const unscoped = {
    assumed: true,
    ...(SNAPSHOT_REQUEST_PATTERN.test(authorityScope) ? { snapshotNotApplied: true } : {}),
  } as const;

  // "Review this codebase" names the code as the subject, and the code is now
  // something Review can read: the tree is split into units and reviewed a unit
  // at a time. So the repository is the target, not the diff inside it. This is
  // the request that used to be refused.
  if (WHOLE_REPOSITORY_PATTERN.test(authorityScope)) {
    const repositoryScope = scoped.paths ?? { include: ['.'], exclude: [] };
    return snapshotParseResult(
      repositoryScope.include.length === 0
        ? { ...repositoryScope, include: ['.'] }
        : repositoryScope,
      scoped,
    );
  }

  if (scoped.paths === undefined) return scopedParseResult(assumedWorkingTree, scoped, unscoped);

  // A snapshot needs somewhere to look, and an exclusion on its own does not
  // name one. A repository-scoped goal already became a snapshot above, so what
  // is left here is an exclusion with no subject, which stays a change review.
  if (scoped.paths.include.length === 0) {
    return scopedParseResult(assumedWorkingTree, scoped, unscoped);
  }

  // The goal named where to look and nothing about changes. "as it stands"
  // says outright that the code itself is the subject; otherwise review the
  // changes there first and fall back to the code only if there are none.
  if (SNAPSHOT_REQUEST_PATTERN.test(authorityScope)) {
    return snapshotParseResult(scoped.paths, scoped);
  }
  return scopedParseResult(assumedWorkingTree, scoped, {
    assumed: true,
    snapshotFallback: scoped.paths,
  });
}

/**
 * The target vocabulary, written the way it is typed. Every rejection below
 * ends with this list, because a rejection that does not say what would have
 * worked just moves the guessing from the engine to the operator.
 */
const EXPLICIT_TARGET_VOCABULARY =
  'working-tree, staged, unstaged, commit:<ref>, a range such as main...HEAD or HEAD~3..HEAD, or a path in this repository such as src/auth';

/**
 * A path in the project, named outright as the target.
 *
 * The prose grammar has always understood places — "review src/auth" scopes
 * the read to that directory — while `--target` understood only Git
 * selectors. That made the flag built to replace the grammar strictly less
 * capable than the grammar, and `--target src/auth` was refused outright.
 *
 * A bare token is never a ref here: refs are spelled `commit:<ref>`, and both
 * range forms carry dots. So an existing path is unambiguous, and the closed
 * keyword vocabulary is still checked first, which keeps `--target staged`
 * meaning the staged changes in a repository that also has a `staged/`
 * directory.
 *
 * Existence is the whole test. Anything that is not a real path comes back
 * undefined and is refused by name, because a caller who stated an intent and
 * got it wrong is better served by a rejection than by a review of something
 * adjacent to what they asked for.
 */
function explicitTargetPath(value: string, projectRoot: string | undefined): string | undefined {
  if (projectRoot === undefined) return undefined;
  // `./src/auth`, `src/auth/`, and `src/auth` name one place. Normalize to the
  // stored form so the report, the pathspec, and the operator's word agree.
  // `.` survives: it is the repository root, which is a legitimate subject.
  const trimmed = value.trim().replace(/^\.\//u, '').replace(/\/+$/u, '');
  const candidate = trimmed.length === 0 ? '.' : trimmed;
  if (candidate !== '.' && scopePathFromToken(candidate) !== candidate) return undefined;
  const abs = resolve(projectRoot, candidate);
  // Lexical containment first, so an obvious `../..` never reaches the disk.
  if (!insideProject(projectRoot, abs)) return undefined;
  try {
    // lstat, not stat: the named thing itself must not be a symbolic link.
    const stat = lstatSync(abs);
    if (!stat.isDirectory() && !stat.isFile()) return undefined;
    // Then again on the canonical path. `resolve` is lexical, so the check
    // above passes for `linked/secret.txt` where `linked` is a symlink out of
    // the project — the last component is a regular file and nothing lexical
    // says otherwise. Comparing realpaths on both sides closes that, and
    // canonicalizing the root too keeps a project reached through a symlink
    // (macOS /tmp is /private/tmp) from refusing every path in itself.
    if (!insideProject(realpathSync(projectRoot), realpathSync(abs))) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

/**
 * Read a target the caller named outright, rather than one recovered from the
 * goal prose.
 *
 * This is deliberately not a grammar. It recognises a closed vocabulary exactly
 * and rejects everything else by name. The prose parser has to be forgiving,
 * because refusing an ordinary sentence costs more than reviewing the obvious
 * thing and disclosing the assumption. An explicit target is the opposite case:
 * the caller stated an intent, so quietly reviewing something adjacent to it is
 * strictly worse than saying the value was not understood. Nothing here strips
 * punctuation, skips filler words, or falls back.
 *
 * `projectRoot` enables the path form. Without one there is nothing to check a
 * path against, so the closed Git vocabulary is all that is left; every caller
 * that has a root passes it.
 */
export function parseExplicitReviewTarget(
  value: string,
  options: { readonly projectRoot?: string } = {},
): ReviewTargetParseResult {
  const named = value.trim();
  if (named.length === 0) {
    return { ok: false, reason: `--target was empty. Name one of: ${EXPLICIT_TARGET_VOCABULARY}.` };
  }

  // Only the keywords are case-folded. A ref is not: Git refs are
  // case-sensitive, and lowercasing one would hand Git a name the caller never
  // typed and report the failure against the wrong string.
  const keyword = named.toLowerCase();
  if (keyword === 'working-tree' || keyword === 'working_tree') {
    return { ok: true, target: { kind: 'working_tree', mode: 'all', explicit: true } };
  }
  if (keyword === 'staged' || keyword === 'unstaged') {
    return { ok: true, target: { kind: 'working_tree', mode: keyword, explicit: true } };
  }

  const commitPrefix = 'commit:';
  if (keyword.startsWith(commitPrefix)) {
    const ref = named.slice(commitPrefix.length);
    if (ref.length === 0) {
      return {
        ok: false,
        reason:
          '--target commit: names no commit. Write the ref after the colon, such as commit:abc1234.',
      };
    }
    if (!isSafeReviewRef(ref)) {
      return { ok: false, reason: unsafeRefReason(ref) };
    }
    return { ok: true, target: { kind: 'commit', ref } };
  }

  if (named.includes('..')) {
    // Three dots first: '..' is a prefix of '...', so testing the shorter form
    // first would split 'main...HEAD' into 'main' and '.HEAD'.
    const dots = named.includes('...') ? '...' : '..';
    const separatorIndex = named.indexOf(dots);
    const base = named.slice(0, separatorIndex);
    const head = named.slice(separatorIndex + dots.length);
    if (base.length === 0 || head.length === 0) {
      return {
        ok: false,
        reason: `--target "${named}" is a range missing one of its ends. Name both, such as main...HEAD.`,
      };
    }
    if (!isSafeReviewRef(base)) return { ok: false, reason: unsafeRefReason(base) };
    if (!isSafeReviewRef(head)) return { ok: false, reason: unsafeRefReason(head) };
    return { ok: true, target: { kind: 'range', base, head, dots } };
  }

  // A place in the repository, not a selector over its history. Same meaning
  // the prose grammar gives "review src/auth": the changes there, falling back
  // to the code as it stands when nothing has changed there. Coming back empty
  // on a clean tree would answer a question nobody asked.
  const path = explicitTargetPath(named, options.projectRoot);
  if (path !== undefined) {
    const paths: ReviewPathScope = { include: [path], exclude: [] };
    return {
      ok: true,
      target: withPathScope({ kind: 'working_tree', mode: 'all', explicit: true }, paths),
      snapshotFallback: paths,
    };
  }

  return {
    ok: false,
    reason: `Review does not know the target "${named}". Name one of: ${EXPLICIT_TARGET_VOCABULARY}.`,
  };
}

/**
 * Path narrowings the goal asks for, phrased for a report that did not apply
 * them.
 *
 * Naming a target skips the prose parser, and the prose parser is currently the
 * only thing that reads a narrowing like "only in src/auth". Without this, a
 * named target would drop that narrowing on the floor without a word, which is
 * the exact failure the explicit target exists to remove — moving a silent
 * mis-scope from the target to the paths is not progress.
 *
 * It reports rather than applies, deliberately. Applying prose narrowing on top
 * of an explicit target would keep the phrase grammar load-bearing, and the
 * ruling on that grammar is that it stops growing. `--paths` is the real fix.
 */
function proseNarrowingPhrases(goal: string): readonly string[] {
  const authorityScope = maskReviewLiteralData(normalizeReviewQuotes(goal));
  const requested = extractReviewScope(authorityScope);
  const phrases = [...requested.notApplied];
  if (requested.paths !== undefined) {
    phrases.push(reviewPathScopePaths(requested.paths));
  } else {
    // The bare form, "review src/auth", which names somewhere to look without
    // any narrowing clause around it.
    const pathOnly = pathOnlyRequestPath(authorityScope);
    if (pathOnly !== undefined) {
      phrases.push(scopePathFromToken(pathOnly) ?? pathOnly.trim());
    }
  }
  const carve = requested.excludedChangeClass;
  if (carve !== undefined) phrases.push(carve.phrase);
  return phrases;
}

function unsafeRefReason(ref: string): string {
  return `--target named the ref "${ref}", which Review will not hand to Git. A ref may not start with a dash, contain '..' inside a single end, or use '@{'. Name one of: ${EXPLICIT_TARGET_VOCABULARY}.`;
}

export function reviewScopeRequiresGitEvidence(scope: string): boolean {
  const parsed = parseReviewTarget(scope);
  if (!parsed.ok) return true;
  return parsed.target.kind !== 'goal';
}

function reviewTargetLabel(
  target: Extract<ReviewTarget, { readonly kind: 'commit' | 'range' }>,
): string {
  if (target.kind === 'commit') return `commit ${target.ref}`;
  return `range ${target.base}${target.dots}${target.head}`;
}

function runtimeTarget(target: ReviewTarget): RuntimeGitTarget | undefined {
  if (target.kind === 'commit') return { kind: 'commit', ref: target.ref };
  if (target.kind === 'range') {
    return { kind: 'range', base: target.base, head: target.head, dots: target.dots };
  }
  return undefined;
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
  target: Extract<ReviewTarget, { readonly kind: 'commit' | 'range' }>,
): string {
  return `Review target unavailable: ${reviewTargetLabel(target)} could not be read from this repository.`;
}

async function collectTargetEvidence(
  projectRoot: string,
  target: Extract<ReviewTarget, { readonly kind: 'commit' | 'range' }>,
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
  const paths = target.paths;
  const pinnedTarget = await resolveTarget(projectRoot, requestTarget, reader, directContext);
  const evidenceResults =
    reader === undefined
      ? (() => {
          const directTarget = prepareDirectTarget(projectRoot, pinnedTarget, directContext);
          return {
            diff: runGit(
              projectRoot,
              runtimeGitArgsWithPathScope(targetDiffArgs(directTarget), paths),
              {
                maxBufferBytes: MAX_DIFF_BUFFER_BYTES,
                allowPartialStdout: true,
              },
              directContext,
            ),
            diffStat: runGit(
              projectRoot,
              runtimeGitArgsWithPathScope(targetDiffArgs(directTarget, true), paths),
              {},
              directContext,
            ),
          };
        })()
      : {
          diff: await readGit(reader, 'target_diff', projectRoot, pinnedTarget, paths),
          diffStat: await readGit(reader, 'target_diff_stat', projectRoot, pinnedTarget, paths),
        };
  const { diff, diffStat } = evidenceResults;
  if (!diff.ok) {
    throw new Error(`${targetUnavailableMessage(target)} ${diff.reason}`);
  }
  if (!diffStat.ok) {
    throw new Error(`${targetUnavailableMessage(target)} ${diffStat.reason}`);
  }
  const targetDiff = gitDiffEvidence(diff, projectDeclaredGenerated(projectRoot));
  if (targetDiff.text.length === 0) {
    throw new Error(
      `Review target has no changes to inspect: ${reviewTargetLabel(target)}${
        paths === undefined ? '' : ` ${reviewPathScopeLabel(paths)}`
      } resolved successfully but produced an empty diff.`,
    );
  }
  return { targetDiff, targetDiffStat: diffStat.stdout, pinnedTarget };
}

function gitDiffEvidence(
  result: GitResult,
  isDeclaredGenerated: (path: string) => boolean,
): ReviewEvidenceText {
  if (!result.ok) return truncateText(result.reason, MAX_DIFF_CHARS);
  // Rank rather than head-slice. Git emits file sections in path order, so a
  // slice decides the review's subject by the alphabet; on this repository's
  // own range it kept `docs/` and the compiled bundles and cut every `src/`
  // hunk. See diff-ranking.ts.
  const ranked = rankDiffText(result.stdout, MAX_DIFF_CHARS, { isDeclaredGenerated });
  const counts =
    ranked.matchedFileCount === 0
      ? {}
      : {
          matched_file_count: ranked.matchedFileCount,
          included_file_count: ranked.includedFileCount,
        };
  if (!result.truncated_by_buffer) {
    return { text: ranked.text, truncated: ranked.truncated, ...counts };
  }
  return {
    text: `${ranked.text}\n[truncated by the bounded Git reader]`,
    truncated: true,
    ...counts,
  };
}

// How much of `.gitattributes` is read before deciding what the project calls
// generated. The declarations are a handful of lines in every repository that
// has them; the bound is here because this reads a file from a tree Circuit
// does not control.
const MAX_GITATTRIBUTES_CHARS = 64_000;

/**
 * What this project declares generated, read from the repository root's
 * `.gitattributes`. Absent or unreadable reads as "declares nothing", which is
 * the same answer Circuit gave before the file was consulted at all.
 */
function projectDeclaredGenerated(projectRoot: string): (path: string) => boolean {
  const file = readWorkspaceFile(
    projectRoot,
    '.gitattributes',
    'include-content',
    MAX_GITATTRIBUTES_CHARS,
  );
  return declaredGeneratedMatcher(file.content?.text);
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
  paths?: ReviewPathScope,
): Promise<{
  readonly result: GitResult;
  readonly flags: readonly HiddenIndexFlag[];
}> {
  // Scoped with the rest of the read: a hidden flag outside the reviewed paths
  // cannot hide a change inside them, and stopping the run over it would stop
  // a review that was never going to look there.
  const result =
    reader === undefined
      ? runGit(
          projectRoot,
          runtimeGitArgsWithPathScope(['ls-files', '-v', '-z', '--'], paths),
          {},
          directContext,
        )
      : await readGit(reader, 'hidden_index_flags', projectRoot, undefined, paths);
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

/**
 * Read one workspace file into evidence under bounds, re-checking after the
 * open and after the read that the path is still the same regular file inside
 * the project. Used for untracked evidence and for snapshots, which differ in
 * how much of a file they are willing to carry but not in how it is read.
 */
function readWorkspaceFile(
  projectRoot: string,
  path: string,
  contentPolicy: ReviewUntrackedContentPolicy,
  maxChars: number = MAX_UNTRACKED_FILE_CHARS,
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

    const byteLimit = Math.min(openedStat.size, maxChars + 1);
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
    const content = truncateText(decoded, maxChars, openedStat.size, openedStat.size > bytesRead);
    return { path, byte_length: openedStat.size, content };
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
  pathScope?: ReviewPathScope,
): Promise<{
  readonly count: number;
  readonly truncated: boolean;
  readonly files: ReviewUntrackedFileEvidence[];
}> {
  const listed =
    reader === undefined
      ? runGit(
          projectRoot,
          runtimeGitArgsWithPathScope(
            ['ls-files', '--others', '--exclude-standard', '-z'],
            pathScope,
          ),
          {},
          directContext,
        )
      : await readGit(reader, 'untracked_files', projectRoot, undefined, pathScope);
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
      .map((path) => readWorkspaceFile(projectRoot, path, contentPolicy)),
  };
}

/**
 * Read the current contents of the tracked files a path scope names. The file
 * list comes from Git rather than the filesystem, so ignored paths and build
 * output can never enter a snapshot even when the operator points at a
 * directory that contains them.
 *
 * Bounds are applied in listing order and reported, never absorbed: a caller
 * can always tell a complete snapshot from a partial one by comparing
 * `matched_file_count` against the files it received.
 */
async function collectSnapshotEvidence(
  projectRoot: string,
  paths: ReviewPathScope,
  reader?: RuntimeGitReader,
  directContext?: DirectGitContext,
): Promise<{
  readonly matchedFileCount: number;
  readonly truncated: boolean;
  readonly files: ReviewSnapshotFileEvidence[];
}> {
  const listed =
    reader === undefined
      ? runGit(
          projectRoot,
          runtimeGitArgsWithPathScope(['ls-files', '--cached', '--exclude-standard', '-z'], paths),
          {},
          directContext,
        )
      : await readGit(reader, 'tracked_files', projectRoot, undefined, paths);
  if (!listed.ok) {
    throw new Error(
      `Review target unavailable: the files at ${reviewPathScopePaths(paths)} could not be listed. ${listed.reason}`,
    );
  }
  if (listed.truncated_by_buffer) {
    throw new Error(
      'Review target unavailable: the file listing was truncated before it could be verified.',
    );
  }
  const matched = listed.stdout.split('\0').filter((path) => path.length > 0);
  // Git lists alphabetically, which is not an order any review wants its budget
  // spent in. Rank the matched set so source is read before prose and before
  // generated output; nothing is removed, so the coverage note below still
  // compares what was read against everything that matched.
  const files: ReviewSnapshotFileEvidence[] = [];
  let spentChars = 0;
  for (const path of rankSnapshotPaths(matched, {
    isDeclaredGenerated: projectDeclaredGenerated(projectRoot),
  })) {
    if (files.length >= MAX_SNAPSHOT_FILES || spentChars >= MAX_SNAPSHOT_TOTAL_CHARS) break;
    const file = readWorkspaceFile(
      projectRoot,
      path,
      'include-content',
      Math.min(MAX_SNAPSHOT_FILE_CHARS, MAX_SNAPSHOT_TOTAL_CHARS - spentChars),
    );
    spentChars += file.content?.text.length ?? 0;
    files.push(file);
  }
  return { matchedFileCount: matched.length, truncated: files.length < matched.length, files };
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
        : target.kind === 'snapshot'
          ? reviewPathScopePaths(target.paths)
          : reviewTargetLabel(target);
    throw new Error(
      `Review target unavailable: ${targetLabel} cannot be read because the workspace root was not provided.`,
    );
  }
  const directContext =
    options.gitReader === undefined ? prepareDirectGitContext(projectRoot) : undefined;
  if (directContext !== undefined) assertDirectGitMetadataSafe(directContext);
  const evidenceRoot = directContext?.workTree ?? projectRoot;

  if (target.kind === 'snapshot') {
    const snapshot = await collectSnapshotEvidence(
      evidenceRoot,
      target.paths,
      options.gitReader,
      directContext,
    );
    if (snapshot.matchedFileCount === 0) {
      // Nobody named a path when the target is the repository itself, so
      // "check the path" would send the operator after a path they never gave.
      const wholeTree = target.paths.include.length === 1 && target.paths.include[0] === '.';
      throw new Error(
        wholeTree
          ? 'Review found no tracked files in this repository. Commit the files to review, or name a commit, a range, staged, or unstaged to review a change instead.'
          : `Review found no tracked files at ${reviewPathScopePaths(target.paths)}. Check the path, or name a commit, a range, staged, or unstaged to review a change instead.`,
      );
    }
    return {
      kind: 'git-snapshot',
      project_root: evidenceRoot,
      target_kind: 'snapshot',
      files: snapshot.files,
      matched_file_count: snapshot.matchedFileCount,
      files_truncated: snapshot.truncated,
      path_scope: target.paths,
    };
  }

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
      ...(target.paths === undefined ? {} : { path_scope: target.paths }),
    };
  }

  const emptyDiffResult: GitResult = { ok: true, stdout: '', truncated_by_buffer: false };
  const paths = target.paths;
  const hiddenIndex = await inspectHiddenIndexFlags(
    evidenceRoot,
    options.gitReader,
    directContext,
    paths,
  );
  assertNoHiddenIndexFlags(hiddenIndex.flags);
  const readDiff = async (
    operation: 'staged_diff' | 'unstaged_diff',
    directArgs: readonly string[],
  ): Promise<GitResult> =>
    options.gitReader === undefined
      ? runGit(
          evidenceRoot,
          runtimeGitArgsWithPathScope(directArgs, paths),
          {
            maxBufferBytes: MAX_DIFF_BUFFER_BYTES,
            allowPartialStdout: true,
          },
          directContext,
        )
      : await readGit(options.gitReader, operation, evidenceRoot, undefined, paths);
  const readStat = async (
    operation: 'staged_diff_stat' | 'unstaged_diff_stat',
    directArgs: readonly string[],
  ): Promise<GitResult> =>
    options.gitReader === undefined
      ? runGit(evidenceRoot, runtimeGitArgsWithPathScope(directArgs, paths), {}, directContext)
      : await readGit(options.gitReader, operation, evidenceRoot, undefined, paths);
  const readChangedGitlinks = async (
    operation: 'staged_changed_gitlinks' | 'unstaged_changed_gitlinks',
    directArgs: readonly string[],
  ): Promise<GitResult> =>
    options.gitReader === undefined
      ? runGit(evidenceRoot, runtimeGitArgsWithPathScope(directArgs, paths), {}, directContext)
      : await readGit(options.gitReader, operation, evidenceRoot, undefined, paths);
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
      ? runGit(
          evidenceRoot,
          runtimeGitArgsWithPathScope(['status', '--short', '--ignore-submodules=none'], paths),
          {},
          directContext,
        )
      : await readGit(options.gitReader, 'status', evidenceRoot, undefined, paths);

  const status =
    target.mode === 'all'
      ? await readStatus()
      : { ok: true as const, stdout: '', truncated_by_buffer: false };
  // Evidence failures are fatal whether or not the operator named the target.
  // D1 makes an unnamed goal review the working tree, so an unreadable working
  // tree means Review has nothing to review, and it says so before it spends.
  if (!status.ok) {
    throw new Error(`Review target unavailable: Git status could not be read. ${status.reason}`);
  }
  const stagedResult =
    target.mode === 'unstaged' ? emptyDiffResult : await readDiff('staged_diff', stagedDiffArgs);
  const unstagedResult =
    target.mode === 'staged' ? emptyDiffResult : await readDiff('unstaged_diff', unstagedDiffArgs);
  if (!stagedResult.ok) {
    throw new Error(
      `Review target unavailable: staged changes could not be read. ${stagedResult.reason}`,
    );
  }
  if (!unstagedResult.ok) {
    throw new Error(
      `Review target unavailable: unstaged changes could not be read. ${unstagedResult.reason}`,
    );
  }
  const declaredGenerated = projectDeclaredGenerated(evidenceRoot);
  const staged = gitDiffEvidence(stagedResult, declaredGenerated);
  const unstaged = gitDiffEvidence(unstagedResult, declaredGenerated);
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
  if (!stagedStat.ok) {
    throw new Error(
      `Review target unavailable: the staged change summary could not be read. ${stagedStat.reason}`,
    );
  }
  if (!unstagedStat.ok) {
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
          paths,
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
  if (!selectedContentAvailable) {
    const scopeSuffix = paths === undefined ? '' : ` ${reviewPathScopeLabel(paths)}`;
    if (target.explicit) {
      throw new ReviewTargetEmptyError(
        `Review target has no changes to inspect: ${target.mode === 'all' ? 'working tree changes' : `${target.mode} changes`}${scopeSuffix} are empty.`,
      );
    }
    throw new ReviewTargetEmptyError(
      `Review found no changes to inspect. The goal did not name a target, so Review looked at the working tree${scopeSuffix}. Name a commit, a range, staged, or unstaged if you meant a different target.`,
    );
  }

  const statSections = [
    ...(stagedStat.ok && stagedStat.stdout.length > 0 ? [`Staged:\n${stagedStat.stdout}`] : []),
    ...(unstagedStat.ok && unstagedStat.stdout.length > 0
      ? [`Unstaged:\n${unstagedStat.stdout}`]
      : []),
  ];
  return {
    kind: 'git-working-tree',
    project_root: evidenceRoot,
    status_short: printableStatus(status.stdout),
    staged_diff: staged,
    unstaged_diff: unstaged,
    diff_stat: statSections.join('\n'),
    target_kind: 'working_tree',
    target_mode: target.mode,
    untracked_file_count: untracked.count,
    untracked_files_truncated: untracked.truncated,
    untracked_content_policy: untrackedContentPolicy,
    untracked_files: untracked.files,
    ...(submodulePaths.length === 0 ? {} : { submodule_paths: [...submodulePaths] }),
    ...(paths === undefined ? {} : { path_scope: paths }),
  };
}

export const reviewIntakeComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'review.intake@v1',
  async build(context: ComposeBuildContext): Promise<unknown> {
    // The explicit target wins outright, and is not merely consulted when the
    // grammar comes up empty. A caller who named a target has already decided;
    // letting a phrase match override that would make the flag advisory and
    // leave the guess in charge, which is the whole problem.
    const named = context.target;
    const parsedTarget =
      named === undefined
        ? parseReviewTarget(context.goal)
        : parseExplicitReviewTarget(
            named,
            context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot },
          );
    if (!parsedTarget.ok) throw new Error(parsedTarget.reason);
    // Supplied material counts as named. The question this field answers is
    // whether the caller decided what Review would look at or Review decided
    // for them, and when the goal carries the material inline the caller handed
    // over the subject itself. Nothing was recovered by phrase matching, so
    // calling it inferred would report a guess that never happened.
    const targetProvenance =
      named !== undefined || parsedTarget.target.kind === 'goal' ? 'named' : 'inferred';
    // Skipping the prose parser also skips the only reader of path narrowings,
    // so anything the goal asked to narrow to goes unread here. Name it in the
    // report instead of quietly reviewing wider than the request.
    const narrowingUnread = named === undefined ? [] : proseNarrowingPhrases(context.goal);
    const scopeNotApplied =
      parsedTarget.scopeNotApplied ?? (narrowingUnread.length === 0 ? undefined : narrowingUnread);
    const untrackedContent =
      context.evidencePolicy?.includeUntrackedFileContent === true
        ? { includeUntrackedFileContent: true as const }
        : {};
    const reader = context.gitReader === undefined ? {} : { gitReader: context.gitReader };
    const collect = async (target: ReviewTarget): Promise<ReviewEvidence> =>
      await collectReviewEvidence(context.projectRoot, {
        ...untrackedContent,
        target,
        ...reader,
      });

    let target = parsedTarget.target;
    let evidence: ReviewEvidence;
    let snapshotFallbackFrom: string | undefined;
    try {
      evidence = await collect(target);
    } catch (error) {
      // The operator named paths but no change. An empty diff there is not a
      // dead end: the code at those paths is what they pointed at, so review
      // it rather than reporting that nothing happened.
      const fallback = parsedTarget.snapshotFallback;
      if (fallback === undefined || !(error instanceof ReviewTargetEmptyError)) throw error;
      snapshotFallbackFrom = reviewPathScopePaths(fallback);
      target = { kind: 'snapshot', paths: fallback };
      evidence = await collect(target);
    }

    return projectReviewIntake({
      scope: context.goal,
      target,
      targetProvenance,
      evidence,
      maxUntrackedFiles: MAX_UNTRACKED_FILES,
      // An assumed working tree that became a snapshot is no longer an
      // assumption about which changes to read, so the warning would misdescribe
      // what happened.
      ...(parsedTarget.assumed === true && snapshotFallbackFrom === undefined
        ? { assumedTarget: true }
        : {}),
      ...(scopeNotApplied === undefined ? {} : { scopeNotApplied }),
      ...(snapshotFallbackFrom === undefined ? {} : { snapshotFallbackFrom }),
      ...(parsedTarget.snapshotNotApplied === true ? { snapshotNotApplied: true } : {}),
    });
  },
};
