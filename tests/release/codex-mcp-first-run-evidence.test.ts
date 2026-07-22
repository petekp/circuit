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
  'source_ref_exact',
] as const;

const EXPECTED = {
  pluginVersion: '0.1.2',
  pluginTreeSha256: 'a'.repeat(64),
  repository: 'petekp/circuit',
} as const;

function report(): unknown {
  return {
    schema_version: 1,
    host: 'codex',
    surface: 'mcp',
    mode: 'published',
    status: 'pass',
    proof_stage: 'candidate',
    reason: 'passed',
    source: {
      repository: 'petekp/circuit',
      ref: 'c'.repeat(40),
      expected_version: '0.1.2',
    },
    versions: {
      node: '22.18.0',
      codex: '0.145.0',
      plugin: '0.1.2',
      plugin_tree_sha256: 'a'.repeat(64),
    },
    evidence: REQUIRED_EVIDENCE.map((name) => ({ name, ok: true })),
    review: {
      run_id: '11111111-1111-4111-8111-111111111111',
      status: 'completed',
      attempt_count: 1,
      report_sha256: 'b'.repeat(64),
      mcp_only: true,
      shell_fallback: false,
      sandbox_escalation: false,
    },
  };
}

describe('Codex MCP first-run release evidence', () => {
  it('accepts a passing published report for the exact plugin version and tree', () => {
    expect(validateCodexMcpFirstRunEvidence(report(), EXPECTED)).toEqual([]);
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

    expect(validateCodexMcpFirstRunEvidence(stale, EXPECTED)).toEqual(
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

    expect(validateCodexMcpFirstRunEvidence(duplicate, EXPECTED)).toContain(
      'required evidence circuit_list_invoked did not pass exactly once',
    );
  });

  it('rejects a no-spend loader smoke that never completed Review', () => {
    const loaderOnly = report() as { review?: unknown };
    loaderOnly.review = undefined;

    expect(validateCodexMcpFirstRunEvidence(loaderOnly, EXPECTED)).toEqual(
      expect.arrayContaining([
        'evidence is missing the Review run ID',
        'Review evidence status must be completed',
        'Review evidence must record exactly one attempt',
        'evidence is missing a valid Review report digest',
        'Review evidence must prove MCP-only execution without shell fallback',
        'Review evidence must prove no sandbox escalation',
      ]),
    );
  });

  it('rejects retried, escalated, or shell-fallback Review evidence', () => {
    const unsafe = report() as {
      review: {
        attempt_count: number;
        mcp_only: boolean;
        shell_fallback: boolean;
        sandbox_escalation: boolean;
      };
    };
    unsafe.review.attempt_count = 2;
    unsafe.review.mcp_only = false;
    unsafe.review.shell_fallback = true;
    unsafe.review.sandbox_escalation = true;

    expect(validateCodexMcpFirstRunEvidence(unsafe, EXPECTED)).toEqual(
      expect.arrayContaining([
        'Review evidence must record exactly one attempt',
        'Review evidence must prove MCP-only execution without shell fallback',
        'Review evidence must prove no sandbox escalation',
      ]),
    );
  });

  it('rejects a moving branch or a different repository', () => {
    const wrongSource = report() as {
      source: { repository: string; ref: string };
    };
    wrongSource.source = { repository: 'someone/circuit', ref: 'main' };

    expect(validateCodexMcpFirstRunEvidence(wrongSource, EXPECTED)).toEqual(
      expect.arrayContaining([
        'evidence repository must be petekp/circuit',
        'candidate evidence ref must be a full immutable Git commit SHA',
      ]),
    );
  });

  it('rejects evidence that is not explicitly the pre-publication candidate proof', () => {
    const wrongStage = report() as { proof_stage: string };
    wrongStage.proof_stage = 'public';

    expect(validateCodexMcpFirstRunEvidence(wrongStage, EXPECTED)).toContain(
      'evidence proof_stage must be candidate',
    );
  });
});
