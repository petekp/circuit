import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 5_000_000;
const MAX_ARG_COUNT = 256;
const MAX_ARG_CHARS = 64 * 1024;
const MAX_ENV_VALUE_CHARS = 32 * 1024;
const DEFAULT_INTERRUPT_GRACE_MS = 500;
const DESCENDANT_POLL_MS = 100;
const DESCENDANT_STARTUP_SETTLE_MS = 25;
const DESCENDANT_STARTUP_POLL_MS = 10;
const DESCENDANT_STARTUP_WINDOW_MS = 500;
const MAX_GIT_POINTER_BYTES = 8 * 1024;

const PRIVATE_READ_ROOTS = [
  '/Users',
  '/Volumes',
  '/Network',
  '/home',
  '/private/tmp',
  '/private/var/folders',
  '/tmp',
  '/var/folders',
  '/System/Volumes/Data/Users',
  '/System/Volumes/Data/home',
  '/System/Volumes/Data/private/tmp',
  '/System/Volumes/Data/private/var/folders',
];

const INHERITED_ENV_KEYS = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SystemRoot',
  'TERM',
  'USER',
  'WINDIR',
]);

// Proof plans currently use an empty env. These few conventional test/build
// switches are enough for an experiment without carrying arbitrary host state
// or credentials into a workspace command.
const COMMAND_ENV_KEYS = new Set([
  ...INHERITED_ENV_KEYS,
  'CI',
  'FORCE_COLOR',
  'NODE_ENV',
  'NO_COLOR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
]);

