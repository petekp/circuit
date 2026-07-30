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
  mcpCodexPromptOnlyHardeningConfigArgs,
} from './nested-codex.js';

const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const REINSTALL_ABSOLUTE_CODEX_ACTION =
  'Reinstall the Circuit plugin so it can pin an absolute Codex executable, then retry.';
const REINSTALL_PINNED_CODEX_ACTION =
  'Reinstall the Circuit plugin so the nested worker uses the pinned Codex executable, then retry.';
const CODEX_INSTALL_ACTION = 'Confirm Codex is installed and runnable, then retry.';
const CODEX_FLAGS_ACTION =
  "Update Codex to a version that supports Circuit's required execution flags, then retry.";
const STRICT_CONFIG_ACTION =
  "Update Codex to a version that accepts Circuit's required strict configuration, then retry.";
const SANDBOX_ACTION = 'Update Codex so its required sandbox capability passes, then retry.';
const TOOL_SURFACE_ACTION =
  'Update Codex so its required tool-surface capability passes, then retry.';

export class McpHostPreflightError extends Error {
  readonly code = 'codex_capability_missing' as const;
  readonly nextAction: string;

  constructor(
    message: string,
    nextAction = 'Update Codex and retry after correcting the reported host capability failure.',
  ) {
    super(message);
    this.name = 'McpHostPreflightError';
    this.nextAction = nextAction;
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
      // The isolated home doubles as the probe working directory. The host can
      // delete the directory this server was launched from (Codex 0.146
      // reinstalls the plugin cache after spawning the MCP server), and a
      // probe that inherits that deleted directory dies on startup for a
      // reason that has nothing to do with configuration.
      const result = spawnSync(executable, [...args], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        env: safeProbeEnvironment(environment, isolatedCodexHome),
        cwd: isolatedCodexHome,
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

/**
 * Names what actually happened, including what the probe wrote. A probe can
 * fail for host reasons that look nothing like the capability being proven,
 * and a report that drops Codex's own words turns those into false diagnoses.
 */
function probeFailureDetail(result: ProbeResult): string {
  const cause =
    result.error !== undefined
      ? `failed to run (${result.error.message})`
      : `exited ${result.status ?? 'without a status'}`;
  const output = `${result.stderr}\n${result.stdout}`.trim().slice(0, 500);
  return `it ${cause}${output.length === 0 ? ' and wrote nothing' : `. Codex reported: ${output}`}`;
}

function requireSuccessfulProbe(result: ProbeResult, name: string, nextAction: string): string {
  if (result.error !== undefined || result.status !== 0) {
    throw new McpHostPreflightError(
      `Circuit could not prove the required Codex ${name}: ${probeFailureDetail(result)}.`,
      nextAction,
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (Buffer.byteLength(output, 'utf8') > MAX_PROBE_OUTPUT_BYTES) {
    throw new McpHostPreflightError(
      `The Codex ${name} probe returned too much output.`,
      nextAction,
    );
  }
  return output;
}

function requireStrictConfigProbe(result: ProbeResult): void {
  if (result.error !== undefined) {
    throw new McpHostPreflightError(
      `Circuit could not prove that Codex accepts the fixed hardening configuration: ${probeFailureDetail(result)}.`,
      STRICT_CONFIG_ACTION,
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (Buffer.byteLength(output, 'utf8') > MAX_PROBE_OUTPUT_BYTES) {
    throw new McpHostPreflightError(
      'The Codex strict configuration probe returned too much output.',
      STRICT_CONFIG_ACTION,
    );
  }
  // `--listen off` deliberately asks app-server to parse the complete strict
  // config and stop before opening a transport. Codex 0.144.3 reports that
  // expected terminal condition with status 1; a later host may return 0.
  if (result.status === 0 || (result.status === 1 && /no transport configured/i.test(output)))
    return;
  throw new McpHostPreflightError(
    `The installed Codex did not strictly accept Circuit's fixed hardening configuration: ${probeFailureDetail(result)}.`,
    STRICT_CONFIG_ACTION,
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
    throw new McpHostPreflightError(
      'The pinned Codex executable path is not absolute.',
      REINSTALL_ABSOLUTE_CODEX_ACTION,
    );
  }
  if (options.nested.policy.executable !== codexExecutable) {
    throw new McpHostPreflightError(
      'The nested Codex canary is not bound to the pinned executable.',
      REINSTALL_PINNED_CODEX_ACTION,
    );
  }
  const production =
    options.run === undefined ? productionRunner(options.environment ?? process.env) : undefined;
  const run = options.run ?? production?.run;
  if (run === undefined)
    throw new McpHostPreflightError(
      'The Codex capability probe is unavailable.',
      'Restart Codex and retry. If the probe remains unavailable, reinstall the Circuit plugin.',
    );
  try {
    const versionOutput = requireSuccessfulProbe(
      run(codexExecutable, ['--version']),
      'version',
      CODEX_INSTALL_ACTION,
    );
    const execHelpOutput = requireSuccessfulProbe(
      run(codexExecutable, ['exec', ...MCP_CODEX_STRICT_FLAGS, '--help']),
      'required execution flags',
      CODEX_FLAGS_ACTION,
    );
    const strictConfigProbeArgs = (hardeningArgs: readonly string[]): string[] => [
      'app-server',
      '--strict-config',
      '--listen',
      'off',
      '-c',
      'analytics.enabled=false',
      ...hardeningArgs,
      ...buildMcpCodexSandboxConfigArgs(options.nested.policy),
      '-c',
      'web_search="disabled"',
    ];
    requireStrictConfigProbe(
      run(codexExecutable, strictConfigProbeArgs(MCP_CODEX_HARDENING_CONFIG_ARGS)),
    );
    // The prompt-only relay adds fields that older Codex releases reject under
    // --strict-config. Prove that exact shape here, before any run depends on it.
    requireStrictConfigProbe(
      run(codexExecutable, strictConfigProbeArgs(mcpCodexPromptOnlyHardeningConfigArgs())),
    );
    let sandbox: Awaited<ReturnType<typeof runCodexNestedSandboxCanary>>;
    try {
      sandbox = await (options.runSandboxCanary ?? runCodexNestedSandboxCanary)(options.nested);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new McpHostPreflightError(
        `Circuit could not prove the required nested Codex sandbox: ${detail}`,
        SANDBOX_ACTION,
      );
    }
    try {
      await (options.runToolSurfaceCanary ?? runCodexToolSurfaceCanary)(options.nested);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new McpHostPreflightError(
        `Circuit could not prove the required nested Codex tool surface: ${detail}`,
        TOOL_SURFACE_ACTION,
      );
    }
    return assertCodexHostCapabilities({
      versionOutput,
      execHelpOutput,
      pluginMcpTransport: 'stdio',
      workspaceMetadataValidated: options.workspaceMetadataValidated,
      nestedSandboxValidated: true,
      sharedTempIsolation: sandbox.shared_temp_isolation,
    });
  } finally {
    production?.dispose();
  }
}
