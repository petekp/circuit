#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ProofSandboxBlockedError,
  resolveGitMetadataReadRoots,
  runSandboxedProofCommand,
} from './proof-sandbox.mjs';

const REQUEST_SCHEMA = 'circuit.mcp-proof-request@v1';
const RESPONSE_SCHEMA = 'circuit.mcp-proof-response@v1';
const MAX_REQUEST_BYTES = 1024 * 1024;
const CANCEL_POLL_MS = 50;
const GIT_STATE_HELPER_ENV = 'CIRCUIT_MCP_GIT_STATE_HELPER';
const GIT_STATE_TIMEOUT_MS = 60_000;
const GIT_STATE_MAX_OUTPUT_BYTES = 5_000_000;

const GIT_GLOBAL_ARGS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'interactive.diffFilter=',
  '-c',
  'submodule.recurse=false',
];

const GIT_READ_COMMANDS = new Map([
  [
    'git-review-status',
    ['/usr/bin/git', ...GIT_GLOBAL_ARGS, 'status', '--short', '--ignore-submodules=all'],
  ],
  [
    'git-review-staged-diff',
    [
      '/usr/bin/git',
      ...GIT_GLOBAL_ARGS,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--cached',
      '--',
    ],
  ],
  [
    'git-review-unstaged-diff',
    [
      '/usr/bin/git',
      ...GIT_GLOBAL_ARGS,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--',
    ],
  ],
  [
    'git-review-staged-stat',
    [
      '/usr/bin/git',
      ...GIT_GLOBAL_ARGS,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--stat',
      '--cached',
      '--',
    ],
  ],
  [
    'git-review-untracked',
    ['/usr/bin/git', ...GIT_GLOBAL_ARGS, 'ls-files', '--others', '--exclude-standard', '-z'],
  ],
  [
    'git-working-tree-status',
    [
      '/usr/bin/git',
      ...GIT_GLOBAL_ARGS,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=all',
    ],
  ],
]);

const GIT_STATE_COMMAND_IDS = new Set([
  'build-baseline-snapshot-git-state',
  'build-touch-area-git-state',
  'fix-baseline-snapshot-git-state',
  'fix-change-set-git-state',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) throw new ProofSandboxBlockedError(`${label} must be an object.`);
  const extras = Object.keys(value).filter((key) => !keys.has(key));
  if (extras.length > 0) {
    throw new ProofSandboxBlockedError(`${label} has unsupported fields: ${extras.join(', ')}.`);
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new ProofSandboxBlockedError(`${label} must be a non-empty string without null bytes.`);
  }
  return value;
}

function isInsideOrSame(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseCommand(value) {
  assertExactKeys(
    value,
    new Set(['id', 'cwd', 'argv', 'timeout_ms', 'max_output_bytes', 'env']),
    'command',
  );
  requiredString(value.id, 'command.id');
  requiredString(value.cwd, 'command.cwd');
  if (!Array.isArray(value.argv))
    throw new ProofSandboxBlockedError('command.argv must be an array.');
  if (!isRecord(value.env)) throw new ProofSandboxBlockedError('command.env must be an object.');
  return value;
}

function assertGitReadCommand(command) {
  const expected = GIT_READ_COMMANDS.get(command.id);
  if (expected !== undefined && JSON.stringify(command.argv) === JSON.stringify(expected)) {
    if (Object.keys(command.env).length !== 0) {
      throw new ProofSandboxBlockedError(
        'git-read-only commands cannot supply environment values.',
      );
    }
    return;
  }
  if (!GIT_STATE_COMMAND_IDS.has(command.id)) {
    throw new ProofSandboxBlockedError(
      'git-read-only accepts only the fixed Circuit Git read operations.',
    );
  }
  const pinnedHelper = process.env[GIT_STATE_HELPER_ENV];
  if (
    typeof pinnedHelper !== 'string' ||
    !path.isAbsolute(pinnedHelper) ||
    command.cwd !== '.' ||
    command.argv.length !== 2 ||
    command.argv[0] !== process.execPath ||
    command.argv[1] !== pinnedHelper ||
    command.timeout_ms !== GIT_STATE_TIMEOUT_MS ||
    command.max_output_bytes !== GIT_STATE_MAX_OUTPUT_BYTES
  ) {
    throw new ProofSandboxBlockedError(
      'git-read-only git-state commands must use the pinned git-state helper.',
    );
  }
  if (Object.keys(command.env).length !== 0) {
    throw new ProofSandboxBlockedError('git-read-only commands cannot supply environment values.');
  }
}

async function resolveGitStateReadRoots(request, projectRoot) {
  if (!GIT_STATE_COMMAND_IDS.has(request.command.id)) return [];
  const executable = request.command.argv[0];
  const helper = request.command.argv[1];
  const executableStat = await lstat(executable);
  const helperStat = await lstat(helper);
  if (executableStat.isSymbolicLink() || !executableStat.isFile()) {
    throw new ProofSandboxBlockedError('The git-state Node executable must be a regular file.');
  }
  if (helperStat.isSymbolicLink() || !helperStat.isFile()) {
    throw new ProofSandboxBlockedError('The pinned git-state helper must be a regular file.');
  }
  const canonicalExecutable = await realpath(executable);
  const canonicalHelper = await realpath(helper);
  if (
    isInsideOrSame(projectRoot, canonicalExecutable) ||
    isInsideOrSame(projectRoot, canonicalHelper)
  ) {
    throw new ProofSandboxBlockedError(
      'The git-state executable and helper must be outside the writable project.',
    );
  }
  return [path.dirname(canonicalExecutable), path.dirname(canonicalHelper)];
}

export function parseProofSandboxRequest(value) {
  assertExactKeys(
    value,
    new Set(['schema', 'access', 'projectRoot', 'cwd', 'command', 'cancelFile']),
    'proof sandbox request',
  );
  if (value.schema !== REQUEST_SCHEMA) {
    throw new ProofSandboxBlockedError(`proof sandbox request schema must be ${REQUEST_SCHEMA}.`);
  }
  const projectRoot = requiredString(value.projectRoot, 'projectRoot');
  const cwd = requiredString(value.cwd, 'cwd');
  const cancelFile = requiredString(value.cancelFile, 'cancelFile');
  const access = value.access;
  if (access !== 'workspace-write' && access !== 'git-read-only') {
    throw new ProofSandboxBlockedError('access must be workspace-write or git-read-only.');
  }
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(cwd) || !path.isAbsolute(cancelFile)) {
    throw new ProofSandboxBlockedError('projectRoot, cwd, and cancelFile must be absolute paths.');
  }
  const command = parseCommand(value.command);
  if (access === 'git-read-only') assertGitReadCommand(command);
  return {
    schema: REQUEST_SCHEMA,
    access,
    projectRoot,
    cwd,
    command,
    cancelFile,
  };
}