export class ProofSandboxBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProofSandboxBlockedError';
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInsideOrSame(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requiredString(value, label, maxChars = MAX_ARG_CHARS) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProofSandboxBlockedError(`${label} must be a non-empty string.`);
  }
  if (value.includes('\0')) throw new ProofSandboxBlockedError(`${label} contains a null byte.`);
  if (value.length > maxChars) {
    throw new ProofSandboxBlockedError(`${label} is too long.`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ProofSandboxBlockedError(
      `${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

async function optionalLstat(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function resolveProofCwd(workspace, cwd) {
  if (path.isAbsolute(cwd)) {
    throw new ProofSandboxBlockedError('Proof cwd must be relative to the workspace.');
  }
  const target = path.resolve(workspace, cwd);
  if (!isInsideOrSame(workspace, target)) {
    throw new ProofSandboxBlockedError(`Proof cwd ${JSON.stringify(cwd)} escapes the workspace.`);
  }

  let cursor = workspace;
  for (const segment of cwd.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue;
    cursor = path.resolve(cursor, segment);
    const stat = await optionalLstat(cursor);
    if (stat === undefined) {
      throw new ProofSandboxBlockedError(`Proof cwd ${JSON.stringify(cwd)} does not exist.`);
    }
    if (stat.isSymbolicLink()) {
      throw new ProofSandboxBlockedError(
        `Proof cwd ${JSON.stringify(cwd)} crosses symbolic link ${JSON.stringify(cursor)}.`,
      );
    }
  }

  const canonical = await realpath(target);
  if (!isInsideOrSame(workspace, canonical)) {
    throw new ProofSandboxBlockedError(`Proof cwd ${JSON.stringify(cwd)} escapes the workspace.`);
  }
  return canonical;
}

function validateCommandEnvironment(value) {
  if (!isRecord(value)) throw new ProofSandboxBlockedError('Proof env must be an object.');
  const env = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!COMMAND_ENV_KEYS.has(key)) {
      throw new ProofSandboxBlockedError(`Proof env key ${JSON.stringify(key)} is not allowed.`);
    }
    if (typeof entry !== 'string') {
      throw new ProofSandboxBlockedError(
        `Proof env value for ${JSON.stringify(key)} must be a string.`,
      );
    }
    if (entry.length > MAX_ENV_VALUE_CHARS || entry.includes('\0')) {
      throw new ProofSandboxBlockedError(`Proof env value for ${JSON.stringify(key)} is invalid.`);
    }
    env[key] = entry;
  }
  return env;
}

function boundedEnvironment(baseEnv, commandEnv, privateTemp) {
  const env = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = baseEnv[key];
    if (typeof value === 'string') env[key] = value;
  }
  Object.assign(env, commandEnv);
  // Never let a proof plan redirect its home or temporary files outside the
  // one writable workspace. Host credentials and proxy variables are omitted.
  env.HOME = path.join(privateTemp, 'home');
  env.TEMP = privateTemp;
  env.TMP = privateTemp;
  env.TMPDIR = privateTemp;
  env.CIRCUIT_MCP_PROOF_SANDBOX = '1';
  return env;
}

function gitReadOnlyEnvironment(env) {
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    PAGER: 'cat',
  };
}

function seatbeltString(value) {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')}"`;
}

function pathAndAncestors(candidate) {
  const found = [];
  let cursor = path.resolve(candidate);
  while (true) {
    found.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) return found;
    cursor = parent;
  }
}

export function buildMacosProofSandboxProfile(workspace, options = {}) {
  const access = options.access ?? 'workspace-write';
  if (access !== 'workspace-write' && access !== 'git-read-only') {
    throw new ProofSandboxBlockedError(`Unsupported sandbox access mode: ${String(access)}.`);
  }
  const readRoots = [...new Set(options.readRoots ?? [workspace])];
  const writableRoots = [...new Set(options.writableRoots ?? [workspace])];
  const readMetadataPaths = [...new Set(readRoots.flatMap(pathAndAncestors))];
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix*)',
  ];
  if (access === 'workspace-write') {
    profile.push('(allow file-read*)');
  } else {
    profile.push(
      '(allow file-read*',
      '  (require-all',
      ...PRIVATE_READ_ROOTS.map((root) => `    (require-not (subpath ${seatbeltString(root)}))`),
      '  )',
      ')',
      '(allow file-read*',
      ...readRoots.map((root) => `  (subpath ${seatbeltString(root)})`),
      ')',
      '(allow file-read-metadata',
      ...readMetadataPaths.map((root) => `  (literal ${seatbeltString(root)})`),
      ')',
    );
  }
  profile.push(
    '(allow file-write*',
    ...writableRoots.map((root) => `  (subpath ${seatbeltString(root)})`),
    '  (literal "/dev/null")',
    '  (literal "/dev/dtracehelper"))',
    '(deny network*)',
  );
  return profile.join('\n');
}

function defaultSandboxLaunch(input) {
  if (process.platform !== 'darwin') {
    throw new ProofSandboxBlockedError(
      `The MCP proof sandbox spike only implements macOS Seatbelt, not ${process.platform}.`,
    );
  }
  if (!existsSync('/usr/bin/sandbox-exec')) {
    throw new ProofSandboxBlockedError('macOS sandbox-exec is unavailable.');
  }
  return {
    executable: '/usr/bin/sandbox-exec',
    args: [
      '-p',
      buildMacosProofSandboxProfile(input.workspace, {
        access: input.access,
        readRoots: input.readRoots,
        writableRoots: input.writableRoots,
      }),
      input.argv[0],
      ...input.argv.slice(1),
    ],
    provider: 'macos-seatbelt',
    network: 'denied',
  };
}

async function readSmallRegularFile(candidate, label) {
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_GIT_POINTER_BYTES) {
    throw new ProofSandboxBlockedError(`${label} must be a small regular file.`);
  }
  return await readFile(candidate, 'utf8');
}

