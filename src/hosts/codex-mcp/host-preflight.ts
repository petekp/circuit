import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { type CodexHostCapabilities, assertCodexHostCapabilities } from './capabilities.js';
import {
  type CodexNestedHostProbeInput,
  runCodexNestedSandboxCanary,
  runCodexToolSurfaceCanary,
} from './host-sandbox-canary.js';
import {
  MCP_CODEX_HARDENING_CONFIG_ARGS,
  MCP_CODEX_STRICT_FLAGS,
  buildMcpCodexSandboxConfigArgs,
} from './nested-codex.js';

const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

export class McpHostPreflightError extends Error {
  readonly code = 'codex_capability_missing' as const;
  readonly nextAction =
    'Update Codex to a version whose named sandbox denies shared temporary files, then retry.';

  constructor(message: string) {
    super(message);
    this.name = 'McpHostPreflightError';
  }
}

interface ProbeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

type ProbeRunner = (executable: string, args: readonly string[]) => ProbeResult;

function safeProbeEnvironment(
  environment: NodeJS.ProcessEnv,
  isolatedCodexHome: string,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const name of ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TMPDIR'] as const) {
    const value = environment[name];
    if (value !== undefined) safe[name] = value;
  }
  safe.CODEX_HOME = isolatedCodexHome;
  safe.TMPDIR = isolatedCodexHome;
  return safe;
}

function productionRunner(environment: NodeJS.ProcessEnv): {
  readonly run: ProbeRunner;
  readonly dispose: () => void;
} {
  const isolatedCodexHome = mkdtempSync(join(tmpdir(), 'circuit-codex-capability-'));
  return {
    run: (executable, args) => {
      const result = spawnSync(executable, [...args], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        env: safeProbeEnvironment(environment, isolatedCodexHome),
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
    dispose: () => rmSync(isolatedCodexHome, { recursive: true, force: true }),
  };
}

function requireSuccessfulProbe(result: ProbeResult, name: string): string {
  if (result.error !== undefined || result.status !== 0) {
    throw new McpHostPreflightError(`Circuit could not prove the required Codex ${name}.`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (Buffer.byteLength(output, 'utf8') > MAX_PROBE_OUTPUT_BYTES) {
    throw new McpHostPreflightError(`The Codex ${name} probe returned too much output.`);
  }
  return output;
}

function requireStrictConfigProbe(result: ProbeResult): void {
  if (result.error !== undefined) {
    throw new McpHostPreflightError(
      'Circuit could not prove that Codex accepts the fixed hardening configuration.',
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (Buffer.byteLength(output, 'utf8') > MAX_PROBE_OUTPUT_BYTES) {
    throw new McpHostPreflightError(
      'The Codex strict configuration probe returned too much output.',
    );
  }
  // `--listen off` deliberately asks app-server to parse the complete strict
  // config and stop before opening a transport. Codex 0.144.3 reports that
  // expected terminal condition with status 1; a later host may return 0.
  if (result.status === 0 || (result.status === 1 && /no transport configured/i.test(output)))
    return;
  throw new McpHostPreflightError(
    "The installed Codex did not strictly accept Circuit's fixed hardening configuration.",
  );
}

export async function probeCodexHostCapabilities(
  codexExecutable: string,
  options: {
    readonly workspaceMetadataValidated: boolean;
    readonly nested: CodexNestedHostProbeInput;
    readonly run?: ProbeRunner;
    readonly environment?: NodeJS.ProcessEnv;
    readonly runSandboxCanary?: typeof runCodexNestedSandboxCanary;
    readonly runToolSurfaceCanary?: typeof runCodexToolSurfaceCanary;
  },
): Promise<CodexHostCapabilities> {
  if (!isAbsolute(codexExecutable)) {
    throw new McpHostPreflightError('The pinned Codex executable path is not absolute.');
  }
  if (options.nested.policy.executable !== codexExecutable) {
    throw new McpHostPreflightError(
      'The nested Codex canary is not bound to the pinned executable.',
    );
  }
  const production =
    options.run === undefined ? productionRunner(options.environment ?? process.env) : undefined;
  const run = options.run ?? production?.run;
  if (run === undefined)
    throw new McpHostPreflightError('The Codex capability probe is unavailable.');
  try {
    const versionOutput = requireSuccessfulProbe(run(codexExecutable, ['--version']), 'version');
    const execHelpOutput = requireSuccessfulProbe(
      run(codexExecutable, ['exec', ...MCP_CODEX_STRICT_FLAGS, '--help']),
      'required execution flags',
    );
    requireStrictConfigProbe(
      run(codexExecutable, [
        'app-server',
        '--strict-config',
        '--listen',
        'off',
        '-c',
        'analytics.enabled=false',
        ...MCP_CODEX_HARDENING_CONFIG_ARGS,
        ...buildMcpCodexSandboxConfigArgs(options.nested.policy),
        '-c',
        'web_search="disabled"',
      ]),
    );
    try {
      await (options.runSandboxCanary ?? runCodexNestedSandboxCanary)(options.nested);
      await (options.runToolSurfaceCanary ?? runCodexToolSurfaceCanary)(options.nested);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new McpHostPreflightError(
        `Circuit could not prove the required nested Codex sandbox: ${detail}`,
      );
    }
    return assertCodexHostCapabilities({
      versionOutput,
      execHelpOutput,
      pluginMcpTransport: 'stdio',
      workspaceMetadataValidated: options.workspaceMetadataValidated,
      nestedSandboxValidated: true,
    });
  } finally {
    production?.dispose();
  }
}
