export const MINIMUM_CODEX_VERSION = '0.146.0' as const;

export type CodexSharedTempIsolation = 'isolated' | 'exposed';

export type CodexHostCapabilityErrorCode =
  | 'codex_version_invalid'
  | 'codex_version_unsupported'
  | 'codex_capability_missing';

export class CodexHostCapabilityError extends Error {
  readonly code: CodexHostCapabilityErrorCode;
  readonly nextAction: string;

  constructor(code: CodexHostCapabilityErrorCode, message: string, nextAction: string) {
    super(message);
    this.name = 'CodexHostCapabilityError';
    this.code = code;
    this.nextAction = nextAction;
  }
}

export interface CodexHostCapabilityProbeInput {
  readonly versionOutput: string;
  readonly execHelpOutput: string;
  readonly pluginMcpTransport: 'stdio' | undefined;
  readonly workspaceMetadataValidated: boolean;
  readonly nestedSandboxValidated: boolean;
  readonly sharedTempIsolation: CodexSharedTempIsolation;
}

export interface CodexHostCapabilities {
  readonly codex_version: string;
  readonly minimum_version: typeof MINIMUM_CODEX_VERSION;
  readonly plugin_mcp: true;
  readonly strict_config: true;
  readonly workspace_metadata: true;
  readonly nested_sandbox: true;
  readonly shared_temp_isolation: CodexSharedTempIsolation;
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly text: string;
}

export function parseCodexCliVersion(output: string): ParsedVersion {
  const match = /\bcodex(?:-cli)?\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/i.exec(output);
  if (match === null) {
    throw new CodexHostCapabilityError(
      'codex_version_invalid',
      'Circuit could not understand the Codex version output.',
      `Run codex --version, then install Codex ${MINIMUM_CODEX_VERSION} or newer.`,
    );
  }
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new CodexHostCapabilityError(
      'codex_version_invalid',
      'Circuit could not understand the Codex version output.',
      `Run codex --version, then install Codex ${MINIMUM_CODEX_VERSION} or newer.`,
    );
  }
  return { major, minor, patch, text: `${major}.${minor}.${patch}` };
}

function compareVersion(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

const MINIMUM_PARSED_VERSION: ParsedVersion = { major: 0, minor: 146, patch: 0, text: '0.146.0' };

const REQUIRED_EXEC_HELP_CAPABILITIES = [
  ['strict configuration', /(^|\s)--strict-config(?:\s|$)/m],
  ['ignored user config', /(^|\s)--ignore-user-config(?:\s|$)/m],
  ['ignored project rules', /(^|\s)--ignore-rules(?:\s|$)/m],
  ['JSONL events', /(^|\s)--json(?:\s|$)/m],
  ['workspace sandbox', /--sandbox(?:\s|=|\s*<)/m],
  ['ephemeral sessions', /(^|\s)--ephemeral(?:\s|$)/m],
] as const;

export function assertCodexHostCapabilities(
  input: CodexHostCapabilityProbeInput,
): CodexHostCapabilities {
  const version = parseCodexCliVersion(input.versionOutput);
  if (compareVersion(version, MINIMUM_PARSED_VERSION) < 0) {
    throw new CodexHostCapabilityError(
      'codex_version_unsupported',
      `Circuit MCP requires Codex ${MINIMUM_CODEX_VERSION} or newer; this host reports ${version.text}.`,
      `Update Codex to ${MINIMUM_CODEX_VERSION} or newer, then retry.`,
    );
  }

  if (input.pluginMcpTransport !== 'stdio') {
    throw new CodexHostCapabilityError(
      'codex_capability_missing',
      'The Codex plugin MCP capability could not be proven.',
      'Start Circuit through the installed Codex plugin, not by running its MCP file directly.',
    );
  }
  if (!input.workspaceMetadataValidated) {
    throw new CodexHostCapabilityError(
      'codex_capability_missing',
      'The Codex workspace metadata capability could not be proven.',
      'Update Codex and retry from a real workspace directory.',
    );
  }
  if (!input.nestedSandboxValidated) {
    throw new CodexHostCapabilityError(
      'codex_capability_missing',
      "The installed Codex did not pass Circuit's nested sandbox capability canary.",
      'Update Codex and retry after correcting the reported sandbox capability failure.',
    );
  }
  if (input.sharedTempIsolation !== 'isolated' && input.sharedTempIsolation !== 'exposed') {
    throw new CodexHostCapabilityError(
      'codex_capability_missing',
      'The Codex shared temporary directory posture could not be proven.',
      'Update Codex and retry after the host capability probe completes successfully.',
    );
  }

  for (const [name, pattern] of REQUIRED_EXEC_HELP_CAPABILITIES) {
    if (!pattern.test(input.execHelpOutput)) {
      throw new CodexHostCapabilityError(
        'codex_capability_missing',
        `The installed Codex does not advertise the required ${name} capability.`,
        `Update Codex to ${MINIMUM_CODEX_VERSION} or newer, then retry.`,
      );
    }
  }

  return Object.freeze({
    codex_version: version.text,
    minimum_version: MINIMUM_CODEX_VERSION,
    plugin_mcp: true,
    strict_config: true,
    workspace_metadata: true,
    nested_sandbox: true,
    shared_temp_isolation: input.sharedTempIsolation,
  });
}