export async function resolveGitMetadataReadRoots(workspaceInput) {
  const workspace = await realpath(workspaceInput);
  const dotGit = path.join(workspace, '.git');
  const dotGitStat = await lstat(dotGit).catch((error) => {
    throw new ProofSandboxBlockedError(`Git metadata could not be inspected: ${error.message}`);
  });
  if (dotGitStat.isSymbolicLink()) {
    throw new ProofSandboxBlockedError('The workspace .git entry must not be a symbolic link.');
  }
  if (dotGitStat.isDirectory()) {
    const gitDir = await realpath(dotGit);
    const unexpectedCommonDir = await optionalLstat(path.join(gitDir, 'commondir'));
    if (unexpectedCommonDir !== undefined) {
      throw new ProofSandboxBlockedError(
        'An in-workspace Git directory must not redirect through commondir.',
      );
    }
    return [...new Set([workspace, gitDir])];
  }
  if (!dotGitStat.isFile()) {
    throw new ProofSandboxBlockedError('The workspace .git entry is not a file or directory.');
  }
  const pointer = (await readSmallRegularFile(dotGit, 'The workspace .git pointer')).trim();
  const match = /^gitdir: (.+)$/u.exec(pointer);
  if (match?.[1] === undefined) {
    throw new ProofSandboxBlockedError('The workspace .git pointer is invalid.');
  }
  const gitDir = await realpath(path.resolve(workspace, match[1]));
  const gitDirStat = await lstat(gitDir);
  if (!gitDirStat.isDirectory()) {
    throw new ProofSandboxBlockedError('The resolved Git directory is not a directory.');
  }

  const commonPointer = path.join(gitDir, 'commondir');
  let commonText;
  try {
    commonText = (await readSmallRegularFile(commonPointer, 'The Git commondir pointer')).trim();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ProofSandboxBlockedError(
        'A Git pointer must use the complete linked worktree shape with commondir.',
      );
    }
    throw error;
  }
  if (commonText.length === 0 || commonText.includes('\0')) {
    throw new ProofSandboxBlockedError('The Git commondir pointer is invalid.');
  }
  const commonDir = await realpath(path.resolve(gitDir, commonText));
  const commonStat = await lstat(commonDir);
  if (!commonStat.isDirectory()) {
    throw new ProofSandboxBlockedError('The resolved Git common directory is not a directory.');
  }
  const expectedCommonDir = await realpath(path.resolve(gitDir, '..', '..'));
  if (path.basename(path.dirname(gitDir)) !== 'worktrees' || commonDir !== expectedCommonDir) {
    throw new ProofSandboxBlockedError(
      'The Git pointer does not use the fixed linked worktree directory shape.',
    );
  }
  const backlinkText = (
    await readSmallRegularFile(path.join(gitDir, 'gitdir'), 'The Git worktree backlink')
  ).trim();
  if (backlinkText.length === 0 || backlinkText.includes('\0')) {
    throw new ProofSandboxBlockedError('The Git worktree backlink is invalid.');
  }
  const backlink = await realpath(
    path.isAbsolute(backlinkText) ? backlinkText : path.resolve(gitDir, backlinkText),
  );
  const workspaceDotGit = await realpath(dotGit);
  if (backlink !== workspaceDotGit) {
    throw new ProofSandboxBlockedError('The Git worktree backlink does not match this workspace.');
  }
  return [...new Set([workspace, gitDir, commonDir])];
}

async function resolvePrivateTempParent(workspace, candidateInput) {
  const candidate = path.resolve(candidateInput ?? tmpdir());
  const candidateStat = await lstat(candidate).catch((error) => {
    throw new ProofSandboxBlockedError(
      `Private proof temp root could not be inspected: ${error.message}`,
    );
  });
  if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
    throw new ProofSandboxBlockedError('Private proof temp root must be a real directory.');
  }
  const canonical = await realpath(candidate);
  if (isInsideOrSame(workspace, canonical)) {
    throw new ProofSandboxBlockedError(
      'Private proof temp root must be outside the model-writable workspace.',
    );
  }
  return canonical;
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

