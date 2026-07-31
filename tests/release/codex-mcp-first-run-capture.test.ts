import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { hashCanonicalWorkspace } from '../../scripts/release/codex-invocation-evidence.js';
import {
  buildFirstRunInvocation,
  codexHookStateKey,
  codexHookTrustedHash,
  parseFirstRunHostTrace,
  renderCodexHookTrustToml,
  renderCodexHooksJson,
  renderFirstRunProofBundle,
  scanRenderedBundleForPrivateText,
} from '../../scripts/release/codex-mcp-first-run-capture.js';
import {
  REQUIRED_EVIDENCE,
  validateCodexMcpFirstRunEvidence,
} from '../../scripts/release/codex-mcp-first-run-evidence.js';
import { ReviewResult } from '../../src/flows/review/reports.js';
import { RunResult } from '../../src/schemas/result.js';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '/private/tmp/circuit-first-run-review';
const PLUGIN_TREE = 'b'.repeat(64);
const CANDIDATE_REF = 'd'.repeat(40);

function runResult(): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    flow_id: 'review',
    goal: 'Review the staged README fix',
    outcome: 'complete',
    summary: 'The staged change is clean.',
    closed_at: '2026-07-30T12:00:00.000Z',
    trace_entries_observed: 12,
    manifest_hash: 'manifest-sha256',
    verdict: 'CLEAN',
  };
}

function reviewReport(): Record<string, unknown> {
  return {
    scope: 'Review the staged README fix',
    findings: [],
    verdict: 'CLEAN',
    outcome: 'complete',
    assessment: 'The staged change is correct.',
    verification: ['Inspected the complete staged diff.'],
    confidence_limitations: [],
    evidence_warnings: [],
  };
}

function hostTrace(result: Record<string, unknown>): string {
  const events = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    {
      type: 'item.started',
      item: {
        id: 'start-1',
        type: 'mcp_tool_call',
        server: 'circuit',
        tool: 'circuit_start',
        arguments: { flow: 'review', goal: 'Review the staged README fix' },
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'start-1',
        type: 'mcp_tool_call',
        server: 'circuit',
        tool: 'circuit_start',
        arguments: { flow: 'review', goal: 'Review the staged README fix' },
        result: {
          structured_content: { schema_version: 1, ok: true, run_id: RUN_ID, state: 'starting' },
        },
      },
    },
    {
      type: 'item.started',
      item: {
        id: 'status-1',
        type: 'mcp_tool_call',
        server: 'circuit',
        tool: 'circuit_status',
        arguments: { run_id: RUN_ID },
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'status-1',
        type: 'mcp_tool_call',
        server: 'circuit',
        tool: 'circuit_status',
        arguments: { run_id: RUN_ID },
        result: {
          structured_content: {
            schema_version: 1,
            ok: true,
            run_id: RUN_ID,
            state: 'complete',
            cursor: 12,
            events: [],
            final_report: { schema: 'circuit.review.result', data: result },
          },
        },
      },
    },
    { type: 'turn.completed' },
  ];
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

const ARGV = [
  'exec',
  '--strict-config',
  '--ephemeral',
  '--json',
  '-C',
  WORKSPACE,
  '--sandbox',
  'workspace-write',
  '-c',
  'approval_policy="never"',
  '-c',
  'analytics.enabled=false',
  '-c',
  'check_for_update_on_startup=false',
  '-m',
  'gpt-5.4-mini',
  '--color',
  'never',
  'Run Review through Circuit MCP.',
] as const;

function invocation(): Record<string, unknown> {
  return buildFirstRunInvocation({
    argv: ARGV,
    workspacePath: WORKSPACE,
    source: {
      repository: 'petekp/circuit',
      ref: CANDIDATE_REF,
      expected_version: '0.1.3',
      plugin_tree_sha256: PLUGIN_TREE,
    },
    host: {
      architecture: 'arm64',
      macos_version: '15.7.3',
      codex_version: '0.146.0',
      node_version: '24.18.1',
    },
    exitCode: 0,
    cleanupConfirmed: true,
    cleanupInterventionRequired: false,
  });
}

function bundle() {
  const result = runResult();
  return {
    reason:
      'The published plugin completed a first-attempt MCP Review through real headless Codex.',
    source: {
      repository: 'petekp/circuit',
      ref: CANDIDATE_REF,
      expected_version: '0.1.3',
    },
    versions: {
      node: '24.18.1',
      codex: '0.146.0',
      plugin: '0.1.3',
      plugin_tree_sha256: PLUGIN_TREE,
      architecture: 'arm64' as const,
      macos: '15.7.3',
    },
    evidence: [
      ...REQUIRED_EVIDENCE.map((name) => ({ name, ok: true })),
      {
        name: 'headless_start_preapproved_via_trusted_permission_hook',
        ok: true,
        detail:
          'The operator pre-approved exactly one tool, mcp__circuit__circuit_start, through a trusted Codex permission hook in the isolated bench.',
      },
    ],
    review: { run_id: RUN_ID, workspacePath: WORKSPACE },
    artifacts: {
      runResult: result,
      reviewReport: reviewReport(),
      hostTraceText: hostTrace(result),
      invocation: invocation(),
    },
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function writeRendered(root: string, files: readonly { path: string; text: string }[]): void {
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text);
  }
}

