type ExpectedPlugin = {
  readonly pluginVersion: string;
  readonly pluginTreeSha256: string;
  readonly repository: string;
};

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

const SHA256 = /^[a-f0-9]{64}$/;
const FULL_GIT_SHA = /^[a-f0-9]{40}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
  if (typeof review?.run_id !== 'string' || review.run_id.length === 0) {
    issues.push('evidence is missing the Review run ID');
  }
  if (review?.status !== 'completed') {
    issues.push('Review evidence status must be completed');
  }
  if (review?.attempt_count !== 1) {
    issues.push('Review evidence must record exactly one attempt');
  }
  if (typeof review?.report_sha256 !== 'string' || !SHA256.test(review.report_sha256)) {
    issues.push('evidence is missing a valid Review report digest');
  }
  if (review?.mcp_only !== true || review?.shell_fallback !== false) {
    issues.push('Review evidence must prove MCP-only execution without shell fallback');
  }
  if (review?.sandbox_escalation !== false) {
    issues.push('Review evidence must prove no sandbox escalation');
  }
  return issues;
}