async function observedProcessTree(rootPid, enumerate = undefined) {
  if (enumerate !== undefined) return await enumerate(rootPid);
  const output = await execFilePromise('/bin/ps', ['-ax', '-o', 'pid=,ppid=']);
  const children = new Map();
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match === null) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }

  const descendants = [];
  const visit = (pid, depth) => {
    for (const child of children.get(pid) ?? []) {
      visit(child, depth + 1);
      descendants.push({ pid: child, depth });
    }
  };
  visit(rootPid, 1);
  return descendants.sort((left, right) => right.depth - left.depth).map((entry) => entry.pid);
}

async function observedProcessGroup(rootPid, enumerate = undefined) {
  if (enumerate !== undefined) return await enumerate(rootPid);
  const output = await execFilePromise('/bin/ps', ['-ax', '-o', 'pid=,pgid=']);
  const members = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match === null) continue;
    const pid = Number(match[1]);
    const processGroup = Number(match[2]);
    if (processGroup === rootPid && pid !== rootPid) members.push(pid);
  }
  return members;
}

async function observedProcessSnapshot(rootPid) {
  const output = await execFilePromise('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid=']);
  const children = new Map();
  const group = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (match === null) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const processGroup = Number(match[3]);
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
    if (processGroup === rootPid && pid !== rootPid) group.push(pid);
  }
  const descendants = [];
  const visit = (pid, depth) => {
    for (const child of children.get(pid) ?? []) {
      visit(child, depth + 1);
      descendants.push({ pid: child, depth });
    }
  };
  visit(rootPid, 1);
  return {
    tree: descendants.sort((left, right) => right.depth - left.depth).map((entry) => entry.pid),
    group,
  };
}

export function observeDescendants(rootPid, options = {}) {
  const observed = new Set();
  let enumerationSucceeded = true;
  let enumerationError;
  let startupPoll = true;
  const startedAt = performance.now();
  let stopped = false;
  let timer;
  let activePoll;
  const capture = async () => {
    const { tree, group } =
      options.enumerate === undefined && options.enumerateGroup === undefined
        ? await observedProcessSnapshot(rootPid)
        : {
            tree: await observedProcessTree(rootPid, options.enumerate),
            group: await observedProcessGroup(rootPid, options.enumerateGroup),
          };
    for (const pid of [...tree, ...group]) observed.add(pid);
  };
  const poll = () => {
    if (stopped || activePoll !== undefined) return;
    const settleStartup = startupPoll;
    startupPoll = false;
    activePoll = Promise.resolve()
      .then(async () => {
        await capture();
        const startupSettleMs = options.startupSettleMs ?? DESCENDANT_STARTUP_SETTLE_MS;
        if (settleStartup && startupSettleMs > 0) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, startupSettleMs));
          await capture();
        }
      })
      .catch((error) => {
        enumerationSucceeded = false;
        enumerationError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        activePoll = undefined;
        if (stopped) return;
        const startupWindowMs = options.startupWindowMs ?? DESCENDANT_STARTUP_WINDOW_MS;
        const delay =
          performance.now() - startedAt < startupWindowMs
            ? (options.startupPollMs ?? DESCENDANT_STARTUP_POLL_MS)
            : (options.pollMs ?? DESCENDANT_POLL_MS);
        timer = setTimeout(() => {
          timer = undefined;
          poll();
        }, delay);
        timer.unref();
      });
  };
  poll();
  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      const pollAtStop = activePoll;
      if (pollAtStop !== undefined) await pollAtStop;
      return {
        pids: [...observed],
        enumerationSucceeded,
        ...(enumerationError === undefined ? {} : { enumerationError }),
      };
    },
  };
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

function pidIsPossiblyAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process may still exist. Only ESRCH proves it is gone.
    return error?.code !== 'ESRCH';
  }
}

async function remainingObservedPids(pids, timeoutMs = 750) {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter(pidIsPossiblyAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    remaining = pids.filter(pidIsPossiblyAlive);
  }
  return remaining;
}

