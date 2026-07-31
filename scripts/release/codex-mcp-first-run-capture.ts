import { createHash } from 'node:crypto';

import { hashCanonicalWorkspace } from './codex-invocation-evidence.ts';

/**
 * Pure assembly half of the Codex MCP first-run proof producer.
 *
 * Everything here is deterministic and unit-testable: trusted-hook trust
 * material, host-trace extraction, invocation evidence, and rendering the
 * digest-bound proof bundle. The live half (spawning real Codex) lives in
 * capture-codex-mcp-first-run-proof.ts and consumes these functions.
 */

export interface CodexPermissionHook {
  readonly matcher: string;
  readonly command: string;
  readonly timeoutSeconds?: number;
}

const CODEX_DEFAULT_HOOK_TIMEOUT_SECONDS = 600;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedHookTimeout(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds === undefined) return CODEX_DEFAULT_HOOK_TIMEOUT_SECONDS;
  return Math.max(1, Math.floor(timeoutSeconds));
}

/**
 * Codex trusts a configured hook only when config.toml carries a hash of the
 * hook's normalized identity. This mirrors the Rust normalization on Codex
 * 0.146.0 (verified byte-identical against a live bench hash); a mismatch is
 * loud in practice because an untrusted hook is silently skipped and the
 * capture then fails on a cancelled tool call.
 */
export function codexHookTrustedHash(hook: CodexPermissionHook): string {
  const identity = {
    event_name: 'permission_request',
    matcher: hook.matcher,
    hooks: [
      {
        type: 'command',
        command: hook.command,
        timeout: normalizedHookTimeout(hook.timeoutSeconds),
        async: false,
      },
    ],
  };
  return `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`;
}

export function codexHookStateKey(hooksJsonPath: string): string {
  return `${hooksJsonPath}:permission_request:0:0`;
}

