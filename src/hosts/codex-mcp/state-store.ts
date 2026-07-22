import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { sha256OfJson } from '../../schemas/hashing.js';
import { checkpointBindingSha256 } from './checkpoint-view.js';
import { CircuitStartInputV1, McpRunStateV1 } from './contracts.js';
import { CODEX_MCP_ROOTS_SOURCE, CODEX_SANDBOX_METADATA_KEY } from './resources.js';

const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = z.guid({ error: 'run_id must be a UUID' });
const MAX_STATE_BYTES = 1_048_576;
const MAX_CONTROL_BYTES = 65_536;
const MAX_WORKSPACE_RUN_ENTRIES = 1_000;
const MAX_RETENTION_SCAN_ENTRIES = 10_000;
const TERMINAL_STATES = new Set(['complete', 'needs_attention', 'cancelled', 'interrupted']);
const RETENTION_TOMBSTONE = /^\.retention\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.tmp$/;
const START_STAGING_DIRECTORY = /^\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.tmp$/;

const IsoTimestamp = z.iso.datetime();
const Sha256 = z.string().regex(SHA256);
const Summary = z.string().trim().min(1).max(1_000);
const SafeIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@/-]*$/);
const CheckpointIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 4_096) return false;
  if (value.includes('\\') || value.includes('\0') || isAbsolute(value)) return false;
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return false;
  return normalize(value).split(sep).join('/') === value;
}

const SafeRelativePath = z
  .string()
  .refine(isSafeRelativePath, 'must be a normalized relative path');
const AbsolutePath = z.string().min(1).max(4_096).refine(isAbsolute, 'must be an absolute path');

export const McpWorkspaceIdentityV1 = z
  .object({
    key: Sha256,
    canonical_path: AbsolutePath,
    device: z.string().min(1).max(64),
    inode: z.string().min(1).max(64),
    identity_source: z
      .enum([CODEX_SANDBOX_METADATA_KEY, CODEX_MCP_ROOTS_SOURCE])
      .default(CODEX_SANDBOX_METADATA_KEY),
  })
  .strict();
export type McpWorkspaceIdentity = z.infer<typeof McpWorkspaceIdentityV1>;

const ExecutableIdentityV1 = z
  .object({
    real_path: AbsolutePath,
    device: z.string().min(1).max(64),
    inode: z.string().min(1).max(64),
    sha256: Sha256,
  })
  .strict();

export const ProcessIdentityV1 = z
  .object({
    pid: z.number().int().positive().max(2_147_483_647),
    process_group_id: z.number().int().positive().max(2_147_483_647),
    started_at: IsoTimestamp,
    birth_token: z.string().min(1).max(256),
    executable: ExecutableIdentityV1,
  })
  .strict();
export type ProcessIdentity = z.infer<typeof ProcessIdentityV1>;

export const ProcessOwnerIdentityV1 = ProcessIdentityV1.extend({
  instance_id: z.string().min(1).max(128),
}).strict();
export type ProcessOwnerIdentity = z.infer<typeof ProcessOwnerIdentityV1>;

export type ProcessStatus = 'alive' | 'absent' | 'unknown';

const StoredExitV1 = z
  .object({
    observed_at: IsoTimestamp,
    exit_code: z.number().int().min(-1).max(255).optional(),
    signal: z.string().min(1).max(64).optional(),
    process_group_cleanup: z.enum(['confirmed', 'unconfirmed']),
  })
  .strict();

export const StoredLaunchV1 = z
  .object({
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    allocation_owner: ProcessOwnerIdentityV1,
    phase: z.enum([
      'reserved',
      'supervisor_recorded',
      'launch_authorized',
      'runtime_recorded',
      'exited',
    ]),
    supervisor: ProcessIdentityV1.optional(),
    runtime: ProcessIdentityV1.optional(),
    authorization_sha256: Sha256.optional(),
    authorized_at: IsoTimestamp.optional(),
    exit: StoredExitV1.optional(),
  })
  .strict()
  .superRefine((launch, ctx) => {
    if (launch.phase === 'supervisor_recorded' && launch.supervisor === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['supervisor'],
        message: 'supervisor identity is required',
      });
    }
    if (
      (launch.phase === 'launch_authorized' || launch.phase === 'runtime_recorded') &&
      (launch.supervisor === undefined ||
        launch.authorization_sha256 === undefined ||
        launch.authorized_at === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['phase'],
        message: 'authorized launch requires supervisor identity and authorization evidence',
      });
    }
    if (launch.phase === 'runtime_recorded' && launch.runtime === undefined) {
      ctx.addIssue({ code: 'custom', path: ['runtime'], message: 'runtime identity is required' });
    }
    if (
      launch.runtime !== undefined &&
      launch.authorization_sha256 !== undefined &&
      launch.runtime.birth_token !== launch.authorization_sha256
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['runtime', 'birth_token'],
        message: 'worker identity must use the committed launch token',
      });
    }
    if (launch.phase === 'exited' && launch.exit === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['exit'],
        message: 'exited launch requires exit evidence',
      });
    }
    if (launch.phase !== 'exited' && launch.exit !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['exit'],
        message: 'exit evidence is allowed only after launch exit',
      });
    }
    if (
      launch.phase === 'reserved' &&
      (launch.supervisor !== undefined ||
        launch.runtime !== undefined ||
        launch.authorization_sha256 !== undefined ||
        launch.authorized_at !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['phase'],
        message: 'reserved launch must not carry process or authorization evidence',
      });
    }
    if (
      launch.phase === 'supervisor_recorded' &&
      (launch.runtime !== undefined ||
        launch.authorization_sha256 !== undefined ||
        launch.authorized_at !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['phase'],
        message: 'supervisor_recorded must not carry later launch evidence',
      });
    }
    if (launch.phase === 'launch_authorized' && launch.runtime !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['runtime'],
        message: 'runtime identity is allowed only after it is recorded',
      });
    }
  });
export type StoredLaunch = z.infer<typeof StoredLaunchV1>;

export const StoredCheckpointV1 = z
  .object({
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    step_id: CheckpointIdentifier,
    attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    request_path: SafeRelativePath.refine((value) => value.length <= 2_048),
    request_sha256: Sha256,
    allowed_choices: z.array(CheckpointIdentifier.max(64)).min(1).max(20),
    choices_sha256: Sha256,
  })
  .strict()
  .superRefine((checkpoint, ctx) => {
    if (new Set(checkpoint.allowed_choices).size !== checkpoint.allowed_choices.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowed_choices'],
        message: 'checkpoint choices must be unique',
      });
    }
    if (checkpoint.choices_sha256 !== sha256OfJson(checkpoint.allowed_choices)) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices_sha256'],
        message: 'choices_sha256 must bind the ordered allowed choices',
      });
    }
  });
export type StoredCheckpoint = z.infer<typeof StoredCheckpointV1>;

const StoredFinalReportV1 = z
  .object({
    schema: SafeIdentifier,
    path: SafeRelativePath,
    sha256: Sha256,
    byte_length: z.number().int().nonnegative().max(262_144),
    summary: Summary,
  })
  .strict();

const StoredProgressEventV1 = z
  .object({
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    kind: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9._-]*$/),
    recorded_at: IsoTimestamp,
    summary: Summary,
  })
  .strict();

const StoredProgressV1 = z
  .object({
    next_cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    retained_from_cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    dropped_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    events: z.array(StoredProgressEventV1).max(512),
  })
  .strict()
  .superRefine((progress, ctx) => {
    let previous = progress.retained_from_cursor - 1;
    for (const [index, event] of progress.events.entries()) {
      if (event.cursor <= previous || event.cursor >= progress.next_cursor) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', index, 'cursor'],
          message: 'progress cursors must be strictly increasing and below next_cursor',
        });
      }
      previous = event.cursor;
    }
  });

const StoredFailureV1 = z
  .object({
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    message: z.string().trim().min(1).max(1_000),
  })
  .strict();

const RecoveryStatus = z.enum(['alive', 'absent', 'unknown']);
export const StoredRecoveryV1 = z
  .object({
    reason: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_]*$/),
    detected_at: IsoTimestamp,
    last_checked_at: IsoTimestamp,
    owner_status: RecoveryStatus.optional(),
    supervisor_status: RecoveryStatus.optional(),
    runtime_status: RecoveryStatus.optional(),
    process_group_status: RecoveryStatus.optional(),
    cancellation_requested: z.boolean(),
  })
  .strict();
export type StoredRecovery = z.infer<typeof StoredRecoveryV1>;

// CircuitStartInputV1 intentionally supplies `web_search: off` to public
// callers. Durable records are stricter: the normalized value must already be
// present on disk rather than being silently invented while a record is read.
const StoredStartInputV1 = z.intersection(
  CircuitStartInputV1,
  z.object({ web_search: z.enum(['off', 'cached']) }),
);

