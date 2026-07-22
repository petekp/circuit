import { createHash, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

import { sha256OfJson, sha256OfString } from '../../schemas/hashing.js';
import { RunId } from '../../schemas/ids.js';
import { RunRelativePath } from '../../schemas/scalars.js';
import {
  CODEX_MCP_ROOTS_SOURCE,
  CODEX_SANDBOX_METADATA_KEY,
  type TrustedCodexWorkspace,
} from './resources.js';

const MAX_CHECKPOINT_REQUEST_BYTES = 256 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const CHECKPOINT_TOKEN_PATTERN = /^cpt1\.[a-f0-9]{64}$/;

const ChoiceIdV1 = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const StoredCheckpointLocatorSchemaV1 = z
  .object({
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    step_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    request_path: z
      .string()
      .min(1)
      .max(2_048)
      .superRefine((value, ctx) => {
        if (value.includes('\0')) {
          ctx.addIssue({ code: 'custom', message: 'request_path must not contain NUL bytes' });
          return;
        }
        const parsed = RunRelativePath.safeParse(value);
        if (!parsed.success) {
          ctx.addIssue({ code: 'custom', message: 'request_path must be run-relative' });
        }
      }),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    allowed_choices: z.array(ChoiceIdV1).min(1).max(20),
    choices_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((locator, ctx) => {
    const seen = new Set<string>();
    for (const [index, choice] of locator.allowed_choices.entries()) {
      if (seen.has(choice)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowed_choices', index],
          message: `duplicate allowed choice '${choice}'`,
        });
      }
      seen.add(choice);
    }
    if (locator.choices_sha256 !== sha256OfJson(locator.allowed_choices)) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices_sha256'],
        message: 'choices_sha256 must bind the ordered allowed choices',
      });
    }
  });

export type StoredCheckpointLocatorV1 = z.infer<typeof StoredCheckpointLocatorSchemaV1>;

const CheckpointRequestChoiceV1 = z
  .object({
    id: ChoiceIdV1,
    label: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const CheckpointRequestV1 = z
  .object({
    schema_version: z.literal(1),
    step_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    prompt: z.string().trim().min(1).max(4_000),
    allowed_choices: z.array(ChoiceIdV1).min(1).max(20),
    choices: z.array(CheckpointRequestChoiceV1).min(1).max(20),
    safe_default_choice: ChoiceIdV1.optional(),
    // Runtime resume owns the flow-specific contents. MCP proves that this is
    // an object and deliberately does not project or return it.
    execution_context: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((request, ctx) => {
    const allowed = new Set<string>();
    for (const [index, choice] of request.allowed_choices.entries()) {
      if (allowed.has(choice)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowed_choices', index],
          message: `duplicate allowed choice '${choice}'`,
        });
      }
      allowed.add(choice);
    }

    const choices = new Set<string>();
    for (const [index, choice] of request.choices.entries()) {
      if (choices.has(choice.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['choices', index, 'id'],
          message: `duplicate choice '${choice.id}'`,
        });
      }
      choices.add(choice.id);
      if (choice.id !== request.allowed_choices[index]) {
        ctx.addIssue({
          code: 'custom',
          path: ['choices', index, 'id'],
          message: 'choices must match allowed_choices in order',
        });
      }
    }
    if (request.choices.length !== request.allowed_choices.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'choices must match allowed_choices exactly',
      });
    }
    if (request.safe_default_choice !== undefined && !allowed.has(request.safe_default_choice)) {
      ctx.addIssue({
        code: 'custom',
        path: ['safe_default_choice'],
        message: 'safe_default_choice must be an allowed choice',
      });
    }
  });

export type CheckpointViewErrorCode =
  | 'workspace_unavailable'
  | 'checkpoint_locator_invalid'
  | 'checkpoint_request_unavailable'
  | 'checkpoint_request_unsafe'
  | 'checkpoint_request_too_large'
  | 'checkpoint_request_invalid'
  | 'checkpoint_stale'
  | 'checkpoint_token_invalid'
  | 'choice_unavailable';

