import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

export const DURABLE_JOB_STATES = [
  'starting',
  'running',
  'waiting_for_input',
  'resuming',
  'complete',
  'needs_attention',
  'failed',
  'interrupted',
  'cancelled',
  'recovery_required',
];

export const TERMINAL_JOB_STATES = [
  'complete',
  'needs_attention',
  'failed',
  'interrupted',
  'cancelled',
];

const ACTIVE_JOB_STATES = new Set(['starting', 'running', 'resuming', 'recovery_required']);
const TERMINAL_JOB_STATE_SET = new Set(TERMINAL_JOB_STATES);
const RELEASES_LEASE_STATES = new Set([...TERMINAL_JOB_STATES, 'waiting_for_input']);
const ALLOWED_TRANSITIONS = new Map([
  [
    'starting',
    new Set(['starting', 'running', 'failed', 'interrupted', 'cancelled', 'recovery_required']),
  ],
  [
    'running',
    new Set([
      'running',
      'waiting_for_input',
      'complete',
      'needs_attention',
      'failed',
      'interrupted',
      'cancelled',
      'recovery_required',
    ]),
  ],
  [
    'waiting_for_input',
    new Set([
      'waiting_for_input',
      'resuming',
      'needs_attention',
      'failed',
      'interrupted',
      'cancelled',
    ]),
  ],
  [
    'resuming',
    new Set(['resuming', 'running', 'failed', 'interrupted', 'cancelled', 'recovery_required']),
  ],
  [
    'recovery_required',
    new Set(['recovery_required', 'needs_attention', 'failed', 'interrupted', 'cancelled']),
  ],
  ['complete', new Set(['complete'])],
  ['needs_attention', new Set(['needs_attention'])],
  ['failed', new Set(['failed'])],
  ['interrupted', new Set(['interrupted'])],
  ['cancelled', new Set(['cancelled'])],
]);

const RECORD_VERSION = 1;
const LEASE_VERSION = 1;
const CHECKPOINT_DECISION_VERSION = 1;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_TERMINAL_JOBS = 100;
const DEFAULT_LEASE_STALE_MS = 2 * 60 * 1_000;
const DEFAULT_MAX_EVENTS = 2_000;
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENT_ITEM_BYTES = 16 * 1024;
const DEFAULT_MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_FINAL_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_JOB_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LEASE_FILE_BYTES = 32 * 1024;
const MAX_CHECKPOINT_DECISION_BYTES = 32 * 1024;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireSafeRunId(runId) {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId) || runId === '.' || runId === '..') {
    throw new Error('runId must be a path-safe id of 1 through 64 characters.');
  }
  return runId;
}

function requireSafeOwnerId(ownerId) {
  if (
    typeof ownerId !== 'string' ||
    !SAFE_RUN_ID.test(ownerId) ||
    ownerId === '.' ||
    ownerId === '..'
  ) {
    throw new Error('ownerId must be a path-safe id of 1 through 64 characters.');
  }
  return ownerId;
}

function requireShortString(value, label, maxBytes) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${label} is too large.`);
  }
  return value;
}

function cloneBoundedJson(value, label, maxBytes) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-compatible.`);
  }
  if (json === undefined) throw new Error(`${label} must be JSON-compatible.`);
  if (Buffer.byteLength(json) > maxBytes) throw new Error(`${label} is too large.`);
  return JSON.parse(json);
}

function truncateUtf8(value, maxBytes) {
  if (typeof value !== 'string') return undefined;
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) return value;
  return encoded.subarray(0, maxBytes).toString('utf8');
}

function compactEvent(event) {
  if (!isRecord(event)) return { type: 'unknown' };
  return {
    ...(typeof event.type === 'string' ? { type: truncateUtf8(event.type, 128) } : {}),
    ...(typeof event.recorded_at === 'string'
      ? { recorded_at: truncateUtf8(event.recorded_at, 128) }
      : {}),
    ...(typeof event.label === 'string' ? { label: truncateUtf8(event.label, 1_000) } : {}),
    ...(typeof event.step_id === 'string' ? { step_id: truncateUtf8(event.step_id, 256) } : {}),
    ...(typeof event.outcome === 'string' ? { outcome: truncateUtf8(event.outcome, 128) } : {}),
    ...(typeof event.verdict === 'string' ? { verdict: truncateUtf8(event.verdict, 128) } : {}),
    ...(typeof event.reason === 'string' ? { reason: truncateUtf8(event.reason, 2_000) } : {}),
    ...(typeof event.text === 'string' ? { text: truncateUtf8(event.text, 2_000) } : {}),
    ...(typeof event.display_text === 'string'
      ? { display_text: truncateUtf8(event.display_text, 2_000) }
      : {}),
    ...(typeof event.display?.text === 'string'
      ? { display_text: truncateUtf8(event.display.text, 2_000) }
      : {}),
    ...(typeof event.status_text === 'string'
      ? { status_text: truncateUtf8(event.status_text, 2_000) }
      : {}),
    ...(typeof event.presentation?.status_text === 'string'
      ? { status_text: truncateUtf8(event.presentation.status_text, 2_000) }
      : {}),
  };
}

function timestamp(now) {
  return new Date(now()).toISOString();
}

function parseTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function defaultProcessProbe(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'absent' : 'unknown';
  }
}

async function optionalLstat(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (error?.code !== 'EINVAL' && error?.code !== 'ENOTSUP') throw error;
  } finally {
    await handle?.close();
  }
}

async function readRegularJson(file, maxBytes, label) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | NO_FOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error(`${label} is not a regular file.`);
    if (fileStat.size > maxBytes) throw new Error(`${label} is too large.`);
    const text = await handle.readFile('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} does not contain valid JSON.`);
    }
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`${label} must not be a symbolic link.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function assertReplaceableRegularFile(file, label) {
  const fileStat = await optionalLstat(file);
  if (fileStat === undefined) throw new Error(`${label} does not exist.`);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`${label} must be a regular file and must not be a symbolic link.`);
  }
}

async function writeTempJson(directory, baseName, value, ownerId) {
  const json = `${JSON.stringify(value)}\n`;
  const temporary = path.join(directory, `.${baseName}.${ownerId}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  return temporary;
}

async function createEmptyRegularFile(file) {
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  await handle.close();
}

