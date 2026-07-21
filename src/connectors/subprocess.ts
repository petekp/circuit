import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

import { stateDirUnwritableSummary } from './state-dir.js';

export class ConnectorSubprocessSpawnError extends Error {
  constructor(
    readonly phase: 'spawn-failed' | 'spawn-error',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorSubprocessSpawnError';
  }
}

export class ConnectorSubprocessCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorSubprocessCleanupError';
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
  readonly cancelled?: boolean;
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
  /** Experiment-only cooperative cancellation marker owned by the MCP host. */
  readonly cancelFile?: string;
  readonly cancelPollMs?: number;
  /**
   * Experiment-only sealed MCP boundary. A completed worker must not leave
   * members of its freshly-created process group running between flow steps.
   */
  readonly requireEmptyProcessGroupOnExit?: boolean;
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
    return `no output for ${bounds.idleMs}ms (inactivity; a step that legitimately goes silent longer can raise budgets.inactivity_ms)`;
  }
  return `exceeded the ${bounds.absoluteMs}ms wall-clock backstop`;
}

// ---------------------------------------------------------------------------
// Launch-failure interpreter, shared by the CLI-agent connectors
// (claude-code, codex, cursor-agent). When a connector CLI dies at launch, the
// raw evidence — a Node spawn error, a stderr storm, a stream error buried at
// the end of stdout — is illegible on its own. These helpers turn the known
// failure classes into ONE plain sentence that leads the relay error: what
// happened, whose fault it is, and what to do next. The raw detail always
// stays AFTER the plain sentence (truncated), never instead of it.
// ---------------------------------------------------------------------------

// Sign-in failure wording observed across the three CLIs (claude prints
// "Not logged in - Please run /login"; codex and cursor-agent print variants
// of "not logged in"). Kept in step with the doctor-side pattern in
// health.ts (which subprocess.ts cannot import without a cycle).
const SIGNED_OUT_OUTPUT_PATTERN =
  /not logged in|logged out|unauthenticated|login required|not signed in|sign in required|please run \/login|invalid api key/i;

const SANDBOX_DENIAL_PATTERN = /operation not permitted/gi;
// A single "Operation not permitted" can be an app-level detail; a repeated
// storm of them is the signature of a sandboxed launch (observed 10x in one
// codex run, drowning the actual failure). The threshold stays at 3: the
// scanned text includes stdout and stream errors, which carry agent-written
// conversation content, so a lower bar risks misdiagnosing a task that merely
// talks about permission errors. Runs sandboxed too tightly to reach 3 are
// covered by the state-db signature below instead.
const SANDBOX_DENIAL_MIN_COUNT = 3;

// The signature of a worker CLI that launched but could not write its
// out-of-project state directory (codex: `~/.codex/state_5.sqlite`), the
// canonical failure of running Circuit inside a sandboxed host session that
// only allows project writes. Matched against STDERR ONLY: stdout is
// conversation content, and a task about sqlite could echo these words.
const STATE_DB_READONLY_PATTERN = /failed to open state db|attempt to write a read-?only database/i;
// Where the state directory is, parsed from the CLI's own report. The runtime
// line names the directory; the db line names the sqlite file inside it.
const STATE_RUNTIME_DIR_PATTERN = /failed to initialize state runtime at ([^:\n]+):/i;
const STATE_DB_FILE_PATTERN = /state db at (\S+?):/i;

const STREAM_ERROR_MESSAGE_MAX_CHARS = 400;

// One plain sentence for a subprocess that never launched (spawn threw or the
// CLI's --version shellout failed). `errorText` is the raw error message the
// failure produced; it is only pattern-matched here — callers keep it in the
// detail section of their error.
export function launchFailureSummary(cli: string, errorText: string): string {
  if (errorText.includes('ENOENT')) {
    return `The ${cli} CLI is not installed or not on your PATH (spawn ENOENT). Run \`circuit doctor\` to check connector health.`;
  }
  if (errorText.includes('EACCES')) {
    return `The ${cli} CLI was found but cannot be executed (EACCES). Fix its file permissions, or run \`circuit doctor\` to check connector health.`;
  }
  return `The ${cli} CLI failed to start. Run \`circuit doctor\` to check connector health.`;
}

export interface ConnectorFailureSummaryInput {
  // Executable name as the operator knows it: 'claude', 'codex', 'cursor-agent'.
  readonly cli: string;
  // Connector-specific sign-in instruction, e.g. 'Run `codex login` to sign in'.
  readonly signInHint: string;
  readonly stderr: string;
  // Scanned for sign-in wording only where the CLI reports failures on stdout
  // as plain text (cursor-agent). Pass '' for stream-JSON connectors — their
  // stdout is conversation content and would false-positive.
  readonly stdout: string;
  // The last error-typed stream event extracted from stdout (see
  // lastStreamErrorMessage), when the connector has a structured stream.
  readonly streamError: string | undefined;
}

