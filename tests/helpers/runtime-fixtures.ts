import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

/**
 * Shared runtime-test fixtures.
 *
 * These primitives were previously re-derived byte-for-byte across dozens of
 * test files (deterministicNow in ~46, withTempRun in 3). Hoisting them behind
 * one small interface means a change to clock granularity or temp-run lifecycle
 * is a single edit here instead of a fan-out across the suite.
 */

/**
 * A deterministic monotonic clock: returns a `() => Date` that advances exactly
 * one second per call, starting at `startMs`. Lets trace/runtime tests assert on
 * stable, ordered timestamps without touching the wall clock.
 */
export function deterministicNow(startMs: number): () => Date {
  let n = 0;
  return () => new Date(startMs + n++ * 1000);
}

/**
 * Run `fn` against a fresh temporary run directory, removing it afterward even
 * if `fn` throws. The mkdtemp prefix defaults to `circuit-runtime-`; pass an
 * explicit prefix as the first argument when a test needs a recognizable name.
 */
export function withTempRun<T>(fn: (runDir: string) => Promise<T>): Promise<T>;
export function withTempRun<T>(prefix: string, fn: (runDir: string) => Promise<T>): Promise<T>;
export async function withTempRun<T>(
  prefixOrFn: string | ((runDir: string) => Promise<T>),
  maybeFn?: (runDir: string) => Promise<T>,
): Promise<T> {
  const prefix = typeof prefixOrFn === 'string' ? prefixOrFn : 'circuit-runtime-';
  const fn = typeof prefixOrFn === 'function' ? prefixOrFn : maybeFn;
  if (fn === undefined) {
    throw new Error('withTempRun requires a callback');
  }
  const runDir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(runDir);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

/**
 * The common stub `RelayResult` literal, previously hand-built byte-for-byte
 * across ~40 test files. Tests assert on `result_body` (and, via the relayer,
 * `request_payload`) — never on `receipt_id`, `duration_ms`, or `cli_version` —
 * so those three carry stable, arbitrary defaults. Pass `overrides` (shallow
 * merged) for the per-site `result_body`/`receipt_id` a given test needs.
 */
export function stubRelayResult(overrides: Partial<RelayResult> = {}): RelayResult {
  return {
    request_payload: '',
    receipt_id: 'stub-receipt',
    result_body: '',
    duration_ms: 1,
    cli_version: '0.0.0-stub',
    ...overrides,
  };
}

/**
 * Run `fn` with `process.stdout.write` and `process.stderr.write` patched to
 * accumulate everything written to them, restoring both originals in a `finally`
 * even if `fn` throws. Returns `fn`'s own return value as `result` (this is how
 * CLI-driving tests recover the exit code the invoked operation returns) plus the
 * captured `stdout`/`stderr` strings.
 *
 * A leaked patch would silently corrupt every later test in the worker, so the
 * restore is unconditional and restores the exact originals captured on entry.
 * The `write` casts match how the codebase patches the (overloaded) write
 * signature: accept a `string | Uint8Array` chunk, decode to UTF-8, return `true`.
 */
export async function captureStreams<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

/**
 * Thin wrapper over `captureStreams` for the common case of a CLI that prints a
 * single JSON document to stdout: captures both streams, then `JSON.parse`s the
 * captured stdout into `json` (typed `T`). `result` is `fn`'s return value (the
 * exit code), and the raw `stdout`/`stderr` are passed through for assertions.
 */
export async function captureJson<T = unknown>(
  fn: () => Promise<number>,
): Promise<{ result: number; json: T; stdout: string; stderr: string }> {
  const { result, stdout, stderr } = await captureStreams(fn);
  return { result, json: JSON.parse(stdout) as T, stdout, stderr };
}

/**
 * Build a `RelayFn` whose `relay` yields `stubRelayResult` with `request_payload`
 * bound to the live `input.prompt` and `result_body` taken from `body` — either a
 * constant string or a function of the relay input (for prompt-dependent stubs).
 * `connectorName` defaults to `claude-code`; pass `overrides` for a different
 * `receipt_id`, connector identity, or any other RelayResult field.
 *
 * The fixture only consumes the supplied prompt and never reads a workspace,
 * so it can truthfully declare the prompt-only boundary required by Review.
 */
export function makeStubRelayer(
  body: string | ((input: RelayInput) => string),
  overrides: Partial<RelayResult> & { connectorName?: string } = {},
): RelayFn {
  const { connectorName = 'claude-code', ...resultOverrides } = overrides;
  return {
    connectorName,
    promptOnlyContext: true,
    relay: async (input: RelayInput): Promise<RelayResult> =>
      stubRelayResult({
        request_payload: input.prompt,
        result_body: typeof body === 'function' ? body(input) : body,
        ...resultOverrides,
      }),
  };
}