export class CheckpointViewError extends Error {
  readonly code: CheckpointViewErrorCode;

  constructor(code: CheckpointViewErrorCode, message: string) {
    super(message);
    this.name = 'CheckpointViewError';
    this.code = code;
  }
}

export interface CheckpointViewChoiceV1 {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface CheckpointViewV1 {
  readonly token: string;
  readonly prompt: string;
  readonly choices: readonly CheckpointViewChoiceV1[];
}

export interface ReadCheckpointViewInputV1 {
  readonly workspace: TrustedCodexWorkspace;
  readonly run_id: string;
  readonly checkpoint: StoredCheckpointLocatorV1;
}

export interface AssertCheckpointResumeInputV1 extends ReadCheckpointViewInputV1 {
  readonly checkpoint_token: string;
  readonly choice_id: string;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
  readonly links: bigint;
}

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface RequestPathSnapshot {
  readonly directories: readonly DirectoryIdentity[];
  readonly file: FileIdentity;
}

interface ValidatedCheckpointInput {
  readonly workspace: string;
  readonly workspaceKey: string;
  readonly runId: string;
  readonly checkpoint: StoredCheckpointLocatorV1;
}

function pathError(error: unknown): CheckpointViewError {
  if (error instanceof CheckpointViewError) return error;
  return new CheckpointViewError(
    'checkpoint_request_unavailable',
    'The saved checkpoint request is unavailable.',
  );
}

function regularFileIdentity(info: BigIntStats): FileIdentity {
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    modified: info.mtimeNs,
    changed: info.ctimeNs,
    links: info.nlink,
  };
}

function descriptorFileIdentity(info: BigIntStats): FileIdentity {
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    modified: info.mtimeNs,
    changed: info.ctimeNs,
    links: info.nlink,
  };
}

function directoryIdentity(info: BigIntStats): DirectoryIdentity {
  return { device: info.dev, inode: info.ino };
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed &&
    left.links === right.links
  );
}

function samePathSnapshot(left: RequestPathSnapshot, right: RequestPathSnapshot): boolean {
  return (
    left.directories.length === right.directories.length &&
    left.directories.every((entry, index) => {
      const other = right.directories[index];
      return other !== undefined && sameDirectory(entry, other);
    }) &&
    sameFile(left.file, right.file)
  );
}

async function inspectRequestPath(input: ValidatedCheckpointInput): Promise<RequestPathSnapshot> {
  const segments = ['.circuit', 'runs', input.runId, ...input.checkpoint.request_path.split('/')];
  const directories: DirectoryIdentity[] = [];
  let cursor = input.workspace;

  try {
    const workspaceInfo = await lstat(cursor, { bigint: true });
    if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
      throw new CheckpointViewError(
        'workspace_unavailable',
        'The trusted Codex workspace is no longer a real directory.',
      );
    }
    directories.push(directoryIdentity(workspaceInfo));

    for (const segment of segments.slice(0, -1)) {
      cursor = join(cursor, segment);
      const info = await lstat(cursor, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new CheckpointViewError(
          'checkpoint_request_unsafe',
          'Circuit refused a checkpoint request path that crosses a link or non-directory.',
        );
      }
      directories.push(directoryIdentity(info));
    }

    cursor = join(cursor, segments.at(-1) ?? '');
    const fileInfo = await lstat(cursor, { bigint: true });
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.nlink !== 1n) {
      throw new CheckpointViewError(
        'checkpoint_request_unsafe',
        'Circuit refused a checkpoint request that is not one ordinary file.',
      );
    }
    return { directories, file: regularFileIdentity(fileInfo) };
  } catch (error) {
    throw pathError(error);
  }
}