// One plain sentence for a CLI that launched and then failed, classified from
// its captured output. Returns undefined when nothing recognizable matched —
// callers then fall back to their existing raw-detail error.
export function connectorFailureSummary(input: ConnectorFailureSummaryInput): string | undefined {
  const scanned = `${input.stderr}\n${input.stdout}\n${input.streamError ?? ''}`;
  if (SIGNED_OUT_OUTPUT_PATTERN.test(scanned)) {
    return `The ${input.cli} CLI is not logged in. ${input.signInHint}, or run \`circuit doctor\` to check connector health.`;
  }
  if (STATE_DB_READONLY_PATTERN.test(input.stderr)) {
    // Checked before the denial-storm branch: this diagnosis is more specific
    // (it names the directory and the setup fix), and the observed failure
    // produces too few denial lines to trip the storm threshold anyway.
    const stateDir =
      input.stderr.match(STATE_RUNTIME_DIR_PATTERN)?.[1]?.trim() ??
      parentOfPath(input.stderr.match(STATE_DB_FILE_PATTERN)?.[1]);
    return `${stateDirUnwritableSummary(input.cli, stateDir)} Run \`circuit doctor\` to check connector health.`;
  }
  const denialCount = (scanned.match(SANDBOX_DENIAL_PATTERN) ?? []).length;
  if (denialCount >= SANDBOX_DENIAL_MIN_COUNT) {
    // The storm itself is noise; the real failure is usually the last stderr
    // line that is NOT part of it. Surface that line so it stops drowning.
    const realFailure = lastLineWithout(input.stderr, /operation not permitted/i);
    const lastErrorClause =
      realFailure === undefined ? '' : ` Last error: ${JSON.stringify(realFailure)}.`;
    return `The ${input.cli} CLI was blocked by this machine's sandbox (${denialCount} "Operation not permitted" errors).${lastErrorClause} Rerun outside the sandbox that is blocking it, or run \`circuit doctor\` to check connector health.`;
  }
  if (input.streamError !== undefined) {
    const trimmed = input.streamError.trim();
    return `The ${input.cli} CLI reported an error: ${trimmed}${trimmed.endsWith('.') ? '' : '.'}`;
  }
  return undefined;
}

function parentOfPath(path: string | undefined): string | undefined {
  return path === undefined ? undefined : dirname(path);
}

function lastLineWithout(text: string, exclude: RegExp): string | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] as string).trim();
    if (line.length > 0 && !exclude.test(line)) return line;
  }
  return undefined;
}

// Scan a captured stream-JSON stdout for the LAST error-typed event and return
// its human message. A failed relay puts the real failure near the END of the
// stream (the head is the init handshake), so an error built from the head
// alone cuts the diagnosis off. Tolerant by design: lines that fail to parse
// are skipped rather than aborting the scan — a partial stream must still give
// up its terminal error. Covers the claude-code shapes (type:'error', an
// `error` field, a result flagged is_error) and the codex shapes (type:'error',
// type:'turn.failed', a nested error item).
export function lastStreamErrorMessage(stdout: string): string | undefined {
  let found: string | undefined;
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const message = streamErrorMessageFrom(parsed as Record<string, unknown>);
    if (message !== undefined) found = message;
  }
  return found === undefined ? undefined : found.slice(0, STREAM_ERROR_MESSAGE_MAX_CHARS);
}

function streamErrorMessageFrom(entry: Record<string, unknown>): string | undefined {
  // codex nested error item: {type:'item.completed', item:{type:'error', message}}.
  const item = entry.item;
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type === 'error') {
      return typeof itemRecord.message === 'string' && itemRecord.message.length > 0
        ? itemRecord.message
        : JSON.stringify(itemRecord).slice(0, STREAM_ERROR_MESSAGE_MAX_CHARS);
    }
  }
  const errorField = entry.error === null ? undefined : entry.error;
  const errorTyped = entry.type === 'error' || entry.type === 'turn.failed';
  const errorResult = entry.is_error === true;
  if (!errorTyped && !errorResult && errorField === undefined) return undefined;
  if (typeof entry.message === 'string' && entry.message.length > 0) return entry.message;
  if (typeof entry.result === 'string' && entry.result.length > 0) return entry.result;
  if (typeof errorField === 'string' && errorField.length > 0) return errorField;
  if (typeof errorField === 'object' && errorField !== null && !Array.isArray(errorField)) {
    const nested = (errorField as Record<string, unknown>).message;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  if (errorTyped || errorResult) {
    return JSON.stringify(entry).slice(0, STREAM_ERROR_MESSAGE_MAX_CHARS);
  }
  // An inert `error` field with no readable message is not clearly an error
  // event; claiming it would put noise ahead of real diagnostics.
  return undefined;
}