export async function interruptObservedProcessTree(rootPid, options = {}) {
  const graceMs = options.graceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
  // Freeze the known process group before enumeration. This narrows the race in
  // which a child could fork while ps is taking its snapshot.
  signalPidOrGroup(rootPid, 'SIGSTOP');
  for (const pid of options.knownPids ?? []) signalPidOrGroup(pid, 'SIGSTOP');
  let descendantPids = [...new Set(options.knownPids ?? [])];
  let enumerationSucceeded = true;
  let enumerationError;
  try {
    const [tree, group] = await Promise.all([
      observedProcessTree(rootPid, options.enumerate),
      observedProcessGroup(rootPid, options.enumerateGroup),
    ]);
    descendantPids = [...new Set([...descendantPids, ...tree, ...group])];
  } catch (error) {
    enumerationSucceeded = false;
    enumerationError = error instanceof Error ? error.message : String(error);
  }

  for (const pid of descendantPids) signalPidOrGroup(pid, 'SIGTERM');
  signalPidOrGroup(rootPid, 'SIGTERM');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, graceMs));
  for (const pid of descendantPids) signalPidOrGroup(pid, 'SIGKILL');
  signalPidOrGroup(rootPid, 'SIGKILL');

  const observedPids = [...new Set([rootPid, ...descendantPids])];
  const remainingPids = await remainingObservedPids(observedPids);
  return {
    scope: 'observed_process_tree',
    descendantPids,
    enumerationSucceeded,
    ...(enumerationError === undefined ? {} : { enumerationError }),
    remainingPids,
    confirmed: enumerationSucceeded && remainingPids.length === 0,
  };
}

function appendBounded(current, chunk, remainingBytes) {
  if (remainingBytes <= 0) return { text: current, keptBytes: 0, capped: chunk.length > 0 };
  const kept = chunk.subarray(0, remainingBytes);
  return {
    text: current + kept.toString('utf8'),
    keptBytes: kept.length,
    capped: kept.length < chunk.length,
  };
}

function stoppedStatus(reason) {
  if (reason === 'timeout') return 'timed_out';
  if (reason === 'cancel') return 'cancelled';
  return 'output_limit';
}

function cleanupNotRequired() {
  return {
    scope: 'observed_process_tree',
    descendantPids: [],
    enumerationSucceeded: true,
    remainingPids: [],
    confirmed: true,
    required: false,
  };
}

