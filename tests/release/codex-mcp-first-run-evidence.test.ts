import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { packageTreeSha256 } from '../../scripts/plugins/package-tree.js';
import { hashCanonicalWorkspace } from '../../scripts/release/codex-invocation-evidence.js';
import {
  validateCandidateGitBinding,
  validateCodexMcpFirstRunEvidence,
} from '../../scripts/release/codex-mcp-first-run-evidence.js';
import { ReviewResult } from '../../src/flows/review/reports.js';
import { RunResult } from '../../src/schemas/result.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '/private/tmp/circuit-first-run-review';
const REQUIRED_EVIDENCE = [
  'real_plugin_loader_completed',
  'tool_search_discovered_six_tools',
  'circuit_list_invoked',
  'trusted_workspace_metadata',
  'exact_workspace_identity',
  'product_created_private_control_state',
  'owned_process_cleanup',
  'source_ref_exact',
] as const;

function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function runResult(): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    flow_id: 'review',
    goal: 'Review the fixture change',
    outcome: 'complete',
    summary: 'The fixture change is clean.',
    closed_at: '2026-07-22T12:00:00.000Z',
    trace_entries_observed: 12,
    manifest_hash: 'manifest-sha256',
    verdict: 'CLEAN',
  };
}

function reviewResult(): Record<string, unknown> {
  return {
    scope: 'fixture change',
    findings: [],
    verdict: 'CLEAN',
    outcome: 'complete',
    assessment: 'The reviewed change is correct.',
    verification: ['Inspected the complete diff.'],
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
        arguments: { flow: 'review', goal: 'Review the fixture change', web_search: 'off' },
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'start-1',
        type: 'mcp_tool_call',
        server: 'circuit',
        tool: 'circuit_start',
        arguments: { flow: 'review', goal: 'Review the fixture change', web_search: 'off' },
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
    {
      type: 'item.completed',
      item: { id: 'message-1', type: 'agent_message', text: 'Review complete.' },
    },
    { type: 'turn.completed' },
  ];
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function invocation(): Record<string, unknown> {
  return {
    schema_version: 1,
    argv: [
      'exec',
      '--strict-config',
      '-C',
      WORKSPACE,
      '--ephemeral',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '--json',
      'Run Review through Circuit MCP.',
    ],
    workspace_sha256: hashCanonicalWorkspace(WORKSPACE),
    source: {
      repository: 'petekp/circuit',
      ref: 'c'.repeat(40),
      expected_version: '0.1.2',
      plugin_tree_sha256: 'a'.repeat(64),
    },
    host: {
      architecture: 'arm64',
      macos_version: '15.7.3',
      codex_version: '0.145.0',
      node_version: '22.18.0',
    },
    exit_code: 0,
    cleanup_confirmed: true,
    cleanup_intervention_required: false,
  };
}

function fixture(): {
  root: string;
  report: Record<string, unknown>;
  rewrite: (relativePath: string, value: unknown, raw?: boolean) => void;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'circuit-mcp-first-run-proof-'));
  const files = new Map<string, string>();
  const write = (relativePath: string, value: unknown, raw = false): void => {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    const body = raw ? String(value) : `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(path, body);
    files.set(relativePath, body);
  };
  const result = runResult();
  write('review/result.json', result);
  write('review/review-result.json', reviewResult());
  write('review/codex.jsonl', hostTrace(result), true);
  write('review/invocation.json', invocation());
  const artifact = (path: string) => ({ path, sha256: digest(files.get(path) as string) });
  const report = {
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
      architecture: 'arm64',
      macos: '15.7.3',
    },
    evidence: REQUIRED_EVIDENCE.map((name) => ({ name, ok: true })),
    review: {
      run_id: RUN_ID,
      workspace_sha256: hashCanonicalWorkspace(WORKSPACE),
      run_result: artifact('review/result.json'),
      review_report: artifact('review/review-result.json'),
      host_trace: artifact('review/codex.jsonl'),
      invocation: artifact('review/invocation.json'),
    },
  };
  return {
    root,
    report,
    rewrite: write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function expected(root: string) {
  return {
    pluginVersion: '0.1.2',
    pluginTreeSha256: 'a'.repeat(64),
    repository: 'petekp/circuit',
    proofRoot: root,
    validateRunResult: (value: unknown) => RunResult.safeParse(value).success,
    validateReviewResult: (value: unknown) => ReviewResult.safeParse(value).success,
  } as const;
}

describe('Codex MCP first-run release evidence', () => {
  it('runs the release checker under direct Node without loading raw source schemas', () => {
    const checked = spawnSync(
      process.execPath,
      ['scripts/release/check-codex-mcp-first-run-proof.ts'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(checked.status, `${checked.stderr}\n${checked.stdout}`).toBe(0);
    expect(`${checked.stderr}\n${checked.stdout}`).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('derives a first-attempt MCP-only Review from bound artifacts', () => {
    const proof = fixture();
    try {
      expect(validateCodexMcpFirstRunEvidence(proof.report, expected(proof.root))).toEqual([]);
    } finally {
      proof.cleanup();
    }
  });

  it('binds the proof to an existing ancestor commit with identical plugin bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'circuit-mcp-candidate-binding-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      return result.stdout.trim();
    };
    try {
      mkdirSync(join(root, 'plugins/codex'), { recursive: true });
      writeFileSync(join(root, 'plugins/codex/README.md'), 'candidate\n');
      git('init', '-q');
      git('config', 'user.name', 'Circuit Test');
      git('config', 'user.email', 'circuit@example.invalid');
      git('add', '.');
      git('commit', '-qm', 'candidate');
      const candidate = git('rev-parse', 'HEAD');
      writeFileSync(join(root, 'evidence.txt'), 'captured later\n');
      git('add', '.');
      git('commit', '-qm', 'evidence');
      const digest = packageTreeSha256(join(root, 'plugins/codex'));

      expect(
        validateCandidateGitBinding({
          repoRoot: root,
          candidateRef: candidate,
          headRef: 'HEAD',
          expectedPluginTreeSha256: digest,
        }),
      ).toEqual([]);
      expect(
        validateCandidateGitBinding({
          repoRoot: root,
          candidateRef: 'f'.repeat(40),
          headRef: 'HEAD',
          expectedPluginTreeSha256: digest,
        }),
      ).toContain('candidate evidence commit does not exist');
      expect(
        validateCandidateGitBinding({
          repoRoot: root,
          candidateRef: candidate,
          headRef: 'HEAD',
          expectedPluginTreeSha256: 'a'.repeat(64),
        }),
      ).toContain('candidate evidence plugin tree does not match the current release candidate');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects stale versions, stale plugin bytes, and incomplete loader proof', () => {
    const proof = fixture();
    try {
      const current = proof.report as {
        mode: string;
        versions: { plugin: string; plugin_tree_sha256: string };
        evidence: Array<{ name: string; ok: boolean }>;
      };
      current.mode = 'packed';
      current.versions.plugin = '0.1.1';
      current.versions.plugin_tree_sha256 = 'b'.repeat(64);
      const cleanup = current.evidence.find((item) => item.name === 'owned_process_cleanup');
      if (cleanup === undefined) throw new Error('fixture is missing cleanup evidence');
      cleanup.ok = false;

      expect(validateCodexMcpFirstRunEvidence(current, expected(proof.root))).toEqual(
        expect.arrayContaining([
          'evidence mode must be published',
          'evidence plugin version 0.1.1 does not match 0.1.2',
          'evidence plugin-tree digest does not match the current Codex plugin',
          'required evidence owned_process_cleanup did not pass exactly once',
        ]),
      );
    } finally {
      proof.cleanup();
    }
  });

  it('rejects duplicate required evidence markers', () => {
    const proof = fixture();
    try {
      const report = proof.report as { evidence: Array<{ name: string; ok: boolean }> };
      report.evidence.push({ name: 'circuit_list_invoked', ok: true });
      expect(validateCodexMcpFirstRunEvidence(report, expected(proof.root))).toContain(
        'required evidence circuit_list_invoked did not pass exactly once',
      );
    } finally {
      proof.cleanup();
    }
  });

  it('rejects tampered artifacts and unsafe artifact paths', () => {
    const proof = fixture();
    try {
      proof.rewrite('review/result.json', { tampered: true });
      const report = proof.report as {
        review: { host_trace: { path: string } };
      };
      report.review.host_trace.path = '../outside.jsonl';
      expect(validateCodexMcpFirstRunEvidence(report, expected(proof.root))).toEqual(
        expect.arrayContaining([
          'Review run result digest does not match its artifact',
          'Review host trace path must stay inside the proof folder',
        ]),
      );
    } finally {
      proof.cleanup();
    }
  });

  it('rejects shell fallback, duplicate starts, and dangerous host arguments', () => {
    const proof = fixture();
    try {
      const result = runResult();
      const trace = hostTrace(result)
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      trace.splice(2, 0, {
        type: 'item.completed',
        item: { id: 'shell-1', type: 'command_execution', command: 'bin/circuit run review' },
      });
      trace.splice(
        4,
        0,
        trace.find((event) => event.item?.tool === 'circuit_start'),
      );
      const traceBody = `${trace.map((event) => JSON.stringify(event)).join('\n')}\n`;
      proof.rewrite('review/codex.jsonl', traceBody, true);
      const report = proof.report as {
        review: { host_trace: { sha256: string }; invocation: { sha256: string } };
      };
      report.review.host_trace.sha256 = digest(traceBody);
      const unsafeInvocation = {
        ...invocation(),
        argv: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json'],
      };
      proof.rewrite('review/invocation.json', unsafeInvocation);
      report.review.invocation.sha256 = digest(
        readFileSync(join(proof.root, 'review/invocation.json')),
      );

      expect(validateCodexMcpFirstRunEvidence(report, expected(proof.root))).toEqual(
        expect.arrayContaining([
          'Review host trace contains shell or file-change work',
          'Review host trace duplicates an MCP start item ID',
          'Review invocation contains an unapproved Codex option or configuration',
        ]),
      );
    } finally {
      proof.cleanup();
    }
  });

  it('rejects a moving branch, a different repository, or the wrong proof stage', () => {
    const proof = fixture();
    try {
      const report = proof.report as {
        proof_stage: string;
        source: { repository: string; ref: string };
      };
      report.proof_stage = 'public';
      report.source = { repository: 'someone/circuit', ref: 'main' };
      expect(validateCodexMcpFirstRunEvidence(report, expected(proof.root))).toEqual(
        expect.arrayContaining([
          'evidence proof_stage must be candidate',
          'evidence repository must be petekp/circuit',
          'candidate evidence ref must be a full immutable Git commit SHA',
        ]),
      );
    } finally {
      proof.cleanup();
    }
  });
});
