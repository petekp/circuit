import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateCodexMcpCandidateMatrix } from '../../scripts/release/codex-mcp-candidate-matrix.js';
import { BuildResult } from '../../src/flows/build/reports.js';
import { ExploreResult } from '../../src/flows/explore/reports.js';
import { FixResult } from '../../src/flows/fix/reports.js';
import { PrototypeResult } from '../../src/flows/prototype/reports.js';
import { ReviewResult } from '../../src/flows/review/reports.js';
import { TraceEntry } from '../../src/schemas/trace-entry.js';

const CANDIDATE = 'c'.repeat(40);
const TREE = 'a'.repeat(64);
const VERSION = '0.1.2';
const CODEX_VERSION = '0.145.0';
const WORKSPACE = '/private/tmp/circuit candidate matrix';
const CONSENT_ERROR =
  'cached web search requires explicit consent because the query leaves the machine';
const RUNS = [
  ['review', 'review'],
  ['fix', 'fix'],
  ['build', 'build'],
  ['explore', 'explore'],
  ['explore-tournament', 'explore'],
  ['prototype', 'prototype'],
  ['prototype-tournament', 'prototype'],
  ['cached-search-explore', 'explore'],
] as const;

function hash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function result(runId: string, flow: string): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: runId,
    flow_id: flow,
    goal: `Prove ${flow}`,
    outcome: 'complete',
    summary: `${flow} completed.`,
    closed_at: '2026-07-22T12:00:00.000Z',
    trace_entries_observed: 20,
    manifest_hash: 'manifest-sha256',
  };
}

function pointer(reportId: string): Record<string, string> {
  return {
    report_id: reportId,
    path: reportId.startsWith('fix.')
      ? `reports/fix/${reportId.slice('fix.'.length)}.json`
      : `reports/${reportId}.json`,
    schema:
      reportId === 'prototype.checkpoint.request'
        ? 'checkpoint.request@v1'
        : reportId === 'prototype.checkpoint.response'
          ? 'checkpoint.response@v1'
          : `${reportId}@v1`,
  };
}

function flowResult(id: string): Record<string, unknown> {
  switch (id) {
    case 'review':
      return {
        scope: 'Review the seeded change.',
        findings: [],
        verdict: 'CLEAN',
        outcome: 'complete',
        assessment: 'The seeded change is clean.',
        verification: ['Inspected the seeded diff and its tests.'],
        confidence_limitations: [],
        evidence_warnings: [],
      };
    case 'fix':
      return {
        summary: 'The seeded failing test was fixed.',
        outcome: 'fixed',
        verification_status: 'passed',
        regression_status: 'proved',
        regression_rerun_status: 'cleared',
        change_set_status: 'pass',
        review_status: 'completed',
        review_verdict: 'accept',
        residual_risks: [],
        evidence_links: [
          'fix.brief',
          'fix.context',
          'fix.diagnosis',
          'fix.regression-proof',
          'fix.baseline-snapshot',
          'fix.change',
          'fix.verification',
          'fix.regression-rerun',
          'fix.change-set',
          'fix.review',
        ].map(pointer),
      };
    case 'build':
      return {
        summary: 'The requested build completed.',
        outcome: 'complete',
        verification_status: 'passed',
        review_verdict: 'accept',
        scope: {
          adherence: 'within_scope',
          violated_guardrails: [],
          unassessed_guardrails: [],
        },
        touch_area: {
          enforcement: 'enforced',
          containment: 'within',
          out_of_bounds_paths: [],
        },
        evidence_links: [
          'build.brief',
          'build.plan',
          'build.implementation',
          'build.verification',
          'build.review',
        ].map(pointer),
      };
    case 'explore-tournament':
      return {
        summary: 'Option 2 was selected.',
        verdict_snapshot: {
          decision_verdict: 'decided',
          tournament_review_verdict: 'recommend',
          selected_option_id: 'option-2',
          objection_count: 0,
          missing_evidence_count: 0,
        },
        evidence_links: [
          'explore.brief',
          'explore.analysis',
          'explore.decision-options',
          'explore.tournament-aggregate',
          'explore.tournament-review',
          'explore.decision',
        ].map(pointer),
      };
    case 'prototype':
      return {
        summary: 'The prototype was verified and kept.',
        outcome: 'kept',
        artifact_status: 'accepted',
        verification_status: 'passed',
        checkpoint_status: 'operator_selected',
        prototype_root: 'prototype-files',
        entry_points: ['prototype-files/index.html'],
        integration_touchpoints: [],
        preview_instructions: 'Open prototype-files/index.html.',
        residual_risks: [],
        next_step: 'Use the verified prototype as Build input.',
        claim_limits: ['not production', 'not deployed'],
        evidence_links: [
          'prototype.brief',
          'prototype.plan',
          'prototype.artifact',
          'prototype.verification',
          'prototype.checkpoint.request',
          'prototype.checkpoint.response',
        ].map(pointer),
        mode: 'single-artifact',
        checkpoint_selection: 'keep-prototype',
      };
    case 'prototype-tournament':
      return {
        summary: 'Variant A was verified and selected.',
        outcome: 'kept',
        artifact_status: 'accepted',
        verification_status: 'passed',
        checkpoint_status: 'operator_selected',
        prototype_root: 'prototype-files',
        entry_points: ['prototype-files/variants/variant-a/index.html'],
        integration_touchpoints: [],
        preview_instructions: 'Open the selected variant.',
        residual_risks: [],
        next_step: 'Use Variant A as Build input.',
        claim_limits: ['not production', 'not deployed'],
        evidence_links: [
          'prototype.brief',
          'prototype.variant-options',
          'prototype.variant-aggregate',
          'prototype.variant-provider-evidence',
          'prototype.variant-verification',
          'prototype.variant-review',
          'prototype.variant-choice-options',
          'prototype.checkpoint.request',
          'prototype.checkpoint.response',
        ].map(pointer),
        mode: 'model-comparison',
        checkpoint_selection: 'variant-a',
        variant_count: 2,
        admitted_variant_count: 2,
        captured_provider_evidence_count: 2,
        model_evidence_status: 'captured',
        recommended_variant_id: 'variant-a',
        selected_variant_id: 'variant-a',
        selected_variant_label: 'Variant A',
        selected_variant_root: 'prototype-files/variants/variant-a',
        comparison_summary: 'Variant A is the clearer option.',
      };
    case 'explore':
    case 'cached-search-explore':
      return {
        summary: 'Use the cited recommendation.',
        verdict_snapshot: {
          compose_verdict: 'accept',
          review_verdict: 'accept',
          objection_count: 0,
          missed_angle_count: 0,
        },
        evidence_links: [
          'explore.brief',
          'explore.analysis',
          'explore.compose',
          'explore.review-verdict',
        ].map(pointer),
      };
    default:
      throw new Error(`unknown flow-result fixture ${id}`);
  }
}

