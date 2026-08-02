import { CLAUDE_CODE_EXECUTABLE } from './claude-code.js';
import { CODEX_EXECUTABLE } from './codex.js';
import { CURSOR_AGENT_EXECUTABLE } from './cursor-agent.js';
import { type BuiltinConnectorName, connectorRemediation } from './remediation.js';
import { isConnectorSubprocessSpawnError, runConnectorSubprocess } from './subprocess.js';

// Connector health probes. A run that relays through a broken or signed-out
// connector CLI dies mid-flight, after real spend on the branches that were
// healthy. These probes ask the same binaries a run would spawn — a version
// call for presence, a status call for sign-in where the CLI has one — and
// classify what came back into plain English with a fix. Classification is
// pure; only `probeBuiltinConnector` touches the system.

export type ProbeOutcome =
  | { readonly kind: 'spawn_error'; readonly message: string }
  | {
      readonly kind: 'ran';
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly timedOut: boolean;
    };

export interface ConnectorHealthCheck {
  // A builtin connector name for the three probes below; a routed custom
  // connector's config-declared name for `probeCustomConnectorPresence`.
  readonly connector: string;
  readonly executable: string;
  readonly state: 'ok' | 'needs_attention' | 'unknown';
  readonly detail: string;
  readonly remediation?: string;
}

interface HealthProbeSpec {
  readonly executable: string;
  readonly presenceArgs: readonly string[];
  readonly authArgs?: readonly string[];
  // What the operator types to fix a signed-out CLI. Only meaningful for a
  // connector that has an `authArgs` probe: without one, nothing here ever
  // gets to claim the CLI is signed out.
  readonly signInCommand?: string;
}

// Probe commands verified against the real CLIs (2026-07-04, re-timed
// 2026-08-02): all three answer `--version` on exit 0; `codex login status`
// (~240ms) and `cursor-agent status` (~1.3s) answer sign-in state on exit 0.
// claude-code has no cheap offline sign-in probe, so presence is its whole
// check and no caller may imply its sign-in state was verified.
const HEALTH_PROBE_SPECS: Record<BuiltinConnectorName, HealthProbeSpec> = {
  'claude-code': { executable: CLAUDE_CODE_EXECUTABLE, presenceArgs: ['--version'] },
  codex: {
    executable: CODEX_EXECUTABLE,
    presenceArgs: ['--version'],
    authArgs: ['login', 'status'],
    signInCommand: 'codex login',
  },
  'cursor-agent': {
    executable: CURSOR_AGENT_EXECUTABLE,
    presenceArgs: ['--version'],
    authArgs: ['status'],
    signInCommand: 'cursor-agent login',
  },
};

export const BUILTIN_CONNECTOR_NAMES: readonly BuiltinConnectorName[] = [
  'claude-code',
  'codex',
  'cursor-agent',
];

const SIGNED_OUT_PATTERN =
  /not logged in|logged out|unauthenticated|login required|not signed in|sign in required/i;

// The first thing the probe said, or nothing at all when it never ran. Taking
// the whole ProbeOutcome rather than a {stdout, stderr} shape keeps callers
// from having to prove the probe ran before they can quote it.
export function probeFirstLine(outcome: ProbeOutcome): string {
  if (outcome.kind !== 'ran') return '';
  const text = outcome.stdout.trim().length > 0 ? outcome.stdout : outcome.stderr;
  return text.trim().split('\n')[0]?.trim() ?? '';
}

/**
 * Did a sign-in probe give positive evidence that the CLI is signed out?
 *
 * Only a probe that ran to completion can answer. A probe that could not
 * start, or ran out of time, is "could not check" and must never be reported
 * as signed out: the CLIs are the ones that occasionally lie in this
 * direction, so intake and doctor both need the absence of an answer to stay
 * an absence.
 *
 * Doctor and the run-intake preflight share this so the two can never drift
 * into disagreeing about what a signed-out CLI looks like.
 */
export function probeReportsSignedOut(outcome: ProbeOutcome): boolean {
  if (outcome.kind !== 'ran' || outcome.timedOut) return false;
  return outcome.code !== 0 || SIGNED_OUT_PATTERN.test(`${outcome.stdout}\n${outcome.stderr}`);
}

/**
 * What to type to sign this CLI back in, or undefined for a connector with no
 * cheap offline sign-in probe. Undefined is load-bearing: it is how a caller
 * knows it has no business saying anything about that CLI's sign-in state.
 */
export function builtinConnectorSignInCommand(connector: BuiltinConnectorName): string | undefined {
  return HEALTH_PROBE_SPECS[connector].signInCommand;
}

export function classifyConnectorHealth(input: {
  readonly connector: BuiltinConnectorName;
  readonly executable: string;
  readonly presence: ProbeOutcome;
  readonly auth?: ProbeOutcome;
}): ConnectorHealthCheck {
  const remediation = connectorRemediation(input.connector);
  const base = { connector: input.connector, executable: input.executable };

  if (input.presence.kind === 'spawn_error') {
    return {
      ...base,
      state: 'needs_attention',
      detail: `the '${input.executable}' command was not found or could not start (${input.presence.message})`,
      remediation,
    };
  }
  if (input.presence.timedOut) {
    return {
      ...base,
      state: 'unknown',
      detail: `could not check: ${input.executable} --version timed out`,
    };
  }
  if (input.presence.code !== 0) {
    const line = probeFirstLine(input.presence);
    return {
      ...base,
      state: 'needs_attention',
      detail: `${input.executable} --version exited with code ${input.presence.code}${line === '' ? '' : `: ${line}`}`,
      remediation,
    };
  }

  const version = probeFirstLine(input.presence);
  if (input.auth === undefined) {
    return { ...base, state: 'ok', detail: version };
  }
  if (input.auth.kind === 'spawn_error') {
    return {
      ...base,
      state: 'needs_attention',
      detail: `${version}; sign-in check could not start (${input.auth.message})`,
      remediation,
    };
  }
  if (input.auth.timedOut) {
    return {
      ...base,
      state: 'unknown',
      detail: `${version}; could not check sign-in state (timed out)`,
    };
  }
  const authLine = probeFirstLine(input.auth);
  if (probeReportsSignedOut(input.auth)) {
    return {
      ...base,
      state: 'needs_attention',
      detail: `${version}; installed but may need sign-in${authLine === '' ? '' : ` (${authLine})`}`,
      remediation,
    };
  }
  return {
    ...base,
    state: 'ok',
    detail: authLine === '' ? version : `${version}; ${authLine}`,
  };
}

