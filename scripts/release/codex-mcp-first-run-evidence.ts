import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { packageGitTreeSha256 } from '../plugins/package-tree.ts';
import { validateCodexInvocationEvidence } from './codex-invocation-evidence.ts';

type ExpectedPlugin = {
  readonly pluginVersion: string;
  readonly pluginTreeSha256: string;
  readonly repository: string;
  readonly proofRoot: string;
  /** Injected from built output so direct Node release checks never load raw src modules. */
  readonly validateRunResult: (value: unknown) => boolean;
  /** Injected from built output so direct Node release checks never load raw src modules. */
  readonly validateReviewResult: (value: unknown) => boolean;
};

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

const SHA256 = /^[a-f0-9]{64}$/;
const FULL_GIT_SHA = /^[a-f0-9]{40}$/;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_HOST_TRACE_BYTES = 2 * 1024 * 1024;
const NONFATAL_DIAGNOSTIC =
  'Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.';
const KNOWN_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'item.started',
  'item.updated',
  'item.completed',
  'turn.completed',
]);
const SAFE_NON_MCP_ITEMS = new Set([
  'agent_message',
  'reasoning',
  'todo_list',
  'tool_search',
  'tool_search_call',
  'error',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function validateCandidateGitBinding(input: {
  readonly repoRoot: string;
  readonly candidateRef: string;
  readonly headRef: string;
  readonly expectedPluginTreeSha256: string;
}): string[] {
  const issues: string[] = [];
  if (!FULL_GIT_SHA.test(input.candidateRef)) {
    return ['candidate evidence ref must be a full immutable Git commit SHA'];
  }
  const commit = spawnSync(
    'git',
    ['-C', input.repoRoot, 'cat-file', '-e', `${input.candidateRef}^{commit}`],
    { encoding: 'utf8' },
  );
  if (commit.error !== undefined || commit.status !== 0) {
    return ['candidate evidence commit does not exist'];
  }
  const ancestor = spawnSync(
    'git',
    ['-C', input.repoRoot, 'merge-base', '--is-ancestor', input.candidateRef, input.headRef],
    { encoding: 'utf8' },
  );
  if (ancestor.error !== undefined || ancestor.status !== 0) {
    issues.push('candidate evidence commit is not an ancestor of the release checkout');
  }
  try {
    if (
      packageGitTreeSha256(input.repoRoot, input.candidateRef, 'plugins/codex') !==
      input.expectedPluginTreeSha256
    ) {
      issues.push('candidate evidence plugin tree does not match the current release candidate');
    }
  } catch {
    issues.push('candidate evidence plugin tree could not be read safely');
  }
  return issues;
}

function artifactReference(
  value: unknown,
): { readonly path: string; readonly sha256: string } | undefined {
  const ref = record(value);
  return typeof ref?.path === 'string' && typeof ref.sha256 === 'string'
    ? { path: ref.path, sha256: ref.sha256 }
    : undefined;
}

function readBoundArtifact(input: {
  readonly root: string;
  readonly reference: unknown;
  readonly label: string;
  readonly maximumBytes: number;
  readonly issues: string[];
}): Buffer | undefined {
  const reference = artifactReference(input.reference);
  if (reference === undefined || !SHA256.test(reference.sha256)) {
    input.issues.push(`${input.label} reference must contain a safe path and SHA-256 digest`);
    return undefined;
  }
  const segments = reference.path.split('/');
  if (
    isAbsolute(reference.path) ||
    reference.path.includes('\\') ||
    reference.path.includes('\0') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    input.issues.push(`${input.label} path must stay inside the proof folder`);
    return undefined;
  }
  let cursor = input.root;
  try {
    for (const segment of segments.slice(0, -1)) {
      cursor = join(cursor, segment);
      const parent = lstatSync(cursor);
      if (!parent.isDirectory() || parent.isSymbolicLink()) {
        input.issues.push(`${input.label} path crosses a link or non-directory`);
        return undefined;
      }
    }
    const path = join(cursor, segments.at(-1) as string);
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size === 0 ||
      info.size > input.maximumBytes
    ) {
      input.issues.push(`${input.label} must be one bounded ordinary file`);
      return undefined;
    }
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
      input.issues.push(`${input.label} digest does not match its artifact`);
      return undefined;
    }
    return bytes;
  } catch {
    input.issues.push(`${input.label} artifact is missing or unreadable`);
    return undefined;
  }
}

function parseJsonArtifact(
  bytes: Buffer | undefined,
  label: string,
  issues: string[],
): unknown | undefined {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    issues.push(`${label} artifact is not valid JSON`);
    return undefined;
  }
}

function parseArguments(item: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof item.arguments === 'string') {
    try {
      return record(JSON.parse(item.arguments) as unknown);
    } catch {
      return undefined;
    }
  }
  return record(item.arguments);
}

function structuredContent(item: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(record(item.result)?.structured_content);
}