async function atomicCreateJson(file, value, ownerId) {
  const directory = path.dirname(file);
  const temporary = await writeTempJson(directory, path.basename(file), value, ownerId);
  try {
    await link(temporary, file);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function atomicReplaceJson(file, value, ownerId, label) {
  await assertReplaceableRegularFile(file, label);
  const directory = path.dirname(file);
  const temporary = await writeTempJson(directory, path.basename(file), value, ownerId);
  try {
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function normalizeWorker(value) {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value) || !Number.isInteger(value.pid) || value.pid < 1) {
    throw new Error('worker must contain a positive integer pid.');
  }
  return {
    pid: value.pid,
    ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
  };
}

function validateStoredJob(value, expectedRunId, expectedRunFolder) {
  if (!isRecord(value) || value.version !== RECORD_VERSION) {
    throw new Error(`Stored job ${expectedRunId} has an unsupported format.`);
  }
  if (value.runId !== expectedRunId || !SAFE_RUN_ID.test(value.runId)) {
    throw new Error(`Stored job ${expectedRunId} has a mismatched run id.`);
  }
  if (typeof value.workspace !== 'string' || !path.isAbsolute(value.workspace)) {
    throw new Error(`Stored job ${expectedRunId} has an invalid workspace.`);
  }
  if (value.runFolder !== expectedRunFolder) {
    throw new Error(`Stored job ${expectedRunId} has an unsafe run folder.`);
  }
  const expectedArtifactsRoot = path.join(
    path.dirname(path.dirname(expectedRunFolder)),
    'mcp-jobs-v1',
    'artifacts',
    expectedRunId,
  );
  if (
    !isRecord(value.artifacts) ||
    value.artifacts.root !== expectedArtifactsRoot ||
    value.artifacts.stdoutPath !== path.join(expectedArtifactsRoot, 'stdout.log') ||
    value.artifacts.stderrPath !== path.join(expectedArtifactsRoot, 'stderr.log') ||
    value.artifacts.progressPath !== path.join(expectedArtifactsRoot, 'progress.jsonl')
  ) {
    throw new Error(`Stored job ${expectedRunId} has unsafe artifact paths.`);
  }
  if (typeof value.flow !== 'string' || !DURABLE_JOB_STATES.includes(value.state)) {
    throw new Error(`Stored job ${expectedRunId} has invalid metadata.`);
  }
  if (!Array.isArray(value.events) || !Number.isInteger(value.eventsDropped)) {
    throw new Error(`Stored job ${expectedRunId} has invalid progress metadata.`);
  }
  if (value.events.length > DEFAULT_MAX_EVENTS || value.eventsDropped < 0) {
    throw new Error(`Stored job ${expectedRunId} exceeds progress limits.`);
  }
  return value;
}

function validateLease(value, expectedWorkspaceKey) {
  if (
    !isRecord(value) ||
    value.version !== LEASE_VERSION ||
    value.workspaceKey !== expectedWorkspaceKey ||
    typeof value.workspace !== 'string' ||
    !path.isAbsolute(value.workspace) ||
    typeof value.runId !== 'string' ||
    !SAFE_RUN_ID.test(value.runId) ||
    typeof value.ownerId !== 'string' ||
    !Number.isInteger(value.ownerPid) ||
    value.ownerPid < 1 ||
    typeof value.heartbeatAt !== 'string'
  ) {
    throw new Error(`Workspace lease ${expectedWorkspaceKey} has invalid metadata.`);
  }
  const actualWorkspaceKey = createHash('sha256').update(value.workspace).digest('hex');
  if (actualWorkspaceKey !== expectedWorkspaceKey) {
    throw new Error(`Workspace lease ${expectedWorkspaceKey} does not match its workspace.`);
  }
  return value;
}

function checkpointDecisionKey(job) {
  return createHash('sha256')
    .update(JSON.stringify({ updatedAt: job.updatedAt, checkpoint: job.final?.checkpoint }))
    .digest('hex');
}

function validateCheckpointDecision(value, expectedRunId) {
  if (
    !isRecord(value) ||
    value.version !== CHECKPOINT_DECISION_VERSION ||
    value.runId !== expectedRunId ||
    !SAFE_RUN_ID.test(value.runId) ||
    (value.kind !== 'resume' && value.kind !== 'cancel') ||
    typeof value.decisionKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.decisionKey) ||
    typeof value.ownerId !== 'string' ||
    !SAFE_RUN_ID.test(value.ownerId) ||
    !Number.isInteger(value.ownerPid) ||
    value.ownerPid < 1 ||
    typeof value.acquiredAt !== 'string'
  ) {
    throw new Error(`Checkpoint decision claim ${expectedRunId} has invalid metadata.`);
  }
  return value;
}

export class DurableJobStore {
  constructor(options) {
    if (!isRecord(options) || typeof options.stateRoot !== 'string') {
      throw new Error('DurableJobStore requires stateRoot.');
    }
    this.requestedStateRoot = path.resolve(options.stateRoot);
    this.ownerId = requireSafeOwnerId(options.ownerId ?? randomUUID());
    this.ownerPid = options.ownerPid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.processProbe = options.processProbe ?? defaultProcessProbe;
    this.afterCheckpointDecisionClaim = options.afterCheckpointDecisionClaim;
    if (!Number.isInteger(this.ownerPid) || this.ownerPid < 1) {
      throw new Error('ownerPid must be a positive integer.');
    }
    if (typeof this.now !== 'function' || typeof this.processProbe !== 'function') {
      throw new Error('now and processProbe must be functions.');
    }
    if (
      this.afterCheckpointDecisionClaim !== undefined &&
      typeof this.afterCheckpointDecisionClaim !== 'function'
    ) {
      throw new Error('afterCheckpointDecisionClaim must be a function.');
    }
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxTerminalJobs = options.maxTerminalJobs ?? DEFAULT_MAX_TERMINAL_JOBS;
    this.leaseStaleMs = options.leaseStaleMs ?? DEFAULT_LEASE_STALE_MS;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.maxEventItemBytes = options.maxEventItemBytes ?? DEFAULT_MAX_EVENT_ITEM_BYTES;
    this.maxReportBytes = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
    for (const [label, value] of [
      ['retentionMs', this.retentionMs],
      ['maxTerminalJobs', this.maxTerminalJobs],
      ['leaseStaleMs', this.leaseStaleMs],
      ['maxEvents', this.maxEvents],
      ['maxEventBytes', this.maxEventBytes],
      ['maxEventItemBytes', this.maxEventItemBytes],
      ['maxReportBytes', this.maxReportBytes],
    ]) {
      if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be non-negative.`);
    }
    this.initializationPromise = undefined;
    this.layout = undefined;
    this.queues = new Map();
  }

  async initialize() {
    if (this.initializationPromise === undefined) {
      this.initializationPromise = this.#initializeOnce();
    }
    return await this.initializationPromise;
  }

  async #initializeOnce() {
    await this.#prepareLayout();
    return await this.#recoverInternal();
  }

  async #prepareLayout() {
    const existingRoot = await optionalLstat(this.requestedStateRoot);
    if (existingRoot?.isSymbolicLink()) {
      throw new Error('The durable state root must not be a symbolic link.');
    }
    await mkdir(this.requestedStateRoot, { recursive: true, mode: 0o700 });
    const stateRootStat = await lstat(this.requestedStateRoot);
    if (!stateRootStat.isDirectory() || stateRootStat.isSymbolicLink()) {
      throw new Error('The durable state root must be a real directory.');
    }
    const stateRoot = await realpath(this.requestedStateRoot);
    const durableRoot = path.join(stateRoot, 'mcp-jobs-v1');
    const jobsRoot = path.join(durableRoot, 'jobs');
    const leasesRoot = path.join(durableRoot, 'leases');
    const artifactsRoot = path.join(durableRoot, 'artifacts');
    const runsRoot = path.join(stateRoot, 'runs');
    for (const [candidate, label] of [
      [durableRoot, 'durable state directory'],
      [jobsRoot, 'durable jobs directory'],
      [leasesRoot, 'durable leases directory'],
      [artifactsRoot, 'durable artifacts directory'],
      [runsRoot, 'durable runs directory'],
    ]) {
      const before = await optionalLstat(candidate);
      if (before?.isSymbolicLink()) throw new Error(`The ${label} must not be a symbolic link.`);
      if (before === undefined) await mkdir(candidate, { mode: 0o700 });
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        throw new Error(`The ${label} must be a real directory.`);
      }
      const canonical = await realpath(candidate);
      if (!pathIsInside(stateRoot, canonical)) {
        throw new Error(`The ${label} resolves outside the state root.`);
      }
    }
    this.layout = { stateRoot, durableRoot, jobsRoot, leasesRoot, artifactsRoot, runsRoot };
  }

  async #assertLayoutSafe() {
    if (this.layout === undefined) throw new Error('DurableJobStore is not initialized.');
    for (const [candidate, label] of [
      [this.layout.durableRoot, 'durable state directory'],
      [this.layout.jobsRoot, 'durable jobs directory'],
      [this.layout.leasesRoot, 'durable leases directory'],
      [this.layout.artifactsRoot, 'durable artifacts directory'],
      [this.layout.runsRoot, 'durable runs directory'],
    ]) {
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        throw new Error(`The ${label} is no longer a safe directory.`);
      }
      const canonical = await realpath(candidate);
      if (!pathIsInside(this.layout.stateRoot, canonical)) {
        throw new Error(`The ${label} resolves outside the state root.`);
      }
    }
  }

  async #ready() {
    await this.initialize();
    await this.#assertLayoutSafe();
  }

  #jobFile(runId) {
    requireSafeRunId(runId);
    return path.join(this.layout.jobsRoot, `${runId}.json`);
  }

  #runFolder(runId) {
    requireSafeRunId(runId);
    return path.join(this.layout.runsRoot, runId);
  }

  #artifacts(runId) {
    requireSafeRunId(runId);
    const root = path.join(this.layout.artifactsRoot, runId);
    return {
      root,
      stdoutPath: path.join(root, 'stdout.log'),
      stderrPath: path.join(root, 'stderr.log'),
      progressPath: path.join(root, 'progress.jsonl'),
    };
  }

  #checkpointDecisionFile(runId) {
    return path.join(this.#artifacts(runId).root, 'checkpoint-decision.json');
  }

  #workspaceKey(workspace) {
    return createHash('sha256').update(workspace).digest('hex');
  }

  #leaseDirectory(workspaceKey) {
    return path.join(this.layout.leasesRoot, workspaceKey);
  }

  #leaseFile(workspaceKey) {
    return path.join(this.#leaseDirectory(workspaceKey), 'lease.json');
  }

  async #canonicalWorkspace(workspace) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
      throw new Error('workspace must be an absolute path.');
    }
    const workspaceStat = await lstat(workspace);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
      throw new Error('workspace must be a real directory, not a symbolic link.');
    }
    return await realpath(workspace);
  }

  async #serialize(key, operation) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolvePromise) => {
      release = resolvePromise;
    });
    const queued = previous.catch(() => {}).then(() => current);
    this.queues.set(key, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }

  async #loadJob(runId) {
    const value = await readRegularJson(
      this.#jobFile(runId),
      MAX_JOB_FILE_BYTES,
      `Stored job ${runId}`,
    );
    return validateStoredJob(value, runId, this.#runFolder(runId));
  }

  async #writeJob(job) {
    validateStoredJob(job, job.runId, this.#runFolder(job.runId));
    const encoded = JSON.stringify(job);
    if (Buffer.byteLength(encoded) > MAX_JOB_FILE_BYTES) {
      throw new Error(`Stored job ${job.runId} exceeds the durable metadata limit.`);
    }
    await atomicReplaceJson(this.#jobFile(job.runId), job, this.ownerId, `Stored job ${job.runId}`);
  }

  async #loadLease(workspaceKey) {
    const leaseDirectory = this.#leaseDirectory(workspaceKey);
    const leaseDirectoryStat = await lstat(leaseDirectory);
    if (!leaseDirectoryStat.isDirectory() || leaseDirectoryStat.isSymbolicLink()) {
      throw new Error(`Workspace lease ${workspaceKey} is not a safe directory.`);
    }
    const canonical = await realpath(leaseDirectory);
    if (!pathIsInside(this.layout.leasesRoot, canonical)) {
      throw new Error(`Workspace lease ${workspaceKey} resolves outside the state root.`);
    }
    let value;
    try {
      value = await readRegularJson(
        this.#leaseFile(workspaceKey),
        MAX_LEASE_FILE_BYTES,
        `Workspace lease ${workspaceKey}`,
      );
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `Workspace lease ${workspaceKey} is incomplete, so Circuit will not remove it automatically.`,
        );
      }
      throw error;
    }
    return validateLease(value, workspaceKey);
  }

  async #createLease(workspace, runId) {
    const workspaceKey = this.#workspaceKey(workspace);
    const leaseDirectory = this.#leaseDirectory(workspaceKey);
    await mkdir(leaseDirectory, { mode: 0o700 });
    const acquiredAt = timestamp(this.now);
    const lease = {
      version: LEASE_VERSION,
      workspaceKey,
      workspace,
      runId,
      ownerId: this.ownerId,
      ownerPid: this.ownerPid,
      acquiredAt,
      heartbeatAt: acquiredAt,
    };
    try {
      await atomicCreateJson(this.#leaseFile(workspaceKey), lease, this.ownerId);
      await syncDirectory(this.layout.leasesRoot);
      return lease;
    } catch (error) {
      await rmdir(leaseDirectory).catch(() => {});
      throw error;
    }
  }

  async #removeLease(lease) {
    const current = await this.#loadLease(lease.workspaceKey);
    if (
      current.runId !== lease.runId ||
      current.ownerId !== lease.ownerId ||
      current.ownerPid !== lease.ownerPid ||
      current.workspace !== lease.workspace
    ) {
      throw new Error('Workspace lease changed while it was being released.');
    }
    await unlink(this.#leaseFile(lease.workspaceKey));
    await rmdir(this.#leaseDirectory(lease.workspaceKey));
    await syncDirectory(this.layout.leasesRoot);
  }

  async #probe(pid) {
    if (!Number.isInteger(pid) || pid < 1) return 'unknown';
    const result = await this.processProbe(pid);
    return result === 'alive' || result === 'absent' || result === 'unknown' ? result : 'unknown';
  }

  async #loadCheckpointDecision(runId) {
    const value = await readRegularJson(
      this.#checkpointDecisionFile(runId),
      MAX_CHECKPOINT_DECISION_BYTES,
      `Checkpoint decision claim ${runId}`,
    );
    return validateCheckpointDecision(value, runId);
  }

  async #optionalCheckpointDecision(runId) {
    try {
      return await this.#loadCheckpointDecision(runId);
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async #removeCheckpointDecision(claim) {
    const current = await this.#loadCheckpointDecision(claim.runId);
    if (
      current.decisionKey !== claim.decisionKey ||
      current.ownerId !== claim.ownerId ||
      current.ownerPid !== claim.ownerPid ||
      current.kind !== claim.kind
    ) {
      throw new Error('Checkpoint decision claim changed while it was being released.');
    }
    await unlink(this.#checkpointDecisionFile(claim.runId));
    await syncDirectory(this.#artifacts(claim.runId).root);
  }

  async #acquireCheckpointDecision(job, kind) {
    const decisionKey = checkpointDecisionKey(job);
    const claim = {
      version: CHECKPOINT_DECISION_VERSION,
      runId: job.runId,
      kind,
      decisionKey,
      ownerId: this.ownerId,
      ownerPid: this.ownerPid,
      acquiredAt: timestamp(this.now),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await atomicCreateJson(this.#checkpointDecisionFile(job.runId), claim, this.ownerId);
        await syncDirectory(this.#artifacts(job.runId).root);
        return claim;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      const existing = await this.#loadCheckpointDecision(job.runId);
      const latest = await this.#loadJob(job.runId);
      if (
        latest.state === 'waiting_for_input' &&
        existing.decisionKey !== checkpointDecisionKey(latest)
      ) {
        await this.#removeCheckpointDecision(existing).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
        continue;
      }
      if (latest.state !== 'waiting_for_input') {
        throw new Error('The waiting Circuit checkpoint changed while it was being claimed.');
      }
      const ownerStatus =
        existing.ownerId === this.ownerId ? 'alive' : await this.#probe(existing.ownerPid);
      if (ownerStatus === 'absent') {
        await this.#removeCheckpointDecision(existing).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
        continue;
      }
      throw new Error('Another MCP server is deciding this waiting Circuit checkpoint.');
    }
    throw new Error('The checkpoint decision claim changed while Circuit tried to acquire it.');
  }

  #leaseAge(lease) {
    const heartbeat = parseTimestamp(lease.heartbeatAt);
    return heartbeat === undefined ? undefined : Math.max(0, this.now() - heartbeat);
  }

  async #markInterruptedAfterRecovery(job, detail) {
    const updatedAt = timestamp(this.now);
    const recovered = {
      ...job,
      state: 'interrupted',
      updatedAt,
      finishedAt: updatedAt,
      worker: undefined,
      interruptionConfirmed: true,
      error:
        'The MCP server restarted before Circuit saved a terminal result. The recorded worker is gone, so the run is interrupted.',
      recovery: {
        ambiguous: false,
        reason: detail,
        checkedAt: updatedAt,
      },
    };
    recovered.worker = undefined;
    await this.#writeJob(recovered);
    return recovered;
  }

  async #markRecoveryRequired(job, detail, workerStatus) {
    if (job.state === 'recovery_required' && job.recovery?.reason === detail) return job;
    const checkedAt = timestamp(this.now);
    const recovered = {
      ...job,
      state: 'recovery_required',
      updatedAt: checkedAt,
      error:
        'The MCP server restarted while this run may still have live processes. The worktree remains locked until their exit is confirmed.',
      recovery: {
        ambiguous: true,
        reason: detail,
        workerStatus,
        checkedAt,
      },
    };
    await this.#writeJob(recovered);
    return recovered;
  }

  async #reconcileLease(lease, knownJob) {
    let job = knownJob;
    if (job === undefined) {
      try {
        job = await this.#loadJob(lease.runId);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          const ownerStatus = await this.#probe(lease.ownerPid);
          if (ownerStatus === 'absent') {
            await this.#removeLease(lease);
            return { released: true, blocked: false };
          }
          return {
            released: false,
            blocked: true,
            reason: 'The lease points to a missing job record, and its owner may still be running.',
          };
        }
        throw error;
      }
    }
    if (job.workspace !== lease.workspace) {
      throw new Error(`Workspace lease ${lease.workspaceKey} does not match its job record.`);
    }
    if (job.state === 'waiting_for_input') {
      // Resume acquires the workspace lease while holding the per-run decision
      // claim, then writes `resuming`. A second server can observe the narrow
      // lease-before-state window. Keep that lease while its decision owner may
      // still be alive; otherwise recovery could release it and admit a second
      // run before the resume write lands.
      const decision = await this.#optionalCheckpointDecision(job.runId);
      if (
        decision !== undefined &&
        decision.kind === 'resume' &&
        decision.decisionKey === checkpointDecisionKey(job) &&
        decision.ownerId === lease.ownerId &&
        decision.ownerPid === lease.ownerPid
      ) {
        const ownerStatus =
          decision.ownerId === this.ownerId ? 'alive' : await this.#probe(decision.ownerPid);
        if (ownerStatus !== 'absent') {
          return {
            released: false,
            blocked: true,
            job,
            reason: 'A live checkpoint decision still owns this waiting run.',
          };
        }
        await this.#removeCheckpointDecision(decision).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }
    }
    if (RELEASES_LEASE_STATES.has(job.state)) {
      await this.#removeLease(lease);
      return { released: true, blocked: false, job };
    }
    const ownerStatus = await this.#probe(lease.ownerPid);
    if (lease.ownerId === this.ownerId || ownerStatus !== 'absent') {
      return {
        released: false,
        blocked: true,
        job,
        reason:
          ownerStatus === 'absent'
            ? 'This store still owns the active lease.'
            : 'The lease owner may still be running.',
      };
    }
    const workerStatus = await this.#probe(job.worker?.pid);
    job = await this.#markRecoveryRequired(
      job,
      job.worker === undefined
        ? 'worker_identity_missing'
        : workerStatus === 'absent'
          ? 'recorded_worker_absent_result_unchecked'
          : 'recorded_worker_may_be_alive',
      workerStatus,
    );
    return {
      released: false,
      blocked: true,
      job,
      reason:
        workerStatus === 'absent'
          ? 'The old worker is gone, but its durable output has not been reconciled.'
          : 'The old worker may still be running.',
    };
  }

  async #acquireLease(workspace, runId) {
    const workspaceKey = this.#workspaceKey(workspace);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.#createLease(workspace, runId);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      const lease = await this.#loadLease(workspaceKey);
      if (
        lease.workspace === workspace &&
        lease.runId === runId &&
        lease.ownerId === this.ownerId
      ) {
        return lease;
      }
      const reconciled = await this.#reconcileLease(lease);
      if (reconciled.released) continue;
      const age = this.#leaseAge(lease);
      const staleText =
        age !== undefined && age > this.leaseStaleMs
          ? ' It is old, but age alone is not proof that it is safe to remove.'
          : '';
      throw new Error(
        `Another Circuit run (${lease.runId}) holds this workspace lease.${staleText}`,
      );
    }
    throw new Error('The workspace lease changed while Circuit tried to acquire it.');
  }

  async #acquireFreshLease(workspace, runId) {
    try {
      return await this.#createLease(workspace, runId);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const lease = await this.#loadLease(this.#workspaceKey(workspace));
    const age = this.#leaseAge(lease);
    const staleText =
      age !== undefined && age > this.leaseStaleMs
        ? ' It is old, but age alone is not proof that it is safe to remove.'
        : '';
    throw new Error(`Another Circuit run (${lease.runId}) holds this workspace lease.${staleText}`);
  }

  async #assertOwnLease(workspace, runId) {
    const workspaceKey = this.#workspaceKey(workspace);
    const lease = await this.#loadLease(workspaceKey);
    if (lease.workspace !== workspace || lease.runId !== runId || lease.ownerId !== this.ownerId) {
      throw new Error('This MCP server does not own the workspace lease for that run.');
    }
    return lease;
  }

  async createJob(input) {
    await this.#ready();
    if (!isRecord(input)) throw new Error('createJob input must be an object.');
    const runId = requireSafeRunId(input.runId);
    const flow = requireShortString(input.flow, 'flow', 128);
    const workspace = await this.#canonicalWorkspace(input.workspace);
    return await this.#serialize(`workspace:${this.#workspaceKey(workspace)}`, async () => {
      const lease = await this.#acquireLease(workspace, runId);
      const createdAt = timestamp(this.now);
      const artifacts = this.#artifacts(runId);
      const artifactsStat = await optionalLstat(artifacts.root);
      if (artifactsStat?.isSymbolicLink()) {
        await this.#removeLease(lease).catch(() => {});
        throw new Error('The durable artifact directory must not be a symbolic link.');
      }
      await mkdir(artifacts.root, { mode: 0o700 });
      const canonicalArtifacts = await realpath(artifacts.root);
      if (!pathIsInside(this.layout.artifactsRoot, canonicalArtifacts)) {
        await this.#removeLease(lease).catch(() => {});
        throw new Error('The durable artifact directory resolves outside the state root.');
      }
      try {
        await Promise.all([
          createEmptyRegularFile(artifacts.stdoutPath),
          createEmptyRegularFile(artifacts.stderrPath),
          createEmptyRegularFile(artifacts.progressPath),
        ]);
      } catch (error) {
        await this.#removeLease(lease).catch(() => {});
        await rm(artifacts.root, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const job = {
        version: RECORD_VERSION,
        runId,
        workspace,
        flow,
        runFolder: this.#runFolder(runId),
        artifacts,
        state: 'starting',
        createdAt,
        updatedAt: createdAt,
        events: [],
        eventBytes: 0,
        eventsDropped: 0,
      };
      try {
        await atomicCreateJson(this.#jobFile(runId), job, this.ownerId);
      } catch (error) {
        await this.#removeLease(lease).catch(() => {});
        await rm(artifacts.root, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return structuredClone(job);
    });
  }

  async #claimWaitingTransition(workspaceInput, runIdInput, nextState) {
    await this.#ready();
    const runId = requireSafeRunId(runIdInput);
    const workspace = await this.#canonicalWorkspace(workspaceInput);
    if (nextState !== 'resuming' && nextState !== 'cancelled') {
      throw new Error('A waiting run can only be claimed for resume or cancellation.');
    }
    return await this.#serialize(`workspace:${this.#workspaceKey(workspace)}`, async () => {
      return await this.#serialize(`job:${runId}`, async () => {
        let job = await this.#loadJob(runId);
        if (job.workspace !== workspace) {
          throw new Error('No Circuit run with that id exists in this workspace.');
        }
        if (job.state !== 'waiting_for_input') {
          throw new Error(
            `Only a run waiting for input can be claimed for ${nextState === 'resuming' ? 'resume' : 'cancellation'}.`,
          );
        }
        const decision = await this.#acquireCheckpointDecision(
          job,
          nextState === 'resuming' ? 'resume' : 'cancel',
        );
        let lease;
        let transitioned = false;
        try {
          // The per-run claim is the cross-process compare-and-swap. Re-read
          // after acquiring it so a process that won immediately before us
          // cannot be overwritten from the stale waiting snapshot above.
          job = await this.#loadJob(runId);
          if (
            job.workspace !== workspace ||
            job.state !== 'waiting_for_input' ||
            checkpointDecisionKey(job) !== decision.decisionKey
          ) {
            throw new Error('The waiting Circuit checkpoint changed while it was being claimed.');
          }
          // Cancellation closes an idle checkpoint and does not need the
          // workspace execution lease. Resume acquires that separate lease
          // while it still owns the decision claim.
          if (nextState === 'resuming') lease = await this.#acquireFreshLease(workspace, runId);
          await this.afterCheckpointDecisionClaim?.({
            runId,
            kind: nextState === 'resuming' ? 'resume' : 'cancel',
          });
          const updatedAt = timestamp(this.now);
          const updated = {
            ...job,
            state: nextState,
            updatedAt,
            worker: undefined,
            ...(nextState === 'cancelled'
              ? {
                  finishedAt: updatedAt,
                  final: undefined,
                  report: undefined,
                  interruptionConfirmed: true,
                  error: 'The waiting Circuit checkpoint was cancelled; no process was running.',
                }
              : {}),
          };
          await this.#writeJob(updated);
          transitioned = true;
          return structuredClone(updated);
        } catch (error) {
          if (lease !== undefined && !transitioned) {
            await this.#removeLease(lease).catch(() => undefined);
          }
          throw error;
        } finally {
          await this.#removeCheckpointDecision(decision).catch(() => undefined);
        }
      });
    });
  }

  async claimResume(workspaceInput, runIdInput) {
    return await this.#claimWaitingTransition(workspaceInput, runIdInput, 'resuming');
  }

  async cancelWaitingCheckpoint(workspaceInput, runIdInput) {
    return await this.#claimWaitingTransition(workspaceInput, runIdInput, 'cancelled');
  }

  async updateJob(workspaceInput, runIdInput, patch) {
    await this.#ready();
    const runId = requireSafeRunId(runIdInput);
    const workspace = await this.#canonicalWorkspace(workspaceInput);
    if (!isRecord(patch)) throw new Error('updateJob patch must be an object.');
    const allowedKeys = new Set([
      'state',
      'worker',
      'final',
      'report',
      'error',
      'interruptionConfirmed',
    ]);
    const unsupported = Object.keys(patch).filter((key) => !allowedKeys.has(key));
    if (unsupported.length > 0) {
      throw new Error(`updateJob has unsupported fields: ${unsupported.join(', ')}.`);
    }
    return await this.#serialize(`job:${runId}`, async () => {
      const job = await this.#loadJob(runId);
      if (job.workspace !== workspace) {
        throw new Error('No Circuit run with that id exists in this workspace.');
      }
      const nextState = patch.state ?? job.state;
      if (!DURABLE_JOB_STATES.includes(nextState)) throw new Error('state is not valid.');
      if (!ALLOWED_TRANSITIONS.get(job.state)?.has(nextState)) {
        throw new Error(`Cannot change a durable job from ${job.state} to ${nextState}.`);
      }
      if (ACTIVE_JOB_STATES.has(job.state) || ACTIVE_JOB_STATES.has(nextState)) {
        await this.#assertOwnLease(workspace, runId);
      }
      const updated = { ...job, state: nextState, updatedAt: timestamp(this.now) };
      if ('worker' in patch) {
        const worker = normalizeWorker(patch.worker);
        if (worker === undefined) updated.worker = undefined;
        else updated.worker = worker;
      }
      if ('final' in patch) {
        if (patch.final === null || patch.final === undefined) updated.final = undefined;
        else updated.final = cloneBoundedJson(patch.final, 'final result', MAX_FINAL_BYTES);
      }
      if ('report' in patch) {
        if (patch.report === null || patch.report === undefined) updated.report = undefined;
        else updated.report = cloneBoundedJson(patch.report, 'report', this.maxReportBytes);
      }
      if ('error' in patch) {
        if (patch.error === null || patch.error === undefined) updated.error = undefined;
        else updated.error = requireShortString(patch.error, 'error', MAX_ERROR_BYTES);
      }
      if ('interruptionConfirmed' in patch) {
        if (patch.interruptionConfirmed === undefined) updated.interruptionConfirmed = undefined;
        else if (typeof patch.interruptionConfirmed !== 'boolean') {
          throw new Error('interruptionConfirmed must be true or false.');
        } else updated.interruptionConfirmed = patch.interruptionConfirmed;
      }
      if (TERMINAL_JOB_STATE_SET.has(nextState)) {
        updated.finishedAt ??= updated.updatedAt;
        updated.worker = undefined;
      }
      await this.#writeJob(updated);
      if (RELEASES_LEASE_STATES.has(nextState) && ACTIVE_JOB_STATES.has(job.state)) {
        const lease = await this.#assertOwnLease(workspace, runId);
        await this.#removeLease(lease);
      } else if (ACTIVE_JOB_STATES.has(nextState)) {
        await this.#heartbeatLease(updated);
      }
      return structuredClone(updated);
    });
  }

  async #heartbeatLease(job) {
    const lease = await this.#assertOwnLease(job.workspace, job.runId);
    const updated = {
      ...lease,
      heartbeatAt: timestamp(this.now),
      ...(job.worker === undefined ? {} : { workerPid: job.worker.pid }),
    };
    await atomicReplaceJson(
      this.#leaseFile(lease.workspaceKey),
      updated,
      this.ownerId,
      `Workspace lease ${lease.workspaceKey}`,
    );
  }

  async appendEvent(workspaceInput, runIdInput, eventInput) {
    await this.#ready();
    const runId = requireSafeRunId(runIdInput);
    const workspace = await this.#canonicalWorkspace(workspaceInput);
    return await this.#serialize(`job:${runId}`, async () => {
      const job = await this.#loadJob(runId);
      if (job.workspace !== workspace) {
        throw new Error('No Circuit run with that id exists in this workspace.');
      }
      const event = compactEvent(eventInput);
      event.cursor = job.events.length;
      const eventBytes = Buffer.byteLength(JSON.stringify(event));
      const shouldDrop =
        eventBytes > this.maxEventItemBytes ||
        job.events.length >= this.maxEvents ||
        job.eventBytes + eventBytes > this.maxEventBytes;
      const updated = {
        ...job,
        updatedAt: timestamp(this.now),
        ...(shouldDrop
          ? { eventsDropped: job.eventsDropped + 1 }
          : {
              events: [...job.events, event],
              eventBytes: job.eventBytes + eventBytes,
            }),
      };
      await this.#writeJob(updated);
      return {
        recorded: !shouldDrop,
        cursor: shouldDrop ? job.events.length : event.cursor,
        eventsDropped: updated.eventsDropped,
      };
    });
  }

  async getJob(workspaceInput, runIdInput) {
    await this.#ready();
    const runId = requireSafeRunId(runIdInput);
    const workspace = await this.#canonicalWorkspace(workspaceInput);
    const job = await this.#loadJob(runId);
    if (job.workspace !== workspace) {
      throw new Error('No Circuit run with that id exists in this workspace.');
    }
    return structuredClone(job);
  }

  async reconcileJob(workspaceInput, runIdInput) {
    await this.#ready();
    const runId = requireSafeRunId(runIdInput);
    const workspace = await this.#canonicalWorkspace(workspaceInput);
    return await this.#serialize(`workspace:${this.#workspaceKey(workspace)}`, async () => {
      const job = await this.#loadJob(runId);
      if (job.workspace !== workspace) {
        throw new Error('No Circuit run with that id exists in this workspace.');
      }
      if (!ACTIVE_JOB_STATES.has(job.state)) return structuredClone(job);
      const lease = await this.#loadLease(this.#workspaceKey(workspace));
      if (lease.runId !== runId || lease.workspace !== workspace) {
        throw new Error('This run does not own the durable workspace lease.');
      }
      const reconciled = await this.#reconcileLease(lease, job);
      return structuredClone(reconciled.job ?? job);
    });
  }

  async resolveRecovery(workspaceInput, runIdInput, options) {
    await this.#ready();
    if (!isRecord(options) || options.confirmedNoProcesses !== true) {
      throw new Error('resolveRecovery requires confirmedNoProcesses: true.');
    }
    const runId = requireSafeRunId(runIdInput);
    const workspace = await this.#canonicalWorkspace(workspaceInput);
    return await this.#serialize(`workspace:${this.#workspaceKey(workspace)}`, async () => {
      const job = await this.#loadJob(runId);
      if (job.workspace !== workspace || job.state !== 'recovery_required') {
        throw new Error('That run is not waiting for recovery confirmation in this workspace.');
      }
      const lease = await this.#loadLease(this.#workspaceKey(workspace));
      if (lease.runId !== runId || lease.workspace !== workspace) {
        throw new Error('This run does not own the durable workspace lease.');
      }
      const updated = await this.#markInterruptedAfterRecovery(
        job,
        'operator_confirmed_no_processes',
      );
      await this.#removeLease(lease);
      return structuredClone(updated);
    });
  }

  async commitRecoveredTerminal(workspaceInput, runIdInput, patch) {
    if (!isRecord(patch)) throw new Error('commitRecoveredTerminal patch must be an object.');
    if (!TERMINAL_JOB_STATE_SET.has(patch.state)) {
      throw new Error('commitRecoveredTerminal requires a terminal state.');
    }
    return await this.commitRecoveredResult(workspaceInput, runIdInput, patch);
  }

  async commitRecoveredResult(workspaceInput, runIdInput, patch) {
    await this.#ready();
    const runId = requireSafeRunId(runIdInput);
    const workspace = await this.#canonicalWorkspace(workspaceInput);
    if (!isRecord(patch)) throw new Error('commitRecoveredResult patch must be an object.');
    const allowedKeys = new Set(['state', 'final', 'report', 'error', 'interruptionConfirmed']);
    const unsupported = Object.keys(patch).filter((key) => !allowedKeys.has(key));
    if (unsupported.length > 0) {
      throw new Error(`commitRecoveredResult has unsupported fields: ${unsupported.join(', ')}.`);
    }
    if (patch.state !== 'waiting_for_input' && !TERMINAL_JOB_STATE_SET.has(patch.state)) {
      throw new Error('commitRecoveredResult requires waiting_for_input or a terminal state.');
    }
    return await this.#serialize(`workspace:${this.#workspaceKey(workspace)}`, async () => {
      const job = await this.#loadJob(runId);
      if (job.workspace !== workspace || job.state !== 'recovery_required') {
        throw new Error('That run is not waiting for terminal recovery in this workspace.');
      }
      const lease = await this.#loadLease(this.#workspaceKey(workspace));
      if (lease.runId !== runId || lease.workspace !== workspace) {
        throw new Error('This run does not own the durable workspace lease.');
      }
      const ownerStatus =
        lease.ownerId === this.ownerId ? 'absent' : await this.#probe(lease.ownerPid);
      const workerStatus = await this.#probe(job.worker?.pid);
      if (ownerStatus !== 'absent' || workerStatus !== 'absent') {
        throw new Error('Recovered output cannot be committed until both old processes are gone.');
      }
      const updatedAt = timestamp(this.now);
      const updated = {
        ...job,
        state: patch.state,
        updatedAt,
        recovery: {
          ambiguous: false,
          reason: 'durable_output_reconciled',
          checkedAt: updatedAt,
        },
      };
      updated.finishedAt = TERMINAL_JOB_STATE_SET.has(patch.state) ? updatedAt : undefined;
      updated.worker = undefined;
      if ('final' in patch) {
        if (patch.final === null || patch.final === undefined) updated.final = undefined;
        else updated.final = cloneBoundedJson(patch.final, 'final result', MAX_FINAL_BYTES);
      }
      if ('report' in patch) {
        if (patch.report === null || patch.report === undefined) updated.report = undefined;
        else updated.report = cloneBoundedJson(patch.report, 'report', this.maxReportBytes);
      }
      if ('error' in patch) {
        if (patch.error === null || patch.error === undefined) updated.error = undefined;
        else updated.error = requireShortString(patch.error, 'error', MAX_ERROR_BYTES);
      } else {
        updated.error = undefined;
      }
      if ('interruptionConfirmed' in patch) {
        if (typeof patch.interruptionConfirmed !== 'boolean') {
          throw new Error('interruptionConfirmed must be true or false.');
        }
        updated.interruptionConfirmed = patch.interruptionConfirmed;
      }
      await this.#writeJob(updated);
      await this.#removeLease(lease);
      return structuredClone(updated);
    });
  }

  async #recoverInternal() {
    await this.#assertLayoutSafe();
    const jobNames = await readdir(this.layout.jobsRoot, { withFileTypes: true });
    const jobs = [];
    for (const entry of jobNames) {
      if (entry.name.startsWith('.') && entry.name.endsWith('.tmp')) continue;
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        throw new Error(`Unexpected entry in durable jobs directory: ${entry.name}.`);
      }
      const runId = entry.name.slice(0, -'.json'.length);
      requireSafeRunId(runId);
      jobs.push(await this.#loadJob(runId));
    }
    const jobsById = new Map(jobs.map((job) => [job.runId, job]));
    const leaseEntries = await readdir(this.layout.leasesRoot, { withFileTypes: true });
    const seenLeaseRuns = new Set();
    const releasedLeases = [];
    const blocked = [];
    const interrupted = [];
    for (const entry of leaseEntries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) {
        throw new Error(`Unexpected entry in durable leases directory: ${entry.name}.`);
      }
      const lease = await this.#loadLease(entry.name);
      seenLeaseRuns.add(lease.runId);
      const reconciled = await this.#reconcileLease(lease, jobsById.get(lease.runId));
      if (reconciled.released) {
        releasedLeases.push(lease.runId);
        if (reconciled.job?.state === 'interrupted') interrupted.push(lease.runId);
      } else {
        blocked.push({
          runId: lease.runId,
          workspace: lease.workspace,
          reason: reconciled.reason,
        });
      }
      if (reconciled.job !== undefined) jobsById.set(lease.runId, reconciled.job);
    }
    for (const job of jobsById.values()) {
      if (!ACTIVE_JOB_STATES.has(job.state) || seenLeaseRuns.has(job.runId)) continue;
      try {
        await this.#createLease(job.workspace, job.runId);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          blocked.push({
            runId: job.runId,
            workspace: job.workspace,
            reason: 'A workspace lease appeared during recovery.',
          });
          continue;
        }
        throw error;
      }
      const workerStatus = await this.#probe(job.worker?.pid);
      const recovered = await this.#markRecoveryRequired(
        job,
        job.worker === undefined
          ? 'orphan_worker_identity_missing'
          : workerStatus === 'absent'
            ? 'orphan_worker_absent_result_unchecked'
            : 'orphan_worker_may_be_alive',
        workerStatus,
      );
      jobsById.set(job.runId, recovered);
      blocked.push({
        runId: job.runId,
        workspace: job.workspace,
        reason:
          workerStatus === 'absent'
            ? 'An orphaned job has durable output that still needs reconciliation.'
            : 'An active job had no lease and its worker exit could not be confirmed.',
      });
    }
    return {
      jobs: [...jobsById.values()].map((job) => structuredClone(job)),
      terminalRunIds: [...jobsById.values()]
        .filter((job) => TERMINAL_JOB_STATE_SET.has(job.state))
        .map((job) => job.runId),
      interruptedRunIds: interrupted,
      releasedLeaseRunIds: releasedLeases,
      blocked,
    };
  }

  async cleanupRetention() {
    await this.#ready();
    return await this.#serialize('retention', async () => {
      const entries = await readdir(this.layout.jobsRoot, { withFileTypes: true });
      const terminalJobs = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const runId = entry.name.slice(0, -'.json'.length);
        const job = await this.#loadJob(runId);
        if (TERMINAL_JOB_STATE_SET.has(job.state)) terminalJobs.push(job);
      }
      terminalJobs.sort((left, right) => {
        return (parseTimestamp(left.updatedAt) ?? 0) - (parseTimestamp(right.updatedAt) ?? 0);
      });
      const cutoff = this.now() - this.retentionMs;
      const excess = Math.max(0, terminalJobs.length - this.maxTerminalJobs);
      const selected = terminalJobs.filter((job, index) => {
        return index < excess || (parseTimestamp(job.updatedAt) ?? 0) <= cutoff;
      });
      const removedRunIds = [];
      const removedRunFolderLinks = [];
      const removedArtifactLinks = [];
      for (const job of selected) {
        await assertReplaceableRegularFile(this.#jobFile(job.runId), `Stored job ${job.runId}`);
        const workspaceKey = this.#workspaceKey(job.workspace);
        const leaseStat = await optionalLstat(this.#leaseDirectory(workspaceKey));
        if (leaseStat !== undefined) {
          const lease = await this.#loadLease(workspaceKey);
          if (lease.runId === job.runId) await this.#removeLease(lease);
        }
        const runFolder = this.#runFolder(job.runId);
        const runFolderStat = await optionalLstat(runFolder);
        if (runFolderStat?.isSymbolicLink()) {
          await unlink(runFolder);
          removedRunFolderLinks.push(job.runId);
        } else if (runFolderStat?.isDirectory()) {
          await rm(runFolder, { recursive: true });
        } else if (runFolderStat !== undefined) {
          await unlink(runFolder);
        }
        const artifactsRoot = this.#artifacts(job.runId).root;
        const artifactsStat = await optionalLstat(artifactsRoot);
        if (artifactsStat?.isSymbolicLink()) {
          await unlink(artifactsRoot);
          removedArtifactLinks.push(job.runId);
        } else if (artifactsStat?.isDirectory()) {
          await rm(artifactsRoot, { recursive: true });
        } else if (artifactsStat !== undefined) {
          await unlink(artifactsRoot);
        }
        await syncDirectory(this.layout.runsRoot);
        await syncDirectory(this.layout.artifactsRoot);
        await assertReplaceableRegularFile(this.#jobFile(job.runId), `Stored job ${job.runId}`);
        await unlink(this.#jobFile(job.runId));
        await syncDirectory(this.layout.jobsRoot);
        removedRunIds.push(job.runId);
      }
      await syncDirectory(this.layout.jobsRoot);
      await syncDirectory(this.layout.runsRoot);
      await syncDirectory(this.layout.artifactsRoot);
      return {
        removedRunIds,
        removedRunFolderLinks,
        removedArtifactLinks,
        retainedTerminalJobs: terminalJobs.length - selected.length,
      };
    });
  }
}