export function renderCodexHooksJson(hook: CodexPermissionHook): string {
  const document = {
    hooks: {
      PermissionRequest: [
        {
          matcher: hook.matcher,
          hooks: [
            {
              type: 'command',
              command: hook.command,
              timeout: normalizedHookTimeout(hook.timeoutSeconds),
            },
          ],
        },
      ],
    },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function renderCodexHookTrustToml(hooksJsonPath: string, hook: CodexPermissionHook): string {
  return `\n[hooks.state."${codexHookStateKey(hooksJsonPath)}"]\ntrusted_hash = "${codexHookTrustedHash(hook)}"\n`;
}

export interface ParsedFirstRunTrace {
  readonly runId?: string;
  readonly finalReportData?: Record<string, unknown>;
  readonly issues: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Pull the run identity and the terminal report out of a Codex exec --json
 * event stream. This is a lenient reader: the release validator is the
 * enforcer, so this only extracts what the producer needs and reports what
 * is missing in plain language.
 */
export function parseFirstRunHostTrace(traceText: string): ParsedFirstRunTrace {
  const issues: string[] = [];
  let runId: string | undefined;
  let finalReportData: Record<string, unknown> | undefined;
  for (const line of traceText.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(line) as unknown);
    } catch {
      continue;
    }
    if (event?.type !== 'item.completed') continue;
    const item = record(event.item);
    if (item?.type !== 'mcp_tool_call' || item.server !== 'circuit') continue;
    const response = record(record(item.result)?.structured_content);
    if (response?.ok !== true) continue;
    if (item.tool === 'circuit_start' && typeof response.run_id === 'string') {
      runId ??= response.run_id;
    }
    if (item.tool === 'circuit_status' && response.state === 'complete') {
      finalReportData = record(record(response.final_report)?.data);
    }
  }
  if (runId === undefined) {
    issues.push('the host trace has no successful circuit_start response');
  }
  if (finalReportData === undefined) {
    issues.push('the host trace has no completed circuit_status with final report data');
  }
  return {
    ...(runId === undefined ? {} : { runId }),
    ...(finalReportData === undefined ? {} : { finalReportData }),
    issues,
  };
}

export interface FirstRunInvocationInput {
  readonly argv: readonly string[];
  readonly workspacePath: string;
  readonly source: {
    readonly repository: string;
    readonly ref: string;
    readonly expected_version: string;
    readonly plugin_tree_sha256: string;
  };
  readonly host: {
    readonly architecture: 'arm64' | 'x64';
    readonly macos_version: string;
    readonly codex_version: string;
    readonly node_version: string;
  };
  readonly exitCode: number;
  readonly cleanupConfirmed: boolean;
  readonly cleanupInterventionRequired: boolean;
}

export function buildFirstRunInvocation(input: FirstRunInvocationInput): Record<string, unknown> {
  return {
    schema_version: 1,
    argv: [...input.argv],
    workspace_sha256: hashCanonicalWorkspace(input.workspacePath),
    source: input.source,
    host: input.host,
    exit_code: input.exitCode,
    cleanup_confirmed: input.cleanupConfirmed,
    cleanup_intervention_required: input.cleanupInterventionRequired,
  };
}

export interface FirstRunEvidenceItem {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface FirstRunCaptureBundle {
  readonly reason: string;
  readonly source: {
    readonly repository: string;
    readonly ref: string;
    readonly expected_version: string;
  };
  readonly versions: {
    readonly node: string;
    readonly codex: string;
    readonly plugin: string;
    readonly plugin_tree_sha256: string;
    readonly architecture: 'arm64' | 'x64';
    readonly macos: string;
  };
  readonly evidence: readonly FirstRunEvidenceItem[];
  readonly review: {
    readonly run_id: string;
    readonly workspacePath: string;
  };
  readonly artifacts: {
    readonly runResult: unknown;
    readonly reviewReport: unknown;
    readonly hostTraceText: string;
    readonly invocation: unknown;
  };
}

export interface RenderedProofFile {
  readonly path: string;
  readonly text: string;
}

export interface RenderedProofBundle {
  readonly files: readonly RenderedProofFile[];
  readonly evidenceText: string;
}

const RUN_RESULT_PATH = 'review/result.json';
const REVIEW_REPORT_PATH = 'review/review-result.json';
const HOST_TRACE_PATH = 'review/codex.jsonl';
const INVOCATION_PATH = 'review/invocation.json';

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digestReference(path: string, text: string): { path: string; sha256: string } {
  return { path, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

/**
 * Render the complete proof bundle in memory: the four digest-bound Review
 * artifacts plus evidence.json referencing them. Pure so callers can scan the
 * rendered bytes for private text before anything touches disk.
 */
export function renderFirstRunProofBundle(bundle: FirstRunCaptureBundle): RenderedProofBundle {
  const runResultText = jsonText(bundle.artifacts.runResult);
  const reviewReportText = jsonText(bundle.artifacts.reviewReport);
  const hostTraceText = bundle.artifacts.hostTraceText.endsWith('\n')
    ? bundle.artifacts.hostTraceText
    : `${bundle.artifacts.hostTraceText}\n`;
  const invocationText = jsonText(bundle.artifacts.invocation);
  const evidence = {
    schema_version: 1,
    host: 'codex',
    surface: 'mcp',
    mode: 'published',
    status: 'pass',
    proof_stage: 'candidate',
    reason: bundle.reason,
    source: bundle.source,
    versions: bundle.versions,
    evidence: bundle.evidence,
    review: {
      run_id: bundle.review.run_id,
      workspace_sha256: hashCanonicalWorkspace(bundle.review.workspacePath),
      run_result: digestReference(RUN_RESULT_PATH, runResultText),
      review_report: digestReference(REVIEW_REPORT_PATH, reviewReportText),
      host_trace: digestReference(HOST_TRACE_PATH, hostTraceText),
      invocation: digestReference(INVOCATION_PATH, invocationText),
    },
  };
  return {
    files: [
      { path: RUN_RESULT_PATH, text: runResultText },
      { path: REVIEW_REPORT_PATH, text: reviewReportText },
      { path: HOST_TRACE_PATH, text: hostTraceText },
      { path: INVOCATION_PATH, text: invocationText },
      { path: 'evidence.json', text: jsonText(evidence) },
    ],
    evidenceText: jsonText(evidence),
  };
}

export interface ForbiddenText {
  readonly label: string;
  readonly value: string;
}

/**
 * The committed bundle must not carry machine-private paths. The fixture
 * workspace path is deliberately publishable; home directories and bench
 * roots are not.
 */
export function scanRenderedBundleForPrivateText(
  rendered: RenderedProofBundle,
  forbidden: readonly ForbiddenText[],
): string[] {
  const findings: string[] = [];
  for (const file of rendered.files) {
    for (const item of forbidden) {
      if (item.value.length > 0 && file.text.includes(item.value)) {
        findings.push(`${file.path} contains ${item.label}`);
      }
    }
  }
  return findings;
}
