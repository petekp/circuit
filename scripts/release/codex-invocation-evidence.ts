import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

type Architecture = 'arm64' | 'x64';

export interface ExpectedCodexInvocation {
  readonly workspaceSha256: string;
  readonly repository: string;
  readonly candidateRef: string;
  readonly pluginVersion: string;
  readonly pluginTreeSha256: string;
  readonly codexVersion: string;
  readonly architecture: Architecture;
  readonly macosVersion: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_COLORS = new Set(['always', 'never', 'auto']);
const ALLOWED_CONFIGS = new Set([
  'approval_policy="never"',
  'analytics.enabled=false',
  'check_for_update_on_startup=false',
]);
const INVOCATION_KEYS = new Set([
  'schema_version',
  'argv',
  'workspace_sha256',
  'source',
  'host',
  'exit_code',
  'cleanup_confirmed',
  'cleanup_intervention_required',
]);
const SOURCE_KEYS = new Set(['repository', 'ref', 'expected_version', 'plugin_tree_sha256']);
const HOST_KEYS = new Set(['architecture', 'macos_version', 'codex_version', 'node_version']);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(
  value: Record<string, unknown> | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  return value !== undefined && Object.keys(value).every((key) => allowed.has(key));
}

function supportedNodeVersion(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 18);
}

export function hashCanonicalWorkspace(workspace: string): string {
  return createHash('sha256').update(workspace, 'utf8').digest('hex');
}

function validateArgv(
  value: unknown,
  expectedWorkspaceSha256: string,
): { readonly boundaryIssues: string[]; readonly unapproved: boolean } {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return { boundaryIssues: ['arguments are malformed'], unapproved: true };
  }
  const argv = value as string[];
  if (argv[0] !== 'exec') return { boundaryIssues: ['command is not exec'], unapproved: true };
  let strictConfig = 0;
  let ephemeral = 0;
  let json = 0;
  let workspace = 0;
  let sandbox = 0;
  let approval = 0;
  let prompt = 0;
  let unapproved = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('-')) {
      prompt += 1;
      if (token.length === 0 || index !== argv.length - 1) unapproved = true;
      continue;
    }
    if (token === '--strict-config') {
      strictConfig += 1;
      continue;
    }
    if (token === '--ephemeral') {
      ephemeral += 1;
      continue;
    }
    if (token === '--json') {
      json += 1;
      continue;
    }
    if (token === '--skip-git-repo-check' || token === '--ignore-user-config') continue;
    if (token === '-C' || token === '--cd') {
      const path = argv[index + 1];
      index += 1;
      workspace += 1;
      if (
        path === undefined ||
        !isAbsolute(path) ||
        hashCanonicalWorkspace(path) !== expectedWorkspaceSha256
      ) {
        workspace += 100;
      }
      continue;
    }
    if (token === '-s' || token === '--sandbox') {
      const mode = argv[index + 1];
      index += 1;
      sandbox += 1;
      if (mode !== 'workspace-write') sandbox += 100;
      continue;
    }
    if (token === '-c' || token === '--config') {
      const config = argv[index + 1];
      index += 1;
      if (config === 'approval_policy="never"') approval += 1;
      else if (config === undefined || !ALLOWED_CONFIGS.has(config)) unapproved = true;
      continue;
    }
    if (token === '-m' || token === '--model') {
      const model = argv[index + 1];
      index += 1;
      if (model === undefined || !SAFE_MODEL.test(model)) unapproved = true;
      continue;
    }
    if (token === '--color') {
      const color = argv[index + 1];
      index += 1;
      if (color === undefined || !SAFE_COLORS.has(color)) unapproved = true;
      continue;
    }
    unapproved = true;
  }
  const boundaryIssues: string[] = [];
  if (strictConfig !== 1) boundaryIssues.push('exactly one strict-config flag is required');
  if (ephemeral !== 1) boundaryIssues.push('exactly one ephemeral flag is required');
  if (json !== 1) boundaryIssues.push('exactly one JSON flag is required');
  if (workspace !== 1) boundaryIssues.push('exactly one workspace must match the fixture');
  if (sandbox !== 1) boundaryIssues.push('exactly one workspace-write sandbox is required');
  if (approval !== 1) boundaryIssues.push('exactly one never-approve policy is required');
  if (prompt !== 1) boundaryIssues.push('exactly one recorded prompt is required');
  return { boundaryIssues, unapproved };
}

export function validateCodexInvocationEvidence(
  value: unknown,
  label: string,
  expected: ExpectedCodexInvocation,
): string[] {
  const issues: string[] = [];
  const invocation = record(value);
  const source = record(invocation?.source);
  const host = record(invocation?.host);
  if (
    invocation?.schema_version !== 1 ||
    !exactKeys(invocation, INVOCATION_KEYS) ||
    !SHA256.test(String(invocation.workspace_sha256 ?? ''))
  ) {
    issues.push(`${label} does not match the strict invocation evidence schema`);
  }
  if (
    !exactKeys(source, SOURCE_KEYS) ||
    source?.repository !== expected.repository ||
    source.ref !== expected.candidateRef ||
    !FULL_COMMIT.test(String(source.ref ?? '')) ||
    source.expected_version !== expected.pluginVersion ||
    source.plugin_tree_sha256 !== expected.pluginTreeSha256
  ) {
    issues.push(`${label} does not match the exact release candidate`);
  }
  if (
    !exactKeys(host, HOST_KEYS) ||
    host?.architecture !== expected.architecture ||
    host.macos_version !== expected.macosVersion ||
    host.codex_version !== expected.codexVersion ||
    !supportedNodeVersion(host.node_version)
  ) {
    issues.push(`${label} does not match the recorded host`);
  }
  if (
    invocation?.workspace_sha256 !== expected.workspaceSha256 ||
    !SHA256.test(expected.workspaceSha256)
  ) {
    issues.push(`${label} does not match the exact fixture workspace`);
  }
  if (
    invocation?.exit_code !== 0 ||
    invocation.cleanup_confirmed !== true ||
    invocation.cleanup_intervention_required !== false
  ) {
    issues.push(`${label} did not exit successfully with natural cleanup`);
  }
  const parsed = validateArgv(invocation?.argv, expected.workspaceSha256);
  for (const issue of parsed.boundaryIssues) issues.push(`${label} must use ${issue}`);
  if (parsed.unapproved) {
    issues.push(`${label} contains an unapproved Codex option or configuration`);
  }
  return issues;
}
