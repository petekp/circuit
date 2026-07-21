import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { interruptObservedProcessTree, observeDescendants } from './proof-sandbox.mjs';

export const RUNTIME_LAUNCH_SCHEMA = 'circuit.mcp-runtime-launch@v1';
export const RUNTIME_EXIT_SCHEMA = 'circuit.mcp-runtime-exit@v1';
export const RUNTIME_CHILD_SCHEMA = 'circuit.mcp-runtime-child@v1';
export const RUNTIME_STDOUT_LIMIT_BYTES = 4 * 1024 * 1024;
export const RUNTIME_STDERR_LIMIT_BYTES = 4 * 1024 * 1024;

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_EXIT_BYTES = 128 * 1024;
const MAX_CHILD_BYTES = 16 * 1024;
const MAX_CLAIM_BYTES = 16 * 1024;
const MAX_PATH_CHARS = 8 * 1024;
const MAX_ARG_COUNT = 256;
const MAX_ARG_CHARS = 64 * 1024;
const MAX_ARG_BYTES = 256 * 1024;
const MAX_ENV_ENTRIES = 128;
const MAX_ENV_KEY_CHARS = 128;
const MAX_ENV_VALUE_CHARS = 32 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const MAX_RECORDED_PIDS = 2_048;
const POLL_MS = 25;
const COOPERATIVE_GRACE_MS = 250;
const REAP_WAIT_MS = 1_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const FORBIDDEN_ENV_KEYS = new Set([
  'BASH_ENV',
  'ENV',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_HISTORY',
]);
const TRANSIENT_RUNTIME_ENV_KEYS = new Set([
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
]);

export class RuntimeSupervisorBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeSupervisorBlockedError';
  }
}

function inspectionError(label, error) {
  const wrapped = new RuntimeSupervisorBlockedError(
    `${label} could not be inspected: ${error.message}`,
  );
  if (typeof error?.code === 'string') wrapped.code = error.code;
  return wrapped;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function splitRuntimeLaunchEnvironment(value) {
  if (!isRecord(value)) {
    throw new RuntimeSupervisorBlockedError('runtime environment must be an object.');
  }
  const durable = {};
  const transient = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (typeof entry !== 'string' || entry.includes('\0') || entry.length > MAX_ENV_VALUE_CHARS) {
      throw new RuntimeSupervisorBlockedError(
        `env value for ${JSON.stringify(key)} is invalid or too long.`,
      );
    }
    if (TRANSIENT_RUNTIME_ENV_KEYS.has(key)) transient[key] = entry;
    else durable[key] = entry;
  }
  return { durable, transient };
}