// Collapse consecutive identical lines into one line plus a repeat marker, so
// a warning storm (the observed codex sandbox case: the same WARN line 10x)
// cannot push the real failure past a truncation cap. Runs of blank lines
// collapse silently to one.
export function condenseRepeatedLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j += 1;
    const count = j - i;
    if (count > 1) {
      out.push(line.trim().length === 0 ? line : `${line} [repeated ${count} times]`);
    } else {
      out.push(line);
    }
    i = j;
  }
  return out.join('\n');
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
  if (input.cancelFile !== undefined && !isAbsolute(input.cancelFile)) {
    throw new Error('Connector cancelFile must be absolute.');
  }
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
    let cancelled = false;
    let timeoutKind: ConnectorTimeoutKind | undefined;
    let killGroupSucceeded = false;

    // Kill the whole process group, falling back to the direct child if the
    // group signal is refused (the child already died and took the group with
    // it, or the platform rejects group signals). Known limit: if BOTH kills
    // fail, this returns false and the worker may be left running as an
    // orphan — the timeout message's 'group-kill failed' marker is the only
    // signal. There is no safe third option from this process: retrying
    // signals a possibly-reused pid, so the honest move is to report and
    // move on.
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

    type ProcessGroupState = 'absent' | 'present' | 'unknown';
    const processGroupState = (): ProcessGroupState => {
      const pid = child.pid;
      if (typeof pid !== 'number') return 'unknown';
      try {
        process.kill(-pid, 0);
        return 'present';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown';
      }
    };

    const waitForEmptyProcessGroup = async (timeoutMs: number): Promise<ProcessGroupState> => {
      const deadline = performance.now() + timeoutMs;
      let state = processGroupState();
      while (state !== 'absent' && performance.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        state = processGroupState();
      }
      return state;
    };

    const cleanCompletedProcessGroup = async (): Promise<boolean> => {
      const initialState = processGroupState();
      if (initialState === 'absent') return true;

      killGroupSucceeded = killProcessGroup('SIGTERM') || killGroupSucceeded;
      const afterTerm = await waitForEmptyProcessGroup(input.sigtermToSigkillGraceMs);
      if (afterTerm === 'absent') return true;

      killGroupSucceeded = killProcessGroup('SIGKILL') || killGroupSucceeded;
      return (await waitForEmptyProcessGroup(1_000)) === 'absent';
    };

    // Escalation timer scheduled after the first SIGTERM; owned here (not by the
    // controller) because it is part of the kill, not the timeout decision.
    let killGraceTimer: NodeJS.Timeout | undefined;
    const stopChild = (kind: 'timeout' | 'cancel', timeout?: ConnectorTimeoutKind): void => {
      if (timedOut || cancelled) return;
      if (kind === 'timeout') {
        timedOut = true;
        timeoutKind = timeout;
      } else {
        cancelled = true;
      }
      killGroupSucceeded = killProcessGroup('SIGTERM');
      killGraceTimer = setTimeout(() => {
        killProcessGroup('SIGKILL');
        killGraceTimer = undefined;
      }, input.sigtermToSigkillGraceMs);
    };
    const controller = createTimeoutController({
      absoluteMs: input.timeoutMs,
      ...(input.idleTimeoutMs === undefined ? {} : { idleMs: input.idleTimeoutMs }),
      onFire: (kind) => stopChild('timeout', kind),
    });
    // Arm the inactivity bound at spawn so a child that never emits anything is
    // still caught (a process silent from t0 is the clearest hang there is).
    controller.onActivity();

    const cancelPoll =
      input.cancelFile === undefined
        ? undefined
        : setInterval(() => {
            if (existsSync(input.cancelFile as string)) stopChild('cancel');
          }, input.cancelPollMs ?? 100);

    const clearDecisionTimers = () => {
      controller.clear();
      if (cancelPoll !== undefined) clearInterval(cancelPoll);
    };

    const clearAllTimers = () => {
      clearDecisionTimers();
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
      clearDecisionTimers();
      // The direct CLI can close before one of its children. Finish the group
      // kill immediately while this freshly-created process-group id still
      // belongs to this launch; cancelling the grace timer here used to leave
      // such children behind.
      if (timedOut || cancelled) {
        killGroupSucceeded = killProcessGroup('SIGKILL') || killGroupSucceeded;
      }
      if (killGraceTimer !== undefined) {
        clearTimeout(killGraceTimer);
        killGraceTimer = undefined;
      }
      void (async () => {
        if (
          input.requireEmptyProcessGroupOnExit === true &&
          !timedOut &&
          !cancelled &&
          !(await cleanCompletedProcessGroup())
        ) {
          reject(
            new ConnectorSubprocessCleanupError(
              'Connector subprocess exited, but Circuit could not confirm that all of its background processes stopped.',
            ),
          );
          return;
        }
        resolve({
          stdout,
          stderr,
          stdoutCapped,
          stderrCapped,
          timedOut,
          cancelled,
          ...(timeoutKind === undefined ? {} : { timeoutKind }),
          killGroupSucceeded,
          code,
          signal,
          durationMs: performance.now() - start,
        });
      })().catch(reject);
    });
  });
}
