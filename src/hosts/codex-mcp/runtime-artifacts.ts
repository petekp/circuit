import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { projectRunStatusFromRunFolder } from '../../app/run-status/run-folder-projector.js';
import { sha256OfJson } from '../../schemas/hashing.js';
import { RunResult } from '../../schemas/result.js';
import type { RuntimeArtifactReconciler, RuntimeExitClassification } from './state-adapter.js';
import type { McpRunRecord } from './state-store.js';

const RESULT_PATH = 'reports/result.json';
const MAX_RESULT_BYTES = 262_144;
const MAX_MANIFEST_BYTES = 16 * 1_048_576;
const MAX_TRACE_BYTES = 64 * 1_048_576;

function plainSummary(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length <= 1_000 ? trimmed : `${trimmed.slice(0, 997)}...`;
}

function failure(
  state: 'needs_attention' | 'interrupted',
  code: string,
  message: string,
): RuntimeExitClassification {
  return { state, summary: message, failure: { code, message } };
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

async function assertOrdinaryFile(path: string, maximumBytes: number): Promise<void> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
    throw new Error('A canonical run artifact is not one ordinary file.');
  }
  if (info.size === 0n || info.size > BigInt(maximumBytes)) {
    throw new Error('A canonical run artifact has an invalid size.');
  }
}

async function safeRunFilePath(
  runRoot: string,
  relativePath: string,
  maximumBytes: number,
): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes('\0')) {
    throw new Error('A canonical run artifact path is unsafe.');
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('A canonical run artifact path is unsafe.');
  }
  let cursor = runRoot;
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('A canonical run artifact path crosses a link or non-directory.');
    }
  }
  const path = join(cursor, segments.at(-1) ?? '');
  await assertOrdinaryFile(path, maximumBytes);
  return path;
}

async function canonicalRunRoot(record: McpRunRecord): Promise<string> {
  const workspace = await realpath(record.workspace.canonical_path);
  if (workspace !== resolve(record.workspace.canonical_path)) {
    throw new Error('The trusted workspace changed before Circuit read run artifacts.');
  }
  const workspaceInfo = await lstat(workspace, { bigint: true });
  if (
    !workspaceInfo.isDirectory() ||
    workspaceInfo.isSymbolicLink() ||
    String(workspaceInfo.dev) !== record.workspace.device ||
    String(workspaceInfo.ino) !== record.workspace.inode
  ) {
    throw new Error('The trusted workspace identity changed before Circuit read run artifacts.');
  }
  let cursor = workspace;
  for (const segment of ['.circuit', 'runs', record.run_id]) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('The canonical run folder crosses a link or non-directory.');
    }
  }
  if ((await realpath(cursor)) !== cursor) {
    throw new Error('The canonical run folder changed before Circuit read it.');
  }
  return cursor;
}

async function readBoundJson(
  runRoot: string,
  relativePath: string,
  maximumBytes: number,
): Promise<{
  readonly bytes: Buffer;
  readonly value: unknown;
}> {
  const path = await safeRunFilePath(runRoot, relativePath, maximumBytes);
  const pathInfo = await lstat(path, { bigint: true });
  if (
    pathInfo.isSymbolicLink() ||
    !pathInfo.isFile() ||
    pathInfo.nlink !== 1n ||
    pathInfo.size === 0n ||
    pathInfo.size > BigInt(maximumBytes)
  ) {
    throw new Error('A canonical run report is unsafe or too large.');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = await handle.stat({ bigint: true });
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(pathInfo, before) || !sameFile(before, after)) {
      throw new Error('A canonical run report changed while Circuit read it.');
    }
  } finally {
    await handle.close();
  }
  const afterPath = await lstat(path, { bigint: true });
  if (afterPath.isSymbolicLink() || !sameFile(pathInfo, afterPath)) {
    throw new Error('A canonical run report changed while Circuit read it.');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('A canonical run report is not valid JSON.');
  }
  return { bytes, value };
}

function relativeRunPath(runRoot: string, path: string): string {
  const candidate = relative(runRoot, path).split(sep).join('/');
  if (
    candidate.length === 0 ||
    candidate.includes('\\') ||
    candidate.includes('\0') ||
    isAbsolute(candidate) ||
    candidate
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('A canonical run artifact points outside the run folder.');
  }
  return candidate;
}