function assertExactKeys(value, allowed, label) {
  if (!isRecord(value)) throw new RuntimeSupervisorBlockedError(`${label} must be an object.`);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new RuntimeSupervisorBlockedError(
      `${label} has unsupported field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}.`,
    );
  }
  const missing = [...allowed].filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new RuntimeSupervisorBlockedError(
      `${label} is missing field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
    );
  }
}

function requiredString(value, label, maxChars = MAX_ARG_CHARS) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeSupervisorBlockedError(`${label} must be a non-empty string.`);
  }
  if (value.length > maxChars || value.includes('\0')) {
    throw new RuntimeSupervisorBlockedError(`${label} is invalid or too long.`);
  }
  return value;
}

function requireSafeRunId(value) {
  if (typeof value !== 'string' || !SAFE_RUN_ID.test(value) || value === '.' || value === '..') {
    throw new RuntimeSupervisorBlockedError(
      'run_id must be a path-safe id of 1 through 64 characters.',
    );
  }
  return value;
}

function requireAbsoluteNormalizedPath(value, label) {
  const candidate = requiredString(value, label, MAX_PATH_CHARS);
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
    throw new RuntimeSupervisorBlockedError(`${label} must be an absolute, normalized path.`);
  }
  return candidate;
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function optionalLstat(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertCanonicalDirectory(candidate, label) {
  const stat = await lstat(candidate).catch((error) => {
    throw inspectionError(label, error);
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new RuntimeSupervisorBlockedError(
      `${label} must be a real directory, not a symbolic link.`,
    );
  }
  const canonical = await realpath(candidate);
  if (canonical !== candidate) {
    throw new RuntimeSupervisorBlockedError(`${label} must already be canonical.`);
  }
  return canonical;
}

async function assertCanonicalRegularFile(candidate, label) {
  const stat = await lstat(candidate).catch((error) => {
    throw inspectionError(label, error);
  });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new RuntimeSupervisorBlockedError(`${label} must be a regular, non-symbolic-link file.`);
  }
  const canonical = await realpath(candidate);
  if (canonical !== candidate) {
    throw new RuntimeSupervisorBlockedError(`${label} must already be canonical.`);
  }
  return canonical;
}

async function assertFixedRegularFile(candidate, label) {
  const stat = await lstat(candidate).catch((error) => {
    throw inspectionError(label, error);
  });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new RuntimeSupervisorBlockedError(`${label} must be a regular, non-symbolic-link file.`);
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

async function writeTemporaryJson(directory, baseName, value, maxBytes) {
  const json = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(json) > maxBytes) {
    throw new RuntimeSupervisorBlockedError(`${baseName} exceeds its size limit.`);
  }
  const temporary = path.join(directory, `.${baseName}.${process.pid}.${randomUUID()}.tmp`);
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

async function atomicCreateJson(file, value, maxBytes) {
  const directory = path.dirname(file);
  const temporary = await writeTemporaryJson(directory, path.basename(file), value, maxBytes);
  try {
    await link(temporary, file);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function atomicReplaceJson(file, value, maxBytes) {
  const directory = path.dirname(file);
  const temporary = await writeTemporaryJson(directory, path.basename(file), value, maxBytes);
  try {
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readRegularJson(file, maxBytes, label) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | NO_FOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new RuntimeSupervisorBlockedError(`${label} is not a regular file.`);
    if (stat.size > maxBytes) throw new RuntimeSupervisorBlockedError(`${label} is too large.`);
    const text = await handle.readFile('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new RuntimeSupervisorBlockedError(`${label} does not contain valid JSON.`);
    }
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new RuntimeSupervisorBlockedError(`${label} must not be a symbolic link.`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export function runtimeSupervisorPaths(stateRootInput, runIdInput) {
  const stateRoot = requireAbsoluteNormalizedPath(stateRootInput, 'state_root');
  const runId = requireSafeRunId(runIdInput);
  const artifactRoot = path.join(stateRoot, 'mcp-jobs-v1', 'artifacts', runId);
  const runRoot = path.join(stateRoot, 'runs', runId);
  return {
    artifactRoot,
    runRoot,
    requestPath: path.join(artifactRoot, 'launch-request.json'),
    claimPath: path.join(artifactRoot, 'supervisor.lock'),
    stdoutPath: path.join(artifactRoot, 'stdout.log'),
    stderrPath: path.join(artifactRoot, 'stderr.log'),
    childPath: path.join(artifactRoot, 'runtime-child.json'),
    exitPath: path.join(artifactRoot, 'exit.json'),
    cancelPath: path.join(runRoot, 'cancel.requested'),
  };
}

function validateArgv(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARG_COUNT) {
    throw new RuntimeSupervisorBlockedError(`argv must contain 1 to ${MAX_ARG_COUNT} strings.`);
  }
  let bytes = 0;
  const argv = value.map((entry, index) => {
    const argument = requiredString(entry, `argv[${index}]`);
    bytes += Buffer.byteLength(argument);
    return argument;
  });
  if (bytes > MAX_ARG_BYTES) throw new RuntimeSupervisorBlockedError('argv is too large.');
  return argv;
}

function validateEnvironment(value, cancelPath) {
  if (!isRecord(value)) throw new RuntimeSupervisorBlockedError('env must be an object.');
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV_ENTRIES) {
    throw new RuntimeSupervisorBlockedError(`env exceeds ${MAX_ENV_ENTRIES} entries.`);
  }
  let bytes = 0;
  const env = {};
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > MAX_ENV_KEY_CHARS) {
      throw new RuntimeSupervisorBlockedError(`env key ${JSON.stringify(key)} is invalid.`);
    }
    if (TRANSIENT_RUNTIME_ENV_KEYS.has(key)) {
      throw new RuntimeSupervisorBlockedError(
        `${key} is transient and must not be persisted in a runtime launch request.`,
      );
    }
    if (FORBIDDEN_ENV_KEYS.has(key) || key.startsWith('DYLD_')) {
      throw new RuntimeSupervisorBlockedError(`${key} is not allowed in a runtime launch.`);
    }
    if (typeof entry !== 'string' || entry.includes('\0') || entry.length > MAX_ENV_VALUE_CHARS) {
      throw new RuntimeSupervisorBlockedError(
        `env value for ${JSON.stringify(key)} is invalid or too long.`,
      );
    }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(entry);
    env[key] = entry;
  }
  if (bytes > MAX_ENV_BYTES) throw new RuntimeSupervisorBlockedError('env is too large.');
  if (env.CIRCUIT_MCP_SEALED !== '1') {
    throw new RuntimeSupervisorBlockedError('env must enable CIRCUIT_MCP_SEALED=1.');
  }
  if (env.CIRCUIT_MCP_CANCEL_FILE !== cancelPath) {
    throw new RuntimeSupervisorBlockedError(
      'env CIRCUIT_MCP_CANCEL_FILE must match the fixed cancel path.',
    );
  }
  return env;
}

function validateTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new RuntimeSupervisorBlockedError(
      `timeout_ms must be an integer from 1 through ${MAX_TIMEOUT_MS}.`,
    );
  }
  return value;
}

function inferRequestLocation(requestPathInput) {
  const requestPath = requireAbsoluteNormalizedPath(requestPathInput, 'launch request path');
  const artifactRoot = path.dirname(requestPath);
  const runId = path.basename(artifactRoot);
  const artifactsRoot = path.dirname(artifactRoot);
  const durableRoot = path.dirname(artifactsRoot);
  const stateRoot = path.dirname(durableRoot);
  if (
    path.basename(requestPath) !== 'launch-request.json' ||
    path.basename(artifactsRoot) !== 'artifacts' ||
    path.basename(durableRoot) !== 'mcp-jobs-v1' ||
    !SAFE_RUN_ID.test(runId)
  ) {
    throw new RuntimeSupervisorBlockedError(
      'The launch request must use its fixed artifact location.',
    );
  }
  return { requestPath, stateRoot, runId };
}

async function validateRequestValue(value, requestPathInput) {
  assertExactKeys(
    value,
    new Set([
      'schema',
      'run_id',
      'state_root',
      'runtime_path',
      'cwd',
      'argv',
      'env',
      'timeout_ms',
      'paths',
    ]),
    'runtime launch request',
  );
  if (value.schema !== RUNTIME_LAUNCH_SCHEMA) {
    throw new RuntimeSupervisorBlockedError(
      `runtime launch request must use ${RUNTIME_LAUNCH_SCHEMA}.`,
    );
  }
  const inferred = inferRequestLocation(requestPathInput);
  const runId = requireSafeRunId(value.run_id);
  const stateRoot = requireAbsoluteNormalizedPath(value.state_root, 'state_root');
  if (runId !== inferred.runId || stateRoot !== inferred.stateRoot) {
    throw new RuntimeSupervisorBlockedError(
      'The launch request does not match its fixed artifact location.',
    );
  }
  await assertCanonicalDirectory(stateRoot, 'state_root');
  const fixed = runtimeSupervisorPaths(stateRoot, runId);
  if (fixed.requestPath !== inferred.requestPath) {
    throw new RuntimeSupervisorBlockedError(
      'The launch request does not match its fixed artifact location.',
    );
  }
  await assertCanonicalDirectory(path.join(stateRoot, 'mcp-jobs-v1'), 'durable state directory');
  await assertCanonicalDirectory(
    path.join(stateRoot, 'mcp-jobs-v1', 'artifacts'),
    'artifact state directory',
  );
  await assertCanonicalDirectory(fixed.artifactRoot, 'run artifact directory');
  await assertCanonicalDirectory(path.join(stateRoot, 'runs'), 'run state directory');
  const runRootStat = await optionalLstat(fixed.runRoot);
  if (runRootStat !== undefined) {
    await assertCanonicalDirectory(fixed.runRoot, 'run directory');
  }
  if (!pathIsInside(stateRoot, fixed.artifactRoot) || !pathIsInside(stateRoot, fixed.runRoot)) {
    throw new RuntimeSupervisorBlockedError('Runtime paths escape state_root.');
  }
  const runtimePath = requireAbsoluteNormalizedPath(value.runtime_path, 'runtime_path');
  await assertCanonicalRegularFile(runtimePath, 'runtime_path');
  const cwd = requireAbsoluteNormalizedPath(value.cwd, 'cwd');
  await assertCanonicalDirectory(cwd, 'cwd');
  assertExactKeys(value.paths, new Set(['stdout', 'stderr', 'exit', 'cancel']), 'paths');
  const paths = {
    stdout: requireAbsoluteNormalizedPath(value.paths.stdout, 'paths.stdout'),
    stderr: requireAbsoluteNormalizedPath(value.paths.stderr, 'paths.stderr'),
    exit: requireAbsoluteNormalizedPath(value.paths.exit, 'paths.exit'),
    cancel: requireAbsoluteNormalizedPath(value.paths.cancel, 'paths.cancel'),
  };
  if (
    paths.stdout !== fixed.stdoutPath ||
    paths.stderr !== fixed.stderrPath ||
    paths.exit !== fixed.exitPath ||
    paths.cancel !== fixed.cancelPath
  ) {
    throw new RuntimeSupervisorBlockedError(
      'stdout, stderr, exit, and cancel must use their fixed run locations.',
    );
  }
  await assertFixedRegularFile(paths.stdout, 'paths.stdout');
  await assertFixedRegularFile(paths.stderr, 'paths.stderr');
  const cancelStat = await optionalLstat(paths.cancel);
  if (cancelStat !== undefined && (cancelStat.isSymbolicLink() || !cancelStat.isFile())) {
    throw new RuntimeSupervisorBlockedError(
      'paths.cancel must be absent or a regular, non-symbolic-link file.',
    );
  }
  const argv = validateArgv(value.argv);
  const env = validateEnvironment(value.env, paths.cancel);
  const timeoutMs = validateTimeout(value.timeout_ms);
  return {
    schema: RUNTIME_LAUNCH_SCHEMA,
    run_id: runId,
    state_root: stateRoot,
    runtime_path: runtimePath,
    cwd,
    argv,
    env,
    timeout_ms: timeoutMs,
    paths,
  };
}

export async function parseRuntimeLaunchRequest(requestPath) {
  const inferred = inferRequestLocation(requestPath);
  const value = await readRegularJson(inferred.requestPath, MAX_REQUEST_BYTES, 'launch request');
  return await validateRequestValue(value, inferred.requestPath);
}

function requirePositivePid(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RuntimeSupervisorBlockedError(`${label} must be a positive integer.`);
  }
  return value;
}

function requireIsoTimestamp(value, label) {
  const timestamp = requiredString(value, label, 128);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new RuntimeSupervisorBlockedError(`${label} must be an ISO timestamp.`);
  }
  return timestamp;
}

function validateRuntimeChildRecord(value, runId) {
  assertExactKeys(
    value,
    new Set([
      'schema',
      'run_id',
      'launch_id',
      'child_pid',
      'process_group_id',
      'supervisor_pid',
      'started_at',
    ]),
    'runtime child record',
  );
  if (value.schema !== RUNTIME_CHILD_SCHEMA) {
    throw new RuntimeSupervisorBlockedError(
      `runtime child record must use ${RUNTIME_CHILD_SCHEMA}.`,
    );
  }
  if (requireSafeRunId(value.run_id) !== runId) {
    throw new RuntimeSupervisorBlockedError('runtime child record does not match this run.');
  }
  const launchId = requiredString(value.launch_id, 'runtime child launch_id', 128);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(launchId)) {
    throw new RuntimeSupervisorBlockedError('runtime child launch_id is invalid.');
  }
  const childPid = requirePositivePid(value.child_pid, 'runtime child child_pid');
  const processGroupId = requirePositivePid(
    value.process_group_id,
    'runtime child process_group_id',
  );
  if (processGroupId !== childPid) {
    throw new RuntimeSupervisorBlockedError(
      'runtime child process_group_id must match its detached child_pid.',
    );
  }
  return {
    schema: RUNTIME_CHILD_SCHEMA,
    run_id: runId,
    launch_id: launchId,
    child_pid: childPid,
    process_group_id: processGroupId,
    supervisor_pid: requirePositivePid(value.supervisor_pid, 'runtime child supervisor_pid'),
    started_at: requireIsoTimestamp(value.started_at, 'runtime child started_at'),
  };
}

export async function readRuntimeChildRecord(stateRootInput, runIdInput) {
  const stateRoot = requireAbsoluteNormalizedPath(stateRootInput, 'state_root');
  const runId = requireSafeRunId(runIdInput);
  await assertCanonicalDirectory(stateRoot, 'state_root');
  const childPath = runtimeSupervisorPaths(stateRoot, runId).childPath;
  const value = await readRegularJson(childPath, MAX_CHILD_BYTES, 'runtime child record');
  return validateRuntimeChildRecord(value, runId);
}

async function readSupervisorClaim(claimPath) {
  const value = await readRegularJson(claimPath, MAX_CLAIM_BYTES, 'supervisor claim');
  assertExactKeys(value, new Set(['schema', 'supervisor_pid', 'started_at']), 'supervisor claim');
  if (value.schema !== 'circuit.mcp-runtime-claim@v1') {
    throw new RuntimeSupervisorBlockedError(
      'supervisor claim must use circuit.mcp-runtime-claim@v1.',
    );
  }
  return {
    schema: value.schema,
    supervisor_pid: requirePositivePid(value.supervisor_pid, 'supervisor claim pid'),
    started_at: requireIsoTimestamp(value.started_at, 'supervisor claim started_at'),
  };
}

function processMayExist(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function assertSafeOptionalFile(file, label) {
  const stat = await optionalLstat(file);
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new RuntimeSupervisorBlockedError(`${label} must be a regular, non-symbolic-link file.`);
  }
  return stat;
}

async function prepareRelaunch(paths, validated, requestExists) {
  const exitStat = await assertSafeOptionalFile(paths.exitPath, 'previous exit record');
  const claimStat = await assertSafeOptionalFile(paths.claimPath, 'previous supervisor claim');
  const childStat = await assertSafeOptionalFile(paths.childPath, 'previous runtime child record');

  // A terminal exit is authoritative. Without one, a still-live supervisor or
  // runtime child means cleanup is not safe and a second launch must wait.
  if (exitStat === undefined && claimStat !== undefined) {
    const claim = await readSupervisorClaim(paths.claimPath);
    if (processMayExist(claim.supervisor_pid)) {
      throw new RuntimeSupervisorBlockedError(
        'The previous supervisor may still be running; relaunch is blocked.',
      );
    }
  }
  if (exitStat === undefined && childStat !== undefined) {
    const child = await readRuntimeChildRecord(validated.state_root, validated.run_id);
    if (processMayExist(child.child_pid)) {
      throw new RuntimeSupervisorBlockedError(
        'The previous runtime child may still be running; relaunch is blocked.',
      );
    }
  }

  // Replace first. If this process dies during the cleanup below, the next
  // attempt sees the same fixed artifacts, proves their owners are absent,
  // and safely repeats the repair.
  if (requestExists) {
    await atomicReplaceJson(paths.requestPath, validated, MAX_REQUEST_BYTES);
  } else {
    await atomicCreateJson(paths.requestPath, validated, MAX_REQUEST_BYTES);
  }
  for (const stalePath of [paths.childPath, paths.exitPath, paths.claimPath]) {
    await unlink(stalePath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
  await syncDirectory(paths.artifactRoot);
}

export async function writeRuntimeLaunchRequest(input) {
  assertExactKeys(
    input,
    new Set(['runId', 'stateRoot', 'runtimePath', 'cwd', 'argv', 'env', 'timeoutMs']),
    'writeRuntimeLaunchRequest input',
  );
  const requestedStateRoot = requireAbsoluteNormalizedPath(input.stateRoot, 'stateRoot');
  const requestedStateStat = await lstat(requestedStateRoot).catch((error) => {
    throw new RuntimeSupervisorBlockedError(`stateRoot could not be inspected: ${error.message}`);
  });
  if (requestedStateStat.isSymbolicLink() || !requestedStateStat.isDirectory()) {
    throw new RuntimeSupervisorBlockedError(
      'stateRoot must be a real directory, not a symbolic link.',
    );
  }
  // DurableJobStore also canonicalizes its root. Doing the same here lets a
  // lifecycle pass a normal macOS /var path while the disk protocol records
  // the canonical /private/var path used by the store-owned artifacts.
  const stateRoot = await realpath(requestedStateRoot);
  const paths = runtimeSupervisorPaths(stateRoot, input.runId);
  const request = {
    schema: RUNTIME_LAUNCH_SCHEMA,
    run_id: input.runId,
    state_root: stateRoot,
    runtime_path: input.runtimePath,
    cwd: input.cwd,
    argv: input.argv,
    env: input.env,
    timeout_ms: input.timeoutMs,
    paths: {
      stdout: paths.stdoutPath,
      stderr: paths.stderrPath,
      exit: paths.exitPath,
      cancel: paths.cancelPath,
    },
  };
  const validated = await validateRequestValue(request, paths.requestPath);
  const existingRequest = await optionalLstat(paths.requestPath);
  if (existingRequest === undefined) {
    const staleArtifacts = await Promise.all([
      optionalLstat(paths.childPath),
      optionalLstat(paths.exitPath),
      optionalLstat(paths.claimPath),
    ]);
    if (staleArtifacts.some((stat) => stat !== undefined)) {
      await prepareRelaunch(paths, validated, false);
    } else {
      await atomicCreateJson(paths.requestPath, validated, MAX_REQUEST_BYTES);
    }
  } else {
    if (existingRequest.isSymbolicLink() || !existingRequest.isFile()) {
      throw new RuntimeSupervisorBlockedError(
        'The previous launch request is not a regular, non-symbolic-link file.',
      );
    }
    await prepareRelaunch(paths, validated, true);
  }
  return { ...validated, requestPath: paths.requestPath };
}

function cleanupNotRequired() {
  return {
    scope: 'observed_process_tree',
    required: false,
    descendant_pids: [],
    enumeration_succeeded: true,
    remaining_pids: [],
    confirmed: true,
  };
}

function normalizeCleanup(cleanup, required = true) {
  const descendantPids = Array.isArray(cleanup?.descendantPids)
    ? cleanup.descendantPids.filter(Number.isInteger)
    : [];
  const remainingPids = Array.isArray(cleanup?.remainingPids)
    ? cleanup.remainingPids.filter(Number.isInteger)
    : [];
  const truncated =
    descendantPids.length > MAX_RECORDED_PIDS || remainingPids.length > MAX_RECORDED_PIDS;
  return {
    scope: 'observed_process_tree',
    required,
    descendant_pids: descendantPids.slice(0, MAX_RECORDED_PIDS),
    enumeration_succeeded: cleanup?.enumerationSucceeded === true,
    ...(typeof cleanup?.enumerationError === 'string'
      ? { enumeration_error: cleanup.enumerationError.slice(0, 4_096) }
      : {}),
    remaining_pids: remainingPids.slice(0, MAX_RECORDED_PIDS),
    confirmed: cleanup?.confirmed === true && !truncated,
    ...(truncated ? { record_truncated: true } : {}),
  };
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function cancelMarkerState(cancelPath) {
  const stat = await optionalLstat(cancelPath);
  if (stat === undefined) return 'absent';
  if (stat.isSymbolicLink() || !stat.isFile()) return 'unsafe';
  return 'present';
}

async function createCancelMarker(cancelPath, reason) {
  const runRoot = path.dirname(cancelPath);
  try {
    await mkdir(runRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await assertCanonicalDirectory(runRoot, 'run directory');
  const existing = await optionalLstat(cancelPath);
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new RuntimeSupervisorBlockedError(
        'The cooperative cancel marker is not a regular, non-symbolic-link file.',
      );
    }
    return;
  }
  const handle = await open(
    cancelPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${reason}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(runRoot);
}

function childCompletion(child) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    child.once('error', (error) => settle({ kind: 'error', error }));
    child.once('close', (code, signal) => settle({ kind: 'exit', code, signal }));
  });
}

async function waitForCompletionOrStop(completion, cancelPath, timeoutMs, externalStop, localStop) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const marker = await cancelMarkerState(cancelPath);
    if (marker === 'present') return { type: 'stop', reason: 'cancel' };
    if (marker === 'unsafe') {
      return {
        type: 'stop',
        reason: 'cancel',
        error: 'The cooperative cancel marker became unsafe.',
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { type: 'stop', reason: 'timeout' };
    const winner = await Promise.race([
      completion.then((result) => ({ type: 'completion', result })),
      externalStop.then(() => ({ type: 'stop', reason: 'cancel' })),
      localStop.then((stop) => ({ type: 'stop', ...stop })),
      wait(Math.min(POLL_MS, remaining)).then(() => ({ type: 'poll' })),
    ]);
    if (winner.type !== 'poll') return winner;
  }
}

async function openAppendOnlyLog(file, label) {
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new RuntimeSupervisorBlockedError(`${label} is not a regular file.`);
    return { handle, size: stat.size };
  } catch (error) {
    await handle?.close();
    if (error?.code === 'ELOOP') {
      throw new RuntimeSupervisorBlockedError(`${label} must not be a symbolic link.`);
    }
    throw error;
  }
}

async function pumpBoundedLog(stream, handle, meter, limit, label, requestStop) {
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = Math.max(0, limit - meter.bytes);
      if (chunk.length > remaining) {
        requestStop({ reason: 'output_limit', limit_exceeded: label });
      }
      const kept = chunk.subarray(0, remaining);
      if (kept.length > 0) {
        await handle.write(kept);
        meter.bytes += kept.length;
      }
    }
    await handle.sync();
  } catch (error) {
    requestStop({
      reason: 'cancel',
      error: `The runtime ${label} log failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function claimLaunch(claimPath) {
  try {
    await atomicCreateJson(
      claimPath,
      {
        schema: 'circuit.mcp-runtime-claim@v1',
        supervisor_pid: process.pid,
        started_at: new Date().toISOString(),
      },
      MAX_CLAIM_BYTES,
    );
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new RuntimeSupervisorBlockedError(
        'This launch request already has a supervisor claim.',
      );
    }
    throw error;
  }
}