export async function runSandboxedProofCommand(input, options = {}) {
  const workspaceInput = requiredString(input?.workspace, 'workspace');
  const workspace = await realpath(workspaceInput).catch((error) => {
    throw new ProofSandboxBlockedError(`Workspace could not be resolved: ${error.message}`);
  });
  const workspaceStat = await lstat(workspace);
  if (!workspaceStat.isDirectory())
    throw new ProofSandboxBlockedError('Workspace is not a directory.');
  const cwd = await resolveProofCwd(workspace, requiredString(input.cwd, 'cwd'));
  if (!Array.isArray(input.argv) || input.argv.length === 0 || input.argv.length > MAX_ARG_COUNT) {
    throw new ProofSandboxBlockedError(`argv must contain 1 to ${MAX_ARG_COUNT} strings.`);
  }
  const argv = input.argv.map((entry, index) => requiredString(entry, `argv[${index}]`));
  const timeoutMs = boundedInteger(input.timeoutMs, 'timeoutMs', 1, MAX_TIMEOUT_MS);
  const maxOutputBytes = boundedInteger(
    input.maxOutputBytes,
    'maxOutputBytes',
    1,
    MAX_OUTPUT_BYTES,
  );
  const commandEnv = validateCommandEnvironment(input.env ?? {});
  const access = input.access ?? 'workspace-write';
  if (access !== 'workspace-write' && access !== 'git-read-only') {
    throw new ProofSandboxBlockedError(`Unsupported sandbox access mode: ${String(access)}.`);
  }

  if (input.signal?.aborted === true) {
    return {
      status: 'cancelled',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: 'Proof command was cancelled before launch.',
      outputCapped: false,
      cleanup: cleanupNotRequired(),
      sandbox: {
        provider: 'not-launched',
        network: 'not_started',
        writableRoots: access === 'workspace-write' ? [workspace] : [],
      },
    };
  }

  const privateTempParent = await resolvePrivateTempParent(workspace, options.privateTempParent);
  const privateTemp = await mkdtemp(path.join(privateTempParent, 'circuit-mcp-proof-'));
  await mkdir(path.join(privateTemp, 'home'));
  const writableRoots = access === 'workspace-write' ? [workspace, privateTemp] : [privateTemp];
  const readRoots = access === 'git-read-only' ? (options.readRoots ?? [workspace]) : [workspace];
  const baseEnvironment = boundedEnvironment(
    options.baseEnv ?? process.env,
    commandEnv,
    privateTemp,
  );
  const env =
    access === 'git-read-only' ? gitReadOnlyEnvironment(baseEnvironment) : baseEnvironment;
  let launch;
  try {
    if (options.testOnlyLaunch !== undefined) {
      if (options.allowUnsafeTestLaunch !== true) {
        throw new ProofSandboxBlockedError(
          'An unsandboxed test launch was supplied without the test-only opt in.',
        );
      }
      launch = options.testOnlyLaunch({ workspace, cwd, argv, env, access });
    } else {
      launch = defaultSandboxLaunch({
        workspace,
        cwd,
        argv,
        env,
        access,
        readRoots: [...new Set([...readRoots, privateTemp])],
        writableRoots,
      });
    }
  } catch (error) {
    await rm(privateTemp, { recursive: true, force: true });
    throw error;
  }
  let child;
  try {
    child = spawn(launch.executable, launch.args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    await rm(privateTemp, { recursive: true, force: true });
    throw new ProofSandboxBlockedError(`Proof sandbox could not start: ${error.message}`);
  }
  const rootPid = child.pid;
  const observer =
    typeof rootPid === 'number'
      ? observeDescendants(rootPid, {
          enumerate: options.enumerate,
          enumerateGroup: options.enumerateGroup,
        })
      : undefined;
  let observed;
  const stopObserver = async () => {
    if (observed === undefined) {
      observed =
        observer === undefined
          ? {
              pids: [],
              enumerationSucceeded: false,
              enumerationError: 'The proof subprocess had no pid.',
            }
          : await observer.stop();
    }
    return observed;
  };

  let stdout = '';
  let stderr = '';
  let capturedBytes = 0;
  let outputCapped = false;
  let stopReason;
  let resolveStop;
  const stopPromise = new Promise((resolvePromise) => {
    resolveStop = resolvePromise;
  });
  const requestStop = (reason) => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    resolveStop(reason);
  };

  const completionPromise = new Promise((resolvePromise) => {
    child.once('error', (error) => resolvePromise({ kind: 'error', error }));
    child.once('close', (code, signal) => resolvePromise({ kind: 'close', code, signal }));
  });

  child.stdout.on('data', (chunk) => {
    const next = appendBounded(stdout, chunk, maxOutputBytes - capturedBytes);
    stdout = next.text;
    capturedBytes += next.keptBytes;
    outputCapped ||= next.capped;
    if (next.capped) requestStop('output_limit');
  });
  child.stderr.on('data', (chunk) => {
    const next = appendBounded(stderr, chunk, maxOutputBytes - capturedBytes);
    stderr = next.text;
    capturedBytes += next.keptBytes;
    outputCapped ||= next.capped;
    if (next.capped) requestStop('output_limit');
  });

  const timeout = setTimeout(() => requestStop('timeout'), timeoutMs);
  const abort = () => requestStop('cancel');
  input.signal?.addEventListener('abort', abort, { once: true });

  try {
    const winner = await Promise.race([
      completionPromise.then((completion) => ({ type: 'completion', completion })),
      stopPromise.then((reason) => ({ type: 'stop', reason })),
    ]);
    if (winner.type === 'completion') {
      const completion = winner.completion;
      if (completion.kind === 'error') {
        throw new ProofSandboxBlockedError(
          `Proof sandbox could not start: ${completion.error.message}`,
        );
      }
      const observedChildren = await stopObserver();
      const liveChildren = observedChildren.pids.filter(pidIsPossiblyAlive);
      let cleanup = {
        scope: 'observed_process_tree',
        descendantPids: observedChildren.pids,
        enumerationSucceeded: observedChildren.enumerationSucceeded,
        ...(observedChildren.enumerationError === undefined
          ? {}
          : { enumerationError: observedChildren.enumerationError }),
        remainingPids: liveChildren,
        confirmed: observedChildren.enumerationSucceeded && liveChildren.length === 0,
        required: false,
      };
      const backgroundViolation = liveChildren.length > 0;
      if (typeof rootPid === 'number' && (backgroundViolation || !cleanup.confirmed)) {
        cleanup = {
          ...(await interruptObservedProcessTree(rootPid, {
            graceMs: options.interruptGraceMs,
            enumerate: options.enumerate,
            enumerateGroup: options.enumerateGroup,
            knownPids: observedChildren.pids,
          })),
          required: true,
        };
      }
      const cleanCompletion = cleanup.confirmed && !backgroundViolation;
      const backgroundDiagnosis = backgroundViolation
        ? cleanup.confirmed
          ? 'Proof command left a background process; observed cleanup was forced and confirmed.'
          : 'Proof command left a background process; observed cleanup could not be confirmed.'
        : cleanup.confirmed
          ? ''
          : 'Proof command process observation failed, so cleanup could not be confirmed.';
      return {
        status: completion.code === 0 && cleanCompletion ? 'passed' : 'failed',
        exitCode: completion.code === 0 && !cleanCompletion ? 1 : completion.code,
        signal: completion.signal,
        stdout,
        stderr: [stderr.trimEnd(), backgroundDiagnosis]
          .filter((part) => part.length > 0)
          .join('\n'),
        outputCapped,
        cleanup,
        sandbox: { provider: launch.provider, network: launch.network, writableRoots },
      };
    }

    const observedChildren = await stopObserver();
    const cleanup =
      typeof rootPid === 'number'
        ? {
            ...(await interruptObservedProcessTree(rootPid, {
              graceMs: options.interruptGraceMs,
              enumerate: options.enumerate,
              enumerateGroup: options.enumerateGroup,
              knownPids: observedChildren.pids,
            })),
            required: true,
          }
        : {
            scope: 'observed_process_tree',
            descendantPids: [],
            enumerationSucceeded: false,
            enumerationError: 'The proof subprocess had no pid.',
            remainingPids: [],
            confirmed: false,
            required: true,
          };

    // Give Node one short chance to reap the direct child. If it does not close,
    // return the unconfirmed cleanup result instead of hanging and pretending.
    await Promise.race([
      completionPromise,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
    ]);
    if (!cleanup.confirmed) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    const status = stoppedStatus(winner.reason);
    const diagnosis = cleanup.confirmed
      ? `Proof command ${status.replace('_', ' ')}; observed process tree cleanup confirmed.`
      : `Proof command ${status.replace('_', ' ')}; observed process tree cleanup could not be confirmed.`;
    return {
      status,
      exitCode: null,
      signal: null,
      stdout,
      stderr: [stderr.trimEnd(), diagnosis].filter((part) => part.length > 0).join('\n'),
      outputCapped,
      cleanup,
      sandbox: { provider: launch.provider, network: launch.network, writableRoots },
    };
  } finally {
    await stopObserver();
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
    await rm(privateTemp, { recursive: true, force: true }).catch(() => undefined);
  }
}
