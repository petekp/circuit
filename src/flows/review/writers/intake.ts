// Review intake compose writer.
//
// Emits the requested review scope plus the local working-tree evidence the
// reviewer needs to audit current changes. The CLI supplies projectRoot from
// its cwd, so Codex/Claude/generic-shell hosts all collect the same evidence
// before the reviewer relay is called.

import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { type SealedGitReadOperation, runSealedGitRead } from '../../../shared/sealed-git-read.js';
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
  operation: SealedGitReadOperation,
  options: { readonly maxBufferBytes?: number; readonly allowPartialStdout?: boolean } = {},
): GitResult {
  const result = runSealedGitRead(projectRoot, operation, {
    maxOutputBytes: options.maxBufferBytes ?? MAX_GIT_BUFFER_BYTES,
  });
  const stdout = outputToString(result.stdout);
  const stderr = outputToString(result.stderr).trim();

  if (result.error !== undefined) {
    if (options.allowPartialStdout === true && stdout.length > 0) {
      return { ok: true, stdout, truncated_by_buffer: true };
    }
    return { ok: false, reason: `${operation} failed: ${result.error.message}` };
  }

  if (result.truncated && options.allowPartialStdout === true && stdout.length > 0) {
    return { ok: true, stdout, truncated_by_buffer: true };
  }

  if (result.status !== 0) {
    const reason = stderr.length > 0 ? stderr : `exited with status ${result.status ?? 'unknown'}`;
    return { ok: false, reason: `${operation} failed: ${reason}` };
  }

  return { ok: true, stdout, truncated_by_buffer: false };
}

function runGitDiff(
  projectRoot: string,
  operation: 'review-staged-diff' | 'review-unstaged-diff',
): ReviewEvidenceText {
  const result = runGit(projectRoot, operation, {
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

function insideProject(projectRoot: string, path: string): boolean {
  const rel = relative(projectRoot, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sameFileIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(
  left: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  },
  right: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  },
): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readUntrackedFile(
  projectRoot: string,
  path: string,
  contentPolicy: ReviewUntrackedContentPolicy,
): ReviewUntrackedFileEvidence {
  const requestedRoot = resolve(projectRoot);
  const abs = resolve(requestedRoot, path);
  if (!insideProject(requestedRoot, abs)) {
    return { path, byte_length: 0, skipped_reason: 'path resolves outside project root' };
  }
  let projectRootReal: string;
  let filePathReal: string;
  let stat: BigIntStats;
  try {
    projectRootReal = realpathSync.native(requestedRoot);
    stat = lstatSync(abs, { bigint: true });
  } catch (err) {
    return { path, byte_length: 0, skipped_reason: `failed to inspect file: ${errorMessage(err)}` };
  }
  const byteLength = Number(stat.size);
  if (stat.isSymbolicLink()) {
    return { path, byte_length: byteLength, skipped_reason: 'symbolic link skipped' };
  }
  if (!stat.isFile()) {
    return { path, byte_length: byteLength, skipped_reason: 'not a regular file' };
  }
  try {
    filePathReal = realpathSync.native(abs);
  } catch (err) {
    return {
      path,
      byte_length: byteLength,
      skipped_reason: `failed to resolve file safely: ${errorMessage(err)}`,
    };
  }
  if (!insideProject(projectRootReal, filePathReal)) {
    return {
      path,
      byte_length: byteLength,
      skipped_reason: 'path resolves outside project root',
    };
  }
  if (contentPolicy === 'metadata-only') {
    return { path, byte_length: byteLength };
  }

  let fd: number | undefined;
  try {
    fd = openSync(filePathReal, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const openedStat = fstatSync(fd, { bigint: true });
    if (!openedStat.isFile()) {
      return { path, byte_length: byteLength, skipped_reason: 'not a regular file' };
    }
    if (!sameFileIdentity(stat, openedStat)) {
      return {
        path,
        byte_length: byteLength,
        skipped_reason: 'file changed before it could be read',
      };
    }
    if (!sameFileSnapshot(stat, openedStat)) {
      return {
        path,
        byte_length: byteLength,
        skipped_reason: 'file contents changed before they could be read',
      };
    }

    const byteLimit = Number(
      openedStat.size < BigInt(MAX_UNTRACKED_FILE_BYTES)
        ? openedStat.size
        : BigInt(MAX_UNTRACKED_FILE_BYTES),
    );
    const bytes = Buffer.alloc(byteLimit);
    const bytesRead = readSync(fd, bytes, 0, byteLimit, 0);
    const afterReadStat = fstatSync(fd, { bigint: true });
    if (!sameFileSnapshot(openedStat, afterReadStat)) {
      return {
        path,
        byte_length: byteLength,
        skipped_reason: 'file contents changed while they were being read',
      };
    }
    const sample = bytes.subarray(0, bytesRead);
    if (sample.includes(0)) {
      return { path, byte_length: byteLength, skipped_reason: 'binary file skipped' };
    }
    const content = truncateText(sample.toString('utf8'), MAX_UNTRACKED_FILE_CHARS);
    return {
      path,
      byte_length: byteLength,
      content:
        openedStat.size > BigInt(bytesRead) && !content.truncated
          ? { ...content, truncated: true }
          : content,
    };
  } catch (err) {
    return {
      path,
      byte_length: byteLength,
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

function collectUntrackedFiles(
  projectRoot: string,
  contentPolicy: ReviewUntrackedContentPolicy,
): {
  readonly count: number;
  readonly truncated: boolean;
  readonly files: ReviewUntrackedFileEvidence[];
} {
  const listed = runGit(projectRoot, 'review-untracked');
  if (!listed.ok) return { count: 0, truncated: false, files: [] };
  const paths = listed.stdout.split('\0').filter((path) => path.length > 0);
  return {
    count: paths.length,
    truncated: paths.length > MAX_UNTRACKED_FILES,
    files: paths
      .slice(0, MAX_UNTRACKED_FILES)
      .map((path) => readUntrackedFile(projectRoot, path, contentPolicy)),
  };
}

function collectReviewEvidence(
  projectRoot: string | undefined,
  options: { readonly includeUntrackedFileContent?: boolean } = {},
): ReviewEvidence {
  if (projectRoot === undefined) {
    return {
      kind: 'unavailable',
      reason: 'CompiledFlowInvocation.projectRoot was not provided',
    };
  }

  const status = runGit(projectRoot, 'review-status');
  if (!status.ok) return { kind: 'unavailable', reason: status.reason };
  const staged = runGitDiff(projectRoot, 'review-staged-diff');
  const unstaged = runGitDiff(projectRoot, 'review-unstaged-diff');
  const diffStat = runGit(projectRoot, 'review-staged-stat');
  const untrackedContentPolicy: ReviewUntrackedContentPolicy =
    options.includeUntrackedFileContent === true ? 'include-content' : 'metadata-only';
  const untracked = collectUntrackedFiles(projectRoot, untrackedContentPolicy);

  return {
    kind: 'git-working-tree',
    project_root: projectRoot,
    status_short: status.stdout,
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
  build(context: ComposeBuildContext): unknown {
    const evidence = collectReviewEvidence(
      context.projectRoot,
      context.evidencePolicy?.includeUntrackedFileContent === true
        ? { includeUntrackedFileContent: true }
        : {},
    );
    return projectReviewIntake({
      scope: context.goal,
      evidence,
      maxUntrackedFiles: MAX_UNTRACKED_FILES,
    });
  },
};