export const McpRunRecordV1 = z
  .object({
    schema_version: z.literal(1),
    record_kind: z.literal('circuit.mcp.run-state'),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    run_id: RUN_ID,
    lease_id: z.guid(),
    workspace: McpWorkspaceIdentityV1,
    request: StoredStartInputV1,
    state: McpRunStateV1,
    summary: Summary,
    runtime_assets_sha256: Sha256,
    run_relative_path: SafeRelativePath,
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
    finished_at: IsoTimestamp.optional(),
    allocation: z.object({ owner: ProcessOwnerIdentityV1, created_at: IsoTimestamp }).strict(),
    launch: StoredLaunchV1,
    progress: StoredProgressV1,
    checkpoint: StoredCheckpointV1.optional(),
    final_report: StoredFinalReportV1.optional(),
    failure: StoredFailureV1.optional(),
    recovery: StoredRecoveryV1.optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.workspace.key !== workspaceKey(record.workspace.canonical_path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['workspace', 'key'],
        message: 'workspace key mismatch',
      });
    }
    if (record.run_relative_path !== `.circuit/runs/${record.run_id}`) {
      ctx.addIssue({
        code: 'custom',
        path: ['run_relative_path'],
        message: 'run path must be derived from run_id',
      });
    }
    if (
      record.launch.generation === 1 &&
      !sameProcessOwner(record.launch.allocation_owner, record.allocation.owner)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['launch', 'allocation_owner'],
        message: 'first launch generation must retain its allocation owner',
      });
    }
    if (record.state === 'waiting_for_input' && record.checkpoint === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkpoint'],
        message: 'waiting state requires checkpoint',
      });
    }
    if (record.state !== 'waiting_for_input' && record.checkpoint !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkpoint'],
        message: 'checkpoint is allowed only while waiting',
      });
    }
    if (
      record.checkpoint !== undefined &&
      record.checkpoint.generation !== record.launch.generation
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkpoint', 'generation'],
        message: 'checkpoint generation must match the current launch generation',
      });
    }
    if (record.state === 'complete' && record.final_report === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['final_report'],
        message: 'complete state requires final report',
      });
    }
    if (record.state !== 'complete' && record.final_report !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['final_report'],
        message: 'final report is allowed only for complete state',
      });
    }
    if (record.state === 'recovery_required' && record.recovery === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['recovery'],
        message: 'recovery_required state requires recovery evidence',
      });
    }
    const terminal = TERMINAL_STATES.has(record.state);
    if (terminal !== (record.finished_at !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['finished_at'],
        message: 'finished_at must exist exactly for terminal states',
      });
    }
    if (terminal && record.launch.exit?.process_group_cleanup !== 'confirmed') {
      ctx.addIssue({
        code: 'custom',
        path: ['launch', 'exit', 'process_group_cleanup'],
        message: 'terminal state requires confirmed process-group cleanup',
      });
    }
    if (
      record.state === 'waiting_for_input' &&
      record.launch.exit?.process_group_cleanup !== 'confirmed'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['launch', 'exit', 'process_group_cleanup'],
        message: 'waiting state requires confirmed process-group cleanup',
      });
    }
    if (
      record.state === 'running' &&
      record.launch.phase !== 'runtime_recorded' &&
      record.launch.phase !== 'exited'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['launch', 'phase'],
        message: 'running state requires a recorded runtime identity',
      });
    }
    if (
      (record.state === 'running' ||
        record.state === 'waiting_for_input' ||
        record.state === 'complete') &&
      record.launch.runtime === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['launch', 'runtime'],
        message: `${record.state} state requires a recorded runtime identity`,
      });
    }
    if (record.state === 'waiting_for_input' && record.launch.phase !== 'exited') {
      ctx.addIssue({
        code: 'custom',
        path: ['launch', 'phase'],
        message: 'waiting state requires an exited launch',
      });
    }
    if (record.state === 'resuming' && record.launch.generation < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['launch', 'generation'],
        message: 'resuming state requires a new launch generation',
      });
    }
  });
export type McpRunRecord = z.infer<typeof McpRunRecordV1>;

const WorkspaceLeaseRecordV1 = z
  .object({
    schema_version: z.literal(1),
    record_kind: z.literal('circuit.mcp.workspace-lease'),
    lease_id: z.guid(),
    workspace: McpWorkspaceIdentityV1,
    run_id: RUN_ID,
    staging_name: z
      .string()
      .min(1)
      .max(200)
      .regex(/^\.[0-9a-f-]+\.[0-9a-f-]+\.tmp$/),
    allocation_owner: ProcessOwnerIdentityV1,
    acquired_at: IsoTimestamp,
  })
  .strict();
type WorkspaceLeaseRecord = z.infer<typeof WorkspaceLeaseRecordV1>;

const WorkspaceGuardRecordV1 = z
  .object({
    schema_version: z.literal(1),
    record_kind: z.enum(['circuit.mcp.workspace-guard', 'circuit.mcp.workspace-guard-reclaim']),
    guard_id: z.guid(),
    workspace_key: Sha256,
    owner: ProcessOwnerIdentityV1,
    acquired_at: IsoTimestamp,
  })
  .strict();
type WorkspaceGuardRecord = z.infer<typeof WorkspaceGuardRecordV1>;

const OperationNameV1 = z.enum([
  'resume',
  'cancel',
  'reconcile',
  'recover',
  'retention',
  'reclaim',
]);
export type OperationName = z.infer<typeof OperationNameV1>;

export const OperationClaimRecordV1 = z
  .object({
    schema_version: z.literal(1),
    record_kind: z.literal('circuit.mcp.operation-claim'),
    claim_id: z.guid(),
    run_id: RUN_ID,
    workspace_key: Sha256,
    operation: OperationNameV1,
    expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    checkpoint_binding_sha256: Sha256.optional(),
    owner: ProcessOwnerIdentityV1,
    acquired_at: IsoTimestamp,
  })
  .strict();
export type OperationClaimRecord = z.infer<typeof OperationClaimRecordV1>;

export class McpStateStoreError extends Error {
  readonly code: string;
  readonly next_action: string | undefined;

  constructor(code: string, message: string, nextAction?: string) {
    super(message);
    this.name = 'McpStateStoreError';
    this.code = code;
    this.next_action = nextAction;
  }
}

export function workspaceKey(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath, 'utf8').digest('hex');
}

export function trustedWorkspaceIdentity(
  path: string,
  identitySource: McpWorkspaceIdentity['identity_source'] = CODEX_SANDBOX_METADATA_KEY,
): McpWorkspaceIdentity {
  let direct: Stats;
  try {
    direct = lstatSync(path);
  } catch {
    throw new McpStateStoreError('workspace_invalid', 'The trusted workspace does not exist.');
  }
  if (direct.isSymbolicLink() || !direct.isDirectory()) {
    throw new McpStateStoreError(
      'workspace_invalid',
      'The trusted workspace must be a real directory, not a symbolic link.',
    );
  }
  const canonicalPath = realpathSync.native(path);
  const stat = statSync(canonicalPath);
  return McpWorkspaceIdentityV1.parse({
    key: workspaceKey(canonicalPath),
    canonical_path: canonicalPath,
    device: String(stat.dev),
    inode: String(stat.ino),
    identity_source: identitySource,
  });
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function sameWorkspace(left: McpWorkspaceIdentity, right: McpWorkspaceIdentity): boolean {
  return (
    left.key === right.key &&
    left.canonical_path === right.canonical_path &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function sameProcessOwner(left: ProcessOwnerIdentity, right: ProcessOwnerIdentity): boolean {
  return (
    left.instance_id === right.instance_id &&
    left.pid === right.pid &&
    left.process_group_id === right.process_group_id &&
    left.started_at === right.started_at &&
    left.birth_token === right.birth_token &&
    left.executable.real_path === right.executable.real_path &&
    left.executable.device === right.executable.device &&
    left.executable.inode === right.executable.inode &&
    left.executable.sha256 === right.executable.sha256
  );
}

function sameOperationClaim(left: OperationClaimRecord, right: OperationClaimRecord): boolean {
  return (
    left.claim_id === right.claim_id &&
    left.run_id === right.run_id &&
    left.workspace_key === right.workspace_key &&
    left.operation === right.operation &&
    left.expected_revision === right.expected_revision &&
    left.checkpoint_binding_sha256 === right.checkpoint_binding_sha256 &&
    left.acquired_at === right.acquired_at &&
    sameProcessOwner(left.owner, right.owner)
  );
}

function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.process_group_id === right.process_group_id &&
    left.started_at === right.started_at &&
    left.birth_token === right.birth_token &&
    left.executable.real_path === right.executable.real_path &&
    left.executable.device === right.executable.device &&
    left.executable.inode === right.executable.inode &&
    left.executable.sha256 === right.executable.sha256
  );
}

function storedCheckpointBinding(record: McpRunRecord): string | undefined {
  if (record.checkpoint === undefined) return undefined;
  return checkpointBindingSha256({
    workspace_key: record.workspace.key,
    run_id: record.run_id,
    checkpoint: record.checkpoint,
  });
}

function assertCurrentWorkspace(workspace: McpWorkspaceIdentity): void {
  const parsed = McpWorkspaceIdentityV1.parse(workspace);
  if (parsed.key !== workspaceKey(parsed.canonical_path)) {
    throw new McpStateStoreError(
      'workspace_changed',
      'The trusted workspace identity has changed.',
    );
  }
  let current: McpWorkspaceIdentity;
  try {
    current = trustedWorkspaceIdentity(parsed.canonical_path, parsed.identity_source);
  } catch {
    throw new McpStateStoreError(
      'workspace_changed',
      'The trusted workspace is no longer available.',
    );
  }
  if (!sameWorkspace(parsed, current)) {
    throw new McpStateStoreError(
      'workspace_changed',
      'The trusted workspace identity has changed.',
    );
  }
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new McpStateStoreError(
      'state_unsafe_directory',
      `Circuit state path is not a real directory: ${path}`,
    );
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new McpStateStoreError(
      'state_permissions',
      `Circuit state directory is not private: ${path}`,
    );
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new McpStateStoreError(
      'state_owner',
      `Circuit state directory has the wrong owner: ${path}`,
    );
  }
}

