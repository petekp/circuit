import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { checkpointViewForJob } from './checkpoint-view.mjs';
import { DurableJobStore } from './durable-job-store.mjs';
import { assertTrustedCodexExecutableUnchanged } from './host-discovery.mjs';
import {
  readRuntimeChildRecord,
  runtimeSupervisorPaths,
  splitRuntimeLaunchEnvironment,
  writeRuntimeLaunchRequest,
} from './runtime-supervisor.mjs';
import {
  SEALED_RUNTIME_CAPABILITIES,
  assertPackagedAssetsUnchanged,
  assertSealedRuntimeCapabilities,
  createSealedEnvironment,
  createSealedRunPolicy,
} from './sealed-policy.mjs';

export const PUBLIC_FLOWS = ['build', 'explore', 'fix', 'prototype', 'review'];
export const PROCESS_LEVELS = ['low', 'medium', 'high'];
export const POWER_LEVELS = ['auto', 'low', 'medium', 'high'];

const FLOW_AXES = {
  build: { processes: PROCESS_LEVELS, tournament: false, autonomous: true },
  explore: { processes: PROCESS_LEVELS, tournament: true, autonomous: true },
  fix: { processes: PROCESS_LEVELS, tournament: false, autonomous: true },
  prototype: { processes: ['medium', 'high'], tournament: true, autonomous: true },
  review: { processes: ['medium'], tournament: false, autonomous: false },
};

const ENV_ALLOWLIST = new Set([
  'ALL_PROXY',
  'CODEX_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'USER',
]);

