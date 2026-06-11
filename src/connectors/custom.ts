// Custom connector subprocess adapter.
//
// Custom connectors receive the prompt as a temp file and must write a JSON
// object to the configured output file. Stdout and stderr are diagnostic only;
// do not treat them as the durable relay result.
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CustomConnectorDescriptor } from '../schemas/connector.js';
import type { ConnectorRelayInput, RelayResult } from '../shared/connector-relay.js';
import { extractJsonObject } from '../shared/json-extraction.js';
import {
  type ConnectorSubprocessResult,
  cappedSuffix,
  isConnectorSubprocessSpawnError,
  runConnectorSubprocess,
  spawnErrorVerb,
} from './subprocess.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const SIGTERM_TO_SIGKILL_GRACE_MS = 2_000;
const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const STDOUT_MAX_BYTES = 16 * 1024 * 1024;
const STDERR_MAX_BYTES = 1024 * 1024;

export interface CustomRelayInput extends ConnectorRelayInput {
  readonly descriptor: CustomConnectorDescriptor;
}

async function extractConfiguredOutput(
  descriptor: CustomConnectorDescriptor,
  outputFile: string,
): Promise<{ readonly receiptId: string; readonly resultBody: string }> {
  const outputStats = await stat(outputFile);
  if (outputStats.size > OUTPUT_MAX_BYTES) {
    throw new Error(
      `custom connector '${descriptor.name}' output file exceeded ${OUTPUT_MAX_BYTES} bytes`,
    );
  }
  const raw = await readFile(outputFile, 'utf8');
  if (raw.trim().length === 0) {
    throw new Error(`custom connector '${descriptor.name}' output file was empty`);
  }
  return {
    receiptId: `custom:${descriptor.name}:${Date.now()}`,
    resultBody: extractJsonObject(raw),
  };
}

// The resolved selection crosses the subprocess boundary as environment
// variables, not argv: the custom command contract (authored argv + prompt
// file + output file) stays byte-identical for connectors that ignore the
// dial, and a wrapper that does honor it reads the variables it cares about.
// This is how a power tier reaches a local worker — `power_tiers.<name>`
// materializes a model the engine itself cannot run, and the wrapper maps
// CIRCUIT_RELAY_MODEL onto its CLI's model flag.
function selectionEnv(input: CustomRelayInput): Record<string, string> {
  const env: Record<string, string> = {};
  const model = input.resolvedSelection?.model;
  if (model !== undefined) {
    env.CIRCUIT_RELAY_MODEL = model.model;
    env.CIRCUIT_RELAY_MODEL_PROVIDER = model.provider;
  }
  const effort = input.resolvedSelection?.effort;
  if (effort !== undefined) {
    env.CIRCUIT_RELAY_EFFORT = effort;
  }
  return env;
}

export async function relayCustom(input: CustomRelayInput): Promise<RelayResult> {
  const { descriptor } = input;
  if (descriptor.prompt_transport !== 'prompt-file') {
    throw new Error(
      `custom connector '${descriptor.name}' prompt transport '${descriptor.prompt_transport}' is not implemented`,
    );
  }
  const [executable, ...baseArgs] = descriptor.command;
  if (executable === undefined) {
    throw new Error(`custom connector '${descriptor.name}' command is empty`);
  }
  const tempDir = await mkdtemp(join(tmpdir(), 'circuit-custom-connector-'));
  const promptFile = join(tempDir, 'prompt.txt');
  const outputFile = join(tempDir, 'output.txt');
  await writeFile(promptFile, input.prompt, 'utf8');
  const args = [...baseArgs, promptFile, outputFile];
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    let result: ConnectorSubprocessResult;
    try {
      result = await runConnectorSubprocess({
        executable,
        args,
        timeoutMs,
        stdoutMaxBytes: STDOUT_MAX_BYTES,
        stderrMaxBytes: STDERR_MAX_BYTES,
        sigtermToSigkillGraceMs: SIGTERM_TO_SIGKILL_GRACE_MS,
        env: { ...process.env, ...selectionEnv(input) },
      });
    } catch (error) {
      if (isConnectorSubprocessSpawnError(error)) {
        throw new Error(
          `custom connector '${descriptor.name}' ${spawnErrorVerb(error)}: ${error.message}`,
        );
      }
      throw error;
    }

    if (result.timedOut) {
      throw new Error(
        `custom connector '${descriptor.name}' timed out after ${timeoutMs}ms; group-kill ${result.killGroupSucceeded ? 'sent' : 'failed'}; final signal=${result.signal ?? 'none'}; stderr[:500]=${result.stderr.slice(0, 500)}`,
      );
    }
    if (result.code !== 0) {
      throw new Error(
        `custom connector '${descriptor.name}' exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ''}; stderr[:500]=${result.stderr.slice(0, 500)}`,
      );
    }
    try {
      const extracted = await extractConfiguredOutput(descriptor, outputFile);
      return {
        request_payload: input.prompt,
        receipt_id: extracted.receiptId,
        result_body: extracted.resultBody,
        duration_ms: result.durationMs,
        cli_version: `custom:${descriptor.name}`,
      };
    } catch (error) {
      const stdoutSuffix = cappedSuffix(result.stdoutCapped, 'stdout');
      const stderrSuffix = cappedSuffix(result.stderrCapped, 'stderr');
      throw new Error(
        `custom connector '${descriptor.name}': ${(error as Error).message}; stdout[:500]=${result.stdout.slice(0, 500)}${stdoutSuffix}; stderr[:200]=${result.stderr.slice(0, 200)}${stderrSuffix}`,
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