function verificationCommand(): Record<string, unknown> {
  return {
    command_id: 'proof',
    argv: ['npm', 'test'],
    cwd: '.',
    exit_code: 0,
    status: 'passed',
    duration_ms: 10,
    stdout_summary: 'passed',
    stderr_summary: '',
  };
}

function mcpCall(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  response: Record<string, unknown>,
): Record<string, unknown>[] {
  const item = { id, type: 'mcp_tool_call', server: 'circuit', tool, arguments: args };
  return [
    { type: 'item.started', item },
    {
      type: 'item.completed',
      item: { ...item, result: { structured_content: response } },
    },
  ];
}

function session(events: readonly Record<string, unknown>[], threadId = 'thread-proof'): string {
  return `${[
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started' },
    ...events,
    { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'Done.' } },
    { type: 'turn.completed' },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`;
}

function invocation(architecture: 'arm64' | 'x64'): Record<string, unknown> {
  return {
    schema_version: 1,
    argv: [
      'exec',
      '--strict-config',
      '--ephemeral',
      '--sandbox',
      'workspace-write',
      '-C',
      WORKSPACE,
      '-c',
      'approval_policy="never"',
      '--json',
      'Use Circuit MCP.',
    ],
    workspace_sha256: hash(WORKSPACE),
    source: {
      repository: 'petekp/circuit',
      ref: CANDIDATE,
      expected_version: VERSION,
      plugin_tree_sha256: TREE,
    },
    host: {
      architecture,
      macos_version: '15.7.3',
      codex_version: CODEX_VERSION,
      node_version: '22.18.0',
    },
    exit_code: 0,
    cleanup_confirmed: true,
    cleanup_intervention_required: false,
  };
}

