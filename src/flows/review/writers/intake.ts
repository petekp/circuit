// Review intake compose writer.
//
// Emits the requested review scope plus the local working-tree evidence the
// reviewer needs to audit current changes. The CLI supplies projectRoot from
// its cwd, so Codex/Claude/generic-shell hosts all collect the same evidence
// before the reviewer relay is called.

import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { RuntimeGitOperation, RuntimeGitReader } from '../../../shared/runtime-git-reader.js';
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

type GitResult =
  | { ok: true; stdout: string; truncated_by_buffer: boolean }
  | {
      ok: false;
      reason: string;
    };

function truncateText(text: string, maxChars: number): ReviewEvidenceText {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`,
    truncated: true,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function outputToString(output: string | Buffer | Uint8Array | null | undefined): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  return Buffer.from(output).toString('utf8');
}

function runGit(
  projectRoot: string,
  args: readonly string[],
  options: { readonly maxBufferBytes?: number; readonly allowPartialStdout?: boolean } = {},
): GitResult {
  const result = spawnSync('git', [...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: options.maxBufferBytes ?? MAX_GIT_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = outputToString(result.stdout);
  const stderr = outputToString(result.stderr).trim();

  if (result.error !== undefined) {
    if (options.allowPartialStdout === true && stdout.length > 0) {
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

function runGitDiff(projectRoot: string, args: readonly string[]): ReviewEvidenceText {
  const result = runGit(projectRoot, args, {
    maxBufferBytes: MAX_DIFF_BUFFER_BYTES,
    allowPartialStdout: true,
  });
  if (!result.ok) return truncateText(result.reason, MAX_DIFF_CHARS);
  if (!result.truncated_by_buffer) return truncateText(result.stdout, MAX_DIFF_CHARS);
  const truncated = truncateText(result.stdout, MAX_DIFF_CHARS);
  return {
    text: `${truncated.text}\n[truncated because git output exceeded ${MAX_DIFF_BUFFER_BYTES} bytes before completion]`,
    truncated: true,
  };
}

async function readGit(
  reader: RuntimeGitReader,
  operation: RuntimeGitOperation,
  projectRoot: string,
): Promise<GitResult> {
  const result = await reader.read({ operation, projectRoot });
  if (result.operation !== operation) {
    return { ok: false, reason: `Git reader returned ${result.operation} for ${operation}.` };
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
  return {
    ok: true,
    stdout: result.stdout,
    truncated_by_buffer: result.truncated,
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
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(abs);
  } catch (err) {
    return { path, byte_length: 0, skipped_reason: `failed to inspect file: ${errorMessage(err)}` };
  }
  if (stat.isSymbolicLink()) {
    return { path, byte_length: stat.size, skipped_reason: 'symbolic link skipped' };
  }
  if (!stat.isFile()) {
    return { path, byte_length: stat.size, skipped_reason: 'not a regular file' };
  }
  if (contentPolicy === 'metadata-only') {
    return { path, byte_length: stat.size };
  }

  let fd: number | undefined;
  try {
    const byteLimit = Math.min(stat.size, MAX_UNTRACKED_FILE_BYTES);
    fd = openSync(abs, 'r');
    const bytes = Buffer.alloc(byteLimit);
    const bytesRead = readSync(fd, bytes, 0, byteLimit, 0);
    const sample = bytes.subarray(0, bytesRead);
    if (sample.includes(0)) {
      return { path, byte_length: stat.size, skipped_reason: 'binary file skipped' };
    }
    const content = truncateText(sample.toString('utf8'), MAX_UNTRACKED_FILE_CHARS);
    return {
      path,
      byte_length: stat.size,
      content:
        stat.size > bytesRead && !content.truncated ? { ...content, truncated: true } : content,
    };
  } catch (err) {
    return {
      path,
      byte_length: stat.size,
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
): Promise<{
  readonly count: number;
  readonly truncated: boolean;
  readonly files: ReviewUntrackedFileEvidence[];
}> {
  const listed =
    reader === undefined
      ? runGit(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
      : await readGit(reader, 'untracked_files', projectRoot);
  if (!listed.ok) return { count: 0, truncated: false, files: [] };
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
    readonly gitReader?: RuntimeGitReader;
  } = {},
): Promise<ReviewEvidence> {
  if (projectRoot === undefined) {
    return {
      kind: 'unavailable',
      reason: 'CompiledFlowInvocation.projectRoot was not provided',
    };
  }

  const status =
    options.gitReader === undefined
      ? runGit(projectRoot, ['status', '--short'])
      : await readGit(options.gitReader, 'status', projectRoot);
  if (!status.ok) return { kind: 'unavailable', reason: status.reason };
  const staged =
    options.gitReader === undefined
      ? runGitDiff(projectRoot, ['diff', '--cached', '--no-ext-diff', '--'])
      : gitDiffEvidence(await readGit(options.gitReader, 'staged_diff', projectRoot));
  const unstaged =
    options.gitReader === undefined
      ? runGitDiff(projectRoot, ['diff', '--no-ext-diff', '--'])
      : gitDiffEvidence(await readGit(options.gitReader, 'unstaged_diff', projectRoot));
  const diffStat =
    options.gitReader === undefined
      ? runGit(projectRoot, ['diff', '--stat', '--cached', '--no-ext-diff'])
      : await readGit(options.gitReader, 'staged_diff_stat', projectRoot);
  const untrackedContentPolicy: ReviewUntrackedContentPolicy =
    options.includeUntrackedFileContent === true ? 'include-content' : 'metadata-only';
  const untracked = await collectUntrackedFiles(
    projectRoot,
    untrackedContentPolicy,
    options.gitReader,
  );

  return {
    kind: 'git-working-tree',
    project_root: projectRoot,
    status_short: printableStatus(status.stdout),
    staged_diff: staged,
    unstaged_diff: unstaged,
    diff_stat: diffStat.ok ? diffStat.stdout : diffStat.reason,
    untracked_file_count: untracked.count,
    untracked_files_truncated: untracked.truncated,
    untracked_content_policy: untrackedContentPolicy,
    untracked_files: untracked.files,
  };
}

export const reviewIntakeComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'review.intake@v1',
  async build(context: ComposeBuildContext): Promise<unknown> {
    const evidence = await collectReviewEvidence(context.projectRoot, {
      ...(context.evidencePolicy?.includeUntrackedFileContent === true
        ? { includeUntrackedFileContent: true }
        : {}),
      ...(context.gitReader === undefined ? {} : { gitReader: context.gitReader }),
    });
    return projectReviewIntake({
      scope: context.goal,
      evidence,
      maxUntrackedFiles: MAX_UNTRACKED_FILES,
    });
  },
};