export class CanonicalRuntimeArtifactReconciler implements RuntimeArtifactReconciler {
  async classifyExit(input: {
    readonly record: McpRunRecord;
    readonly exit: Parameters<RuntimeArtifactReconciler['classifyExit']>[0]['exit'];
  }): Promise<RuntimeExitClassification> {
    if (input.exit.output_limit_exceeded !== undefined) {
      return failure(
        'needs_attention',
        'worker_output_limit',
        `Circuit stopped the worker after its ${input.exit.output_limit_exceeded} output exceeded the safe limit.`,
      );
    }
    if (input.exit.signal !== undefined) {
      return failure(
        'interrupted',
        'worker_signalled',
        'The Circuit worker stopped before it recorded a normal outcome.',
      );
    }
    const workerExitedNonzero = input.exit.exit_code !== undefined && input.exit.exit_code !== 0;

    let runRoot: string;
    let status: ReturnType<typeof projectRunStatusFromRunFolder>;
    try {
      runRoot = await canonicalRunRoot(input.record);
      await assertOrdinaryFile(join(runRoot, 'manifest.snapshot.json'), MAX_MANIFEST_BYTES);
      await assertOrdinaryFile(join(runRoot, 'trace.ndjson'), MAX_TRACE_BYTES);
      status = projectRunStatusFromRunFolder(runRoot);
    } catch {
      return workerExitedNonzero
        ? failure(
            'needs_attention',
            'worker_exit_nonzero',
            'The Circuit worker exited with an error before it completed or parked safely.',
          )
        : failure(
            'needs_attention',
            'run_artifact_unavailable',
            'Circuit could not safely read the worker run artifacts.',
          );
    }
    if (
      'run_id' in status &&
      status.run_id !== undefined &&
      (status.run_id !== input.record.run_id || status.flow_id !== input.record.request.flow)
    ) {
      return failure(
        'needs_attention',
        'run_artifact_mismatch',
        'The worker run artifacts do not match this Circuit run.',
      );
    }
    if (workerExitedNonzero && status.engine_state !== 'completed') {
      return failure(
        'needs_attention',
        'worker_exit_nonzero',
        'The Circuit worker exited with an error before it completed or parked safely.',
      );
    }

    if (status.engine_state === 'waiting_checkpoint') {
      const checkpoint = status.checkpoint;
      if (checkpoint.request_path === undefined || checkpoint.request_sha256 === undefined) {
        return failure(
          'needs_attention',
          'checkpoint_invalid',
          'The worker stopped at a checkpoint without a complete saved request.',
        );
      }
      let requestPath: string;
      try {
        requestPath = relativeRunPath(runRoot, checkpoint.request_path);
        await safeRunFilePath(runRoot, requestPath, 262_144);
      } catch {
        return failure(
          'needs_attention',
          'checkpoint_unsafe',
          'Circuit refused an unsafe saved checkpoint request.',
        );
      }
      const choices = checkpoint.choices.map((choice) => choice.id);
      return {
        state: 'waiting_for_input',
        summary: `Circuit is waiting at the ${checkpoint.step_id} checkpoint.`,
        checkpoint: {
          generation: input.record.launch.generation,
          step_id: checkpoint.step_id,
          attempt: checkpoint.attempt,
          request_path: requestPath,
          request_sha256: checkpoint.request_sha256,
          allowed_choices: choices,
          choices_sha256: sha256OfJson(choices),
        },
      };
    }

    if (status.engine_state === 'open') {
      return workerExitedNonzero
        ? failure(
            'needs_attention',
            'worker_exit_nonzero',
            'The Circuit worker exited with an error before it completed or parked safely.',
          )
        : failure(
            'interrupted',
            'worker_interrupted',
            'The Circuit worker exited before it recorded a final outcome.',
          );
    }
    if (status.engine_state === 'invalid') {
      return failure(
        'needs_attention',
        'run_artifact_invalid',
        'The Circuit worker left invalid run artifacts.',
      );
    }

    let resultBytes: Buffer;
    let result: ReturnType<typeof RunResult.parse>;
    try {
      const saved = await readBoundJson(runRoot, RESULT_PATH, MAX_RESULT_BYTES);
      resultBytes = saved.bytes;
      result = RunResult.parse(saved.value);
    } catch {
      return failure(
        'needs_attention',
        'final_report_invalid',
        'Circuit could not safely read the worker final report.',
      );
    }
    if (result.run_id !== input.record.run_id || result.flow_id !== input.record.request.flow) {
      return failure(
        'needs_attention',
        'final_report_mismatch',
        'The worker final report does not match this Circuit run.',
      );
    }
    if (workerExitedNonzero && result.outcome === 'complete') {
      return failure(
        'needs_attention',
        'worker_exit_nonzero',
        'The Circuit worker exited with an error before it completed or parked safely.',
      );
    }
    if (status.engine_state !== 'completed' || result.outcome !== 'complete') {
      return failure(
        'needs_attention',
        'run_needs_attention',
        plainSummary(result.reason ?? result.summary, 'The Circuit run needs attention.'),
      );
    }
    return {
      state: 'complete',
      summary: plainSummary(result.summary, 'Circuit completed the run.'),
      final_report: {
        schema: `circuit.${result.flow_id}.result`,
        path: RESULT_PATH,
        sha256: createHash('sha256').update(resultBytes).digest('hex'),
        byte_length: resultBytes.byteLength,
        summary: plainSummary(result.summary, 'Circuit completed the run.'),
      },
    };
  }
}
