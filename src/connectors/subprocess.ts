import { type ChildProcess, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export class ConnectorSubprocessSpawnError extends Error {
  constructor(
    readonly phase: 'spawn-failed' | 'spawn-error',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorSubprocessSpawnError';
  }
}

export function isConnectorSubprocessSpawnError(
  error: unknown,
): error is ConnectorSubprocessSpawnError {
  return (
    error instanceof ConnectorSubprocessSpawnError ||
    (error instanceof Error && error.name === 'ConnectorSubprocessSpawnError')
  );
}

// Which bound stopped a timed-out subprocess: 'idle' means it produced no
// output for the inactivity window; 'absolute' means it ran past the hard
// wall-clock ceiling regardless of activity.
export type ConnectorTimeoutKind = 'idle' | 'absolute';

export interface ConnectorSubprocessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutCapped: boolean;
  readonly stderrCapped: boolean;
  readonly timedOut: boolean;
  readonly timeoutKind?: ConnectorTimeoutKind;
  readonly killGroupSucceeded: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
}

export interface RunConnectorSubprocessInput {
  readonly executable: string;
  readonly args: readonly string[];
  // Hard wall-clock ceiling. Never reset; a runaway that keeps streaming is
  // still stopped here.
  readonly timeoutMs: number;
  // Optional inactivity ceiling. When set, the subprocess is stopped after this
  // many milliseconds with no stdout/stderr output; every chunk resets it. Left
  // undefined by connectors that want a pure wall-clock cap (custom, health).
  readonly idleTimeoutMs?: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  readonly sigtermToSigkillGraceMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface CreateTimeoutControllerInput {
  // Hard ceiling that never resets.
  readonly absoluteMs: number;
  // Inactivity ceiling, reset on every onActivity(). Omit for absolute-only.
  readonly idleMs?: number;
  // Invoked at most once, naming which bound elapsed first.
  readonly onFire: (kind: ConnectorTimeoutKind) => void;
}

export interface TimeoutController {
  // Call once after spawn (to arm the inactivity bound at t0) and again on every
  // chunk of output. A no-op once a bound has fired or clear() has run.
  readonly onActivity: () => void;
  // Cancel all pending bounds. Idempotent; safe after a fire.
  readonly clear: () => void;
}

// The two-bound timeout policy, factored out of the subprocess plumbing so the
// firing logic is unit-testable with fake timers and reviewable in isolation.
// The absolute bound is armed immediately and never reset. The inactivity bound
// (when idleMs is set) is armed on the first onActivity() and re-armed on each
// subsequent one; the earliest bound to elapse fires exactly once.
export function createTimeoutController(input: CreateTimeoutControllerInput): TimeoutController {
  let fired = false;
  let disposed = false;
  let idleTimer: NodeJS.Timeout | undefined;

  const fire = (kind: ConnectorTimeoutKind): void => {
    if (fired || disposed) return;
    fired = true;
    input.onFire(kind);
  };

  const absoluteTimer = setTimeout(() => fire('absolute'), input.absoluteMs);

  const onActivity = (): void => {
    if (fired || disposed || input.idleMs === undefined) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire('idle'), input.idleMs);
  };