function validateHostTrace(
  bytes: Buffer | undefined,
  runId: string | undefined,
  runResult: unknown,
  issues: string[],
): void {
  if (bytes === undefined) return;
  const lines = bytes
    .toString('utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  const events: Record<string, unknown>[] = [];
  for (const [index, line] of lines.entries()) {
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(line) as unknown);
    } catch {
      // Report only the line number; captured model text may contain private source data.
    }
    if (event === undefined || typeof event.type !== 'string') {
      issues.push(`Review host trace line ${index + 1} is malformed`);
      continue;
    }
    if (!KNOWN_EVENT_TYPES.has(event.type)) {
      issues.push(`Review host trace line ${index + 1} has an unknown event type`);
    }
    events.push(event);
  }
  if (events[0]?.type !== 'thread.started' || events[1]?.type !== 'turn.started') {
    issues.push('Review host trace is missing its opening thread and turn events');
  }
  if (events.at(-1)?.type !== 'turn.completed') {
    issues.push('Review host trace is missing its terminal turn.completed event');
  }

  const started = new Map<string, Record<string, unknown>>();
  let startCalls = 0;
  let startCompletedAt = -1;
  let finalStatus: Record<string, unknown> | undefined;
  let unsafeWork = false;
  let unknownItem = false;
  let failedCall = false;
  for (const [index, event] of events.entries()) {
    if (!String(event.type).startsWith('item.')) continue;
    const item = record(event.item);
    if (item === undefined || typeof item.type !== 'string' || typeof item.id !== 'string') {
      issues.push(`Review host trace item at event ${index + 1} is malformed`);
      continue;
    }
    if (item.type === 'command_execution' || item.type === 'file_change') {
      unsafeWork = true;
      continue;
    }
    if (item.type !== 'mcp_tool_call') {
      if (!SAFE_NON_MCP_ITEMS.has(item.type)) unknownItem = true;
      if (item.type === 'error' && item.message !== NONFATAL_DIAGNOSTIC) failedCall = true;
      continue;
    }
    if (item.server !== 'circuit') {
      issues.push('Review host trace contains a non-Circuit MCP call');
      continue;
    }
    if (item.tool !== 'circuit_start' && item.tool !== 'circuit_status') {
      issues.push('Review host trace contains an unexpected Circuit tool call');
      continue;
    }
    if (event.type === 'item.started') {
      if (started.has(item.id)) issues.push('Review host trace duplicates an MCP start item ID');
      started.set(item.id, item);
      continue;
    }
    if (event.type !== 'item.completed') continue;
    const opening = started.get(item.id);
    if (opening === undefined || opening.server !== item.server || opening.tool !== item.tool) {
      issues.push('Review host trace has an unpaired MCP completion');
    } else {
      started.delete(item.id);
    }
    const response = structuredContent(item);
    if (
      response?.ok !== true ||
      item.error !== undefined ||
      record(item.result)?.is_error === true
    ) {
      failedCall = true;
      continue;
    }
    const args = parseArguments(item);
    if (item.tool === 'circuit_start') {
      if (args?.flow !== 'review' || (args.web_search !== undefined && args.web_search !== 'off')) {
        issues.push('Review circuit_start must select Review with web search off');
      }
      if (response.run_id !== runId)
        issues.push('Review circuit_start returned a different run ID');
      startCalls += 1;
      startCompletedAt = index;
    } else {
      if (startCompletedAt < 0 || index <= startCompletedAt) {
        issues.push('Review circuit_status completed before circuit_start');
      }
      if (args?.run_id !== runId || response.run_id !== runId) {
        issues.push('Review circuit_status used a different run ID');
      }
      if (response.state === 'complete') finalStatus = response;
    }
  }
  if (started.size > 0) issues.push('Review host trace has an MCP call without a completion');
  if (unsafeWork) issues.push('Review host trace contains shell or file-change work');
  if (unknownItem) issues.push('Review host trace contains an unknown item type');
  if (failedCall) issues.push('Review host trace contains a failed tool or diagnostic event');
  if (startCalls !== 1) {
    issues.push('Review host trace must contain exactly one successful circuit_start');
  }
  if (finalStatus === undefined) {
    issues.push('Review host trace has no successful terminal circuit_status');
  } else if (!isDeepStrictEqual(record(finalStatus.final_report)?.data, runResult)) {
    issues.push('Review terminal MCP report does not match the checked run result');
  }
}

