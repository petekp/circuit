import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODEX_SANDBOX_METADATA_KEY = 'codex/sandbox-state-meta' as const;

export type CodexWorkspaceMetadataErrorCode =
  | 'workspace_metadata_missing'
  | 'workspace_metadata_invalid'
  | 'workspace_metadata_unsafe'
  | 'workspace_unavailable'
  | 'workspace_not_directory';

export class CodexWorkspaceMetadataError extends Error {
  readonly code: CodexWorkspaceMetadataErrorCode;
  readonly nextAction: string;

  constructor(
    code: CodexWorkspaceMetadataErrorCode,
    message: string,
    nextAction = 'Update Codex and retry from a real workspace directory.',
  ) {
    super(message);
    this.name = 'CodexWorkspaceMetadataError';
    this.code = code;
    this.nextAction = nextAction;
  }
}

export interface TrustedCodexWorkspace {
  readonly metadata_key: typeof CODEX_SANDBOX_METADATA_KEY;
  readonly workspace: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function sandboxCwdFromRequest(request: unknown): string {
  if (!isRecord(request) || !hasOwn(request, '_meta') || !isRecord(request._meta)) {
    throw new CodexWorkspaceMetadataError(
      'workspace_metadata_missing',
      `Codex did not provide ${CODEX_SANDBOX_METADATA_KEY} workspace metadata.`,
    );
  }

  const meta = request._meta;
  if (!hasOwn(meta, CODEX_SANDBOX_METADATA_KEY)) {
    throw new CodexWorkspaceMetadataError(
      'workspace_metadata_missing',
      `Codex did not provide ${CODEX_SANDBOX_METADATA_KEY} workspace metadata.`,
    );
  }

  const sandboxState = meta[CODEX_SANDBOX_METADATA_KEY];
  if (!isRecord(sandboxState) || !hasOwn(sandboxState, 'sandboxCwd')) {
    throw new CodexWorkspaceMetadataError(
      'workspace_metadata_invalid',
      `Codex provided ${CODEX_SANDBOX_METADATA_KEY} in an unsupported shape.`,
    );
  }

  const sandboxCwd = sandboxState.sandboxCwd;
  if (typeof sandboxCwd !== 'string' || sandboxCwd.length === 0) {
    throw new CodexWorkspaceMetadataError(
      'workspace_metadata_invalid',
      'Codex workspace metadata must contain a non-empty sandboxCwd file URL.',
    );
  }
  return sandboxCwd;
}

function pathFromTrustedFileUrl(value: string): string {
  if (isAbsolute(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CodexWorkspaceMetadataError(
      'workspace_metadata_invalid',
      'Codex sandboxCwd must be an absolute path or file URL.',
    );
  }

  if (
    url.protocol !== 'file:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new CodexWorkspaceMetadataError(
      'workspace_metadata_invalid',
      'Codex sandboxCwd must be a local file URL without credentials, a host, a query, or a fragment.',
    );
  }

  try {
    // Marketplace-safe by host metadata: Codex supplies this absolute local
    // workspace URL for the current tool call; it is never package-relative.
    const path = fileURLToPath(url);
    if (path.length === 0 || !path.startsWith('/')) {
      throw new Error('not an absolute path');
    }
    return path;
  } catch {
    throw new CodexWorkspaceMetadataError(
      'workspace_metadata_invalid',
      'Codex sandboxCwd is not a valid local file URL.',
    );
  }
}

export async function resolveTrustedCodexWorkspace(
  request: unknown,
): Promise<TrustedCodexWorkspace> {
  const requestedPath = pathFromTrustedFileUrl(sandboxCwdFromRequest(request));

  let workspace: string;
  try {
    workspace = await realpath(requestedPath);
  } catch {
    throw new CodexWorkspaceMetadataError(
      'workspace_unavailable',
      'The workspace from Codex metadata does not exist or cannot be resolved.',
    );
  }
  if (workspace !== resolve(requestedPath)) {
    throw new CodexWorkspaceMetadataError(
      'workspace_metadata_unsafe',
      'The workspace from Codex metadata reaches the directory through a symbolic link.',
      'Open the real workspace directory in Codex and retry.',
    );
  }

  let workspaceStat: Awaited<ReturnType<typeof stat>>;
  try {
    workspaceStat = await stat(workspace);
  } catch {
    throw new CodexWorkspaceMetadataError(
      'workspace_unavailable',
      'The workspace from Codex metadata became unavailable while Circuit checked it.',
    );
  }
  if (!workspaceStat.isDirectory()) {
    throw new CodexWorkspaceMetadataError(
      'workspace_not_directory',
      'The workspace from Codex metadata is not a directory.',
    );
  }

  return {
    metadata_key: CODEX_SANDBOX_METADATA_KEY,
    workspace,
  };
}