  const clear = (): void => {
    disposed = true;
    clearTimeout(absoluteTimer);
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  return { onActivity, clear };
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
  if (remaining <= 0) {
    return { text: current, bytes: currentBytes, capped: true };
  }

  return {
    text: current + Buffer.from(chunk, 'utf8').subarray(0, remaining).toString('utf8'),
    bytes: maxBytes,
    capped: true,
  };
}

// Human-readable verb for a spawn failure, shared by every connector's
// `catch (error) { if (isConnectorSubprocessSpawnError(error)) ... }` block.
// `spawn-failed` is a synchronous throw from `spawn()`; `spawn-error` is an
// async `'error'` event (e.g. ENOENT surfaced after the call returned).
export function spawnErrorVerb(
  error: ConnectorSubprocessSpawnError,
): 'spawn failed' | 'spawn error' {
  return error.phase === 'spawn-failed' ? 'spawn failed' : 'spawn error';
}

// Trailing annotation appended to a stream sample when capture hit its byte
// cap, so a truncated tail in an error message is never mistaken for the
// stream's true end. `stream` names which stream the sample came from.
export function cappedSuffix(capped: boolean, stream: 'stdout' | 'stderr'): string {
  return capped ? ` [${stream} capped]` : '';
}

// Human-readable cause for a timed-out subprocess, naming which bound elapsed.
// Shared by the CLI-agent connectors so an operator reading a timeout error can
// tell an inactivity kill (the agent went silent — likely wedged) apart from a
// wall-clock kill (the agent kept working past the hard ceiling). Falls back to
// the absolute wording whenever the inactivity bound is not the cause, including
// the absolute-only connectors that pass no idleMs.
export function describeTimeout(
  result: Pick<ConnectorSubprocessResult, 'timeoutKind'>,
  bounds: { readonly idleMs?: number; readonly absoluteMs: number },
): string {
  if (result.timeoutKind === 'idle' && bounds.idleMs !== undefined) {
    return `no output for ${bounds.idleMs}ms (inactivity)`;
  }
  return `exceeded the ${bounds.absoluteMs}ms wall-clock backstop`;
}

// Split a connector's stdout into NDJSON objects: one JSON object per
// non-empty line. `label` prefixes per-line parse errors so callers can tell
// which stream failed (e.g. 'stream-json' for claude-code, 'codex --json' for
// codex). The empty-stdout guard stays in each connector because the exact
// wording is pinned by contract tests and varies per connector.
export function parseNdjsonObjects(stdout: string, label: string): Array<Record<string, unknown>> {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  const objects: Array<Record<string, unknown>> = [];
  for (const [idx, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `${label} line ${idx + 1} is not valid JSON: ${(err as Error).message}; line[:200]=${line.slice(0, 200)}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`${label} line ${idx + 1} is not a JSON object`);
    }
    objects.push(parsed as Record<string, unknown>);
  }
  return objects;
}

export async function runConnectorSubprocess(
  input: RunConnectorSubprocessInput,
): Promise<ConnectorSubprocessResult> {
  const start = performance.now();
  return await new Promise<ConnectorSubprocessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(input.executable, [...input.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: input.env ?? process.env,
        detached: true,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
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

    const killProcessGroup = (signal: NodeJS.Signals): boolean => {
      const pid = child.pid;
      if (typeof pid !== 'number') return false;
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        try {
          child.kill(signal);
          return true;
        } catch {
          return false;
        }
      }
    };

    // Escalation timer scheduled after the first SIGTERM; owned here (not by the
    // controller) because it is part of the kill, not the timeout decision.
    let killGraceTimer: NodeJS.Timeout | undefined;
    const controller = createTimeoutController({
      absoluteMs: input.timeoutMs,
      ...(input.idleTimeoutMs === undefined ? {} : { idleMs: input.idleTimeoutMs }),
      onFire: (kind) => {
        timedOut = true;
        timeoutKind = kind;
        killGroupSucceeded = killProcessGroup('SIGTERM');
        killGraceTimer = setTimeout(() => {
          killProcessGroup('SIGKILL');
          killGraceTimer = undefined;
        }, input.sigtermToSigkillGraceMs);
      },
    });
    // Arm the inactivity bound at spawn so a child that never emits anything is
    // still caught (a process silent from t0 is the clearest hang there is).
    controller.onActivity();

    const clearAllTimers = () => {
      controller.clear();
      if (killGraceTimer !== undefined) {
        clearTimeout(killGraceTimer);
        killGraceTimer = undefined;
      }
    };

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
      clearAllTimers();
      reject(new ConnectorSubprocessSpawnError('spawn-error', error.message));
    });
    child.on('close', (code, signal) => {
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
    });
  });
}
