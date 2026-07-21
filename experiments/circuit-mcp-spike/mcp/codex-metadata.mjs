import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODEX_SANDBOX_METADATA_KEY = 'codex/sandbox-state-meta';
export const CODEX_SANDBOX_METADATA_CONTRACT = 'sandbox-cwd-v1';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function observedCodexMetadataKeys(params) {
  const metadata = isRecord(params?._meta) ? params._meta : {};
  return Object.keys(metadata)
    .filter((key) => key.startsWith('codex/'))
    .sort();
}

/**
 * Pure compatibility check for Codex's private per-tool-call metadata.
 *
 * Additive fields are allowed. The spike depends on only one field, and fails
 * closed when that field or its private key changes.
 */
export function inspectCodexSandboxMetadata(params) {
  const observedKeys = observedCodexMetadataKeys(params);
  const outerMetadata = isRecord(params?._meta) ? params._meta : undefined;
  if (outerMetadata === undefined || !hasOwn(outerMetadata, CODEX_SANDBOX_METADATA_KEY)) {
    return {
      compatible: false,
      contract: CODEX_SANDBOX_METADATA_CONTRACT,
      metadata_key: CODEX_SANDBOX_METADATA_KEY,
      reason: `missing ${CODEX_SANDBOX_METADATA_KEY}`,
      observed_codex_keys: observedKeys,
    };
  }

  const sandboxMetadata = outerMetadata[CODEX_SANDBOX_METADATA_KEY];
  if (!isRecord(sandboxMetadata) || !hasOwn(sandboxMetadata, 'sandboxCwd')) {
    return {
      compatible: false,
      contract: CODEX_SANDBOX_METADATA_CONTRACT,
      metadata_key: CODEX_SANDBOX_METADATA_KEY,
      reason: `${CODEX_SANDBOX_METADATA_KEY} must be an object with its own sandboxCwd field`,
      observed_codex_keys: observedKeys,
    };
  }

  const sandboxCwd = sandboxMetadata.sandboxCwd;
  if (typeof sandboxCwd !== 'string' || sandboxCwd.length === 0) {
    return {
      compatible: false,
      contract: CODEX_SANDBOX_METADATA_CONTRACT,
      metadata_key: CODEX_SANDBOX_METADATA_KEY,
      reason: `${CODEX_SANDBOX_METADATA_KEY}.sandboxCwd must be a non-empty string`,
      observed_codex_keys: observedKeys,
    };
  }

  return {
    compatible: true,
    contract: CODEX_SANDBOX_METADATA_CONTRACT,
    metadata_key: CODEX_SANDBOX_METADATA_KEY,
    sandbox_cwd: sandboxCwd,
    observed_fields: Object.keys(sandboxMetadata).sort(),
  };
}

function pathFromSandboxCwd(sandboxCwd) {
  if (path.isAbsolute(sandboxCwd)) return sandboxCwd;

  let workspaceUrl;
  try {
    workspaceUrl = new URL(sandboxCwd);
  } catch {
    throw new Error('Codex sandboxCwd is not an absolute path or valid file URL.');
  }
  if (workspaceUrl.protocol !== 'file:') {
    throw new Error('Codex sandboxCwd must use the file: protocol.');
  }
  if (
    workspaceUrl.username.length > 0 ||
    workspaceUrl.password.length > 0 ||
    workspaceUrl.search.length > 0 ||
    workspaceUrl.hash.length > 0
  ) {
    throw new Error('Codex sandboxCwd file URL must not contain credentials, a query, or a hash.');
  }
  return fileURLToPath(workspaceUrl);
}

export async function trustedWorkspaceFromCodexMetadata(params) {
  const canary = inspectCodexSandboxMetadata(params);
  if (!canary.compatible) {
    const observed = canary.observed_codex_keys.join(', ') || 'none';
    throw new Error(
      `Codex sandbox metadata is incompatible: ${canary.reason}. Observed Codex keys: ${observed}.`,
    );
  }

  const workspace = await realpath(pathFromSandboxCwd(canary.sandbox_cwd));
  const workspaceStat = await stat(workspace);
  if (!workspaceStat.isDirectory()) {
    throw new Error('Codex sandboxCwd does not name a directory.');
  }
  return { workspace, canary };
}
