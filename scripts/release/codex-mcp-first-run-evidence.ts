type ExpectedPlugin = {
  readonly pluginVersion: string;
  readonly pluginTreeSha256: string;
};

const REQUIRED_EVIDENCE = [
  'real_plugin_loader_completed',
  'tool_search_discovered_six_tools',
  'circuit_list_invoked',
  'trusted_workspace_metadata',
  'exact_workspace_identity',
  'private_control_state',
  'owned_process_cleanup',
] as const;

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

  const source = record(root.source);
  if (typeof source?.repository !== 'string' || source.repository.length === 0) {
    issues.push('evidence is missing the remote repository');
  }
  if (typeof source?.ref !== 'string' || source.ref.length === 0) {
    issues.push('evidence is missing the exact remote ref');
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
  return issues;
}
