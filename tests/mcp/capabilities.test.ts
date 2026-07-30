import { describe, expect, it } from 'vitest';

import {
  MINIMUM_CODEX_VERSION,
  assertCodexHostCapabilities,
  parseCodexCliVersion,
} from '../../src/hosts/codex-mcp/capabilities.js';

const COMPLETE_HELP = `
  --strict-config
  --ignore-user-config
  --ignore-rules
  --json
  -s, --sandbox <SANDBOX_MODE>
  --ephemeral
`;

describe('Codex MCP capability preflight', () => {
  it('accepts the minimum supported Codex version only with every live capability', () => {
    expect(
      assertCodexHostCapabilities({
        versionOutput: 'codex-cli 0.146.0\n',
        execHelpOutput: COMPLETE_HELP,
        pluginMcpTransport: 'stdio',
        workspaceMetadataValidated: true,
        nestedSandboxValidated: true,
        sharedTempIsolation: 'isolated',
      }),
    ).toEqual({
      codex_version: '0.146.0',
      minimum_version: MINIMUM_CODEX_VERSION,
      plugin_mcp: true,
      strict_config: true,
      workspace_metadata: true,
      nested_sandbox: true,
      shared_temp_isolation: 'isolated',
    });
  });

  it('accepts and records Codex-equivalent shared temporary exposure', () => {
    expect(
      assertCodexHostCapabilities({
        versionOutput: 'codex-cli 0.146.0\n',
        execHelpOutput: COMPLETE_HELP,
        pluginMcpTransport: 'stdio',
        workspaceMetadataValidated: true,
        nestedSandboxValidated: true,
        sharedTempIsolation: 'exposed',
      }),
    ).toMatchObject({
      nested_sandbox: true,
      shared_temp_isolation: 'exposed',
    });
  });

  it.each(['0.145.0', '0.144.3', '0.143.99', '0.118.0'])(
    'rejects unsupported Codex %s before trusting feature probes',
    (version) => {
      expect(() =>
        assertCodexHostCapabilities({
          versionOutput: `codex-cli ${version}`,
          execHelpOutput: COMPLETE_HELP,
          pluginMcpTransport: 'stdio',
          workspaceMetadataValidated: true,
          nestedSandboxValidated: true,
          sharedTempIsolation: 'isolated',
        }),
      ).toThrow(/0\.146\.0 or newer/);
    },
  );

  it('rejects a version string it cannot parse', () => {
    expect(() => parseCodexCliVersion('Codex newest')).toThrow(/version output/);
  });

  it.each([
    ['plugin MCP transport', { pluginMcpTransport: undefined }],
    ['workspace metadata', { workspaceMetadataValidated: false }],
    ['nested sandbox', { nestedSandboxValidated: false }],
    ['strict configuration', { execHelpOutput: COMPLETE_HELP.replace('--strict-config', '') }],
    ['ignored user config', { execHelpOutput: COMPLETE_HELP.replace('--ignore-user-config', '') }],
    ['ignored project rules', { execHelpOutput: COMPLETE_HELP.replace('--ignore-rules', '') }],
    ['JSONL events', { execHelpOutput: COMPLETE_HELP.replace('--json', '') }],
    ['workspace sandbox', { execHelpOutput: COMPLETE_HELP.replace('--sandbox', '--other') }],
  ])('rejects a host missing %s', (_label, replacement) => {
    expect(() =>
      assertCodexHostCapabilities({
        versionOutput: 'codex-cli 0.146.0',
        execHelpOutput: COMPLETE_HELP,
        pluginMcpTransport: 'stdio',
        workspaceMetadataValidated: true,
        nestedSandboxValidated: true,
        sharedTempIsolation: 'isolated',
        ...replacement,
      }),
    ).toThrow(/capability/i);
  });

  it.each([
    ['missing', undefined],
    ['unknown', 'unknown'],
  ] as const)('rejects a %s private shared-temp posture', (_label, sharedTempIsolation) => {
    expect(() =>
      assertCodexHostCapabilities({
        versionOutput: 'codex-cli 0.146.0',
        execHelpOutput: COMPLETE_HELP,
        pluginMcpTransport: 'stdio',
        workspaceMetadataValidated: true,
        nestedSandboxValidated: true,
        sharedTempIsolation: sharedTempIsolation as never,
      }),
    ).toThrow(/shared.temp|capability/i);
  });
});