function fixture(): {
  root: string;
  matrix: Record<string, unknown>;
  rewrite: (path: string, value: unknown, raw?: boolean) => { path: string; sha256: string };
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'circuit-candidate-matrix-'));
  const write = (relativePath: string, value: unknown, raw = false) => {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    const body = raw ? String(value) : `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(path, body);
    return { path: relativePath, sha256: hash(body) };
  };

  const runs = RUNS.map(([id, flow], index) => {
    const runId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
    const runResult = result(runId, flow);
    const tournament = id.endsWith('-tournament');
    const cached = id === 'cached-search-explore';
    const needsResume = tournament || id === 'prototype';
    const architecture = index % 2 === 0 ? 'arm64' : 'x64';
    const checkpointChoice =
      id === 'explore-tournament'
        ? 'option-2'
        : id === 'prototype-tournament'
          ? 'variant-a'
          : 'keep-prototype';
    const startArgs: Record<string, unknown> = {
      flow,
      goal: `Prove ${id}`,
      web_search: cached ? 'cached' : 'off',
      ...(cached ? { consent: { cached_web_search: true } } : {}),
      ...(tournament ? { tournament: 2 } : {}),
      ...(id === 'prototype-tournament'
        ? {
            variants: [
              { id: 'variant-a', label: 'Variant A', model: 'gpt-5.4-mini', effort: 'low' },
              { id: 'variant-b', label: 'Variant B', model: 'gpt-5.4-mini', effort: 'low' },
            ],
          }
        : {}),
    };
    const start = mcpCall('start', 'circuit_start', startArgs, {
      schema_version: 1,
      ok: true,
      run_id: runId,
      state: 'starting',
      next_cursor: 0,
      summary: 'Circuit started the run.',
    });
    const resume = needsResume
      ? mcpCall(
          'resume',
          'circuit_resume',
          { run_id: runId, checkpoint_token: 'checkpoint-token-1234', choice_id: checkpointChoice },
          {
            schema_version: 1,
            ok: true,
            run_id: runId,
            state: 'resuming',
            next_cursor: 10,
            summary: 'Circuit resumed the run.',
          },
        )
      : [];
    const checkpointStatus = needsResume
      ? mcpCall(
          'checkpoint-status',
          'circuit_status',
          { run_id: runId },
          {
            schema_version: 1,
            ok: true,
            run_id: runId,
            state: 'waiting_for_input',
            events: [],
            next_cursor: 10,
            truncated: false,
            checkpoint: {
              token: 'checkpoint-token-1234',
              prompt: 'Choose one option.',
              choices: [{ id: checkpointChoice, label: 'Selected choice' }],
            },
            summary: 'Circuit is waiting for input.',
          },
        )
      : [];
    const list =
      id === 'prototype-tournament'
        ? mcpCall(
            'list',
            'circuit_list',
            {},
            {
              schema_version: 1,
              ok: true,
              runs: [
                {
                  run_id: runId,
                  flow: 'prototype',
                  state: 'waiting_for_input',
                  updated_at: '2026-07-22T12:00:00.000Z',
                  checkpoint_available: true,
                  summary: 'Waiting for a prototype choice.',
                },
              ],
              truncated: false,
              summary: 'One run.',
            },
          )
        : [];
    const status = mcpCall(
      'status',
      'circuit_status',
      { run_id: runId },
      {
        schema_version: 1,
        ok: true,
        run_id: runId,
        state: 'complete',
        events: [],
        next_cursor: 20,
        truncated: false,
        final_report: {
          schema: `circuit.${flow}.result`,
          summary: `${flow} completed.`,
          data: runResult,
        },
        summary: `${flow} completed.`,
      },
    );
    const traces =
      id === 'prototype-tournament'
        ? [
            write(
              `runs/${id}/host-1.jsonl`,
              session([...start, ...checkpointStatus], 'thread-before-restart'),
              true,
            ),
            write(
              `runs/${id}/host-2.jsonl`,
              session([...list, ...resume, ...status], 'thread-after-restart'),
              true,
            ),
          ]
        : [
            write(
              `runs/${id}/host.jsonl`,
              session([...start, ...checkpointStatus, ...resume, ...status]),
              true,
            ),
          ];
    const invocations = traces.map((_trace, invocationIndex) =>
      write(`runs/${id}/invocation-${invocationIndex + 1}.json`, invocation(architecture)),
    );
    const specificResult = flowResult(id);
    const supportingReports: Record<string, unknown> = {};
    if (id === 'explore' || id === 'cached-search-explore') {
      supportingReports.compose = write(`runs/${id}/compose.json`, {
        verdict: 'accept',
        subject: 'Stable Codex release',
        recommendation: cached
          ? `Use Codex ${CODEX_VERSION}, the current stable release.`
          : 'Use the cited option.',
        success_condition_alignment: 'The recommendation answers the question.',
        supporting_aspects: [
          {
            aspect: 'Release evidence',
            contribution: 'Grounds the recommendation.',
            evidence_refs: ['analysis:release-evidence'],
          },
        ],
      });
      supportingReports.analysis = write(`runs/${id}/analysis.json`, {
        subject: 'Stable Codex release',
        aspects: [
          {
            name: 'Release evidence',
            summary: 'The official release page names the current release.',
            evidence: [
              {
                source: cached
                  ? `https://github.com/openai/codex/releases/tag/rust-v${CODEX_VERSION}`
                  : 'docs/fixture.md',
                summary: 'Supports the recommendation.',
              },
            ],
          },
        ],
      });
    }
    if (id === 'explore-tournament') {
      supportingReports.decision = write(`runs/${id}/decision.json`, {
        verdict: 'decided',
        decision_question: 'Which option should we choose?',
        selected_option_id: checkpointChoice,
        selected_option_label: 'Option 2',
        decision: 'Choose option 2.',
        rationale: 'It best meets the goal.',
        rejected_options: [],
        evidence_links: ['reports/tournament-review.json'],
        assumptions: [],
        residual_risks: [],
        next_action: 'Proceed with option 2.',
        follow_up_workflow: 'Build',
      });
    }
    if (id === 'prototype') {
      supportingReports.verification = write(`runs/${id}/verification.json`, {
        overall_status: 'passed',
        commands: [verificationCommand()],
        review_assets: [],
      });
    }
    if (id === 'prototype-tournament') {
      supportingReports.variant_verification = write(`runs/${id}/variant-verification.json`, {
        overall_status: 'passed',
        required_captured_provider_evidence_count: 2,
        captured_provider_evidence_count: 2,
        admitted_variant_count: 2,
        variant_results: ['variant-a', 'variant-b'].map((variantId) => ({
          variant_id: variantId,
          status: 'passed',
          entry_points: [`prototype-files/variants/${variantId}/index.html`],
          created_files: [`prototype-files/variants/${variantId}/index.html`],
          notes: [],
        })),
        commands: [verificationCommand()],
        review_assets: [],
      });
    }
    const artifactPaths =
      id === 'prototype'
        ? ['prototype-files/index.html']
        : id === 'prototype-tournament'
          ? [
              'prototype-files/variants/variant-a/index.html',
              'prototype-files/variants/variant-b/index.html',
            ]
          : [];
    return {
      id,
      flow,
      run_id: runId,
      architecture,
      workspace_sha256: hash(WORKSPACE),
      run_result: write(`runs/${id}/result.json`, runResult),
      flow_result_schema:
        id === 'review'
          ? 'review.result@v1'
          : id === 'fix'
            ? 'fix.result@v1'
            : id === 'build'
              ? 'build.result@v1'
              : id.startsWith('explore') || cached
                ? 'explore.result@v1'
                : 'prototype.result@v1',
      flow_result: write(`runs/${id}/flow-result.json`, specificResult),
      ...(Object.keys(supportingReports).length > 0
        ? { supporting_reports: supportingReports }
        : {}),
      ...(artifactPaths.length > 0
        ? {
            artifact_files: artifactPaths.map((workspacePath) => ({
              workspace_path: workspacePath,
              artifact: write(
                `runs/${id}/artifacts/${workspacePath.replaceAll('/', '-')}`,
                `<html>${workspacePath}</html>`,
                true,
              ),
            })),
          }
        : {}),
      host_traces: traces,
      invocations,
      ...(cached
        ? {
            circuit_trace: write(
              `runs/${id}/trace.ndjson`,
              `${[
                {
                  schema_version: 1,
                  sequence: 1,
                  recorded_at: '2026-07-22T11:59:59.000Z',
                  run_id: runId,
                  kind: 'relay.started',
                  step_id: 'analyze-step',
                  attempt: 1,
                  connector: { kind: 'builtin', name: 'codex' },
                  role: 'researcher',
                  resolved_selection: { skills: [] },
                  resolved_from: { source: 'explicit' },
                },
                {
                  schema_version: 1,
                  sequence: 2,
                  recorded_at: '2026-07-22T12:00:00.000Z',
                  run_id: runId,
                  kind: 'relay.receipt',
                  step_id: 'analyze-step',
                  attempt: 1,
                  cli_version: `codex-cli ${CODEX_VERSION}`,
                  receipt_id: 'cached-search-receipt',
                  web_search_count: 1,
                },
              ]
                .map((entry) => JSON.stringify(entry))
                .join('\n')}\n`,
              true,
            ),
          }
        : {}),
    };
  });

  const smoke = (arch: string) =>
    write(`architectures/${arch}/loader.json`, {
      schema_version: 1,
      host: 'codex',
      surface: 'mcp',
      mode: 'published',
      status: 'pass',
      reason: 'passed',
      source: { repository: 'petekp/circuit', ref: CANDIDATE, expected_version: VERSION },
      versions: {
        node: '22.18.0',
        codex: CODEX_VERSION,
        plugin: VERSION,
        plugin_tree_sha256: TREE,
      },
      evidence: [
        'real_plugin_loader_completed',
        'tool_search_discovered_six_tools',
        'circuit_list_invoked',
        'trusted_workspace_metadata',
        'exact_workspace_identity',
        'product_created_private_control_state',
        'owned_process_cleanup',
        'source_ref_exact',
      ].map((name) => ({ name, ok: true })),
    });
  const canary = (arch: 'arm64' | 'x64', kind: 'sandbox' | 'proof-network') => {
    const sandbox = kind === 'sandbox';
    const checks = sandbox
      ? [
          'AUTH_READ_DENIED',
          'ENV_CLEAN',
          'GIT_EXEC',
          'NETWORK_DENIED',
          'NODE_EXEC',
          'PRIVATE_WRITE',
          'SIBLING_READ_DENIED',
          'SYMLINK_READ_DENIED',
          'WORKSPACE_WRITE',
          'SHARED_TEMP_DIAGNOSTIC_RECORDED',
          'TOOL_SURFACE_OFF',
          'TOOL_SURFACE_CACHED',
        ]
      : [
          'SOCKET_DENIED',
          'DNS_DENIED',
          'CURL_DENIED',
          'URLSESSION_DENIED',
          'BACKGROUND_URLSESSION_XPC_DENIED',
          'NO_LOOPBACK_CONNECTIONS',
          'CLEANUP_CONFIRMED',
        ];
    return write(`architectures/${arch}/${kind}.json`, {
      schema_version: 1,
      canary_id: sandbox ? 'nested_codex_sandbox' : 'proof_command_network',
      status: 'pass',
      test_file: sandbox
        ? 'tests/mcp/host-sandbox-canary-live.test.ts'
        : 'tests/mcp/proof-sandbox-live.test.ts',
      source: {
        repository: 'petekp/circuit',
        ref: CANDIDATE,
        expected_version: VERSION,
        plugin_tree_sha256: TREE,
      },
      host: {
        architecture: arch,
        macos_version: '15.7.3',
        codex_version: CODEX_VERSION,
        node_version: '22.18.0',
      },
      checks: checks.map((name) => ({ name, ok: true })),
      cleanup_confirmed: true,
      cleanup_intervention_required: false,
      ...(sandbox ? { shared_temp_isolation: 'exposed' } : {}),
    });
  };
  const architectures = (['arm64', 'x64'] as const).map((architecture) => ({
    architecture,
    macos_version: '15.7.3',
    loader: smoke(architecture),
    sandbox_canary: canary(architecture, 'sandbox'),
    proof_network_canary: canary(architecture, 'proof-network'),
  }));
  const emptyListResponse = {
    schema_version: 1,
    ok: true,
    runs: [],
    truncated: false,
    summary: 'No runs.',
  };
  const noConsent = session([
    ...mcpCall('list-before', 'circuit_list', {}, emptyListResponse),
    ...mcpCall(
      'no-consent',
      'circuit_start',
      { flow: 'explore', goal: 'Search without consent', web_search: 'cached' },
      {
        schema_version: 1,
        ok: false,
        error: {
          code: 'invalid_request',
          message: CONSENT_ERROR,
        },
      },
    ),
    ...mcpCall('list-after', 'circuit_list', {}, emptyListResponse),
  ]);
  const matrix = {
    schema_version: 1,
    source: {
      repository: 'petekp/circuit',
      ref: CANDIDATE,
      expected_version: VERSION,
      plugin_tree_sha256: TREE,
    },
    stable_codex_version: CODEX_VERSION,
    spend: {
      hard_cap_usd: 50,
      stop_at_usd: 45,
      provider_reported_usd: 12.34,
      input_tokens: 1000,
      output_tokens: 500,
    },
    architectures,
    runs,
    negative_checks: {
      no_consent_search: {
        architecture: 'arm64',
        workspace_sha256: hash(WORKSPACE),
        host_trace: write('negative/no-consent.jsonl', noConsent, true),
        invocation: write('negative/no-consent-invocation.json', invocation('arm64')),
      },
    },
  };
  return {
    root,
    matrix,
    rewrite: write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const expected = (root: string) => ({
  proofRoot: root,
  repository: 'petekp/circuit',
  candidateRef: CANDIDATE,
  pluginVersion: VERSION,
  pluginTreeSha256: TREE,
  codexVersion: CODEX_VERSION,
  validateTraceEntry: (value: unknown) => TraceEntry.safeParse(value).success,
  validateFlowResult: (schema: string, value: unknown) => {
    const schemas = {
      'review.result@v1': ReviewResult,
      'fix.result@v1': FixResult,
      'build.result@v1': BuildResult,
      'explore.result@v1': ExploreResult,
      'prototype.result@v1': PrototypeResult,
    } as const;
    return schemas[schema as keyof typeof schemas]?.safeParse(value).success === true;
  },
});

describe('Codex MCP release candidate matrix', () => {
  it('loads under the same direct Node execution used by the release gate', () => {
    const loaded = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "await import('./scripts/release/codex-mcp-candidate-matrix.ts')",
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(loaded.status, loaded.stderr).toBe(0);
  });

  it('is a distinct release gate before candidate_host_proven can be set', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const publish = readFileSync('scripts/plugins/publish.ts', 'utf8');
    expect(packageJson.scripts['check-release-infra:nobuild']).toContain(
      'check-codex-mcp-candidate-matrix.ts',
    );
    expect(publish.indexOf("runCommand('check_release_ready'")).toBeLessThan(
      publish.indexOf('candidate_host_proven = true'),
    );
  });

  it('accepts all required flows, both Mac architectures, search, and negative gates', () => {
    const proof = fixture();
    try {
      expect(validateCodexMcpCandidateMatrix(proof.matrix, expected(proof.root))).toEqual([]);
    } finally {
      proof.cleanup();
    }
  });

  it.each([
    [
      'missing required fields',
      'fix',
      (value: Record<string, unknown>): void => {
        value.summary = undefined;
      },
    ],
    [
      'unknown fields',
      'build',
      (value: Record<string, unknown>): void => {
        value.unexpected = true;
      },
    ],
  ] as const)('rejects flow results with %s', (_case, runId, mutate) => {
    const proof = fixture();
    try {
      const matrix = proof.matrix as {
        runs: Array<{
          id: string;
          flow_result_schema: string;
          flow_result: { path: string; sha256: string };
        }>;
      };
      const lane = matrix.runs.find((run) => run.id === runId);
      if (lane === undefined) throw new Error(`fixture is missing ${runId}`);
      const result = JSON.parse(
        readFileSync(join(proof.root, lane.flow_result.path), 'utf8'),
      ) as Record<string, unknown>;
      mutate(result);
      lane.flow_result = proof.rewrite(lane.flow_result.path, result);

      expect(validateCodexMcpCandidateMatrix(matrix, expected(proof.root))).toContain(
        `${runId} flow result does not match the ${lane.flow_result_schema} contract`,
      );
    } finally {
      proof.cleanup();
    }
  });

  it('rejects generic evidence that is not bound to the exact flow, host, and rejected request', () => {
    const proof = fixture();
    try {
      const matrix = proof.matrix as {
        architectures: Array<{
          architecture: string;
          sandbox_canary: { path: string; sha256: string };
        }>;
        runs: Array<{
          id: string;
          flow_result_schema?: string | undefined;
          flow_result?: { path: string; sha256: string } | undefined;
          host_traces: Array<{ path: string; sha256: string }>;
        }>;
        negative_checks: {
          no_consent_search: {
            host_trace: { path: string; sha256: string };
          };
        };
      };
      const review = matrix.runs.find((run) => run.id === 'review');
      const tournament = matrix.runs.find((run) => run.id === 'prototype-tournament');
      const arm = matrix.architectures.find((entry) => entry.architecture === 'arm64');
      if (!review || !tournament || !arm) throw new Error('fixture is incomplete');
      review.flow_result_schema = undefined;
      review.flow_result = undefined;
      arm.sandbox_canary = proof.rewrite('architectures/arm64/sandbox.json', {
        success: true,
        numFailedTests: 0,
        numPassedTests: 1,
      });

      const restartEvents = readFileSync(
        join(proof.root, tournament.host_traces[1]?.path ?? ''),
        'utf8',
      )
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const event of restartEvents) {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.tool !== 'circuit_list') continue;
        const result = item.result as Record<string, unknown> | undefined;
        const structured = result?.structured_content as Record<string, unknown> | undefined;
        if (structured !== undefined) structured.runs = [];
      }
      tournament.host_traces[1] = proof.rewrite(
        'runs/prototype-tournament/host-2.jsonl',
        `${restartEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        true,
      );

      matrix.negative_checks.no_consent_search.host_trace = proof.rewrite(
        'negative/no-consent.jsonl',
        session(
          mcpCall(
            'no-consent',
            'circuit_start',
            { flow: 'explore', goal: 'Search without consent', web_search: 'cached' },
            {
              schema_version: 1,
              ok: false,
              error: {
                code: 'internal_error',
                message: 'Circuit could not complete this request safely.',
              },
            },
          ),
        ),
        true,
      );
      expect(validateCodexMcpCandidateMatrix(proof.matrix, expected(proof.root))).toEqual(
        expect.arrayContaining([
          'review is missing flow-specific result evidence',
          'arm64 sandbox canary does not match the exact candidate and host',
          'prototype-tournament circuit_list did not contain the waiting run',
          'no-consent cached search did not prove the exact consent rejection without run creation',
        ]),
      );
    } finally {
      proof.cleanup();
    }
  });

  it('rejects a missing flow, excess spend, or a tampered artifact', () => {
    const proof = fixture();
    try {
      const matrix = proof.matrix as {
        runs: Array<{ id: string; run_result: { sha256: string } }>;
        spend: { provider_reported_usd: number };
      };
      matrix.runs = matrix.runs.filter((run) => run.id !== 'build');
      matrix.spend.provider_reported_usd = 46;
      const firstRun = matrix.runs[0];
      if (firstRun === undefined) throw new Error('fixture is missing candidate runs');
      firstRun.run_result.sha256 = 'f'.repeat(64);
      expect(validateCodexMcpCandidateMatrix(matrix, expected(proof.root))).toEqual(
        expect.arrayContaining([
          'candidate matrix must contain build exactly once',
          'candidate matrix provider-reported spend must not exceed $45',
          'review run result digest does not match its artifact',
        ]),
      );
    } finally {
      proof.cleanup();
    }
  });

  it('rejects a retried flow, shell fallback, missing restart recovery, or absent search event', () => {
    const proof = fixture();
    try {
      const matrix = proof.matrix as {
        runs: Array<{
          id: string;
          host_traces: Array<{ path: string; sha256: string }>;
          circuit_trace?: { path: string; sha256: string };
        }>;
      };
      const review = matrix.runs.find((run) => run.id === 'review');
      if (review === undefined) throw new Error('fixture is missing Review');
      const duplicate = session([
        ...mcpCall(
          'start-two',
          'circuit_start',
          { flow: 'review', goal: 'Retry' },
          {
            schema_version: 1,
            ok: true,
            run_id: '11111111-1111-4111-8111-000000000001',
            state: 'starting',
          },
        ),
        {
          type: 'item.completed',
          item: { id: 'shell', type: 'command_execution', command: 'bin/circuit run review' },
        },
      ]);
      review.host_traces.push(proof.rewrite('runs/review/retry.jsonl', duplicate, true));
      const tournament = matrix.runs.find((run) => run.id === 'prototype-tournament');
      if (tournament === undefined) throw new Error('fixture is missing Prototype tournament');
      tournament.host_traces = tournament.host_traces.slice(0, 1);
      const search = matrix.runs.find((run) => run.id === 'cached-search-explore');
      if (search === undefined) throw new Error('fixture is missing cached-search Explore');
      search.circuit_trace = proof.rewrite(
        'runs/cached-search-explore/trace.ndjson',
        `${JSON.stringify({ kind: 'relay.receipt', web_search_count: 0 })}\n`,
        true,
      );

      expect(validateCodexMcpCandidateMatrix(matrix, expected(proof.root))).toEqual(
        expect.arrayContaining([
          'review must contain exactly one successful circuit_start',
          'review host trace contains shell or file-change work',
          'prototype-tournament must prove a Codex host restart',
          'cached-search-explore did not record a nested Codex search event',
        ]),
      );
    } finally {
      proof.cleanup();
    }
  });

  it('rejects a cached-search trace entry outside the durable TraceEntry contract', () => {
    const proof = fixture();
    try {
      const matrix = proof.matrix as {
        runs: Array<{
          id: string;
          circuit_trace?: { path: string; sha256: string };
        }>;
      };
      const search = matrix.runs.find((run) => run.id === 'cached-search-explore');
      if (search?.circuit_trace === undefined) {
        throw new Error('fixture is missing cached-search Explore trace');
      }
      const original = readFileSync(join(proof.root, search.circuit_trace.path), 'utf8');
      search.circuit_trace = proof.rewrite(
        'runs/cached-search-explore/trace.ndjson',
        `${original}${JSON.stringify({
          schema_version: 1,
          sequence: 3,
          recorded_at: '2026-07-22T12:00:02.000Z',
          run_id: '11111111-1111-4111-8111-000000000008',
          kind: 'relay.unrecognized',
        })}\n`,
        true,
      );

      expect(validateCodexMcpCandidateMatrix(matrix, expected(proof.root))).toContain(
        'cached-search-explore Circuit trace line 3 does not match the TraceEntry contract',
      );
    } finally {
      proof.cleanup();
    }
  });

  it.each([
    [
      'shell fallback',
      {
        type: 'item.completed',
        item: {
          id: 'shell-fallback',
          type: 'command_execution',
          command: 'bin/circuit run explore',
        },
      },
    ],
    [
      'file changes',
      { type: 'item.completed', item: { id: 'edit', type: 'file_change', path: 'src/app.ts' } },
    ],
    [
      'a non-Circuit MCP call',
      {
        type: 'item.completed',
        item: { id: 'other', type: 'mcp_tool_call', server: 'other', tool: 'diagnose' },
      },
    ],
    [
      'an unpaired Circuit call',
      {
        type: 'item.completed',
        item: { id: 'unpaired', type: 'mcp_tool_call', server: 'circuit', tool: 'circuit_list' },
      },
    ],
    ['a malformed item', { type: 'item.completed', item: { type: 'mcp_tool_call' } }],
  ] as const)('rejects %s in the no-consent search proof', (_label, extraEvent) => {
    const proof = fixture();
    try {
      const matrix = proof.matrix as {
        negative_checks: {
          no_consent_search: { host_trace: { path: string; sha256: string } };
        };
      };
      const trace = matrix.negative_checks.no_consent_search.host_trace;
      const events = readFileSync(join(proof.root, trace.path), 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      events.splice(-1, 0, extraEvent);
      matrix.negative_checks.no_consent_search.host_trace = proof.rewrite(
        'negative/no-consent.jsonl',
        `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
        true,
      );

      expect(validateCodexMcpCandidateMatrix(matrix, expected(proof.root))).toContain(
        'no-consent search trace contains unsafe or unrelated host work',
      );
    } finally {
      proof.cleanup();
    }
  });

  it('rejects an extra paired failed start in the no-consent search proof', () => {
    const proof = fixture();
    try {
      const matrix = proof.matrix as {
        negative_checks: {
          no_consent_search: { host_trace: { path: string; sha256: string } };
        };
      };
      const trace = matrix.negative_checks.no_consent_search.host_trace;
      const events = readFileSync(join(proof.root, trace.path), 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      events.splice(
        -1,
        0,
        ...mcpCall(
          'extra-failed-start',
          'circuit_start',
          { flow: 'explore', goal: 'Retry without search', web_search: 'off' },
          {
            schema_version: 1,
            ok: false,
            error: {
              code: 'internal_error',
              message: 'Circuit could not complete this request safely.',
            },
          },
        ),
      );
      matrix.negative_checks.no_consent_search.host_trace = proof.rewrite(
        'negative/no-consent.jsonl',
        `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
        true,
      );

      expect(validateCodexMcpCandidateMatrix(matrix, expected(proof.root))).toContain(
        'no-consent search trace contains unsafe or unrelated host work',
      );
    } finally {
      proof.cleanup();
    }
  });

  it('rejects unrelated invocation, flow report, checkpoint, consent, and cleanup evidence', () => {
    const proof = fixture();
    try {
      const matrix = proof.matrix as {
        runs: Array<{
          id: string;
          architecture: string;
          workspace_sha256: string;
          host_traces: Array<{ path: string; sha256: string }>;
          invocations: Array<{ path: string; sha256: string }>;
        }>;
      };
      const review = matrix.runs.find((run) => run.id === 'review');
      const fix = matrix.runs.find((run) => run.id === 'fix');
      const build = matrix.runs.find((run) => run.id === 'build');
      const explore = matrix.runs.find((run) => run.id === 'explore');
      const prototype = matrix.runs.find((run) => run.id === 'prototype');
      const cached = matrix.runs.find((run) => run.id === 'cached-search-explore');
      if (!review || !fix || !build || !explore || !prototype || !cached) {
        throw new Error('fixture is incomplete');
      }

      review.invocations[0] = proof.rewrite('runs/review/invocation-1.json', {
        ...invocation('arm64'),
        source: { ...(invocation('arm64').source as object), ref: 'd'.repeat(40) },
      });
      fix.architecture = 'arm64';
      build.workspace_sha256 = hash('/private/tmp/unrelated-workspace');
      const wrongCodex = invocation('x64');
      (wrongCodex.host as Record<string, unknown>).codex_version = '0.144.0';
      explore.invocations[0] = proof.rewrite('runs/explore/invocation-1.json', wrongCodex);
      prototype.host_traces[0] = proof.rewrite(
        'runs/prototype/host.jsonl',
        session([
          ...mcpCall(
            'start',
            'circuit_start',
            { flow: 'prototype', goal: 'Prove prototype', web_search: 'off' },
            {
              schema_version: 1,
              ok: true,
              run_id: '11111111-1111-4111-8111-000000000006',
              state: 'starting',
            },
          ),
          ...mcpCall(
            'checkpoint-status',
            'circuit_status',
            { run_id: '11111111-1111-4111-8111-000000000006' },
            {
              schema_version: 1,
              ok: true,
              run_id: '11111111-1111-4111-8111-000000000006',
              state: 'waiting_for_input',
              checkpoint: { token: 'different-token', choices: [{ id: 'different-choice' }] },
            },
          ),
          ...mcpCall(
            'resume',
            'circuit_resume',
            {
              run_id: '11111111-1111-4111-8111-000000000006',
              checkpoint_token: 'checkpoint-token-1234',
              choice_id: 'option-1',
            },
            {
              schema_version: 1,
              ok: true,
              run_id: '11111111-1111-4111-8111-000000000006',
              state: 'resuming',
            },
          ),
          ...mcpCall(
            'status',
            'circuit_status',
            { run_id: '11111111-1111-4111-8111-000000000006' },
            {
              schema_version: 1,
              ok: true,
              run_id: '11111111-1111-4111-8111-000000000006',
              state: 'complete',
              final_report: {
                schema: 'circuit.review.result',
                data: result('11111111-1111-4111-8111-000000000006', 'prototype'),
              },
            },
          ),
        ]),
        true,
      );
      cached.host_traces[0] = proof.rewrite(
        'runs/cached-search-explore/host.jsonl',
        session(
          mcpCall(
            'start',
            'circuit_start',
            { flow: 'explore', goal: 'Search', web_search: 'cached' },
            {
              schema_version: 1,
              ok: true,
              run_id: '11111111-1111-4111-8111-000000000008',
              state: 'starting',
            },
          ),
        ),
        true,
      );
      const cleanup = invocation('x64');
      cleanup.cleanup_intervention_required = true;
      cached.invocations[0] = proof.rewrite(
        'runs/cached-search-explore/invocation-1.json',
        cleanup,
      );

      expect(validateCodexMcpCandidateMatrix(matrix, expected(proof.root))).toEqual(
        expect.arrayContaining([
          'review invocation 1 does not match the exact release candidate',
          'fix invocation 1 does not match the recorded host',
          'build invocation 1 does not match the exact fixture workspace',
          'explore invocation 1 does not match the recorded host',
          'prototype checkpoint resume does not match its advertised checkpoint',
          'prototype terminal MCP report has the wrong flow schema',
          'cached-search-explore circuit_start has the wrong search consent policy',
          'cached-search-explore invocation 1 did not exit successfully with natural cleanup',
        ]),
      );
    } finally {
      proof.cleanup();
    }
  });
});