export function validateCodexMcpFirstRunEvidence(
  value: unknown,
  expected: ExpectedPlugin,
): string[] {
  const issues: string[] = [];
  const root = record(value);
  if (root === undefined) return ['evidence must be a JSON object'];
  if (root.schema_version !== 1) issues.push('evidence schema_version must be 1');
  if (root.host !== 'codex' || root.surface !== 'mcp') {
    issues.push('evidence must describe the Codex MCP surface');
  }
  if (root.mode !== 'published') issues.push('evidence mode must be published');
  if (root.status !== 'pass') issues.push('evidence status must be pass');
  if (root.proof_stage !== 'candidate') {
    issues.push('evidence proof_stage must be candidate');
  }

  const source = record(root.source);
  if (source?.repository !== expected.repository) {
    issues.push(`evidence repository must be ${expected.repository}`);
  }
  if (typeof source?.ref !== 'string' || !FULL_GIT_SHA.test(source.ref)) {
    issues.push('candidate evidence ref must be a full immutable Git commit SHA');
  }
  if (source?.expected_version !== expected.pluginVersion) {
    issues.push('evidence source version does not match the current plugin');
  }

  const versions = record(root.versions);
  if (typeof versions?.node !== 'string' || versions.node.length === 0) {
    issues.push('evidence is missing the Node version');
  }
  if (typeof versions?.codex !== 'string' || versions.codex.length === 0) {
    issues.push('evidence is missing the Codex version');
  }
  if (versions?.plugin !== expected.pluginVersion) {
    issues.push(
      `evidence plugin version ${String(versions?.plugin ?? '<missing>')} does not match ${expected.pluginVersion}`,
    );
  }
  if (versions?.plugin_tree_sha256 !== expected.pluginTreeSha256) {
    issues.push('evidence plugin-tree digest does not match the current Codex plugin');
  }

  const evidence = Array.isArray(root.evidence) ? root.evidence : [];
  for (const name of REQUIRED_EVIDENCE) {
    const matching = evidence.filter((item) => {
      const entry = record(item);
      return entry?.name === name && entry.ok === true;
    });
    if (matching.length !== 1) {
      issues.push(`required evidence ${name} did not pass exactly once`);
    }
  }

  const review = record(root.review);
  const runId = typeof review?.run_id === 'string' ? review.run_id : undefined;
  if (runId === undefined || runId.length === 0)
    issues.push('evidence is missing the Review run ID');
  const runResultBytes = readBoundArtifact({
    root: expected.proofRoot,
    reference: review?.run_result,
    label: 'Review run result',
    maximumBytes: MAX_JSON_BYTES,
    issues,
  });
  const reviewReportBytes = readBoundArtifact({
    root: expected.proofRoot,
    reference: review?.review_report,
    label: 'Review flow report',
    maximumBytes: MAX_JSON_BYTES,
    issues,
  });
  const hostTraceBytes = readBoundArtifact({
    root: expected.proofRoot,
    reference: review?.host_trace,
    label: 'Review host trace',
    maximumBytes: MAX_HOST_TRACE_BYTES,
    issues,
  });
  const invocationBytes = readBoundArtifact({
    root: expected.proofRoot,
    reference: review?.invocation,
    label: 'Review invocation',
    maximumBytes: MAX_JSON_BYTES,
    issues,
  });

  const runResultValue = parseJsonArtifact(runResultBytes, 'Review run result', issues);
  const parsedRunResult = record(runResultValue);
  const runResultValid = expected.validateRunResult(runResultValue);
  if (!runResultValid || parsedRunResult === undefined) {
    issues.push('Review run result does not match the RunResult contract');
  } else if (
    parsedRunResult.run_id !== runId ||
    parsedRunResult.flow_id !== 'review' ||
    parsedRunResult.outcome !== 'complete'
  ) {
    issues.push('Review run result must be the completed Review run named by the evidence');
  }
  const reviewReportValue = parseJsonArtifact(reviewReportBytes, 'Review flow report', issues);
  const parsedReviewReport = record(reviewReportValue);
  if (!expected.validateReviewResult(reviewReportValue) || parsedReviewReport === undefined) {
    issues.push('Review flow report does not match the ReviewResult contract');
  } else if (parsedReviewReport.outcome !== 'complete' || parsedReviewReport.verdict !== 'CLEAN') {
    issues.push('Review flow report must be a clean completed Review');
  }
  validateHostTrace(hostTraceBytes, runId, runResultValid ? parsedRunResult : undefined, issues);
  issues.push(
    ...validateCodexInvocationEvidence(
      parseJsonArtifact(invocationBytes, 'Review invocation', issues),
      'Review invocation',
      {
        workspaceSha256:
          typeof review?.workspace_sha256 === 'string' ? review.workspace_sha256 : '',
        repository: expected.repository,
        candidateRef: typeof source?.ref === 'string' ? source.ref : '',
        pluginVersion: expected.pluginVersion,
        pluginTreeSha256: expected.pluginTreeSha256,
        codexVersion: typeof versions?.codex === 'string' ? versions.codex : '',
        architecture: versions?.architecture === 'x64' ? 'x64' : 'arm64',
        macosVersion: typeof versions?.macos === 'string' ? versions.macos : '',
      },
    ),
  );
  return issues;
}