async function requireValidatedInput(
  input: ReadCheckpointViewInputV1,
): Promise<ValidatedCheckpointInput> {
  const runId = RunId.safeParse(input.run_id);
  const checkpoint = StoredCheckpointLocatorSchemaV1.safeParse(input.checkpoint);
  if (!runId.success || !checkpoint.success) {
    throw new CheckpointViewError(
      'checkpoint_locator_invalid',
      'Circuit cannot read this checkpoint because its saved location is invalid.',
    );
  }
  if (
    input.workspace.identity_source !== CODEX_SANDBOX_METADATA_KEY &&
    input.workspace.identity_source !== CODEX_MCP_ROOTS_SOURCE
  ) {
    throw new CheckpointViewError(
      'workspace_unavailable',
      'Circuit did not receive the trusted Codex workspace identity.',
    );
  }

  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(input.workspace.workspace);
  } catch {
    throw new CheckpointViewError(
      'workspace_unavailable',
      'The trusted Codex workspace is unavailable.',
    );
  }
  if (canonicalWorkspace !== input.workspace.workspace) {
    throw new CheckpointViewError(
      'workspace_unavailable',
      'The trusted Codex workspace must already be canonical.',
    );
  }

  return {
    workspace: canonicalWorkspace,
    workspaceKey: sha256OfString(canonicalWorkspace),
    runId: runId.data,
    checkpoint: checkpoint.data,
  };
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_CHECKPOINT_REQUEST_BYTES) {
    const remaining = MAX_CHECKPOINT_REQUEST_BYTES + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > MAX_CHECKPOINT_REQUEST_BYTES) {
    throw new CheckpointViewError(
      'checkpoint_request_too_large',
      'The checkpoint request is larger than 256 KiB.',
    );
  }
  return Buffer.concat(chunks, total);
}

