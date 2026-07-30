import { Buffer } from 'node:buffer';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

import type { McpRuntimeAssetPins } from './asset-pins.js';

export const SUPERVISOR_PROTOCOL_VERSION = 1 as const;
export const MAX_SUPERVISOR_MESSAGE_BYTES = 1_048_576;

const AbsolutePath = z.string().min(1).max(4_096).refine(isAbsolute, 'must be an absolute path');
const Timestamp = z.iso.datetime();
const Pid = z.number().int().positive().max(2_147_483_647);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const RunId = z.guid();

export const SupervisorRuntimeAssetPinV1 = z
  .object({
    id: z.string().min(1).max(128),
    role: z.enum(['node', 'codex', 'plugin_runtime', 'git_helper', 'packaged_flow']),
    source_path: AbsolutePath,
    real_path: AbsolutePath,
    device: z.string().min(1).max(64),
    inode: z.string().min(1).max(64),
    mode: z.number().int().nonnegative().max(0xffff_ffff),
    byte_length: z
      .number()
      .int()
      .nonnegative()
      .max(512 * 1_048_576),
    sha256: Sha256,
  })
  .strict();

export const SupervisorRuntimeAssetsV1 = z
  .object({
    schema_version: z.literal(1),
    digest_sha256: Sha256,
    assets: z.array(SupervisorRuntimeAssetPinV1).min(1).max(512),
  })
  .strict();
export type SupervisorRuntimeAssets = McpRuntimeAssetPins;

function isPlainJson(value: unknown, seen: Set<object>, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => isPlainJson(item, seen, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value).every((item) => isPlainJson(item, seen, depth + 1));
  } finally {
    seen.delete(value);
  }
}

const BoundedJson = z.unknown().superRefine((value, ctx) => {
  if (!isPlainJson(value, new Set<object>(), 0)) {
    ctx.addIssue({ code: 'custom', message: 'launch payload must be plain JSON' });
    return;
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SUPERVISOR_MESSAGE_BYTES / 2) {
    ctx.addIssue({ code: 'custom', message: 'launch payload is too large' });
  }
});

export const SupervisorProcessObservationV1 = z
  .object({
    pid: Pid,
    process_group_id: Pid,
    birth_token: z.string().trim().min(1).max(256),
    started_at: Timestamp,
  })
  .strict();
export type SupervisorProcessObservation = z.infer<typeof SupervisorProcessObservationV1>;

export const SupervisorExecutableIdentityV1 = z
  .object({
    real_path: AbsolutePath,
    device: z.string().min(1).max(64),
    inode: z.string().min(1).max(64),
    sha256: Sha256,
  })
  .strict();

export const SupervisorHelloV1 = z
  .object({
    schema_version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
    kind: z.literal('supervisor_ready'),
    supervisor: SupervisorProcessObservationV1,
  })
  .strict();
export type SupervisorHello = z.infer<typeof SupervisorHelloV1>;

export const SupervisorAuthorizationV1 = z
  .object({
    schema_version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
    kind: z.literal('launch_authorization'),
    authorization_token: Sha256,
    run_id: RunId,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    control_directory: AbsolutePath,
    runtime_assets: SupervisorRuntimeAssetsV1,
    worker: z
      .object({
        node_executable: AbsolutePath,
        entrypoint: AbsolutePath,
        launch_payload: BoundedJson,
      })
      .strict(),
    limits: z
      .object({
        worker_start_ms: z.number().int().min(100).max(30_000),
        terminate_ms: z.number().int().min(100).max(30_000),
        kill_ms: z.number().int().min(100).max(30_000),
        stdout_bytes: z
          .number()
          .int()
          .min(1_024)
          .max(16 * 1_048_576),
        stderr_bytes: z
          .number()
          .int()
          .min(1_024)
          .max(16 * 1_048_576),
      })
      .strict(),
  })
  .strict();
export type SupervisorAuthorization = z.infer<typeof SupervisorAuthorizationV1>;

export const SupervisorRuntimeStartedV1 = z
  .object({
    schema_version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
    kind: z.literal('runtime_started'),
    authorization_sha256: Sha256,
    runtime: SupervisorProcessObservationV1,
  })
  .strict();
export type SupervisorRuntimeStarted = z.infer<typeof SupervisorRuntimeStartedV1>;

export const SupervisorLaunchFailureV1 = z
  .object({
    schema_version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
    kind: z.literal('launch_failed'),
    stage: z.enum(['authorization', 'journal', 'worker_spawn', 'worker_identity']),
    message: z.string().trim().min(1).max(1_000),
    cleanup_confirmed: z.boolean(),
  })
  .strict();
export type SupervisorLaunchFailure = z.infer<typeof SupervisorLaunchFailureV1>;

export const SupervisorMessageV1 = z.discriminatedUnion('kind', [
  SupervisorHelloV1,
  SupervisorRuntimeStartedV1,
  SupervisorLaunchFailureV1,
]);
export type SupervisorMessage = z.infer<typeof SupervisorMessageV1>;

export const RuntimeJournalV1 = z
  .object({
    schema_version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
    record_kind: z.literal('circuit.mcp.runtime-observation'),
    run_id: RunId,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    authorization_sha256: Sha256,
    runtime: SupervisorProcessObservationV1,
    runtime_executable: SupervisorExecutableIdentityV1,
    recorded_at: Timestamp,
  })
  .strict();
export type RuntimeJournal = z.infer<typeof RuntimeJournalV1>;

export const ExitJournalV1 = z
  .object({
    schema_version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
    record_kind: z.literal('circuit.mcp.exit-observation'),
    run_id: RunId,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    authorization_sha256: Sha256,
    runtime: SupervisorProcessObservationV1,
    observed_at: Timestamp,
    exit_code: z.number().int().min(-1).max(255).optional(),
    signal: z.string().min(1).max(64).optional(),
    process_group_cleanup: z.enum(['confirmed', 'unconfirmed']),
    output_limit_exceeded: z.enum(['stdout', 'stderr']).optional(),
    // The newest worker stderr, kept so a worker that dies on startup still
    // leaves its own explanation behind. Progress lines share this stream and
    // are filtered out by the consumer, not here.
    stderr_tail: z.string().min(1).max(8_192).optional(),
  })
  .strict();
export type ExitJournal = z.infer<typeof ExitJournalV1>;

export function encodeSupervisorMessage(value: unknown): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (encoded.byteLength > MAX_SUPERVISOR_MESSAGE_BYTES) {
    throw new Error('supervisor message exceeds the protocol limit');
  }
  return encoded;
}

export function decodeSupervisorMessage<T>(bytes: Buffer, schema: z.ZodType<T>): T {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SUPERVISOR_MESSAGE_BYTES) {
    throw new Error('supervisor message has an invalid size');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('supervisor message is not valid JSON');
  }
  return schema.parse(value);
}