function ensurePrivateDirectory(path: string, recursive = false): void {
  try {
    mkdirSync(path, { mode: 0o700, recursive });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  assertPrivateDirectory(path);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readDirectoryBounded(
  path: string,
  maximumEntries: number,
  code: string,
  message: string,
  nextAction?: string,
): Dirent[] {
  const directory = opendirSync(path);
  const entries: Dirent[] = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) return entries;
      if (entries.length === maximumEntries) {
        throw new McpStateStoreError(code, message, nextAction);
      }
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stageCompleteFile(target: string, contents: string): string {
  const stage = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const fd = openSync(
    stage,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    rmSync(stage, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
  return stage;
}

function createJsonExclusive(target: string, value: unknown): boolean {
  const stage = stageCompleteFile(target, jsonBytes(value));
  let created = false;
  try {
    try {
      linkSync(stage, target);
      created = true;
      fsyncDirectory(dirname(target));
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    return created;
  } finally {
    rmSync(stage, { force: true });
    fsyncDirectory(dirname(target));
  }
}

function replaceJsonAtomic(target: string, value: unknown): void {
  const stage = stageCompleteFile(target, jsonBytes(value));
  try {
    renameSync(stage, target);
    fsyncDirectory(dirname(target));
  } catch (error) {
    rmSync(stage, { force: true });
    throw error;
  }
}

function assertPrivateRegularFile(path: string, stat: Stats): void {
  if (!stat.isFile()) {
    throw new McpStateStoreError(
      'state_unsafe_file',
      `Circuit state is not a regular file: ${path}`,
    );
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new McpStateStoreError('state_permissions', `Circuit state file is not private: ${path}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new McpStateStoreError('state_owner', `Circuit state file has the wrong owner: ${path}`);
  }
}

class TransientStateRead extends Error {}

function readStrictJsonOnce<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes: number,
  corruptCode: string,
): T {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === 'ELOOP') {
      throw new McpStateStoreError(
        'state_unsafe_file',
        `Circuit state path is a symbolic link: ${path}`,
      );
    }
    throw error;
  }
  try {
    const before = fstatSync(fd);
    assertPrivateRegularFile(path, before);
    if (before.size > maxBytes) {
      throw new McpStateStoreError(corruptCode, `Circuit state file is too large: ${path}`);
    }
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    let atPath: Stats;
    try {
      atPath = lstatSync(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new TransientStateRead();
      throw error;
    }
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new McpStateStoreError(
        corruptCode,
        `Circuit state bytes changed while they were being read: ${path}`,
      );
    }
    if (atPath.isSymbolicLink()) {
      throw new McpStateStoreError('state_unsafe_file', `Circuit state became a link: ${path}`);
    }
    if (after.dev !== atPath.dev || after.ino !== atPath.ino) throw new TransientStateRead();
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new McpStateStoreError(corruptCode, `Circuit state contains invalid JSON: ${path}`);
    }
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) {
      throw new McpStateStoreError(corruptCode, `Circuit state has an invalid record: ${path}`);
    }
    return parsed.data;
  } finally {
    closeSync(fd);
  }
}

function readStrictJson<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes: number,
  corruptCode: string,
): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return readStrictJsonOnce(path, schema, maxBytes, corruptCode);
    } catch (error) {
      if (error instanceof TransientStateRead || errorCode(error) === 'ENOENT') {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  if (errorCode(lastError) === 'ENOENT') throw lastError;
  throw new McpStateStoreError(
    'state_read_busy',
    `Circuit state kept changing while it was read: ${path}`,
  );
}

function unlinkExactClaim(path: string, expected: OperationClaimRecord): void {
  const current = readStrictJson(
    path,
    OperationClaimRecordV1,
    MAX_CONTROL_BYTES,
    'operation_claim_corrupt',
  );
  if (current.claim_id !== expected.claim_id || !sameProcessOwner(current.owner, expected.owner)) {
    throw new McpStateStoreError(
      'operation_claim_changed',
      'The operation claim was replaced before it could be released.',
    );
  }
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function unlinkExactLease(path: string, expected: WorkspaceLeaseRecord): void {
  const current = readStrictJson(path, WorkspaceLeaseRecordV1, MAX_CONTROL_BYTES, 'lease_corrupt');
  if (current.lease_id !== expected.lease_id || current.run_id !== expected.run_id) {
    throw new McpStateStoreError('lease_changed', 'The workspace lease changed before release.');
  }
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function unlinkExactWorkspaceGuard(path: string, expected: WorkspaceGuardRecord): void {
  const current = readStrictJson(
    path,
    WorkspaceGuardRecordV1,
    MAX_CONTROL_BYTES,
    'workspace_guard_corrupt',
  );
  if (
    current.guard_id !== expected.guard_id ||
    current.record_kind !== expected.record_kind ||
    !sameProcessOwner(current.owner, expected.owner)
  ) {
    throw new McpStateStoreError(
      'workspace_guard_changed',
      'The workspace guard changed before release.',
    );
  }
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<McpRunRecord['state'], ReadonlySet<McpRunRecord['state']>>
> = {
  starting: new Set([
    'running',
    'waiting_for_input',
    'cancelling',
    'complete',
    'needs_attention',
    'interrupted',
    'recovery_required',
  ]),
  running: new Set([
    'waiting_for_input',
    'cancelling',
    'complete',
    'needs_attention',
    'interrupted',
    'recovery_required',
  ]),
  waiting_for_input: new Set(['resuming', 'cancelling', 'cancelled', 'recovery_required']),
  resuming: new Set([
    'running',
    'waiting_for_input',
    'cancelling',
    'complete',
    'needs_attention',
    'interrupted',
    'recovery_required',
  ]),
  cancelling: new Set(['cancelled', 'recovery_required']),
  recovery_required: new Set(['recovery_required', 'interrupted', 'cancelled']),
  complete: new Set(),
  needs_attention: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

const ALLOWED_LAUNCH_TRANSITIONS: Readonly<
  Record<StoredLaunch['phase'], ReadonlySet<StoredLaunch['phase']>>
> = {
  reserved: new Set(['supervisor_recorded', 'exited']),
  supervisor_recorded: new Set(['launch_authorized', 'exited']),
  launch_authorized: new Set(['runtime_recorded', 'exited']),
  runtime_recorded: new Set(['exited']),
  exited: new Set(),
};

export interface OperationHandle {
  readonly claim: OperationClaimRecord;
}

interface OperationMetadata {
  readonly workspace: McpWorkspaceIdentity;
  readonly runId: string;
  revision: number;
  released: boolean;
}

interface WorkspaceGuardHandle {
  readonly path: string;
  readonly record: WorkspaceGuardRecord;
  released: boolean;
}

export type AcquireOperationResult =
  | { readonly ok: true; readonly handle: OperationHandle }
  | {
      readonly ok: false;
      readonly code: 'operation_in_progress' | 'operation_owner_unknown';
      readonly message: string;
    };

export interface McpStateStoreOptions {
  readonly stateRoot: string;
  readonly now?: () => Date;
  readonly randomId?: () => string;
  readonly inspectProcess?: (identity: ProcessIdentity) => ProcessStatus;
  readonly inspectProcessGroup?: (identity: ProcessIdentity) => ProcessStatus;
  readonly inspectProcessToken?: (token: string) => ProcessStatus;
  readonly beforeTerminalLeaseRelease?: (record: McpRunRecord) => void;
  readonly beforeRunStateRead?: (runId: string) => void;
  readonly afterOperationClaimReclaimed?: (claim: OperationClaimRecord) => void;
}

export interface ReserveRunInput {
  readonly run_id: string;
  readonly workspace: McpWorkspaceIdentity;
  readonly request: z.input<typeof CircuitStartInputV1>;
  readonly runtime_assets_sha256: string;
  readonly owner: ProcessOwnerIdentity;
  readonly summary: string;
}

export interface TransitionRunInput {
  readonly handle: OperationHandle;
  readonly to: McpRunRecord['state'];
  readonly summary: string;
  readonly launch?: StoredLaunch;
  readonly checkpoint?: StoredCheckpoint | null;
  readonly final_report?: z.infer<typeof StoredFinalReportV1> | null;
  readonly failure?: z.infer<typeof StoredFailureV1> | null;
  readonly recovery?: StoredRecovery | null;
}

export interface RunListItem {
  readonly run_id: string;
  readonly flow: McpRunRecord['request']['flow'];
  readonly state: McpRunRecord['state'];
  readonly updated_at: string;
  readonly checkpoint_available: boolean;
  readonly summary: string;
}

export interface PruneTerminalRunsResult {
  readonly removed_run_ids: readonly string[];
  readonly retained_terminal_count: number;
  readonly skipped_active_count: number;
  readonly cleaned_interrupted_count: number;
}

export interface RunPaths {
  readonly run_dir: string;
  readonly state_file: string;
  readonly operation_file: string;
  readonly operation_release_file: string;
  readonly lease_file: string;
}

export class McpStateStore {
  readonly stateRoot: string;
  readonly runsRoot: string;
  readonly leasesRoot: string;
  readonly #now: () => Date;
  readonly #randomId: () => string;
  readonly #inspectProcess: (identity: ProcessIdentity) => ProcessStatus;
  readonly #inspectProcessGroup: (identity: ProcessIdentity) => ProcessStatus;
  readonly #inspectProcessToken: (token: string) => ProcessStatus;
  readonly #beforeTerminalLeaseRelease: (record: McpRunRecord) => void;
  readonly #beforeRunStateRead: (runId: string) => void;
  readonly #afterOperationClaimReclaimed: (claim: OperationClaimRecord) => void;
  readonly #handles = new WeakMap<OperationHandle, OperationMetadata>();

  constructor(options: McpStateStoreOptions) {
    if (!isAbsolute(options.stateRoot)) {
      throw new McpStateStoreError(
        'state_root_invalid',
        'Circuit MCP state root must be absolute.',
      );
    }
    ensurePrivateDirectory(options.stateRoot, true);
    this.stateRoot = realpathSync.native(options.stateRoot);
    assertPrivateDirectory(this.stateRoot);
    this.runsRoot = join(this.stateRoot, 'runs');
    this.leasesRoot = join(this.stateRoot, 'leases');
    ensurePrivateDirectory(this.runsRoot);
    ensurePrivateDirectory(this.leasesRoot);
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
    this.#inspectProcess = options.inspectProcess ?? (() => 'unknown');
    this.#inspectProcessGroup = options.inspectProcessGroup ?? (() => 'unknown');
    this.#inspectProcessToken = options.inspectProcessToken ?? (() => 'unknown');
    this.#beforeTerminalLeaseRelease = options.beforeTerminalLeaseRelease ?? (() => undefined);
    this.#beforeRunStateRead = options.beforeRunStateRead ?? (() => undefined);
    this.#afterOperationClaimReclaimed = options.afterOperationClaimReclaimed ?? (() => undefined);
  }

  pathsForRun(workspace: McpWorkspaceIdentity, runId: string): RunPaths {
    const parsedRunId = RUN_ID.parse(runId);
    const parsedWorkspace = McpWorkspaceIdentityV1.parse(workspace);
    const runDir = join(this.runsRoot, parsedWorkspace.key, parsedRunId);
    return {
      run_dir: runDir,
      state_file: join(runDir, 'state.json'),
      operation_file: join(runDir, 'operation.json'),
      operation_release_file: join(runDir, 'operation.release.json'),
      lease_file: join(this.leasesRoot, `${parsedWorkspace.key}.json`),
    };
  }

  reserveRun(input: ReserveRunInput): McpRunRecord {
    return this.#reserveRun(input, false).record;
  }

  reserveRunClaimed(input: ReserveRunInput): {
    readonly record: McpRunRecord;
    readonly handle: OperationHandle;
  } {
    const reserved = this.#reserveRun(input, true);
    if (reserved.handle === undefined) {
      throw new McpStateStoreError(
        'operation_claim_invalid',
        'Circuit did not publish the initial run operation claim.',
      );
    }
    return { record: reserved.record, handle: reserved.handle };
  }

  #reserveRun(
    input: ReserveRunInput,
    claimed: boolean,
  ): { readonly record: McpRunRecord; readonly handle?: OperationHandle } {
    assertCurrentWorkspace(input.workspace);
    const runId = RUN_ID.parse(input.run_id);
    const workspace = McpWorkspaceIdentityV1.parse(input.workspace);
    const request = CircuitStartInputV1.parse(input.request);
    const owner = ProcessOwnerIdentityV1.parse(input.owner);
    const runtimeAssetsSha256 = Sha256.parse(input.runtime_assets_sha256);
    const summary = Summary.parse(input.summary);
    const leaseId = RUN_ID.parse(this.#randomId());
    const now = this.#now().toISOString();
    const stagingName = `.${runId}.${leaseId}.tmp`;
    const workspaceRunsRoot = this.#workspaceRunsRoot(workspace, true);
    const stagingDir = join(workspaceRunsRoot, stagingName);
    const finalRunDir = join(workspaceRunsRoot, runId);
    const leasePath = join(this.leasesRoot, `${workspace.key}.json`);

    if (existsSync(finalRunDir)) {
      throw new McpStateStoreError('run_exists', 'A Circuit MCP run with this ID already exists.');
    }

    const record = this.#parseRecord({
      schema_version: 1,
      record_kind: 'circuit.mcp.run-state',
      revision: 0,
      run_id: runId,
      lease_id: leaseId,
      workspace,
      request,
      state: 'starting',
      summary,
      runtime_assets_sha256: runtimeAssetsSha256,
      run_relative_path: `.circuit/runs/${runId}`,
      created_at: now,
      updated_at: now,
      allocation: { owner, created_at: now },
      launch: { generation: 1, phase: 'reserved', allocation_owner: owner },
      progress: { next_cursor: 0, retained_from_cursor: 0, dropped_count: 0, events: [] },
    });
    const lease = WorkspaceLeaseRecordV1.parse({
      schema_version: 1,
      record_kind: 'circuit.mcp.workspace-lease',
      lease_id: leaseId,
      workspace,
      run_id: runId,
      staging_name: stagingName,
      allocation_owner: owner,
      acquired_at: now,
    });
    const claim = claimed
      ? OperationClaimRecordV1.parse({
          schema_version: 1,
          record_kind: 'circuit.mcp.operation-claim',
          claim_id: RUN_ID.parse(this.#randomId()),
          run_id: runId,
          workspace_key: workspace.key,
          operation: 'reconcile',
          expected_revision: record.revision,
          owner,
          acquired_at: now,
        })
      : undefined;

    let leaseCreated = false;
    let guard: WorkspaceGuardHandle | undefined;
    try {
      guard = this.#acquireWorkspaceGuard(workspace, owner);
      this.#reconcileOrphanStagingUnderGuard(workspace, guard, stagingName);
      if (existsSync(finalRunDir)) {
        throw new McpStateStoreError(
          'run_exists',
          'A Circuit MCP run with this ID already exists.',
        );
      }
      ensurePrivateDirectory(stagingDir);
      if (!createJsonExclusive(join(stagingDir, 'state.json'), record)) {
        throw new McpStateStoreError('run_exists', 'The staged Circuit run already exists.');
      }
      if (claim !== undefined && !createJsonExclusive(join(stagingDir, 'operation.json'), claim)) {
        throw new McpStateStoreError(
          'operation_in_progress',
          'The staged Circuit run already has an operation claim.',
        );
      }
      this.#reconcileLeaseUnderGuard(workspace, leasePath, guard);
      if (!createJsonExclusive(leasePath, lease)) {
        throw new McpStateStoreError(
          'workspace_busy',
          'Another Circuit run already owns this workspace.',
          'Wait for that run to finish, cancel it, or recover it if cleanup is uncertain.',
        );
      }
      leaseCreated = true;
      renameSync(stagingDir, finalRunDir);
      fsyncDirectory(workspaceRunsRoot);
      if (claim !== undefined) {
        const registered = this.#registerHandle(workspace, runId, record.revision, claim);
        if (!registered.ok) {
          throw new McpStateStoreError(registered.code, registered.message);
        }
        return { record, handle: registered.handle };
      }
      return { record: this.readRun(workspace, runId) };
    } catch (error) {
      if (existsSync(stagingDir)) rmSync(stagingDir, { force: true, recursive: true });
      if (leaseCreated && !existsSync(finalRunDir)) {
        try {
          unlinkExactLease(leasePath, lease);
        } catch {
          // Preserve a complete lease when exact cleanup cannot be proved. A
          // later start may reclaim it only after its allocation owner is absent.
        }
      }
      throw error;
    } finally {
      if (guard !== undefined) this.#releaseWorkspaceGuard(guard);
    }
  }

  readRun(workspace: McpWorkspaceIdentity, runId: string): McpRunRecord {
    assertCurrentWorkspace(workspace);
    const workspaceRunsRoot = this.#workspaceRunsRoot(workspace, false);
    if (!existsSync(workspaceRunsRoot)) {
      throw new McpStateStoreError('run_not_found', 'Circuit could not find this run.');
    }
    assertPrivateDirectory(workspaceRunsRoot);
    const paths = this.pathsForRun(workspace, runId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        assertPrivateDirectory(paths.run_dir);
        this.#beforeRunStateRead(runId);
        const record = readStrictJson(
          paths.state_file,
          McpRunRecordV1,
          MAX_STATE_BYTES,
          'state_corrupt',
        );
        if (record.run_id !== runId || !sameWorkspace(record.workspace, workspace)) {
          throw new McpStateStoreError(
            'run_not_owned',
            'This run does not belong to the trusted workspace.',
          );
        }
        return record;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
    }
    throw new McpStateStoreError('run_not_found', 'Circuit could not find this run.');
  }

  acquireOperation(input: {
    readonly workspace: McpWorkspaceIdentity;
    readonly run_id: string;
    readonly operation: Exclude<OperationName, 'reclaim'>;
    readonly owner: ProcessOwnerIdentity;
    readonly checkpoint_binding_sha256?: string;
  }): AcquireOperationResult {
    const workspace = McpWorkspaceIdentityV1.parse(input.workspace);
    const owner = ProcessOwnerIdentityV1.parse(input.owner);
    const operation = OperationNameV1.exclude(['reclaim']).parse(input.operation);
    const paths = this.pathsForRun(workspace, input.run_id);
    const record = this.readRun(workspace, input.run_id);
    if (operation === 'resume') {
      if (record.state !== 'waiting_for_input' || record.checkpoint === undefined) {
        throw new McpStateStoreError(
          'run_not_waiting',
          'Only a run waiting for input can be resumed.',
        );
      }
      if (input.checkpoint_binding_sha256 === undefined) {
        throw new McpStateStoreError(
          'checkpoint_binding_required',
          'Resume requires the validated checkpoint binding.',
        );
      }
      if (input.checkpoint_binding_sha256 !== storedCheckpointBinding(record)) {
        throw new McpStateStoreError(
          'checkpoint_stale',
          'This checkpoint changed before Circuit could claim resume.',
        );
      }
    }
    const claim = OperationClaimRecordV1.parse({
      schema_version: 1,
      record_kind: 'circuit.mcp.operation-claim',
      claim_id: RUN_ID.parse(this.#randomId()),
      run_id: record.run_id,
      workspace_key: workspace.key,
      operation,
      expected_revision: record.revision,
      ...(input.checkpoint_binding_sha256 === undefined
        ? {}
        : { checkpoint_binding_sha256: input.checkpoint_binding_sha256 }),
      owner,
      acquired_at: this.#now().toISOString(),
    });

    let guard: WorkspaceGuardHandle;
    try {
      guard = this.#acquireWorkspaceGuard(workspace, owner);
    } catch (error) {
      if (error instanceof McpStateStoreError && error.code === 'workspace_guard_busy') {
        return {
          ok: false,
          code: 'operation_in_progress',
          message: 'Another Circuit operation is already changing this workspace.',
        };
      }
      if (error instanceof McpStateStoreError && error.code === 'workspace_guard_owner_unknown') {
        return {
          ok: false,
          code: 'operation_owner_unknown',
          message: 'Circuit cannot prove whether another operation owns this workspace.',
        };
      }
      throw error;
    }
    try {
      this.#clearReleasedOperation(paths);
      let reclaimed: OperationClaimRecord | undefined;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (createJsonExclusive(paths.operation_file, claim)) {
          if (reclaimed !== undefined) this.#clearReleaseMarkerForClaim(paths, reclaimed);
          return this.#completeClaimAcquisition(workspace, record.run_id, claim);
        }
        let existing: OperationClaimRecord;
        try {
          existing = readStrictJson(
            paths.operation_file,
            OperationClaimRecordV1,
            MAX_CONTROL_BYTES,
            'operation_claim_corrupt',
          );
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          throw error;
        }
        const status = this.#inspectOwnerTree(existing.owner);
        if (status === 'alive') {
          return {
            ok: false,
            code: 'operation_in_progress',
            message: 'Another Circuit operation is already changing this run.',
          };
        }
        if (status === 'unknown') {
          return {
            ok: false,
            code: 'operation_owner_unknown',
            message: 'Circuit cannot prove whether another operation still owns this run.',
          };
        }
        unlinkExactClaim(paths.operation_file, existing);
        reclaimed = existing;
        this.#afterOperationClaimReclaimed(existing);
        this.#clearReleaseMarkerForClaim(paths, existing);
      }
      return {
        ok: false,
        code: 'operation_in_progress',
        message: 'Another Circuit operation is already changing this run.',
      };
    } finally {
      this.#releaseWorkspaceGuard(guard);
    }
  }

  advanceLaunch(input: {
    readonly handle: OperationHandle;
    readonly launch: StoredLaunch;
    readonly summary?: string;
  }): McpRunRecord {
    const metadata = this.#activeHandle(input.handle);
    this.#assertHandleOwnsClaim(input.handle, metadata);
    const current = this.readRun(metadata.workspace, metadata.runId);
    if (current.revision !== metadata.revision) {
      throw new McpStateStoreError(
        'state_revision_changed',
        'The run changed during this operation.',
      );
    }
    if (
      current.state !== 'starting' &&
      current.state !== 'running' &&
      current.state !== 'resuming' &&
      current.state !== 'cancelling' &&
      !(current.state === 'recovery_required' && input.handle.claim.operation === 'recover')
    ) {
      throw new McpStateStoreError(
        'launch_not_active',
        'Circuit cannot advance launch evidence for this run state.',
      );
    }
    const launch = StoredLaunchV1.parse(input.launch);
    this.#assertLaunchAdvance(current.launch, launch);
    const next = this.#parseRecord({
      ...current,
      revision: current.revision + 1,
      updated_at: this.#now().toISOString(),
      summary: input.summary ?? current.summary,
      launch,
    });
    const paths = this.pathsForRun(metadata.workspace, metadata.runId);
    this.#assertHandleOwnsClaim(input.handle, metadata);
    replaceJsonAtomic(paths.state_file, next);
    metadata.revision = next.revision;
    return next;
  }

  transitionRun(input: TransitionRunInput): McpRunRecord {
    const metadata = this.#activeHandle(input.handle);
    this.#assertHandleOwnsClaim(input.handle, metadata);
    const current = this.readRun(metadata.workspace, metadata.runId);
    if (current.revision !== metadata.revision) {
      throw new McpStateStoreError(
        'state_revision_changed',
        'The run changed during this operation.',
      );
    }
    if (!ALLOWED_TRANSITIONS[current.state].has(input.to)) {
      throw new McpStateStoreError(
        'invalid_transition',
        `Circuit cannot change a run from ${current.state} to ${input.to}.`,
      );
    }
    if (current.state === 'recovery_required' && input.handle.claim.operation !== 'recover') {
      throw new McpStateStoreError(
        'recovery_required',
        'Only Circuit recovery may repair a recovery_required run.',
      );
    }
    if (input.to === 'resuming') {
      if (
        input.handle.claim.operation !== 'resume' ||
        input.handle.claim.checkpoint_binding_sha256 === undefined
      ) {
        throw new McpStateStoreError(
          'resume_not_authorized',
          'Resume requires the token-bound checkpoint operation claim.',
        );
      }
      if (input.handle.claim.checkpoint_binding_sha256 !== storedCheckpointBinding(current)) {
        throw new McpStateStoreError(
          'checkpoint_stale',
          'This checkpoint changed before Circuit could resume it.',
        );
      }
      if (
        input.launch === undefined ||
        input.launch.phase !== 'reserved' ||
        input.launch.generation !== current.launch.generation + 1 ||
        !sameProcessOwner(input.launch.allocation_owner, input.handle.claim.owner)
      ) {
        throw new McpStateStoreError(
          'invalid_resume_generation',
          'Resume must start a new reserved launch generation owned by its operation claimant.',
        );
      }
    } else if (
      input.launch !== undefined &&
      sha256OfJson(input.launch) !== sha256OfJson(current.launch)
    ) {
      if (
        current.state === 'recovery_required' &&
        input.handle.claim.operation === 'recover' &&
        current.launch.phase === 'exited' &&
        input.launch.phase === 'exited'
      ) {
        this.#assertRecoveryExitConfirmation(current.launch, input.launch);
      } else {
        this.#assertLaunchAdvance(current.launch, input.launch);
      }
    }

    const {
      checkpoint: _oldCheckpoint,
      final_report: _oldFinal,
      finished_at: _oldFinished,
      ...base
    } = current;
    const terminal = TERMINAL_STATES.has(input.to);
    const candidate = {
      ...base,
      revision: current.revision + 1,
      state: input.to,
      summary: input.summary,
      updated_at: this.#now().toISOString(),
      ...(terminal ? { finished_at: this.#now().toISOString() } : {}),
      launch: input.launch ?? current.launch,
      ...(input.checkpoint === undefined
        ? input.to === 'waiting_for_input' && current.checkpoint !== undefined
          ? { checkpoint: current.checkpoint }
          : {}
        : input.checkpoint === null
          ? {}
          : { checkpoint: input.checkpoint }),
      ...(input.final_report === undefined
        ? input.to === 'complete' && current.final_report !== undefined
          ? { final_report: current.final_report }
          : {}
        : input.final_report === null
          ? {}
          : { final_report: input.final_report }),
      ...(input.failure === undefined
        ? current.failure === undefined
          ? {}
          : { failure: current.failure }
        : input.failure === null
          ? {}
          : { failure: input.failure }),
      ...(input.recovery === undefined
        ? current.recovery === undefined
          ? {}
          : { recovery: current.recovery }
        : input.recovery === null
          ? {}
          : { recovery: input.recovery }),
    };
    const next = this.#parseRecord(candidate);
    const paths = this.pathsForRun(metadata.workspace, metadata.runId);
    const guard = terminal
      ? this.#acquireWorkspaceGuard(next.workspace, input.handle.claim.owner)
      : undefined;
    try {
      if (guard !== undefined) this.#beforeTerminalLeaseRelease(next);
      this.#assertHandleOwnsClaim(input.handle, metadata);
      replaceJsonAtomic(paths.state_file, next);
      metadata.revision = next.revision;
      if (guard !== undefined) {
        this.#releaseLeaseForRecord(next, guard);
      }
      return next;
    } finally {
      if (guard !== undefined) this.#releaseWorkspaceGuard(guard);
    }
  }

  releaseOperation(handle: OperationHandle): void {
    const metadata = this.#activeHandle(handle);
    const paths = this.pathsForRun(metadata.workspace, metadata.runId);
    this.#assertHandleOwnsClaim(handle, metadata);
    if (!createJsonExclusive(paths.operation_release_file, handle.claim)) {
      const existing = readStrictJson(
        paths.operation_release_file,
        OperationClaimRecordV1,
        MAX_CONTROL_BYTES,
        'operation_claim_corrupt',
      );
      if (!sameOperationClaim(existing, handle.claim)) {
        // An old owner can pass its ownership check, pause, and publish its
        // release marker after this claim has replaced it. Serialize the
        // repair with claim replacement, prove this handle still owns the
        // current claim, then replace the stale marker with this exact claim.
        // The old owner can no longer create over the now-existing marker.
        const repairGuard = this.#acquireWorkspaceGuard(metadata.workspace, handle.claim.owner);
        try {
          this.#assertHandleOwnsClaim(handle, metadata);
          const currentRelease = readStrictJson(
            paths.operation_release_file,
            OperationClaimRecordV1,
            MAX_CONTROL_BYTES,
            'operation_claim_corrupt',
          );
          if (!sameOperationClaim(currentRelease, handle.claim)) {
            replaceJsonAtomic(paths.operation_release_file, handle.claim);
          }
          metadata.released = true;
          this.#clearReleasedOperation(paths);
        } finally {
          this.#releaseWorkspaceGuard(repairGuard);
        }
        return;
      }
    }
    metadata.released = true;
    let guard: WorkspaceGuardHandle;
    try {
      guard = this.#acquireWorkspaceGuard(metadata.workspace, handle.claim.owner);
    } catch (error) {
      if (
        error instanceof McpStateStoreError &&
        (error.code === 'workspace_guard_busy' || error.code === 'workspace_guard_owner_unknown')
      ) {
        return;
      }
      throw error;
    }
    try {
      this.#clearReleasedOperation(paths);
    } finally {
      this.#releaseWorkspaceGuard(guard);
    }
  }

  listRuns(
    workspace: McpWorkspaceIdentity,
    options: {
      readonly limit?: number;
      readonly checkpointAvailable?: (record: McpRunRecord) => boolean;
    } = {},
  ): { readonly runs: readonly RunListItem[]; readonly truncated: boolean } {
    assertCurrentWorkspace(workspace);
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new McpStateStoreError(
        'list_limit_invalid',
        'Circuit list limit must be between 1 and 50.',
      );
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return this.#listRunsOnce(workspace, limit, options.checkpointAvailable);
      } catch (error) {
        if (error instanceof McpStateStoreError && error.code === 'run_not_found') continue;
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
    }
    throw new McpStateStoreError(
      'state_read_busy',
      'Circuit run history kept changing while it was listed.',
    );
  }

  #listRunsOnce(
    workspace: McpWorkspaceIdentity,
    limit: number,
    checkpointAvailable: ((record: McpRunRecord) => boolean) | undefined,
  ): { readonly runs: readonly RunListItem[]; readonly truncated: boolean } {
    const workspaceRunsRoot = this.#workspaceRunsRoot(workspace, false);
    if (!existsSync(workspaceRunsRoot)) return { runs: [], truncated: false };
    const matching: McpRunRecord[] = [];
    const entries = readDirectoryBounded(
      workspaceRunsRoot,
      MAX_WORKSPACE_RUN_ENTRIES,
      'state_limit_exceeded',
      'Circuit MCP has too many retained runs for this workspace.',
      'Run the Circuit MCP doctor before listing again.',
    ).filter((entry) => !entry.name.startsWith('.'));
    for (const entry of entries) {
      if (!RUN_ID.safeParse(entry.name).success || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new McpStateStoreError(
          'state_corrupt',
          'Circuit MCP contains an unexpected run entry.',
        );
      }
      const record = this.readRun(workspace, entry.name);
      if (record.run_id !== entry.name) {
        throw new McpStateStoreError(
          'state_corrupt',
          'A Circuit run record does not match its private directory.',
        );
      }
      if (!sameWorkspace(record.workspace, workspace)) {
        throw new McpStateStoreError(
          'state_corrupt',
          'A Circuit run is stored under the wrong workspace.',
        );
      }
      matching.push(record);
    }
    matching.sort(
      (left, right) =>
        right.updated_at.localeCompare(left.updated_at) || left.run_id.localeCompare(right.run_id),
    );
    const runs = matching.slice(0, limit).map(
      (record): RunListItem => ({
        run_id: record.run_id,
        flow: record.request.flow,
        state: record.state,
        updated_at: record.updated_at,
        checkpoint_available:
          record.state === 'waiting_for_input' &&
          record.checkpoint !== undefined &&
          (checkpointAvailable?.(record) ?? false),
        summary: record.summary,
      }),
    );
    return { runs, truncated: matching.length > limit };
  }

  pruneTerminalRuns(input: {
    readonly workspace: McpWorkspaceIdentity;
    readonly owner: ProcessOwnerIdentity;
    readonly retain: number;
  }): PruneTerminalRunsResult {
    assertCurrentWorkspace(input.workspace);
    const workspace = McpWorkspaceIdentityV1.parse(input.workspace);
    const owner = ProcessOwnerIdentityV1.parse(input.owner);
    if (!Number.isInteger(input.retain) || input.retain < 0 || input.retain > 500) {
      throw new McpStateStoreError(
        'retention_limit_invalid',
        'Circuit retention must keep between 0 and 500 terminal runs.',
      );
    }
    const workspaceRunsRoot = this.#workspaceRunsRoot(workspace, false);
    if (!existsSync(workspaceRunsRoot)) {
      return {
        removed_run_ids: [],
        retained_terminal_count: 0,
        skipped_active_count: 0,
        cleaned_interrupted_count: 0,
      };
    }

    const guard = this.#acquireWorkspaceGuard(workspace, owner);
    try {
      const entries = readDirectoryBounded(
        workspaceRunsRoot,
        MAX_RETENTION_SCAN_ENTRIES,
        'retention_scan_limit_exceeded',
        'Circuit MCP has too many retained entries to prune safely in one operation.',
        'Run the Circuit MCP doctor before retrying retention.',
      );

      let cleanedInterruptedCount = 0;
      for (const entry of entries) {
        const match = RETENTION_TOMBSTONE.exec(entry.name);
        if (match === null) continue;
        if (
          !RUN_ID.safeParse(match[1]).success ||
          !RUN_ID.safeParse(match[2]).success ||
          !entry.isDirectory() ||
          entry.isSymbolicLink()
        ) {
          throw new McpStateStoreError(
            'retention_state_corrupt',
            'Circuit MCP contains an unsafe interrupted-retention entry.',
          );
        }
        const tombstone = join(workspaceRunsRoot, entry.name);
        assertPrivateDirectory(tombstone);
        this.#assertWorkspaceGuard(guard, workspace.key);
        rmSync(tombstone, { force: true, recursive: true });
        fsyncDirectory(workspaceRunsRoot);
        cleanedInterruptedCount += 1;
      }

      const records: McpRunRecord[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (
          !RUN_ID.safeParse(entry.name).success ||
          !entry.isDirectory() ||
          entry.isSymbolicLink()
        ) {
          throw new McpStateStoreError(
            'retention_state_corrupt',
            'Circuit MCP contains an unexpected run entry.',
          );
        }
        const record = this.readRun(workspace, entry.name);
        if (record.run_id !== entry.name) {
          throw new McpStateStoreError(
            'retention_state_corrupt',
            'A Circuit run record does not match its private directory.',
          );
        }
        records.push(record);
      }

      const terminal = records
        .filter((record) => TERMINAL_STATES.has(record.state))
        .sort(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            right.run_id.localeCompare(left.run_id),
        );
      let skippedActiveCount = records.length - terminal.length;
      const removedRunIds: string[] = [];
      for (const record of terminal.slice(input.retain)) {
        const paths = this.pathsForRun(workspace, record.run_id);
        this.#clearReleasedOperation(paths);
        if (existsSync(paths.operation_file)) {
          const claim = readStrictJson(
            paths.operation_file,
            OperationClaimRecordV1,
            MAX_CONTROL_BYTES,
            'operation_claim_corrupt',
          );
          const status = this.#inspectOwnerTree(claim.owner);
          if (status !== 'absent') {
            skippedActiveCount += 1;
            continue;
          }
          unlinkExactClaim(paths.operation_file, claim);
        }

        if (existsSync(paths.lease_file)) {
          const lease = readStrictJson(
            paths.lease_file,
            WorkspaceLeaseRecordV1,
            MAX_CONTROL_BYTES,
            'lease_corrupt',
          );
          if (lease.run_id === record.run_id && lease.lease_id === record.lease_id) {
            this.#assertWorkspaceGuard(guard, workspace.key);
            unlinkExactLease(paths.lease_file, lease);
          }
        }

        const tombstone = join(
          workspaceRunsRoot,
          `.retention.${record.run_id}.${RUN_ID.parse(this.#randomId())}.tmp`,
        );
        this.#assertWorkspaceGuard(guard, workspace.key);
        renameSync(paths.run_dir, tombstone);
        fsyncDirectory(workspaceRunsRoot);
        rmSync(tombstone, { force: true, recursive: true });
        fsyncDirectory(workspaceRunsRoot);
        removedRunIds.push(record.run_id);
      }
      removedRunIds.sort();
      return {
        removed_run_ids: removedRunIds,
        retained_terminal_count: terminal.length - removedRunIds.length,
        skipped_active_count: skippedActiveCount,
        cleaned_interrupted_count: cleanedInterruptedCount,
      };
    } finally {
      this.#releaseWorkspaceGuard(guard);
    }
  }

  recoverRun(input: {
    readonly workspace: McpWorkspaceIdentity;
    readonly run_id: string;
    readonly owner: ProcessOwnerIdentity;
  }): {
    readonly record: McpRunRecord;
    readonly cleanup_confirmed: true;
    readonly lease_released: true;
  } {
    const before = this.readRun(input.workspace, input.run_id);
    if (before.state !== 'recovery_required') {
      throw new McpStateStoreError(
        'run_not_recoverable',
        'Only a recovery_required run can be recovered.',
      );
    }
    const acquired = this.acquireOperation({
      workspace: input.workspace,
      run_id: input.run_id,
      operation: 'recover',
      owner: input.owner,
    });
    if (!acquired.ok) throw new McpStateStoreError(acquired.code, acquired.message);
    try {
      const current = this.readRun(input.workspace, input.run_id);
      if (current.state !== 'recovery_required' || current.recovery === undefined) {
        throw new McpStateStoreError('run_not_recoverable', 'The run no longer needs recovery.');
      }
      const proof = this.#recoveryProof(current);
      if (proof.includes('alive')) {
        throw new McpStateStoreError(
          'recovery_process_alive',
          'Circuit found a process that may still belong to this run.',
          'Call circuit_cancel for this run, then retry circuit_recover.',
        );
      }
      if (proof.includes('unknown')) {
        throw new McpStateStoreError(
          'recovery_process_unknown',
          'Circuit could not prove that every process from this run is absent.',
          'Wait briefly, then retry circuit_recover with this run ID. If Circuit still cannot confirm cleanup, stop and report the run ID; do not force-unlock the workspace.',
        );
      }

      const now = this.#now().toISOString();
      const launch: StoredLaunch = {
        ...current.launch,
        phase: 'exited',
        exit: {
          ...(current.launch.exit?.exit_code === undefined
            ? {}
            : { exit_code: current.launch.exit.exit_code }),
          ...(current.launch.exit?.signal === undefined
            ? {}
            : { signal: current.launch.exit.signal }),
          observed_at: current.launch.exit?.observed_at ?? now,
          process_group_cleanup: 'confirmed',
        },
      };
      const record = this.transitionRun({
        handle: acquired.handle,
        to: current.recovery.cancellation_requested ? 'cancelled' : 'interrupted',
        summary: current.recovery.cancellation_requested
          ? 'Circuit observed that its recorded owned process group is absent and closed the cancelled run.'
          : 'Circuit observed that its recorded owned process group is absent and marked the run interrupted.',
        launch,
        checkpoint: null,
        recovery: {
          ...current.recovery,
          last_checked_at: now,
          ...(current.launch.phase === 'reserved'
            ? { owner_status: 'absent' as const }
            : {
                supervisor_status: 'absent' as const,
                ...(current.launch.runtime === undefined
                  ? {}
                  : { runtime_status: 'absent' as const }),
                process_group_status: 'absent' as const,
              }),
        },
      });
      return { record, cleanup_confirmed: true, lease_released: true };
    } finally {
      this.releaseOperation(acquired.handle);
    }
  }

  reconcileTerminalLease(
    workspace: McpWorkspaceIdentity,
    runId: string,
    owner: ProcessOwnerIdentity,
  ): boolean {
    const guard = this.#acquireWorkspaceGuard(workspace, owner);
    try {
      const record = this.readRun(workspace, runId);
      if (!TERMINAL_STATES.has(record.state)) return false;
      const leasePath = this.pathsForRun(workspace, runId).lease_file;
      if (!existsSync(leasePath)) return false;
      const lease = readStrictJson(
        leasePath,
        WorkspaceLeaseRecordV1,
        MAX_CONTROL_BYTES,
        'lease_corrupt',
      );
      if (lease.run_id !== record.run_id || lease.lease_id !== record.lease_id) return false;
      this.#releaseLeaseForRecord(record, guard);
      return true;
    } finally {
      this.#releaseWorkspaceGuard(guard);
    }
  }

  #workspaceRunsRoot(workspace: McpWorkspaceIdentity, create: boolean): string {
    const path = join(this.runsRoot, workspace.key);
    if (create) ensurePrivateDirectory(path);
    else if (existsSync(path)) assertPrivateDirectory(path);
    return path;
  }

  #parseRecord(value: unknown): McpRunRecord {
    const parsed = McpRunRecordV1.safeParse(value);
    if (!parsed.success) {
      throw new McpStateStoreError('invalid_state_record', 'Circuit refused an invalid run state.');
    }
    return parsed.data;
  }

  #registerHandle(
    workspace: McpWorkspaceIdentity,
    runId: string,
    revision: number,
    claim: OperationClaimRecord,
  ): AcquireOperationResult {
    const handle: OperationHandle = { claim };
    this.#handles.set(handle, { workspace, runId, revision, released: false });
    return { ok: true, handle };
  }

  #completeClaimAcquisition(
    workspace: McpWorkspaceIdentity,
    runId: string,
    claim: OperationClaimRecord,
  ): AcquireOperationResult {
    const paths = this.pathsForRun(workspace, runId);
    let effectiveClaim = claim;
    try {
      // The state may have changed between the read that built this claim and
      // the exclusive create. Re-read after winning, then bind the durable
      // claim and in-memory handle to the revision we actually own.
      const current = this.readRun(workspace, runId);
      if (
        effectiveClaim.operation === 'resume' &&
        (current.state !== 'waiting_for_input' ||
          effectiveClaim.checkpoint_binding_sha256 === undefined ||
          effectiveClaim.checkpoint_binding_sha256 !== storedCheckpointBinding(current))
      ) {
        throw new McpStateStoreError(
          'checkpoint_stale',
          'This checkpoint changed before Circuit won the resume claim.',
        );
      }
      if (current.revision !== claim.expected_revision) {
        effectiveClaim = OperationClaimRecordV1.parse({
          ...claim,
          expected_revision: current.revision,
        });
        replaceJsonAtomic(paths.operation_file, effectiveClaim);
      }
      return this.#registerHandle(workspace, runId, current.revision, effectiveClaim);
    } catch (error) {
      try {
        unlinkExactClaim(paths.operation_file, effectiveClaim);
      } catch {
        // A claim we cannot identify safely remains visible for recovery.
      }
      throw error;
    }
  }

  #activeHandle(handle: OperationHandle): OperationMetadata {
    const metadata = this.#handles.get(handle);
    if (metadata === undefined || metadata.released) {
      throw new McpStateStoreError(
        'operation_claim_invalid',
        'This operation claim is not active.',
      );
    }
    return metadata;
  }

  #assertHandleOwnsClaim(handle: OperationHandle, metadata: OperationMetadata): void {
    const path = this.pathsForRun(metadata.workspace, metadata.runId).operation_file;
    const current = readStrictJson(
      path,
      OperationClaimRecordV1,
      MAX_CONTROL_BYTES,
      'operation_claim_corrupt',
    );
    if (
      current.claim_id !== handle.claim.claim_id ||
      current.run_id !== handle.claim.run_id ||
      current.workspace_key !== handle.claim.workspace_key ||
      current.operation !== handle.claim.operation ||
      !sameProcessOwner(current.owner, handle.claim.owner)
    ) {
      throw new McpStateStoreError(
        'operation_claim_changed',
        'This operation no longer owns the run claim.',
      );
    }
  }

  #clearReleasedOperation(paths: RunPaths): void {
    if (!existsSync(paths.operation_release_file)) return;
    const release = readStrictJson(
      paths.operation_release_file,
      OperationClaimRecordV1,
      MAX_CONTROL_BYTES,
      'operation_claim_corrupt',
    );
    try {
      const current = readStrictJson(
        paths.operation_file,
        OperationClaimRecordV1,
        MAX_CONTROL_BYTES,
        'operation_claim_corrupt',
      );
      if (sameOperationClaim(current, release)) unlinkExactClaim(paths.operation_file, current);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    unlinkExactClaim(paths.operation_release_file, release);
  }

  #clearReleaseMarkerForClaim(paths: RunPaths, expected: OperationClaimRecord): void {
    if (!existsSync(paths.operation_release_file)) return;
    const release = readStrictJson(
      paths.operation_release_file,
      OperationClaimRecordV1,
      MAX_CONTROL_BYTES,
      'operation_claim_corrupt',
    );
    if (sameOperationClaim(release, expected)) {
      unlinkExactClaim(paths.operation_release_file, release);
    }
  }

  #inspectOwnerTree(owner: ProcessIdentity): ProcessStatus {
    // MCP control owners may share Codex's process group. Exact process
    // identity owns control files; recorded worker identities own worker groups.
    return this.#inspectProcess(owner);
  }

  #acquireWorkspaceGuard(
    workspace: McpWorkspaceIdentity,
    owner: ProcessOwnerIdentity,
  ): WorkspaceGuardHandle {
    const guardPath = join(this.leasesRoot, `${workspace.key}.guard.json`);
    const reclaimPath = join(this.leasesRoot, `${workspace.key}.guard.reclaim.json`);
    const desired = WorkspaceGuardRecordV1.parse({
      schema_version: 1,
      record_kind: 'circuit.mcp.workspace-guard',
      guard_id: RUN_ID.parse(this.#randomId()),
      workspace_key: workspace.key,
      owner,
      acquired_at: this.#now().toISOString(),
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (createJsonExclusive(guardPath, desired)) {
        return { path: guardPath, record: desired, released: false };
      }
      let existing: WorkspaceGuardRecord;
      try {
        existing = readStrictJson(
          guardPath,
          WorkspaceGuardRecordV1,
          MAX_CONTROL_BYTES,
          'workspace_guard_corrupt',
        );
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      const status = this.#inspectOwnerTree(existing.owner);
      if (status !== 'absent') {
        throw new McpStateStoreError(
          status === 'alive' ? 'workspace_guard_busy' : 'workspace_guard_owner_unknown',
          status === 'alive'
            ? 'Another Circuit process is changing this workspace lease.'
            : 'Circuit cannot prove whether another process still owns the workspace guard.',
        );
      }

      const reclaim = WorkspaceGuardRecordV1.parse({
        ...desired,
        record_kind: 'circuit.mcp.workspace-guard-reclaim',
        guard_id: RUN_ID.parse(this.#randomId()),
      });
      if (!createJsonExclusive(reclaimPath, reclaim)) {
        let existingReclaim: WorkspaceGuardRecord;
        try {
          existingReclaim = readStrictJson(
            reclaimPath,
            WorkspaceGuardRecordV1,
            MAX_CONTROL_BYTES,
            'workspace_guard_corrupt',
          );
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          throw error;
        }
        const reclaimStatus = this.#inspectOwnerTree(existingReclaim.owner);
        if (reclaimStatus !== 'absent') {
          throw new McpStateStoreError(
            reclaimStatus === 'alive' ? 'workspace_guard_busy' : 'workspace_guard_owner_unknown',
            'Another Circuit process may be reclaiming this workspace guard.',
          );
        }
        unlinkExactWorkspaceGuard(reclaimPath, existingReclaim);
        continue;
      }

      try {
        let current: WorkspaceGuardRecord;
        try {
          current = readStrictJson(
            guardPath,
            WorkspaceGuardRecordV1,
            MAX_CONTROL_BYTES,
            'workspace_guard_corrupt',
          );
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
          if (!createJsonExclusive(guardPath, desired)) continue;
          return { path: guardPath, record: desired, released: false };
        }
        if (current.guard_id !== existing.guard_id) continue;
        const currentStatus = this.#inspectOwnerTree(current.owner);
        if (currentStatus !== 'absent') {
          throw new McpStateStoreError(
            currentStatus === 'alive' ? 'workspace_guard_busy' : 'workspace_guard_owner_unknown',
            'Another Circuit process may still own this workspace guard.',
          );
        }
        unlinkExactWorkspaceGuard(guardPath, current);
        if (!createJsonExclusive(guardPath, desired)) continue;
        return { path: guardPath, record: desired, released: false };
      } finally {
        unlinkExactWorkspaceGuard(reclaimPath, reclaim);
      }
    }
    throw new McpStateStoreError(
      'workspace_guard_busy',
      'Circuit could not acquire the workspace lease guard.',
    );
  }

  #assertWorkspaceGuard(handle: WorkspaceGuardHandle, workspaceKeyValue: string): void {
    if (handle.released || handle.record.workspace_key !== workspaceKeyValue) {
      throw new McpStateStoreError(
        'workspace_guard_changed',
        'This operation no longer owns the workspace guard.',
      );
    }
    const current = readStrictJson(
      handle.path,
      WorkspaceGuardRecordV1,
      MAX_CONTROL_BYTES,
      'workspace_guard_corrupt',
    );
    if (
      current.guard_id !== handle.record.guard_id ||
      !sameProcessOwner(current.owner, handle.record.owner)
    ) {
      throw new McpStateStoreError(
        'workspace_guard_changed',
        'This operation no longer owns the workspace guard.',
      );
    }
  }

  #releaseWorkspaceGuard(handle: WorkspaceGuardHandle): void {
    if (handle.released) {
      throw new McpStateStoreError(
        'workspace_guard_changed',
        'This workspace guard was already released.',
      );
    }
    unlinkExactWorkspaceGuard(handle.path, handle.record);
    handle.released = true;
  }

  #releaseLeaseForRecord(record: McpRunRecord, guard: WorkspaceGuardHandle): void {
    this.#assertWorkspaceGuard(guard, record.workspace.key);
    const leasePath = join(this.leasesRoot, `${record.workspace.key}.json`);
    if (!existsSync(leasePath)) return;
    const lease = readStrictJson(
      leasePath,
      WorkspaceLeaseRecordV1,
      MAX_CONTROL_BYTES,
      'lease_corrupt',
    );
    if (!sameWorkspace(lease.workspace, record.workspace)) {
      throw new McpStateStoreError(
        'lease_changed',
        'The workspace lease identity does not match this run.',
      );
    }
    if (lease.run_id !== record.run_id || lease.lease_id !== record.lease_id) return;
    this.#assertWorkspaceGuard(guard, record.workspace.key);
    unlinkExactLease(leasePath, lease);
  }

  #reconcileLeaseUnderGuard(
    workspace: McpWorkspaceIdentity,
    leasePath: string,
    guard: WorkspaceGuardHandle,
  ): void {
    this.#assertWorkspaceGuard(guard, workspace.key);
    if (!existsSync(leasePath)) return;
    const lease = readStrictJson(
      leasePath,
      WorkspaceLeaseRecordV1,
      MAX_CONTROL_BYTES,
      'lease_corrupt',
    );
    if (!sameWorkspace(lease.workspace, workspace)) {
      throw new McpStateStoreError('lease_changed', 'The workspace lease identity does not match.');
    }
    const workspaceRunsRoot = this.#workspaceRunsRoot(workspace, true);
    const published = join(workspaceRunsRoot, lease.run_id);
    if (existsSync(published)) {
      const record = this.readRun(workspace, lease.run_id);
      if (record.lease_id !== lease.lease_id) {
        throw new McpStateStoreError(
          'lease_changed',
          'The published run does not match its lease.',
        );
      }
      if (
        TERMINAL_STATES.has(record.state) &&
        record.launch.exit?.process_group_cleanup === 'confirmed'
      ) {
        this.#assertWorkspaceGuard(guard, workspace.key);
        unlinkExactLease(leasePath, lease);
        return;
      }
      throw new McpStateStoreError(
        'workspace_busy',
        'Another Circuit run already owns this workspace.',
      );
    }
    const status = this.#inspectOwnerTree(lease.allocation_owner);
    if (status !== 'absent') {
      throw new McpStateStoreError(
        'workspace_busy',
        status === 'alive'
          ? 'Another Circuit start still owns this workspace.'
          : 'Circuit cannot prove that an interrupted start released this workspace.',
      );
    }
    const staging = join(workspaceRunsRoot, lease.staging_name);
    if (existsSync(staging)) rmSync(staging, { force: true, recursive: true });
    this.#assertWorkspaceGuard(guard, workspace.key);
    unlinkExactLease(leasePath, lease);
  }

  #reconcileOrphanStagingUnderGuard(
    workspace: McpWorkspaceIdentity,
    guard: WorkspaceGuardHandle,
    preserveName: string,
  ): void {
    this.#assertWorkspaceGuard(guard, workspace.key);
    const workspaceRunsRoot = this.#workspaceRunsRoot(workspace, true);
    const leasePath = join(this.leasesRoot, `${workspace.key}.json`);
    const lease = existsSync(leasePath)
      ? readStrictJson(leasePath, WorkspaceLeaseRecordV1, MAX_CONTROL_BYTES, 'lease_corrupt')
      : undefined;
    if (lease !== undefined && !sameWorkspace(lease.workspace, workspace)) {
      throw new McpStateStoreError('lease_changed', 'The workspace lease identity does not match.');
    }
    const entries = readDirectoryBounded(
      workspaceRunsRoot,
      MAX_RETENTION_SCAN_ENTRIES,
      'state_limit_exceeded',
      'Circuit MCP has too many private run entries to reconcile safely.',
      'Run the Circuit MCP doctor before starting another run.',
    );
    for (const entry of entries) {
      if (
        entry.name === preserveName ||
        !entry.name.startsWith('.') ||
        RETENTION_TOMBSTONE.test(entry.name)
      ) {
        continue;
      }
      const match = START_STAGING_DIRECTORY.exec(entry.name);
      if (
        match === null ||
        !RUN_ID.safeParse(match[1]).success ||
        !RUN_ID.safeParse(match[2]).success ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        throw new McpStateStoreError(
          'state_corrupt',
          'Circuit MCP contains an unsafe start-staging entry.',
        );
      }
      if (lease?.staging_name === entry.name) continue;
      const stagingPath = join(workspaceRunsRoot, entry.name);
      assertPrivateDirectory(stagingPath);
      const statePath = join(stagingPath, 'state.json');
      if (!existsSync(statePath)) {
        this.#assertWorkspaceGuard(guard, workspace.key);
        rmSync(stagingPath, { force: true, recursive: true });
        fsyncDirectory(workspaceRunsRoot);
        continue;
      }
      const record = readStrictJson(statePath, McpRunRecordV1, MAX_STATE_BYTES, 'state_corrupt');
      if (
        record.run_id !== match[1] ||
        record.lease_id !== match[2] ||
        !sameWorkspace(record.workspace, workspace) ||
        record.revision !== 0 ||
        record.state !== 'starting' ||
        record.launch.phase !== 'reserved'
      ) {
        throw new McpStateStoreError(
          'state_corrupt',
          'Circuit MCP found an invalid unleased start-staging record.',
        );
      }
      const status = this.#inspectOwnerTree(record.launch.allocation_owner);
      if (status === 'alive') {
        throw new McpStateStoreError(
          'workspace_busy',
          'Another Circuit start may still be preparing this workspace.',
        );
      }
      if (status === 'unknown') {
        throw new McpStateStoreError(
          'workspace_owner_unknown',
          'Circuit cannot prove whether an interrupted start still owns this workspace.',
        );
      }
      this.#assertWorkspaceGuard(guard, workspace.key);
      rmSync(stagingPath, { force: true, recursive: true });
      fsyncDirectory(workspaceRunsRoot);
    }
  }

  #assertLaunchAdvance(current: StoredLaunch, next: StoredLaunch): void {
    if (
      current.generation !== next.generation ||
      !ALLOWED_LAUNCH_TRANSITIONS[current.phase].has(next.phase)
    ) {
      throw new McpStateStoreError(
        'invalid_launch_transition',
        `Circuit cannot advance launch phase from ${current.phase} to ${next.phase}.`,
      );
    }
    if (!sameProcessOwner(current.allocation_owner, next.allocation_owner)) {
      throw new McpStateStoreError(
        'launch_identity_changed',
        'The saved launch owner changed during launch.',
      );
    }
    if (
      current.supervisor !== undefined &&
      (next.supervisor === undefined || !sameProcessIdentity(current.supervisor, next.supervisor))
    ) {
      throw new McpStateStoreError(
        'launch_identity_changed',
        'The saved supervisor identity changed during launch.',
      );
    }
    if (
      current.runtime !== undefined &&
      (next.runtime === undefined || !sameProcessIdentity(current.runtime, next.runtime))
    ) {
      throw new McpStateStoreError(
        'launch_identity_changed',
        'The saved runtime identity changed during launch.',
      );
    }
    if (
      current.authorization_sha256 !== undefined &&
      (next.authorization_sha256 !== current.authorization_sha256 ||
        next.authorized_at !== current.authorized_at)
    ) {
      throw new McpStateStoreError(
        'launch_authorization_changed',
        'The saved launch authorization changed.',
      );
    }
    if (
      next.phase === 'exited' &&
      ((current.supervisor === undefined && next.supervisor !== undefined) ||
        (current.runtime === undefined && next.runtime !== undefined) ||
        (current.authorization_sha256 === undefined && next.authorization_sha256 !== undefined))
    ) {
      throw new McpStateStoreError(
        'launch_evidence_skipped',
        'Process and authorization evidence must be durable before launch exit.',
      );
    }
  }

  #assertRecoveryExitConfirmation(current: StoredLaunch, next: StoredLaunch): void {
    if (
      current.exit === undefined ||
      next.exit === undefined ||
      current.exit.process_group_cleanup !== 'unconfirmed' ||
      next.exit.process_group_cleanup !== 'confirmed'
    ) {
      throw new McpStateStoreError(
        'invalid_recovery_evidence',
        'Recovery may only change cleanup evidence from unconfirmed to confirmed.',
      );
    }
    const { exit: currentExit, ...currentLaunch } = current;
    const { exit: nextExit, ...nextLaunch } = next;
    const { process_group_cleanup: _currentCleanup, ...currentExitEvidence } = currentExit;
    const { process_group_cleanup: _nextCleanup, ...nextExitEvidence } = nextExit;
    if (
      sha256OfJson(currentLaunch) !== sha256OfJson(nextLaunch) ||
      sha256OfJson(currentExitEvidence) !== sha256OfJson(nextExitEvidence)
    ) {
      throw new McpStateStoreError(
        'invalid_recovery_evidence',
        'Recovery cannot replace saved launch or exit evidence.',
      );
    }
  }

  #recoveryProof(record: McpRunRecord): readonly ProcessStatus[] {
    if (record.launch.phase === 'reserved') {
      return [this.#inspectProcess(record.launch.allocation_owner)];
    }
    if (record.launch.supervisor === undefined) {
      return record.launch.runtime === undefined
        ? [this.#inspectProcess(record.launch.allocation_owner)]
        : ['unknown'];
    }
    const supervisorStatus = this.#inspectProcess(record.launch.supervisor);
    const supervisorGroupStatus = this.#inspectProcessGroup(record.launch.supervisor);
    const statuses: ProcessStatus[] = [supervisorStatus, supervisorGroupStatus];
    if (record.launch.authorization_sha256 !== undefined && record.launch.runtime === undefined) {
      if (supervisorStatus !== 'absent' || supervisorGroupStatus !== 'absent') {
        return statuses;
      }
      return [...statuses, this.#inspectProcessToken(record.launch.authorization_sha256)];
    }
    if (record.launch.runtime !== undefined) {
      statuses.push(this.#inspectProcess(record.launch.runtime));
      if (record.launch.runtime.process_group_id !== record.launch.supervisor.process_group_id) {
        statuses.push(this.#inspectProcessGroup(record.launch.runtime));
      }
    }
    return statuses;
  }
}

export function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