function summarize(value, maxBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8');
}

function protocolCleanup(cleanup) {
  return {
    scope: cleanup.scope,
    enumeration_succeeded: cleanup.enumerationSucceeded,
    ...(cleanup.enumerationError === undefined
      ? {}
      : { enumeration_error: cleanup.enumerationError }),
    remaining_pids: cleanup.remainingPids,
    confirmed: cleanup.confirmed,
  };
}

export async function executeProofSandboxRequest(rawRequest, options = {}) {
  const request = parseProofSandboxRequest(rawRequest);
  const projectRoot = await realpath(request.projectRoot);
  const cwd = await realpath(request.cwd);
  if (!isInsideOrSame(projectRoot, cwd)) {
    throw new ProofSandboxBlockedError('Resolved proof cwd escapes the project root.');
  }
  const commandCwd = path.resolve(projectRoot, request.command.cwd);
  if (commandCwd !== cwd) {
    throw new ProofSandboxBlockedError('Resolved proof cwd does not match command.cwd.');
  }
  const privateTempParentInput = path.dirname(request.cancelFile);
  const privateTempParentStat = await lstat(privateTempParentInput).catch((error) => {
    throw new ProofSandboxBlockedError(
      `Proof private temp parent could not be inspected: ${error.message}`,
    );
  });
  if (privateTempParentStat.isSymbolicLink() || !privateTempParentStat.isDirectory()) {
    throw new ProofSandboxBlockedError('Proof private temp parent must be a real directory.');
  }
  const privateTempParent = await realpath(privateTempParentInput);
  if (isInsideOrSame(projectRoot, privateTempParent)) {
    throw new ProofSandboxBlockedError(
      'Proof private temp parent must be outside the writable project.',
    );
  }

  const abortController = new AbortController();
  const cancel = () => abortController.abort(new Error('Proof command cancelled.'));
  if (existsSync(request.cancelFile)) cancel();
  const cancelPoll = setInterval(() => {
    if (existsSync(request.cancelFile)) cancel();
  }, options.cancelPollMs ?? CANCEL_POLL_MS);
  cancelPoll.unref();
  const onSignal = () => cancel();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const started = Date.now();
  try {
    const readRoots =
      request.access === 'git-read-only'
        ? [
            ...(await resolveGitMetadataReadRoots(projectRoot)),
            ...(await resolveGitStateReadRoots(request, projectRoot)),
          ]
        : undefined;
    const result = await runSandboxedProofCommand(
      {
        workspace: projectRoot,
        cwd: path.relative(projectRoot, cwd) || '.',
        argv: request.command.argv,
        env: request.command.env,
        timeoutMs: request.command.timeout_ms,
        maxOutputBytes: request.command.max_output_bytes,
        signal: abortController.signal,
        access: request.access,
      },
      {
        ...options.runnerOptions,
        privateTempParent,
        ...(readRoots === undefined ? {} : { readRoots }),
      },
    );
    const durationMs = Math.max(0, Date.now() - started);
    const exitCode = result.exitCode ?? 1;
    return {
      schema: RESPONSE_SCHEMA,
      observation: {
        command: request.command,
        exit_code: exitCode,
        status: result.status === 'passed' ? 'passed' : 'failed',
        duration_ms: durationMs,
        stdout_summary: summarize(result.stdout, request.command.max_output_bytes),
        stderr_summary: summarize(result.stderr, request.command.max_output_bytes),
        timed_out: result.status === 'timed_out',
      },
      execution: {
        status: result.status,
        cleanup: protocolCleanup(result.cleanup),
        sandbox: {
          access: request.access,
          provider: result.sandbox.provider,
          network: result.sandbox.network,
          writable_roots: result.sandbox.writableRoots,
        },
      },
    };
  } finally {
    clearInterval(cancelPoll);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

async function readRequestFromStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new ProofSandboxBlockedError('Proof sandbox request exceeded 1 MiB.');
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (body.trim().length === 0)
    throw new ProofSandboxBlockedError('Proof sandbox request is empty.');
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new ProofSandboxBlockedError(`Proof sandbox request is not valid JSON: ${error.message}`);
  }
}

async function main() {
  try {
    const response = await executeProofSandboxRequest(await readRequestFromStdin());
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