async function writeRuntimeChildRecord(childPath, record) {
  try {
    await atomicCreateJson(childPath, record, MAX_CHILD_BYTES);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new RuntimeSupervisorBlockedError('This launch already has a runtime child record.');
    }
    throw error;
  }
}

async function writeExitRecord(exitPath, exitRecord) {
  try {
    await atomicCreateJson(exitPath, exitRecord, MAX_EXIT_BYTES);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new RuntimeSupervisorBlockedError('This launch already has an exit record.');
    }
    throw error;
  }
}

export async function runRuntimeSupervisor(requestPath) {
  const request = await parseRuntimeLaunchRequest(requestPath);
  const fixed = runtimeSupervisorPaths(request.state_root, request.run_id);
  const existingExit = await optionalLstat(request.paths.exit);
  if (existingExit !== undefined) {
    throw new RuntimeSupervisorBlockedError('This launch already has an exit record.');
  }
  await claimLaunch(fixed.claimPath);
  await unlink(fixed.requestPath);
  await syncDirectory(fixed.artifactRoot);

  const startedAt = new Date().toISOString();
  let child;
  let stdoutHandle;
  let stderrHandle;
  let stdoutPump;
  let stderrPump;
  let processObserver;
  let observedProcesses;
  const stopProcessObserver = async () => {
    if (observedProcesses === undefined && processObserver !== undefined) {
      observedProcesses = await processObserver.stop();
    }
    return (
      observedProcesses ?? {
        pids: [],
        enumerationSucceeded: false,
        enumerationError: 'The runtime process observer did not start.',
      }
    );
  };
  const stdoutMeter = { bytes: 0 };
  const stderrMeter = { bytes: 0 };
  let limitExceeded;
  let stopFromSignal;
  const externalStop = new Promise((resolvePromise) => {
    stopFromSignal = resolvePromise;
  });
  const onSignal = () => stopFromSignal();
  let stopLocally;
  let localStopRequested = false;
  const localStop = new Promise((resolvePromise) => {
    stopLocally = (value) => {
      if (localStopRequested) return;
      localStopRequested = true;
      resolvePromise(value);
    };
  });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let reason = 'exit';
  let completion;
  let cleanup = cleanupNotRequired();
  let errorText;
  try {
    const preexistingCancel = await cancelMarkerState(request.paths.cancel);
    if (preexistingCancel !== 'absent') {
      reason = 'cancel';
      if (preexistingCancel === 'unsafe') {
        errorText = 'The cooperative cancel marker was unsafe before launch.';
      }
    } else {
      const stdoutLog = await openAppendOnlyLog(request.paths.stdout, 'paths.stdout');
      const stderrLog = await openAppendOnlyLog(request.paths.stderr, 'paths.stderr');
      stdoutHandle = stdoutLog.handle;
      stderrHandle = stderrLog.handle;
      stdoutMeter.bytes = stdoutLog.size;
      stderrMeter.bytes = stderrLog.size;
      const launchId = randomUUID();
      const childStartedAt = new Date().toISOString();
      const { transient } = splitRuntimeLaunchEnvironment(process.env);
      child = spawn(process.execPath, [request.runtime_path, ...request.argv], {
        cwd: request.cwd,
        env: { ...request.env, ...transient, CIRCUIT_MCP_LAUNCH_ID: launchId },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const completionPromise = childCompletion(child);
      if (!Number.isInteger(child.pid)) {
        throw new RuntimeSupervisorBlockedError('The runtime child had no pid after spawn.');
      }
      processObserver = observeDescendants(child.pid);
      await writeRuntimeChildRecord(fixed.childPath, {
        schema: RUNTIME_CHILD_SCHEMA,
        run_id: request.run_id,
        launch_id: launchId,
        child_pid: child.pid,
        process_group_id: child.pid,
        supervisor_pid: process.pid,
        started_at: childStartedAt,
      });
      stdoutPump = pumpBoundedLog(
        child.stdout,
        stdoutHandle,
        stdoutMeter,
        RUNTIME_STDOUT_LIMIT_BYTES,
        'stdout',
        stopLocally,
      );
      stderrPump = pumpBoundedLog(
        child.stderr,
        stderrHandle,
        stderrMeter,
        RUNTIME_STDERR_LIMIT_BYTES,
        'stderr',
        stopLocally,
      );
      const winner = await waitForCompletionOrStop(
        completionPromise,
        request.paths.cancel,
        request.timeout_ms,
        externalStop,
        localStop,
      );
      if (winner.type === 'completion') {
        completion = winner.result;
        const observed = await stopProcessObserver();
        const cooperativeCancel = (await cancelMarkerState(request.paths.cancel)) === 'present';
        if (cooperativeCancel) {
          reason = 'cancel';
          cleanup = normalizeCleanup(
            await interruptObservedProcessTree(child.pid, { knownPids: observed.pids }),
          );
        } else {
          const liveDescendants = observed.pids.filter(processMayExist);
          if (!observed.enumerationSucceeded || liveDescendants.length > 0) {
            cleanup = normalizeCleanup(
              await interruptObservedProcessTree(child.pid, { knownPids: observed.pids }),
            );
            errorText =
              liveDescendants.length > 0
                ? 'The Circuit runtime exited while an observed child process was still running.'
                : 'Circuit could not confirm that runtime process observation completed.';
            if (completion.kind === 'exit' && completion.code === 0) {
              completion = { ...completion, code: 1 };
            }
          }
        }
      } else {
        reason = winner.reason;
        errorText = winner.error;
        limitExceeded = winner.limit_exceeded;
        if ((await cancelMarkerState(request.paths.cancel)) === 'absent') {
          await createCancelMarker(request.paths.cancel, winner.reason);
        }
        const graceWinner = await Promise.race([
          completionPromise.then((result) => ({ type: 'completion', result })),
          wait(COOPERATIVE_GRACE_MS).then(() => ({ type: 'grace' })),
        ]);
        if (graceWinner.type === 'completion') {
          completion = graceWinner.result;
          const observed = await stopProcessObserver();
          cleanup = normalizeCleanup(
            await interruptObservedProcessTree(child.pid, { knownPids: observed.pids }),
          );
        } else if (Number.isInteger(child.pid)) {
          try {
            const observed = await stopProcessObserver();
            cleanup = normalizeCleanup(
              await interruptObservedProcessTree(child.pid, { knownPids: observed.pids }),
            );
          } catch (error) {
            cleanup = {
              scope: 'observed_process_tree',
              required: true,
              descendant_pids: [],
              enumeration_succeeded: false,
              enumeration_error: error instanceof Error ? error.message.slice(0, 4_096) : 'unknown',
              remaining_pids: [child.pid],
              confirmed: false,
            };
          }
          completion = await Promise.race([
            completionPromise,
            wait(REAP_WAIT_MS).then(() => undefined),
          ]);
        } else {
          cleanup = {
            scope: 'observed_process_tree',
            required: true,
            descendant_pids: [],
            enumeration_succeeded: false,
            enumeration_error: 'The runtime child had no pid.',
            remaining_pids: [],
            confirmed: false,
          };
        }
      }
    }
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error);
    if (child !== undefined && Number.isInteger(child.pid)) {
      reason = reason === 'timeout' || reason === 'output_limit' ? reason : 'cancel';
      try {
        const observed = await stopProcessObserver();
        cleanup = normalizeCleanup(
          await interruptObservedProcessTree(child.pid, { knownPids: observed.pids }),
        );
      } catch (cleanupError) {
        cleanup = {
          scope: 'observed_process_tree',
          required: true,
          descendant_pids: [],
          enumeration_succeeded: false,
          enumeration_error:
            cleanupError instanceof Error ? cleanupError.message.slice(0, 4_096) : 'unknown',
          remaining_pids: [child.pid],
          confirmed: false,
        };
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await stopProcessObserver();
    await Promise.all([stdoutPump, stderrPump].filter(Boolean));
    await stdoutHandle?.close().catch(() => {});
    await stderrHandle?.close().catch(() => {});
  }

  if (completion?.kind === 'error') {
    errorText = `Runtime failed to start: ${completion.error.message}`;
  }
  const exitRecord = {
    schema: RUNTIME_EXIT_SCHEMA,
    run_id: request.run_id,
    child_pid: Number.isInteger(child?.pid) ? child.pid : null,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    reason,
    code: completion?.kind === 'exit' ? completion.code : null,
    signal: completion?.kind === 'exit' ? completion.signal : null,
    cleanup,
    output: {
      stdout_bytes: stdoutMeter.bytes,
      stderr_bytes: stderrMeter.bytes,
      stdout_limit_bytes: RUNTIME_STDOUT_LIMIT_BYTES,
      stderr_limit_bytes: RUNTIME_STDERR_LIMIT_BYTES,
      ...(limitExceeded === undefined ? {} : { limit_exceeded: limitExceeded }),
    },
    ...(errorText === undefined ? {} : { error: errorText.slice(0, 8_192) }),
  };
  await writeExitRecord(request.paths.exit, exitRecord);
  return exitRecord;
}

async function main() {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) {
    throw new RuntimeSupervisorBlockedError(
      'runtime-supervisor accepts exactly one absolute launch-request JSON path.',
    );
  }
  await runRuntimeSupervisor(process.argv[2]);
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `Circuit MCP runtime supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
