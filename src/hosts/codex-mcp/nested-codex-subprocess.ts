import { type ChildProcess, spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  type ConnectorSubprocessResult,
  ConnectorSubprocessSpawnError,
  type ConnectorTimeoutKind,
  createTimeoutController,
} from '../../connectors/subprocess.js';

export interface RunMcpCodexSubprocessInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly idleTimeoutMs?: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  readonly sigtermToSigkillGraceMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

function appendCapped(
  current: string,
  currentBytes: number,
  chunk: string,
  maxBytes: number,
): { readonly text: string; readonly bytes: number; readonly capped: boolean } {
  const chunkBytes = Buffer.byteLength(chunk, 'utf8');
  if (currentBytes + chunkBytes <= maxBytes) {
    return { text: current + chunk, bytes: currentBytes + chunkBytes, capped: false };
  }

  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) return { text: current, bytes: currentBytes, capped: true };
  return {
    text: current + Buffer.from(chunk, 'utf8').subarray(0, remaining).toString('utf8'),
    bytes: maxBytes,
    capped: true,
  };
}

/**
 * Runs only the sealed native Codex executable used by the MCP worker.
 *
 * The child stays inside the private process group owned by the MCP supervisor.
 * On a timeout this layer signals only that direct child. The supervisor remains
 * responsible for observing and cleaning the complete process group after the
 * worker exits.
 */
export async function runMcpCodexSubprocess(
  input: RunMcpCodexSubprocessInput,
): Promise<ConnectorSubprocessResult> {
  if (!isAbsolute(input.executable) || !isAbsolute(input.cwd)) {
    throw new ConnectorSubprocessSpawnError(
      'spawn-failed',
      'The sealed Codex executable and workspace must use absolute paths.',
    );
  }

  const start = performance.now();
  return await new Promise<ConnectorSubprocessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(input.executable, [...input.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: input.env,
        detached: false,
        cwd: input.cwd,
      });
    } catch (error) {
      reject(
        new ConnectorSubprocessSpawnError(
          'spawn-failed',
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }

    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let stderrBytes = 0;
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;
    let timeoutKind: ConnectorTimeoutKind | undefined;
    let killGroupSucceeded = false;
    let killGraceTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const signalDirectChild = (signal: NodeJS.Signals): boolean => {
      if (typeof child.pid !== 'number') return false;
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    };

    const controller = createTimeoutController({
      absoluteMs: input.timeoutMs,
      ...(input.idleTimeoutMs === undefined ? {} : { idleMs: input.idleTimeoutMs }),
      onFire: (kind) => {
        timedOut = true;
        timeoutKind = kind;
        killGroupSucceeded = signalDirectChild('SIGTERM');
        killGraceTimer = setTimeout(() => {
          signalDirectChild('SIGKILL');
          killGraceTimer = undefined;
        }, input.sigtermToSigkillGraceMs);

        // The direct child may have already exited while one of its descendants
        // still owns an inherited pipe. Waiting for `close` would then hang this
        // worker even though the supervisor can clean that descendant safely.
        if (child.exitCode !== null || child.signalCode !== null) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle(child.exitCode, child.signalCode);
        }
      },
    });

    const clearAllTimers = (): void => {
      controller.clear();
      if (killGraceTimer !== undefined) {
        clearTimeout(killGraceTimer);
        killGraceTimer = undefined;
      }
    };

    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      resolve({
        stdout,
        stderr,
        stdoutCapped,
        stderrCapped,
        timedOut,
        ...(timeoutKind === undefined ? {} : { timeoutKind }),
        killGroupSucceeded,
        code,
        signal,
        durationMs: performance.now() - start,
      });
    };

    controller.onActivity();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      controller.onActivity();
      const next = appendCapped(stdout, stdoutBytes, chunk, input.stdoutMaxBytes);
      stdout = next.text;
      stdoutBytes = next.bytes;
      stdoutCapped = stdoutCapped || next.capped;
    });
    child.stderr?.on('data', (chunk: string) => {
      controller.onActivity();
      const next = appendCapped(stderr, stderrBytes, chunk, input.stderrMaxBytes);
      stderr = next.text;
      stderrBytes = next.bytes;
      stderrCapped = stderrCapped || next.capped;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      reject(new ConnectorSubprocessSpawnError('spawn-error', error.message));
    });
    child.on('exit', (code, signal) => {
      if (!timedOut) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(code, signal);
    });
    child.on('close', (code, signal) => settle(code, signal));
  });
}