const MAX_GOAL_CHARS = 8_000;
const MAX_WHY_CHARS = 2_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_PROGRESS_LINE_BYTES = 16 * 1024;
const DEFAULT_STATUS_WAIT_MS = 5_000;
const MAX_STATUS_WAIT_MS = 10_000;
const DEFAULT_RUN_TIMEOUT_MS = 75 * 60 * 1_000;
const INTERRUPT_GRACE_MS = 2_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, allowed, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${label} has unsupported field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}.`,
    );
  }
}

function requiredString(value, label, maxChars) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.length > maxChars)
    throw new Error(`${label} is too long (maximum ${maxChars} characters).`);
  return value;
}

function optionalString(value, label, maxChars) {
  return value === undefined ? undefined : requiredString(value, label, maxChars);
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

export function parseStartArguments(value) {
  assertExactKeys(
    value,
    new Set([
      'flow',
      'goal',
      'why',
      'power',
      'process',
      'tournament',
      'autonomous',
      'include_untracked_content',
      'web_search',
    ]),
    'circuit_start arguments',
  );
  const flow = value.flow;
  if (typeof flow !== 'string' || !PUBLIC_FLOWS.includes(flow)) {
    throw new Error(`flow must be one of ${PUBLIC_FLOWS.join(', ')}.`);
  }
  const axes = FLOW_AXES[flow];
  const goal = requiredString(value.goal, 'goal', MAX_GOAL_CHARS);
  const why = optionalString(value.why, 'why', MAX_WHY_CHARS);
  const processLevel = value.process;
  if (
    processLevel !== undefined &&
    (typeof processLevel !== 'string' || !axes.processes.includes(processLevel))
  ) {
    throw new Error(`${flow} allows process: ${axes.processes.join(', ')}.`);
  }
  const power = value.power;
  if (power !== undefined && (typeof power !== 'string' || !POWER_LEVELS.includes(power))) {
    throw new Error(`power must be one of ${POWER_LEVELS.join(', ')}.`);
  }
  const tournament = value.tournament;
  if (tournament !== undefined) {
    if (!axes.tournament) throw new Error(`${flow} does not support tournament mode.`);
    if (flow === 'prototype') {
      throw new Error(
        'Prototype tournament is not available in the sealed MCP spike because it requires a trusted variant model matrix. Run Prototype without tournament mode.',
      );
    }
    if (!Number.isInteger(tournament) || tournament < 2 || tournament > 4) {
      throw new Error('tournament must be an integer from 2 through 4.');
    }
  }
  const autonomous = optionalBoolean(value.autonomous, 'autonomous');
  if (autonomous === true && !axes.autonomous) {
    throw new Error(`${flow} does not support autonomous mode.`);
  }
  const includeUntrackedContent = optionalBoolean(
    value.include_untracked_content,
    'include_untracked_content',
  );
  const webSearch = value.web_search;
  if (webSearch !== undefined && webSearch !== 'off' && webSearch !== 'cached') {
    throw new Error('web_search must be one of off, cached.');
  }
  return {
    flow,
    goal,
    ...(why === undefined ? {} : { why }),
    ...(power === undefined ? {} : { power }),
    ...(processLevel === undefined ? {} : { process: processLevel }),
    ...(tournament === undefined ? {} : { tournament }),
    ...(autonomous === undefined ? {} : { autonomous }),
    ...(includeUntrackedContent === undefined ? {} : { includeUntrackedContent }),
    ...(webSearch === undefined ? {} : { webSearch }),
  };
}

export function parseStatusArguments(value) {
  assertExactKeys(
    value,
    new Set(['run_id', 'after_cursor', 'max_events', 'wait_ms']),
    'circuit_status arguments',
  );
  const runId = requiredString(value.run_id, 'run_id', 64);
  const afterCursor = value.after_cursor ?? 0;
  const maxEvents = value.max_events ?? 25;
  const waitMs = value.wait_ms ?? DEFAULT_STATUS_WAIT_MS;
  if (!Number.isInteger(afterCursor) || afterCursor < 0) {
    throw new Error('after_cursor must be a non-negative integer.');
  }
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 100) {
    throw new Error('max_events must be an integer from 1 through 100.');
  }
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_STATUS_WAIT_MS) {
    throw new Error(`wait_ms must be an integer from 0 through ${MAX_STATUS_WAIT_MS}.`);
  }
  return { runId, afterCursor, maxEvents, waitMs };
}

export function parseResumeArguments(value) {
  assertExactKeys(value, new Set(['run_id', 'checkpoint_choice']), 'circuit_resume arguments');
  return {
    runId: requiredString(value.run_id, 'run_id', 64),
    choice: requiredString(value.checkpoint_choice, 'checkpoint_choice', 128),
  };
}

export function parseCancelArguments(value) {
  assertExactKeys(value, new Set(['run_id']), 'circuit_cancel arguments');
  return { runId: requiredString(value.run_id, 'run_id', 64) };
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

export async function assertControlPlaneSafe(workspace) {
  const canonicalWorkspace = await realpath(workspace);
  const controlPlane = path.join(canonicalWorkspace, '.circuit');
  const controlPlaneStat = await optionalLstat(controlPlane);
  if (controlPlaneStat === undefined) return;
  if (controlPlaneStat.isSymbolicLink()) {
    throw new Error('Refusing to run because .circuit is a symbolic link.');
  }
  if (!controlPlaneStat.isDirectory()) {
    throw new Error('Refusing to run because .circuit is not a directory.');
  }
  const canonicalControlPlane = await realpath(controlPlane);
  if (!pathIsInside(canonicalWorkspace, canonicalControlPlane)) {
    throw new Error('Refusing to run because .circuit resolves outside the workspace.');
  }
  for (const relative of [
    '.gitignore',
    'active-run.md',
    'config.yaml',
    'continuity',
    'history',
    'memory',
    'prototypes',
    'runs',
    'worktrees',
  ]) {
    const candidate = path.join(controlPlane, relative);
    const candidateStat = await optionalLstat(candidate);
    if (candidateStat?.isSymbolicLink()) {
      throw new Error(`Refusing to run because .circuit/${relative} is a symbolic link.`);
    }
  }
}

function safeBaseEnvironment(baseEnv) {
  const entries = Object.entries(baseEnv).filter(
    ([key, value]) => ENV_ALLOWLIST.has(key) && value !== undefined,
  );
  return Object.fromEntries(entries);
}

function stderrTail(stderr) {
  const clean = stderr.replaceAll('\0', '').trim();
  return clean.length === 0 ? '' : clean.slice(-2_000);
}

function configReferenceIsCodex(reference) {
  return isRecord(reference) && reference.kind === 'builtin' && reference.name === 'codex';
}

export function assertCodexOnlyConfigSummary(summary, flow, projectConfigPresent = false) {
  if (!isRecord(summary) || !Array.isArray(summary.layers)) {
    throw new Error('Circuit config inspection returned an invalid response.');
  }
  const projectLayers = summary.layers.filter((layer) => layer?.layer === 'project');
  if (projectConfigPresent && projectLayers.length === 0) {
    throw new Error(
      'This project uses a policy-envelope config that the MCP spike cannot safely seal yet.',
    );
  }
  for (const layer of summary.layers) {
    const relay = layer?.config?.relay;
    if (!isRecord(relay)) throw new Error('Circuit config inspection omitted relay settings.');
    if (relay.default !== 'auto' && relay.default !== 'codex') {
      throw new Error(
        `MCP runs require relay.default to be auto or codex, not ${String(relay.default)}.`,
      );
    }
    if (isRecord(relay.connectors) && Object.keys(relay.connectors).length > 0) {
      throw new Error('MCP runs do not accept custom connector commands from project config.');
    }
    for (const reference of Object.values(isRecord(relay.roles) ? relay.roles : {})) {
      if (!configReferenceIsCodex(reference)) {
        throw new Error('MCP runs do not accept a non-Codex role connector override.');
      }
    }
    for (const [configuredFlow, reference] of Object.entries(
      isRecord(relay.flows) ? relay.flows : {},
    )) {
      if (configuredFlow === flow && !configReferenceIsCodex(reference)) {
        throw new Error(`MCP runs do not accept a non-Codex connector override for ${flow}.`);
      }
    }
    const flowConfig = layer?.config?.flows?.[flow];
    const variants = flowConfig?.variant_models;
    if (Array.isArray(variants)) {
      for (const variant of variants) {
        if (variant?.connector !== undefined && !configReferenceIsCodex(variant.connector)) {
          throw new Error(`MCP ${flow} cannot use a non-Codex tournament variant.`);
        }
      }
    }
  }
}

function execFilePromise(executable, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      executable,
      args,
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) rejectPromise(error);
        else resolvePromise(stdout);
      },
    );
  });
}

async function processTree(rootPid) {
  const output = await execFilePromise('/bin/ps', ['-ax', '-o', 'pid=,ppid=']);
  const children = new Map();
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match === null) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const list = children.get(parentPid) ?? [];
    list.push(pid);
    children.set(parentPid, list);
  }
  const found = [];
  const visit = (pid, depth) => {
    for (const child of children.get(pid) ?? []) {
      visit(child, depth + 1);
      found.push({ pid: child, depth });
    }
  };
  visit(rootPid, 1);
  return found.sort((left, right) => right.depth - left.depth).map((entry) => entry.pid);
}

function signalPidOrGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function remainingLivePids(pids, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let live = pids.filter(pidIsAlive);
  while (live.length > 0 && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    live = pids.filter(pidIsAlive);
  }
  return live;
}

export async function interruptProcessTree(rootPid, graceMs = INTERRUPT_GRACE_MS) {
  try {
    process.kill(rootPid, 'SIGSTOP');
  } catch {
    // The process may already have exited.
  }
  let descendants = [];
  let enumerationSucceeded = true;
  try {
    descendants = await processTree(rootPid);
  } catch {
    enumerationSucceeded = false;
    // A direct group kill is still better than leaving the known parent alive.
  }
  for (const pid of descendants) signalPidOrGroup(pid, 'SIGTERM');
  signalPidOrGroup(rootPid, 'SIGTERM');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, graceMs));
  for (const pid of descendants) signalPidOrGroup(pid, 'SIGKILL');
  signalPidOrGroup(rootPid, 'SIGKILL');
  const remainingPids = await remainingLivePids([...new Set([rootPid, ...descendants])]);
  return {
    descendantPids: descendants,
    enumerationSucceeded,
    remainingPids,
    confirmed: enumerationSucceeded && remainingPids.length === 0,
  };
}

function buildStartArgs(input, runFolder, flowRoot) {
  const args = [
    'run',
    input.flow,
    '--goal',
    input.goal,
    '--run-folder',
    runFolder,
    '--flow-root',
    flowRoot,
    '--progress',
    'jsonl',
  ];
  if (input.why !== undefined) args.push('--why', input.why);
  if (input.power !== undefined) args.push('--power', input.power);
  if (input.process !== undefined) args.push('--process', input.process);
  if (input.tournament !== undefined) args.push('--tournament', String(input.tournament));
  if (input.autonomous === true) args.push('--autonomous');
  if (input.includeUntrackedContent === true) args.push('--include-untracked-content');
  return args;
}

function compactFinal(final) {
  if (!isRecord(final)) return undefined;
  return {
    ...(typeof final.run_id === 'string' ? { circuit_run_id: final.run_id } : {}),
    ...(typeof final.flow_id === 'string' ? { flow: final.flow_id } : {}),
    ...(typeof final.outcome === 'string' ? { outcome: final.outcome } : {}),
    ...(typeof final.reason === 'string' ? { reason: final.reason } : {}),
    ...(isRecord(final.checkpoint)
      ? {
          checkpoint: {
            ...(typeof final.checkpoint.step_id === 'string'
              ? { step_id: final.checkpoint.step_id }
              : {}),
            ...(Array.isArray(final.checkpoint.allowed_choices)
              ? { allowed_choices: final.checkpoint.allowed_choices }
              : {}),
          },
        }
      : {}),
  };
}

function compactProgressEvent(event) {
  return {
    ...(typeof event.cursor === 'number' ? { cursor: event.cursor } : {}),
    ...(typeof event.type === 'string' ? { type: event.type } : {}),
    ...(typeof event.recorded_at === 'string' ? { recorded_at: event.recorded_at } : {}),
    ...(typeof event.label === 'string' ? { label: event.label } : {}),
    ...(typeof event.step_id === 'string' ? { step_id: event.step_id } : {}),
    ...(typeof event.outcome === 'string' ? { outcome: event.outcome } : {}),
    ...(typeof event.verdict === 'string' ? { verdict: event.verdict } : {}),
    ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
    ...(typeof event.text === 'string' ? { text: event.text.slice(0, 2_000) } : {}),
    ...(typeof event.display?.text === 'string' ? { display_text: event.display.text } : {}),
    ...(typeof event.presentation?.status_text === 'string'
      ? { status_text: event.presentation.status_text }
      : {}),
  };
}

const FLOW_REPORT_PATHS = Object.freeze({
  build: 'build-result.json',
  explore: 'explore-result.json',
  fix: 'fix-result.json',
  prototype: 'prototype-result.json',
  review: 'review-result.json',
});
const DEFAULT_SUPERVISOR_PATH = path.join(import.meta.dirname, 'runtime-supervisor.mjs');
const POLICY_FILE = 'sealed-policy.json';
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_EXIT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;
const CANCEL_WAIT_MS = 5_000;

function activeState(state) {
  return (
    state === 'starting' ||
    state === 'running' ||
    state === 'resuming' ||
    state === 'recovery_required'
  );
}

async function readBoundedRegularFile(file, maxBytes, label) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | NO_FOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error(`${label} is not a regular file.`);
    if (fileStat.size > maxBytes) throw new Error(`${label} is too large.`);
    return await handle.readFile('utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`${label} must not be a symbolic link.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function truncateRegularFile(file, label) {
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | NO_FOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error(`${label} is not a regular file.`);
    await handle.truncate(0);
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`${label} must not be a symbolic link.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeExclusiveRegularFile(file, contents, label) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const existing = await lstat(file);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`${label} is not a safe regular file.`);
      }
      return false;
    }
    if (error?.code === 'ELOOP') throw new Error(`${label} must not be a symbolic link.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function runtimeCapabilities() {
  return Object.fromEntries(SEALED_RUNTIME_CAPABILITIES.map((capability) => [capability, true]));
}

export class CircuitLifecycle {
  constructor(options) {
    this.runtimePath = options.runtimePath;
    this.flowRoot = options.flowRoot;
    this.pluginRoot = options.pluginRoot;
    this.requestedStateRoot = options.stateRoot;
    this.baseEnv = options.baseEnv ?? process.env;
    this.host = options.host;
    this.assets = options.assets;
    this.sealedState = options.sealedState;
    this.proofRunner = options.proofRunner;
    this.supervisorPath = options.supervisorPath ?? DEFAULT_SUPERVISOR_PATH;
    this.maxRunMs = options.maxRunMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.interruptGraceMs = options.interruptGraceMs ?? INTERRUPT_GRACE_MS;
    this.verifyHost =
      options.verifyHost ?? (() => assertTrustedCodexExecutableUnchanged(this.host.codex));
    this.verifyAssets = options.verifyAssets ?? (() => assertPackagedAssetsUnchanged(this.assets));
    this.verifyBoundary = options.verifyBoundary ?? (() => undefined);
    this.store = options.jobStore ?? new DurableJobStore({ stateRoot: options.stateRoot });
    this.controllers = new Map();
    this.pendingLaunchCancellations = new Set();
    this.refreshQueues = new Map();
    this.pendingOperations = new Set();
    this.closed = false;
    this.shutdownPromise = undefined;
    this.readyPromise = undefined;
    assertSealedRuntimeCapabilities(runtimeCapabilities());
  }

  async #ready() {
    if (this.readyPromise === undefined) {
      this.readyPromise = (async () => {
        await this.store.initialize();
        this.stateRoot = await realpath(this.requestedStateRoot);
        this.sealedState = {
          home: await realpath(this.sealedState.home),
          xdg_config_home: await realpath(this.sealedState.xdg_config_home),
          runs: await realpath(this.sealedState.runs),
        };
        await this.store.cleanupRetention();
      })();
    }
    await this.readyPromise;
  }

  #beginOperation() {
    if (this.closed) throw new Error('The Circuit MCP lifecycle is stopping.');
    let resolveDone;
    const done = new Promise((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    this.pendingOperations.add(done);
    return () => {
      this.pendingOperations.delete(done);
      resolveDone();
    };
  }

  async #assertRunBoundary(workspace) {
    await Promise.all([
      assertControlPlaneSafe(workspace),
      this.verifyHost(),
      this.verifyAssets(),
      this.verifyBoundary(workspace),
    ]);
  }

  #policyPath(job) {
    return path.join(job.artifacts.root, POLICY_FILE);
  }

  async #writePolicy(job, policy) {
    const encoded = `${JSON.stringify(policy)}\n`;
    if (Buffer.byteLength(encoded) > MAX_POLICY_BYTES)
      throw new Error('Sealed policy is too large.');
    await writeFile(this.#policyPath(job), encoded, { flag: 'wx', mode: 0o600 });
  }

  async #readPolicy(job) {
    const body = await readBoundedRegularFile(
      this.#policyPath(job),
      MAX_POLICY_BYTES,
      'Stored sealed policy',
    );
    const policy = JSON.parse(body);
    if (
      policy?.schema !== 'circuit.mcp.sealed-policy@v1' ||
      policy?.workspace !== job.workspace ||
      policy?.flow?.id !== job.flow ||
      policy?.flow?.package_sha256 !== this.assets.sha256
    ) {
      throw new Error('Stored sealed policy does not match this run.');
    }
    const connector = policy.connector;
    const storedIdentity = connector?.executable_identity;
    const pinnedIdentity = this.host.codex.identity;
    const identityKeys = ['device', 'inode', 'modified_ms', 'size'];
    const identityMatches =
      isRecord(storedIdentity) &&
      isRecord(pinnedIdentity) &&
      Object.keys(storedIdentity).sort().join('\0') === identityKeys.join('\0') &&
      Object.keys(pinnedIdentity).sort().join('\0') === identityKeys.join('\0') &&
      identityKeys.every((key) => Object.is(storedIdentity[key], pinnedIdentity[key]));
    if (
      connector?.kind !== 'builtin' ||
      connector?.name !== 'codex' ||
      connector?.executable !== this.host.codex.executable ||
      connector?.executable_version !== this.host.codex.version ||
      !identityMatches ||
      connector?.codex_home !== this.host.codexHome.path
    ) {
      throw new Error('Stored sealed policy does not match the currently pinned Codex host.');
    }
    return policy;
  }

  #environment(policy, cancelFile) {
    return {
      ...safeBaseEnvironment(this.baseEnv),
      ...createSealedEnvironment({
        policy,
        state: this.sealedState,
        proofRunner: this.proofRunner,
        gitStateHelper: this.assets.git_state_path,
        cancelFile,
      }),
      CIRCUIT_PLUGIN_ROOT: this.pluginRoot,
      CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: this.flowRoot,
      CIRCUIT_RUNTIME_SOURCE: 'mcp-spike',
      CIRCUIT_RUNTIME_PATH: this.runtimePath,
    };
  }

  async start(workspace, rawInput) {
    const finishOperation = this.#beginOperation();
    try {
      await this.#ready();
      const input = parseStartArguments(rawInput);
      await this.#assertRunBoundary(workspace);
      if (this.closed) throw new Error('The Circuit MCP lifecycle is stopping.');
      const runId = randomUUID();
      let job;
      try {
        job = await this.store.createJob({ runId, workspace, flow: input.flow });
      } catch (error) {
        if (String(error?.message).includes('holds this workspace lease')) {
          throw new Error('Another Circuit run is already active in this workspace.');
        }
        throw error;
      }
      try {
        const policy = createSealedRunPolicy({
          flow: input.flow,
          workspace: job.workspace,
          webSearch: input.webSearch,
          assets: this.assets,
          host: this.host,
        });
        await this.#writePolicy(job, policy);
        await this.#launch(job, policy, buildStartArgs(input, job.runFolder, this.flowRoot));
      } catch (error) {
        if (error?.preserveWorkspaceLock !== true) {
          await this.store.updateJob(job.workspace, job.runId, {
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
      return { run_id: runId, state: 'running', poll_after_ms: 1_000 };
    } finally {
      finishOperation();
    }
  }

  async #launch(job, policy, args) {
    await mkdir(job.runFolder, { recursive: true, mode: 0o700 });
    await this.#assertSafeRunFolder(job);
    const paths = runtimeSupervisorPaths(this.stateRoot, job.runId);
    // A new run id cannot have a legitimate cancel marker. A resume can: a
    // different MCP server may have accepted cancellation after the durable
    // resume claim but before this server reached spawn. Preserve that marker
    // so the supervisor observes the cross-process cancellation intent.
    if (job.state === 'starting') {
      await unlink(paths.cancelPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
    await Promise.all([
      truncateRegularFile(paths.stdoutPath, 'Circuit stdout'),
      truncateRegularFile(paths.stderrPath, 'Circuit stderr'),
    ]);
    const env = this.#environment(policy, paths.cancelPath);
    const launchEnvironment = splitRuntimeLaunchEnvironment(env);
    const { requestPath } = await writeRuntimeLaunchRequest({
      runId: job.runId,
      stateRoot: this.stateRoot,
      runtimePath: this.runtimePath,
      cwd: job.workspace,
      argv: args,
      env: launchEnvironment.durable,
      timeoutMs: this.maxRunMs,
    });

    // A resume is durably claimed before its supervisor starts. Cancellation
    // can win in that short gap; keep the check immediately beside spawn so
    // no other same-process operation can interleave after it returns false.
    if (this.pendingLaunchCancellations.delete(job.runId)) {
      await this.store.updateJob(job.workspace, job.runId, {
        state: 'cancelled',
        final: null,
        report: null,
        interruptionConfirmed: true,
        error: 'The Circuit resume was cancelled before its runtime started.',
      });
      const error = new Error('The Circuit resume was cancelled before its runtime started.');
      error.preserveJobState = true;
      throw error;
    }

    const supervisor = spawn(process.execPath, [this.supervisorPath, requestPath], {
      cwd: job.workspace,
      env: { ...launchEnvironment.durable, ...launchEnvironment.transient },
      detached: true,
      stdio: 'ignore',
    });
    const controller = { child: supervisor, settle: undefined, detached: false };
    this.controllers.set(job.runId, controller);
    let releaseLaunch;
    const launched = new Promise((resolvePromise) => {
      releaseLaunch = resolvePromise;
    });
    const settle = async (launchError) => {
      await launched;
      if (controller.detached || this.closed) return;
      if (launchError !== undefined && !existsSync(paths.exitPath)) {
        const childRecord = await this.#readRuntimeChild(job);
        const childMayStillBeRunning =
          childRecord !== undefined && pidIsAlive(childRecord.child_pid);
        await this.store
          .updateJob(job.workspace, job.runId, {
            state: childMayStillBeRunning ? 'recovery_required' : 'failed',
            error: childMayStillBeRunning
              ? 'The Circuit supervisor stopped while its runtime may still be running. This workspace remains locked.'
              : `Circuit supervisor failed to start: ${launchError.message}`,
            ...(childMayStillBeRunning ? { interruptionConfirmed: false } : {}),
          })
          .catch(() => undefined);
        return;
      }
      await this.#refresh(job.workspace, job.runId).catch(() => undefined);
    };
    controller.settle = settle;
    supervisor.once('error', (error) => void settle(error));
    supervisor.once('close', (code, signal) => {
      const detail = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`;
      void settle(new Error(`the supervisor stopped with ${detail} before saving an exit record`));
    });
    try {
      await this.store.updateJob(job.workspace, job.runId, {
        state: 'running',
        worker: { pid: supervisor.pid, startedAt: new Date().toISOString() },
        final: null,
        report: null,
        error: null,
        interruptionConfirmed: undefined,
      });
    } catch (error) {
      controller.detached = true;
      controller.child.removeAllListeners('error');
      controller.child.removeAllListeners('close');
      controller.child.once('error', () => undefined);
      this.controllers.delete(job.runId);
      const interruption = Number.isInteger(supervisor.pid)
        ? await interruptProcessTree(supervisor.pid, this.interruptGraceMs)
        : { confirmed: false };
      if (interruption.confirmed !== true) {
        await this.store
          .updateJob(job.workspace, job.runId, {
            state: 'recovery_required',
            worker: Number.isInteger(supervisor.pid)
              ? { pid: supervisor.pid, startedAt: new Date().toISOString() }
              : null,
            error:
              'Circuit could not save the supervisor identity or confirm cleanup. This workspace remains locked.',
            interruptionConfirmed: false,
          })
          .catch(() => undefined);
        const preserved = new Error(
          'Circuit could not save the supervisor identity or confirm cleanup. This workspace remains locked.',
        );
        preserved.preserveWorkspaceLock = true;
        throw preserved;
      }
      throw error;
    } finally {
      releaseLaunch();
    }
    supervisor.unref();
  }

  async #syncProgress(job) {
    if (!existsSync(job.artifacts.stderrPath)) return job;
    let body;
    try {
      body = await readBoundedRegularFile(
        job.artifacts.stderrPath,
        MAX_STDERR_BYTES,
        'Circuit progress log',
      );
    } catch (error) {
      if (String(error?.message).includes('too large')) {
        await this.#writeCancelMarker(job, 'output_limit');
      }
      throw error;
    }
    const completeBody = body.endsWith('\n') ? body : body.slice(0, body.lastIndexOf('\n') + 1);
    const lines = completeBody.split('\n').filter((line) => line.trim().length > 0);
    const processed = job.events.length + job.eventsDropped;
    for (const line of lines.slice(processed)) {
      const lineBytes = Buffer.byteLength(line);
      let event;
      if (lineBytes > MAX_PROGRESS_LINE_BYTES) {
        event = { type: 'runner.stderr', text: line.slice(0, 2_000) };
      } else {
        try {
          const parsed = JSON.parse(line);
          event = isRecord(parsed) ? parsed : { type: 'runner.stderr', text: line.slice(0, 2_000) };
        } catch {
          event = { type: 'runner.stderr', text: line.slice(0, 2_000) };
        }
      }
      await this.store.appendEvent(job.workspace, job.runId, event);
    }
    return await this.store.getJob(job.workspace, job.runId);
  }

  async #readExit(job) {
    const exitPath = runtimeSupervisorPaths(this.stateRoot, job.runId).exitPath;
    if (!existsSync(exitPath)) return undefined;
    const exit = JSON.parse(
      await readBoundedRegularFile(exitPath, MAX_EXIT_BYTES, 'Runtime supervisor exit record'),
    );
    if (exit?.schema !== 'circuit.mcp-runtime-exit@v1' || exit?.run_id !== job.runId) {
      throw new Error('Runtime supervisor exit record is invalid.');
    }
    return exit;
  }

  async #readRuntimeChild(job) {
    try {
      return await readRuntimeChildRecord(this.stateRoot, job.runId);
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async #readFlowReport(job) {
    const reportName = FLOW_REPORT_PATHS[job.flow];
    if (reportName === undefined) throw new Error(`No fixed report is defined for ${job.flow}.`);
    const reportPath = path.join(job.runFolder, 'reports', reportName);
    return JSON.parse(
      await readBoundedRegularFile(reportPath, MAX_REPORT_BYTES, `${job.flow} report`),
    );
  }

  async #assertSafeRunFolder(job) {
    const runFolderStat = await lstat(job.runFolder);
    if (runFolderStat.isSymbolicLink() || !runFolderStat.isDirectory()) {
      throw new Error('The sealed run folder must be a real directory.');
    }
    const canonicalRunFolder = await realpath(job.runFolder);
    if (
      canonicalRunFolder !== job.runFolder ||
      !pathIsInside(this.sealedState.runs, canonicalRunFolder)
    ) {
      throw new Error('The sealed run folder must stay inside Circuit MCP state.');
    }
    return canonicalRunFolder;
  }

  async #terminalPatch(job, exit) {
    if (exit.reason === 'cancel') {
      return exit.cleanup?.confirmed === true
        ? {
            state: 'cancelled',
            error: 'The Circuit run was cancelled; observed process tree cleanup was confirmed.',
            interruptionConfirmed: true,
          }
        : {
            state: 'recovery_required',
            error:
              'Cancellation could not confirm that every observed process exited, so this workspace remains locked.',
            interruptionConfirmed: false,
          };
    }
    if (exit.reason === 'timeout') {
      return exit.cleanup?.confirmed === true
        ? {
            state: 'interrupted',
            error: 'The MCP run exceeded its fixed wall-clock limit.',
            interruptionConfirmed: true,
          }
        : {
            state: 'recovery_required',
            error:
              'The run timed out, but process cleanup was not confirmed, so this workspace remains locked.',
            interruptionConfirmed: false,
          };
    }
    if (exit.reason === 'output_limit') {
      return exit.cleanup?.confirmed === true
        ? {
            state: 'interrupted',
            error: 'The MCP run exceeded its fixed output limit.',
            interruptionConfirmed: true,
          }
        : {
            state: 'recovery_required',
            error:
              'The run exceeded its output limit, but process cleanup was not confirmed, so this workspace remains locked.',
            interruptionConfirmed: false,
          };
    }

    let stdout = '';
    let stderr = '';
    try {
      [stdout, stderr] = await Promise.all([
        readBoundedRegularFile(job.artifacts.stdoutPath, MAX_CAPTURE_BYTES, 'Circuit stdout'),
        readBoundedRegularFile(job.artifacts.stderrPath, MAX_STDERR_BYTES, 'Circuit stderr'),
      ]);
    } catch (error) {
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
    let final;
    try {
      final = JSON.parse(stdout.trim());
    } catch {
      const detail = stderrTail(stderr);
      return {
        state: 'failed',
        error: `Circuit exited without a valid final response (${exit.code ?? exit.signal ?? 'unknown'})${detail.length === 0 ? '.' : `: ${detail}`}`,
      };
    }
    if (final?.outcome === 'checkpoint_waiting' && exit.code === 0) {
      return { state: 'waiting_for_input', final, error: null };
    }

    let report;
    let reportError;
    try {
      report = await this.#readFlowReport(job);
    } catch (error) {
      const flowLabel = `${job.flow.slice(0, 1).toUpperCase()}${job.flow.slice(1)}`;
      reportError = `${flowLabel} report could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    let error = reportError;
    if (exit.code !== 0 && final?.outcome !== 'stopped') {
      const detail = stderrTail(stderr);
      error = `Circuit exited with ${exit.code ?? exit.signal ?? 'an unknown status'}${detail.length === 0 ? '.' : `: ${detail}`}`;
    }
    return {
      state:
        exit.code === 0 && final?.outcome === 'complete' && report !== undefined
          ? 'complete'
          : 'needs_attention',
      final,
      ...(report === undefined ? {} : { report }),
      ...(error === undefined ? { error: null } : { error }),
    };
  }

  async #commitPatch(job, patch) {
    if (patch.state === 'recovery_required') {
      if (job.state === 'recovery_required') return job;
      return await this.store.updateJob(job.workspace, job.runId, patch);
    }
    if (job.state === 'recovery_required') {
      try {
        return await this.store.commitRecoveredResult(job.workspace, job.runId, patch);
      } catch (error) {
        if (String(error?.message).includes('until both old processes are gone')) return job;
        throw error;
      }
    }
    return await this.store.updateJob(job.workspace, job.runId, patch);
  }

  #serializeRefresh(runId, operation) {
    const previous = this.refreshQueues.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.refreshQueues.set(runId, current);
    return current.finally(() => {
      if (this.refreshQueues.get(runId) === current) this.refreshQueues.delete(runId);
    });
  }

  #refresh(workspace, runId) {
    return this.#serializeRefresh(runId, () => this.#refreshOnce(workspace, runId));
  }

  async #refreshOnce(workspace, runId) {
    await this.#ready();
    let job = await this.store.getJob(workspace, runId);
    if (job.state === 'resuming') {
      // The previous checkpoint exit record remains until #launch atomically
      // replaces the fixed supervisor files. Do not mistake that stale exit
      // for the new resume result during this short claim-to-launch window.
      if (!this.controllers.has(runId)) {
        job = await this.store.reconcileJob(workspace, runId);
      }
      return job;
    }
    job = await this.#syncProgress(job);
    const exit = activeState(job.state) ? await this.#readExit(job) : undefined;
    if (exit !== undefined) {
      // The exit record can appear while a large progress snapshot is still
      // being saved. Read the now-closed log once more before going terminal.
      job = await this.#syncProgress(job);
      const patch = await this.#terminalPatch(job, exit);
      job = await this.#commitPatch(job, patch);
      if (!activeState(job.state)) this.controllers.delete(runId);
      return job;
    }
    if (activeState(job.state) && !this.controllers.has(runId)) {
      job = await this.store.reconcileJob(workspace, runId);
    }
    if (job.state === 'recovery_required') {
      const child = await this.#readRuntimeChild(job);
      const supervisorGone = job.worker !== undefined && !pidIsAlive(job.worker.pid);
      const childGone = child !== undefined && !pidIsAlive(child.child_pid);
      if (supervisorGone && childGone) {
        job = await this.store.resolveRecovery(workspace, runId, {
          confirmedNoProcesses: true,
        });
      }
    }
    return job;
  }

  async status(workspace, rawInput) {
    const { runId, afterCursor, maxEvents, waitMs } = parseStatusArguments(rawInput);
    let job = await this.#refresh(workspace, runId);
    if (afterCursor > job.events.length) {
      throw new Error(
        `after_cursor is ahead of this run. Use ${job.events.length} to continue from the latest event.`,
      );
    }
    const deadline = Date.now() + waitMs;
    while (waitMs > 0 && activeState(job.state) && afterCursor >= job.events.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(50, remaining)));
      job = await this.#refresh(workspace, runId);
    }
    const events = job.events
      .slice(afterCursor, afterCursor + maxEvents)
      .map((event) => compactProgressEvent(event));
    const nextCursor = afterCursor + events.length;
    const final = compactFinal(job.final);
    const checkpoint =
      job.state === 'waiting_for_input' ? await checkpointViewForJob(job) : undefined;
    return {
      run_id: job.runId,
      flow: job.flow,
      state: job.state,
      progress: {
        events,
        next_cursor: nextCursor,
        has_more: nextCursor < job.events.length,
        truncated: job.eventsDropped > 0,
      },
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(final === undefined
        ? {}
        : { result: { ...final, ...(job.report === undefined ? {} : { report: job.report }) } }),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.interruptionConfirmed === undefined
        ? {}
        : { interruption_confirmed: job.interruptionConfirmed }),
      ...(activeState(job.state) ? { poll_after_ms: 1_000 } : {}),
    };
  }

  async resume(workspace, rawInput) {
    const finishOperation = this.#beginOperation();
    let runId;
    try {
      const parsed = parseResumeArguments(rawInput);
      runId = parsed.runId;
      const { choice } = parsed;
      await this.#assertRunBoundary(workspace);
      let job = await this.#refresh(workspace, runId);
      if (job.state !== 'waiting_for_input') {
        throw new Error('This Circuit run is not waiting for checkpoint input.');
      }
      const choices = job.final?.checkpoint?.allowed_choices;
      if (!Array.isArray(choices) || !choices.includes(choice)) {
        throw new Error(`checkpoint_choice must be one of ${(choices ?? []).join(', ')}.`);
      }
      job = await this.store.claimResume(workspace, runId);
      try {
        const claimedChoices = job.final?.checkpoint?.allowed_choices;
        if (!Array.isArray(claimedChoices) || !claimedChoices.includes(choice)) {
          throw new Error(`checkpoint_choice must be one of ${(claimedChoices ?? []).join(', ')}.`);
        }
        const policy = await this.#readPolicy(job);
        await this.#launch(job, policy, [
          'resume',
          '--run-folder',
          job.runFolder,
          '--checkpoint-choice',
          choice,
          '--progress',
          'jsonl',
        ]);
      } catch (error) {
        if (error?.preserveWorkspaceLock !== true && error?.preserveJobState !== true) {
          await this.store.updateJob(workspace, runId, {
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
      return { run_id: runId, state: 'running', poll_after_ms: 1_000 };
    } finally {
      if (runId !== undefined) this.pendingLaunchCancellations.delete(runId);
      finishOperation();
    }
  }

  async #writeCancelMarker(job, reason = 'cancel') {
    const cancelFile = runtimeSupervisorPaths(this.stateRoot, job.runId).cancelPath;
    const runFolder = await this.#assertSafeRunFolder(job);
    if (path.dirname(cancelFile) !== runFolder) {
      throw new Error('The cancel marker does not belong to this sealed run.');
    }
    await writeExclusiveRegularFile(cancelFile, `${reason}\n`, 'Circuit cancel marker');
  }

  async cancel(workspace, rawInput) {
    const { runId } = parseCancelArguments(rawInput);
    let job = await this.#refresh(workspace, runId);
    if (job.state === 'waiting_for_input') {
      try {
        job = await this.store.cancelWaitingCheckpoint(workspace, runId);
      } catch (error) {
        // Resume and cancellation compete for the same durable per-run
        // decision claim. If another server won, wait briefly for its claimed
        // state to become visible, then continue through active cancellation.
        job = await this.#refresh(workspace, runId);
        if (job.state === 'waiting_for_input') {
          const message = String(error?.message);
          if (
            !message.includes('holds this workspace lease') &&
            !message.includes('deciding this waiting Circuit checkpoint')
          ) {
            throw error;
          }
          const deadline = Date.now() + CANCEL_WAIT_MS;
          while (job.state === 'waiting_for_input' && Date.now() < deadline) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
            try {
              job = await this.store.cancelWaitingCheckpoint(workspace, runId);
            } catch (retryError) {
              job = await this.#refresh(workspace, runId);
              if (
                job.state === 'waiting_for_input' &&
                !String(retryError?.message).includes('deciding this waiting Circuit checkpoint')
              ) {
                throw retryError;
              }
            }
          }
          if (job.state === 'waiting_for_input') {
            return {
              run_id: job.runId,
              state: job.state,
              changed: false,
              confirmed: false,
            };
          }
        }
      }
      if (job.state === 'cancelled') {
        return {
          run_id: job.runId,
          state: job.state,
          changed: true,
          confirmed: job.interruptionConfirmed === true,
        };
      }
    }
    if (job.state === 'resuming') {
      // Persist cancellation before waiting on this process's controller. A
      // different MCP server cannot see the in-memory set, but the resumed
      // supervisor sees this marker as soon as it starts.
      await this.#writeCancelMarker(job);
      this.pendingLaunchCancellations.add(runId);
      const deadline = Date.now() + CANCEL_WAIT_MS;
      while (job.state === 'resuming' && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        job = await this.#refresh(workspace, runId);
      }
      if (job.state === 'cancelled') {
        return {
          run_id: job.runId,
          state: job.state,
          changed: true,
          confirmed: job.interruptionConfirmed === true,
        };
      }
      if (job.state === 'resuming') {
        return {
          run_id: job.runId,
          state: job.state,
          changed: true,
          confirmed: false,
        };
      }
      this.pendingLaunchCancellations.delete(runId);
    }
    if (
      job.state !== 'running' &&
      job.state !== 'starting' &&
      job.state !== 'resuming' &&
      job.state !== 'recovery_required'
    ) {
      return {
        run_id: job.runId,
        state: job.state,
        changed: false,
        ...(job.interruptionConfirmed === undefined
          ? {}
          : { confirmed: job.interruptionConfirmed }),
      };
    }
    await this.#writeCancelMarker(job);
    const recordedSupervisorPid = this.controllers.get(runId)?.child?.pid ?? job.worker?.pid;
    if (recordedSupervisorPid !== undefined && pidIsAlive(recordedSupervisorPid)) {
      const deadline = Date.now() + CANCEL_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        job = await this.#refresh(workspace, runId);
        if (!activeState(job.state)) {
          return {
            run_id: job.runId,
            state: job.state,
            changed: true,
            confirmed: job.interruptionConfirmed === true,
          };
        }
      }
    }

    // Only signal a ChildProcess object created by this live MCP server. PIDs
    // loaded from durable state have no OS-level birth identity and may have
    // been reused by an unrelated process after a restart.
    const controllerPid = this.controllers.get(runId)?.child?.pid;
    const pid =
      controllerPid !== undefined && pidIsAlive(controllerPid) ? controllerPid : undefined;
    const interruption =
      typeof pid === 'number'
        ? await interruptProcessTree(pid, this.interruptGraceMs)
        : {
            descendantPids: [],
            enumerationSucceeded: false,
            remainingPids: [],
            confirmed: false,
          };
    const patch = {
      state: interruption.confirmed ? 'cancelled' : 'recovery_required',
      interruptionConfirmed: interruption.confirmed,
      error: interruption.confirmed
        ? 'The Circuit run was cancelled; fallback process-tree cleanup was confirmed.'
        : 'Cancellation could not confirm every process exit, so this workspace remains locked.',
    };
    job =
      job.state === 'recovery_required' && patch.state === 'recovery_required'
        ? job
        : job.state === 'recovery_required' && patch.state === 'cancelled'
          ? await this.store.commitRecoveredResult(workspace, runId, patch)
          : await this.store.updateJob(workspace, runId, patch);
    return {
      run_id: job.runId,
      state: job.state,
      changed: true,
      confirmed: interruption.confirmed,
    };
  }

  async shutdown() {
    if (this.shutdownPromise !== undefined) return await this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = (async () => {
      await Promise.allSettled([...this.pendingOperations]);
      for (const controller of this.controllers.values()) {
        controller.detached = true;
        controller.child.removeAllListeners('error');
        controller.child.removeAllListeners('close');
        controller.child.once('error', () => undefined);
        controller.child.unref();
      }
      this.controllers.clear();
    })();
    return await this.shutdownPromise;
  }
}
