import { describe, expect, it } from 'vitest';

import { validateCodexMcpFirstRunEvidence } from '../../scripts/release/codex-mcp-first-run-evidence.js';

const REQUIRED_EVIDENCE = [
  'real_plugin_loader_completed',
  'tool_search_discovered_six_tools',
  'circuit_list_invoked',
  'trusted_workspace_metadata',
  'exact_workspace_identity',
  'private_control_state',
  'owned_process_cleanup',
] as const;

function report(): unknown {
  return {
    schema_version: 1,
    host: 'codex',
    surface: 'mcp',
    mode: 'published',
    status: 'pass',
    reason: 'passed',
    source: {
      repository: 'petekp/circuit',
      ref: 'candidate-sha',
      expected_version: '0.1.2',
    },
    versions: {
      node: '22.18.0',
      codex: '0.145.0',
      plugin: '0.1.2',
      plugin_tree_sha256: 'a'.repeat(64),
    },
    evidence: REQUIRED_EVIDENCE.map((name) => ({ name, ok: true })),
  };
}

describe('Codex MCP first-run release evidence', () => {
  it('accepts a passing published report for the exact plugin version and tree', () => {
    expect(
      validateCodexMcpFirstRunEvidence(report(), {
        pluginVersion: '0.1.2',
        pluginTreeSha256: 'a'.repeat(64),
      }),
    ).toEqual([]);
  });

  it('rejects stale versions, stale plugin bytes, and incomplete host proof', () => {
    const current = report() as {
      mode: string;
      versions: { codex: string; plugin: string; plugin_tree_sha256: string };
      evidence: Array<{ name: string; ok: boolean }>;
    };
    const stale = {
      ...current,
      mode: 'packed',
      versions: {
        codex: current.versions.codex,
        plugin: '0.1.1',
        plugin_tree_sha256: 'b'.repeat(64),
      },
      evidence: current.evidence.map((item) =>
        item.name === 'owned_process_cleanup' ? { ...item, ok: false } : item,
      ),
    };

    expect(
      validateCodexMcpFirstRunEvidence(stale, {
        pluginVersion: '0.1.2',
        pluginTreeSha256: 'a'.repeat(64),
      }),
    ).toEqual(
      expect.arrayContaining([
        'evidence mode must be published',
        'evidence is missing the Node version',
        'evidence plugin version 0.1.1 does not match 0.1.2',
        'evidence plugin-tree digest does not match the current Codex plugin',
        'required evidence owned_process_cleanup did not pass exactly once',
      ]),
    );
  });

  it('rejects duplicate required evidence markers', () => {
    const duplicate = report() as { evidence: Array<{ name: string; ok: boolean }> };
    duplicate.evidence.push({ name: 'circuit_list_invoked', ok: true });

    expect(
      validateCodexMcpFirstRunEvidence(duplicate, {
        pluginVersion: '0.1.2',
        pluginTreeSha256: 'a'.repeat(64),
      }),
    ).toContain('required evidence circuit_list_invoked did not pass exactly once');
  });
});