describe('Codex MCP first-run capture assembly', () => {
  it('computes the Codex trusted-hook hash with canonical key order and timeout defaults', () => {
    const hook = {
      matcher: 'mcp__circuit__circuit_start',
      command: '/bench/allow-circuit-start.sh',
      timeoutSeconds: 10,
    };
    const identity =
      '{"event_name":"permission_request","hooks":[{"async":false,"command":"/bench/allow-circuit-start.sh","timeout":10,"type":"command"}],"matcher":"mcp__circuit__circuit_start"}';
    const expected = `sha256:${createHash('sha256').update(identity).digest('hex')}`;
    expect(codexHookTrustedHash(hook)).toBe(expected);
    expect(codexHookTrustedHash({ matcher: hook.matcher, command: hook.command })).toBe(
      `sha256:${createHash('sha256')
        .update(identity.replace('"timeout":10', '"timeout":600'))
        .digest('hex')}`,
    );
    expect(codexHookStateKey('/bench/hooks.json')).toBe('/bench/hooks.json:permission_request:0:0');
    expect(JSON.parse(renderCodexHooksJson(hook))).toEqual({
      hooks: {
        PermissionRequest: [
          {
            matcher: hook.matcher,
            hooks: [{ type: 'command', command: hook.command, timeout: 10 }],
          },
        ],
      },
    });
    const toml = renderCodexHookTrustToml('/bench/hooks.json', hook);
    expect(toml).toContain('[hooks.state."/bench/hooks.json:permission_request:0:0"]');
    expect(toml).toContain(`trusted_hash = "${codexHookTrustedHash(hook)}"`);
  });

  it('extracts the run identity and terminal report from a host trace', () => {
    const result = runResult();
    const parsed = parseFirstRunHostTrace(hostTrace(result));
    expect(parsed.issues).toEqual([]);
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.finalReportData).toEqual(result);
  });

  it('reports a trace that never completed in plain language', () => {
    const parsed = parseFirstRunHostTrace('{"type":"thread.started"}\n{"type":"turn.started"}\n');
    expect(parsed.runId).toBeUndefined();
    expect(parsed.issues).toEqual([
      'the host trace has no successful circuit_start response',
      'the host trace has no completed circuit_status with final report data',
    ]);
  });

  it('renders a proof bundle that passes the release evidence validator', () => {
    const root = mkdtempSync(join(tmpdir(), 'circuit-first-run-capture-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const rendered = renderFirstRunProofBundle(bundle());
    writeRendered(root, rendered.files);
    const evidence = JSON.parse(rendered.evidenceText) as unknown;
    const issues = validateCodexMcpFirstRunEvidence(evidence, {
      pluginVersion: '0.1.3',
      pluginTreeSha256: PLUGIN_TREE,
      repository: 'petekp/circuit',
      proofRoot: root,
      validateRunResult: (value: unknown) => RunResult.safeParse(value).success,
      validateReviewResult: (value: unknown) => ReviewResult.safeParse(value).success,
    });
    expect(issues).toEqual([]);
  });

  it('binds the workspace hash into both the evidence and the invocation', () => {
    const rendered = renderFirstRunProofBundle(bundle());
    const evidence = JSON.parse(rendered.evidenceText) as {
      review: { workspace_sha256: string };
    };
    const built = invocation() as { workspace_sha256: string };
    expect(evidence.review.workspace_sha256).toBe(hashCanonicalWorkspace(WORKSPACE));
    expect(built.workspace_sha256).toBe(hashCanonicalWorkspace(WORKSPACE));
  });

  it('finds private text anywhere in the rendered bundle', () => {
    const dirty = bundle();
    const rendered = renderFirstRunProofBundle({
      ...dirty,
      artifacts: {
        ...dirty.artifacts,
        reviewReport: {
          ...reviewReport(),
          assessment: 'Saved under /Users/someone/.circuit-live-test today.',
        },
      },
    });
    const findings = scanRenderedBundleForPrivateText(rendered, [
      { label: 'the home directory', value: '/Users/someone' },
      { label: 'the bench root', value: '/bench/that-does-not-appear' },
    ]);
    expect(findings).toEqual(['review/review-result.json contains the home directory']);
  });
});