async function readStableRequestBytes(input: ValidatedCheckpointInput): Promise<Buffer> {
  const requestFile = join(
    input.workspace,
    '.circuit',
    'runs',
    input.runId,
    ...input.checkpoint.request_path.split('/'),
  );
  const pathBefore = await inspectRequestPath(input);
  if (pathBefore.file.size > BigInt(MAX_CHECKPOINT_REQUEST_BYTES)) {
    throw new CheckpointViewError(
      'checkpoint_request_too_large',
      'The checkpoint request is larger than 256 KiB.',
    );
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      requestFile,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const descriptorBeforeInfo = await handle.stat({ bigint: true });
    if (
      !descriptorBeforeInfo.isFile() ||
      descriptorBeforeInfo.nlink !== 1n ||
      descriptorBeforeInfo.size > BigInt(MAX_CHECKPOINT_REQUEST_BYTES)
    ) {
      throw new CheckpointViewError(
        descriptorBeforeInfo.size > BigInt(MAX_CHECKPOINT_REQUEST_BYTES)
          ? 'checkpoint_request_too_large'
          : 'checkpoint_request_unsafe',
        descriptorBeforeInfo.size > BigInt(MAX_CHECKPOINT_REQUEST_BYTES)
          ? 'The checkpoint request is larger than 256 KiB.'
          : 'Circuit refused a checkpoint request that is not one ordinary file.',
      );
    }
    const descriptorBefore = descriptorFileIdentity(descriptorBeforeInfo);
    const pathAfterOpen = await inspectRequestPath(input);
    if (
      !samePathSnapshot(pathBefore, pathAfterOpen) ||
      !sameFile(pathBefore.file, descriptorBefore)
    ) {
      throw new CheckpointViewError(
        'checkpoint_request_unsafe',
        'The checkpoint request changed while Circuit opened it.',
      );
    }

    const bytes = await readBounded(handle);
    const descriptorAfter = descriptorFileIdentity(await handle.stat({ bigint: true }));
    const pathAfterRead = await inspectRequestPath(input);
    if (
      !sameFile(descriptorBefore, descriptorAfter) ||
      !samePathSnapshot(pathAfterOpen, pathAfterRead) ||
      BigInt(bytes.byteLength) !== descriptorAfter.size
    ) {
      throw new CheckpointViewError(
        'checkpoint_request_unsafe',
        'The checkpoint request changed while Circuit read it.',
      );
    }
    return bytes;
  } catch (error) {
    throw pathError(error);
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

function requestBody(bytes: Buffer): z.infer<typeof CheckpointRequestV1> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CheckpointViewError(
      'checkpoint_request_invalid',
      'The checkpoint request is not valid UTF-8.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new CheckpointViewError(
      'checkpoint_request_invalid',
      'The checkpoint request is not valid JSON.',
    );
  }
  const parsed = CheckpointRequestV1.safeParse(raw);
  if (!parsed.success) {
    throw new CheckpointViewError(
      'checkpoint_request_invalid',
      'The checkpoint request does not match the supported format.',
    );
  }
  return parsed.data;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function checkpointBindingSha256(input: {
  readonly workspace_key: string;
  readonly run_id: string;
  readonly checkpoint: StoredCheckpointLocatorV1;
}): string {
  return sha256OfJson({
    schema: 'circuit.mcp.checkpoint-binding@v1',
    workspace_key: input.workspace_key,
    run_id: input.run_id,
    generation: input.checkpoint.generation,
    step_id: input.checkpoint.step_id,
    attempt: input.checkpoint.attempt,
    request_path: input.checkpoint.request_path,
    request_sha256: input.checkpoint.request_sha256,
    allowed_choices: input.checkpoint.allowed_choices,
  });
}

function checkpointToken(input: {
  readonly workspaceKey: string;
  readonly runId: string;
  readonly checkpoint: StoredCheckpointLocatorV1;
}): string {
  return `cpt1.${checkpointBindingSha256({
    workspace_key: input.workspaceKey,
    run_id: input.runId,
    checkpoint: input.checkpoint,
  })}`;
}

function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readCheckpointView(
  input: ReadCheckpointViewInputV1,
): Promise<CheckpointViewV1> {
  const validated = await requireValidatedInput(input);
  const bytes = await readStableRequestBytes(validated);
  if (sha256OfBytes(bytes) !== validated.checkpoint.request_sha256) {
    throw new CheckpointViewError(
      'checkpoint_stale',
      'This checkpoint request has changed. Reload the current checkpoint and try again.',
    );
  }
  const request = requestBody(bytes);
  if (
    request.step_id !== validated.checkpoint.step_id ||
    !sameStrings(request.allowed_choices, validated.checkpoint.allowed_choices)
  ) {
    throw new CheckpointViewError(
      'checkpoint_stale',
      'This checkpoint request no longer matches the saved run. Reload it and try again.',
    );
  }

  return {
    token: checkpointToken(validated),
    prompt: request.prompt,
    choices: request.choices.map((choice) => ({
      id: choice.id,
      label: choice.label ?? choice.id,
      ...(choice.description === undefined ? {} : { description: choice.description }),
    })),
  };
}

function validCheckpointToken(token: string): boolean {
  return CHECKPOINT_TOKEN_PATTERN.test(token);
}

function tokenMatches(actual: string, expected: string): boolean {
  if (!validCheckpointToken(actual) || !validCheckpointToken(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'ascii'), Buffer.from(expected, 'ascii'));
}

export async function assertCheckpointResume(
  input: AssertCheckpointResumeInputV1,
): Promise<CheckpointViewV1> {
  if (!validCheckpointToken(input.checkpoint_token)) {
    throw new CheckpointViewError(
      'checkpoint_token_invalid',
      'The checkpoint token is invalid. Reload the current checkpoint and try again.',
    );
  }
  const view = await readCheckpointView(input);
  if (!tokenMatches(input.checkpoint_token, view.token)) {
    throw new CheckpointViewError(
      'checkpoint_stale',
      'This checkpoint is stale. Reload the current checkpoint and try again.',
    );
  }
  if (!view.choices.some((choice) => choice.id === input.choice_id)) {
    throw new CheckpointViewError(
      'choice_unavailable',
      'That choice is not available. Reload the current checkpoint and try again.',
    );
  }
  return view;
}
