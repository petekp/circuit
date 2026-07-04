import { execFileSync } from 'node:child_process';
import { CURSOR_AGENT_SUPPORTED_EFFORTS } from '../schemas/connector.js';
import type { Effort } from '../schemas/selection-policy.js';
import type { ResolvedSelection } from '../schemas/selection-policy.js';
import {
  type ConnectorRelayInput,
  type RelayResult,
  sha256Hex,
} from '../shared/connector-relay.js';
import { extractJsonObject } from '../shared/json-extraction.js';
import { connectorRemediation } from './remediation.js';
import {
  type ConnectorSubprocessResult,
  cappedSuffix,
  isConnectorSubprocessSpawnError,
  runConnectorSubprocess,
  spawnErrorVerb,
} from './subprocess.js';

export const CURSOR_AGENT_EXECUTABLE = 'cursor-agent';
// Re-exported from the built-in connector registry (the single source of
// truth); kept under this name for the connector's own effort guard and for
// call sites bound to the cursor-agent connector.
export { CURSOR_AGENT_SUPPORTED_EFFORTS };
export const CURSOR_AGENT_DISPATCH_FLAGS = Object.freeze([
  '--print',
  '--output-format',
  'text',
  '--trust',
  '--force',
] as const);

const DEFAULT_TIMEOUT_MS = 600_000;
const SIGTERM_TO_SIGKILL_GRACE_MS = 2_000;
const STDOUT_MAX_BYTES = 16 * 1024 * 1024;
const STDERR_MAX_BYTES = 1024 * 1024;
const VERSION_CAPTURE_TIMEOUT_MS = 5_000;

export interface CursorAgentRelayInput extends ConnectorRelayInput {}

let cachedCursorAgentVersion: string | undefined;
function captureCursorAgentVersion(): string {
  if (cachedCursorAgentVersion !== undefined) return cachedCursorAgentVersion;
  let stdout: string;
  try {
    stdout = execFileSync(CURSOR_AGENT_EXECUTABLE, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_CAPTURE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(`cursor-agent --version failed: ${(err as Error).message}`);
  }
  const version = stdout.trim();
  if (version.length === 0) {
    throw new Error('cursor-agent --version produced empty output');
  }
  cachedCursorAgentVersion = version;
  return version;
}

function selectedGeminiModel(selection: ResolvedSelection | undefined): string | undefined {
  const model = selection?.model;
  if (model === undefined) return undefined;
  if (model.provider !== 'gemini') {
    throw new Error(
      `cursor-agent connector cannot honor model provider '${model.provider}' for model '${model.model}'; expected provider 'gemini'`,
    );
  }
  return model.model;
}

function assertCursorAgentEffort(
  effort: Effort,
): asserts effort is (typeof CURSOR_AGENT_SUPPORTED_EFFORTS)[number] {
  if (!(CURSOR_AGENT_SUPPORTED_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(
      `cursor-agent connector cannot honor effort '${effort}'; supported efforts: ${CURSOR_AGENT_SUPPORTED_EFFORTS.join(', ')}`,
    );
  }
}

export function buildCursorAgentArgs(input: CursorAgentRelayInput): string[] {
  const args: string[] = [...CURSOR_AGENT_DISPATCH_FLAGS];
  const model = selectedGeminiModel(input.resolvedSelection);
  if (model !== undefined) {
    args.push('--model', model);
  }
  const effort = input.resolvedSelection?.effort;
  if (effort !== undefined) {
    assertCursorAgentEffort(effort);
  }
  if (input.cwd !== undefined) {
    args.push('--workspace', input.cwd);
  }
  args.push(input.prompt);
  return args;
}

export async function relayCursorAgent(input: CursorAgentRelayInput): Promise<RelayResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cliVersion = captureCursorAgentVersion();
  const args = buildCursorAgentArgs(input);
  let result: ConnectorSubprocessResult;
  try {
    result = await runConnectorSubprocess({
      executable: CURSOR_AGENT_EXECUTABLE,
      args,
      timeoutMs,
      stdoutMaxBytes: STDOUT_MAX_BYTES,
      stderrMaxBytes: STDERR_MAX_BYTES,
      sigtermToSigkillGraceMs: SIGTERM_TO_SIGKILL_GRACE_MS,
      env: process.env,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });
  } catch (error) {
    if (isConnectorSubprocessSpawnError(error)) {
      throw new Error(
        `cursor-agent subprocess ${spawnErrorVerb(error)}: ${error.message}. ${connectorRemediation('cursor-agent')}`,
      );
    }
    throw error;
  }
  if (result.timedOut) {
    const stdoutSuffix = cappedSuffix(result.stdoutCapped, 'stdout');
    const stderrSuffix = cappedSuffix(result.stderrCapped, 'stderr');
    throw new Error(
      `cursor-agent subprocess timed out after ${timeoutMs}ms; group-kill ${result.killGroupSucceeded ? 'sent' : 'failed'}; final signal=${result.signal ?? 'none'}; stdout[:500]=${result.stdout.slice(0, 500)}${stdoutSuffix}; stderr[:500]=${result.stderr.slice(0, 500)}${stderrSuffix}`,
    );
  }
  if (result.code !== 0) {
    const stdoutSuffix = cappedSuffix(result.stdoutCapped, 'stdout');
    const stderrSuffix = cappedSuffix(result.stderrCapped, 'stderr');
    throw new Error(
      `cursor-agent subprocess exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ''}; stdout[:500]=${result.stdout.slice(0, 500)}${stdoutSuffix}; stderr[:500]=${result.stderr.slice(0, 500)}${stderrSuffix}`,
    );
  }
  if (result.stdoutCapped) {
    throw new Error(
      `cursor-agent subprocess stdout exceeded ${STDOUT_MAX_BYTES} bytes; connector output cannot be evaluated on truncated stream`,
    );
  }

  const resultBodyRaw = result.stdout.trim();
  if (resultBodyRaw.length === 0) {
    throw new Error('cursor-agent stdout is empty');
  }
  return {
    request_payload: input.prompt,
    receipt_id: sha256Hex(resultBodyRaw),
    result_body: extractJsonObject(resultBodyRaw),
    duration_ms: result.durationMs,
    cli_version: cliVersion,
  };
}
