import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  CheckpointReviewResponse,
  type CheckpointReviewResponse as CheckpointReviewResponseValue,
} from '../schemas/checkpoint-review-response.js';

// The schema separately caps the normalized payload at 60,000 bytes. The file
// transport allows a little headroom for the review page's pretty-printed JSON
// while still bounding whitespace and other pre-parse input.
export const MAX_CHECKPOINT_RESPONSE_FILE_BYTES = 64 * 1024;

export type CheckpointResponseFileErrorCode =
  | 'not_found'
  | 'unreadable'
  | 'not_regular_file'
  | 'too_large'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'invalid_response';

export class CheckpointResponseFileError extends Error {
  readonly code: CheckpointResponseFileErrorCode;
  readonly path: string;

  constructor(code: CheckpointResponseFileErrorCode, path: string, message: string) {
    super(message);
    this.name = 'CheckpointResponseFileError';
    this.code = code;
    this.path = path;
  }
}

export function resolveCheckpointResponseFilePath(argument: string, cwd: string): string {
  return isAbsolute(argument) ? argument : resolve(cwd, argument);
}

function openResponseFile(path: string): number {
  try {
    // O_NONBLOCK keeps a pipe or device path from hanging before fstat can
    // reject it. All later checks and reads use this same descriptor, so a path
    // swap cannot change which file is accepted after validation.
    return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new CheckpointResponseFileError(
        'not_found',
        path,
        `No checkpoint response file was found at ${path}.`,
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CheckpointResponseFileError(
        'unreadable',
        path,
        `The checkpoint response file at ${path} could not be read because permission was denied.`,
      );
    }
    throw new CheckpointResponseFileError(
      'unreadable',
      path,
      `The checkpoint response file at ${path} could not be opened.`,
    );
  }
}

function readBoundedRegularFile(path: string): Uint8Array {
  const fd = openResponseFile(path);
  try {
    let stat: ReturnType<typeof fstatSync>;
    try {
      stat = fstatSync(fd);
    } catch {
      throw new CheckpointResponseFileError(
        'unreadable',
        path,
        `The checkpoint response file at ${path} could not be inspected.`,
      );
    }
    if (!stat.isFile()) {
      throw new CheckpointResponseFileError(
        'not_regular_file',
        path,
        `The checkpoint response path at ${path} must be a regular file; folders, pipes, sockets, and devices are not supported.`,
      );
    }
    if (stat.size > MAX_CHECKPOINT_RESPONSE_FILE_BYTES) {
      throw new CheckpointResponseFileError(
        'too_large',
        path,
        `The checkpoint response file at ${path} is too large (limit 64 KiB). Shorten the review notes and export it again.`,
      );
    }

    const buffer = Buffer.allocUnsafe(MAX_CHECKPOINT_RESPONSE_FILE_BYTES + 1);
    let offset = 0;
    try {
      while (offset < buffer.length) {
        const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
    } catch {
      throw new CheckpointResponseFileError(
        'unreadable',
        path,
        `The checkpoint response file at ${path} could not be read.`,
      );
    }
    if (offset > MAX_CHECKPOINT_RESPONSE_FILE_BYTES) {
      throw new CheckpointResponseFileError(
        'too_large',
        path,
        `The checkpoint response file at ${path} is too large (limit 64 KiB). Shorten the review notes and export it again.`,
      );
    }
    return buffer.subarray(0, offset);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The descriptor is no longer useful. Never replace the actionable,
      // sanitized file error above with a platform-specific close message.
    }
  }
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CheckpointResponseFileError(
      'invalid_utf8',
      path,
      `The checkpoint response file at ${path} is not valid UTF-8. Export it again from the current review page.`,
    );
  }
}

function safeJsonLocation(error: unknown, text: string): string {
  if (!(error instanceof Error)) return '';
  const direct = /\bline\s+(\d+)\s+column\s+(\d+)\b/i.exec(error.message);
  if (direct !== null) return ` at line ${direct[1]}, column ${direct[2]}`;
  const positioned = /\bposition\s+(\d+)\b/i.exec(error.message);
  if (positioned === null) return '';
  const position = Number.parseInt(positioned[1] ?? '', 10);
  if (!Number.isSafeInteger(position) || position < 0 || position > text.length) return '';
  const before = text.slice(0, position);
  const line = before.split('\n').length;
  const lastNewline = before.lastIndexOf('\n');
  const column = position - lastNewline;
  return ` at line ${line}, column ${column}`;
}

const SAFE_RESPONSE_FIELDS = new Set([
  'schema',
  'run_id',
  'step_id',
  'attempt',
  'request_sha256',
  'selection',
  'comments',
]);

function safeIssuePath(path: readonly PropertyKey[]): string | undefined {
  const first = path[0];
  if (typeof first !== 'string' || !SAFE_RESPONSE_FIELDS.has(first)) return undefined;
  if (first !== 'comments') return first;
  const index = path[1];
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return 'comments';
  const member = path[2];
  if (member === 'scope' || member === 'choice_id' || member === 'body') {
    return `comments[${index}].${member}`;
  }
  return `comments[${index}]`;
}

function safeInvalidFields(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): readonly string[] {
  const fields = new Set<string>();
  for (const issue of issues) {
    const field = safeIssuePath(issue.path);
    if (field !== undefined) fields.add(field);
  }
  return [...fields].sort();
}

export function readCheckpointResponseFile(input: {
  readonly argument: string;
  readonly cwd: string;
}): CheckpointReviewResponseValue {
  const path = resolveCheckpointResponseFilePath(input.argument, input.cwd);
  const text = decodeUtf8(readBoundedRegularFile(path), path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CheckpointResponseFileError(
      'invalid_json',
      path,
      `The checkpoint response file at ${path} is not valid JSON${safeJsonLocation(error, text)}. Export it again from the current review page.`,
    );
  }

  const parsed = CheckpointReviewResponse.safeParse(raw);
  if (!parsed.success) {
    const fields = safeInvalidFields(parsed.error.issues);
    const fieldDetail = fields.length === 0 ? '' : ` Check these fields: ${fields.join(', ')}.`;
    throw new CheckpointResponseFileError(
      'invalid_response',
      path,
      `The checkpoint response file at ${path} does not match checkpoint.review-response@v1.${fieldDetail} Export a fresh review from the current page.`,
    );
  }
  return parsed.data;
}