// A doctor probe runs `<cli> --version`-class commands, which answer in well
// under a second on a healthy install; 10s absorbs a cold start without
// letting `circuit doctor` hang on a wedged CLI. A connector that is healthy
// but slower than this reports unhealthy — rerunning doctor is the cheap
// retry.
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_OUTPUT_MAX_BYTES = 16_384;

async function runProbe(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  try {
    const result = await runConnectorSubprocess({
      executable,
      args,
      timeoutMs,
      stdoutMaxBytes: PROBE_OUTPUT_MAX_BYTES,
      stderrMaxBytes: PROBE_OUTPUT_MAX_BYTES,
      sigtermToSigkillGraceMs: 2_000,
      env,
    });
    return {
      kind: 'ran',
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  } catch (error) {
    if (isConnectorSubprocessSpawnError(error)) {
      return { kind: 'spawn_error', message: error.message };
    }
    throw error;
  }
}

export function builtinConnectorExecutable(connector: BuiltinConnectorName): string {
  return HEALTH_PROBE_SPECS[connector].executable;
}

// Presence only: does the binary answer `--version`? Run-intake preflight runs
// this first and only asks about sign-in for a binary that answered.
export async function probeBuiltinConnectorPresence(
  connector: BuiltinConnectorName,
  options?: { readonly env?: NodeJS.ProcessEnv },
): Promise<ProbeOutcome> {
  const spec = HEALTH_PROBE_SPECS[connector];
  return await runProbe(spec.executable, spec.presenceArgs, options?.env ?? process.env);
}

// Run intake is a person waiting at a prompt, so its sign-in probe gets a
// tighter budget than doctor's: the real commands answer in 0.24s (codex) and
// 1.3s (cursor-agent), and a CLI slower than this is reported as "could not
// check" rather than holding up the run it was supposed to protect.
export const INTAKE_SIGN_IN_PROBE_TIMEOUT_MS = 5_000;

/**
 * Ask a CLI whether it is signed in, or answer undefined for a connector that
 * has no cheap offline way to say (claude-code). Undefined means the question
 * was never asked, which is different from an answer of "signed in" and must
 * not be flattened into one.
 */
export async function probeBuiltinConnectorSignIn(
  connector: BuiltinConnectorName,
  options?: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number },
): Promise<ProbeOutcome | undefined> {
  const spec = HEALTH_PROBE_SPECS[connector];
  if (spec.authArgs === undefined) return undefined;
  return await runProbe(
    spec.executable,
    spec.authArgs,
    options?.env ?? process.env,
    options?.timeoutMs,
  );
}

export async function probeBuiltinConnector(
  connector: BuiltinConnectorName,
  options?: { readonly env?: NodeJS.ProcessEnv },
): Promise<ConnectorHealthCheck> {
  const spec = HEALTH_PROBE_SPECS[connector];
  const env = options?.env ?? process.env;
  const presence = await runProbe(spec.executable, spec.presenceArgs, env);
  // The sign-in probe only makes sense once the binary itself answered.
  const auth =
    spec.authArgs !== undefined && presence.kind === 'ran' && presence.code === 0
      ? await runProbe(spec.executable, spec.authArgs, env)
      : undefined;
  return classifyConnectorHealth({
    connector,
    executable: spec.executable,
    presence,
    ...(auth === undefined ? {} : { auth }),
  });
}

export async function probeBuiltinConnectors(options?: {
  readonly env?: NodeJS.ProcessEnv;
}): Promise<ConnectorHealthCheck[]> {
  return await Promise.all(
    BUILTIN_CONNECTOR_NAMES.map((name) => probeBuiltinConnector(name, options)),
  );
}

// A routed custom connector has no scripted sign-in probe (its command is
// arbitrary, config-declared), so this checks only that its executable can
// start — a presence probe, not a health probe. Sign-in state always reports
// `unknown` ("could not check"): a successful spawn confirms the binary
// exists, not that it is signed in.
export async function probeCustomConnectorPresence(
  connector: string,
  executable: string,
  options?: { readonly env?: NodeJS.ProcessEnv },
): Promise<ConnectorHealthCheck> {
  const presence = await runProbe(executable, [], options?.env ?? process.env);
  if (presence.kind === 'spawn_error') {
    return {
      connector,
      executable,
      state: 'needs_attention',
      detail: `the '${executable}' command was not found or could not start (${presence.message})`,
      remediation: `Fix: check that '${executable}' is installed and on PATH.`,
    };
  }
  return {
    connector,
    executable,
    state: 'unknown',
    detail: 'could not check: custom connectors have no scripted sign-in probe',
  };
}
