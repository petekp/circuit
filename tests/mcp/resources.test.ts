import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_SANDBOX_METADATA_KEY,
  CodexWorkspaceMetadataError,
  resolveTrustedCodexWorkspace,
  resolveTrustedCodexWorkspaceFromSources,
} from '../../src/hosts/codex-mcp/resources.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'circuit-mcp-resources-'));
  roots.push(root);
  return await realpath(root);
}

function requestWithWorkspace(sandboxCwd: unknown): unknown {
  return {
    _meta: {
      [CODEX_SANDBOX_METADATA_KEY]: {
        sandboxCwd,
      },
    },
  };
}

async function expectMetadataError(input: unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    if (input instanceof Promise) {
      await input;
    } else {
      await resolveTrustedCodexWorkspace(input);
    }
  } catch (error) {
    expect(error).toBeInstanceOf(CodexWorkspaceMetadataError);
    expect((error as CodexWorkspaceMetadataError).code).toBe(code);
    return;
  }
  throw new Error('expected workspace metadata resolution to fail');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex workspace metadata', () => {
  it('reads the exact public metadata key and canonicalizes a real directory', async () => {
    const root = await temporaryRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace);

    const resolved = await resolveTrustedCodexWorkspace({
      request_id: 'additive-host-field',
      _meta: {
        host_version: '0.144.3',
        [CODEX_SANDBOX_METADATA_KEY]: {
          sandboxCwd: pathToFileURL(workspace).href,
          additive_host_field: true,
        },
      },
    });

    expect(resolved).toEqual({
      metadata_key: 'codex/sandbox-state-meta',
      workspace: await realpath(workspace),
    });
  });

  it('accepts the absolute-path form used by older Codex hosts', async () => {
    const workspace = await temporaryRoot();

    await expect(resolveTrustedCodexWorkspace(requestWithWorkspace(workspace))).resolves.toEqual({
      metadata_key: CODEX_SANDBOX_METADATA_KEY,
      workspace: await realpath(workspace),
    });
  });

  it('falls back to a single MCP root when Codex omits sandbox-state metadata', async () => {
    const workspace = await temporaryRoot();

    await expect(
      resolveTrustedCodexWorkspaceFromSources({
        metadata: undefined,
        listRoots: async () => [{ uri: pathToFileURL(workspace).href, name: 'workspace' }],
      }),
    ).resolves.toEqual({
      metadata_key: CODEX_SANDBOX_METADATA_KEY,
      workspace,
    });
  });

  it('does not fall back to MCP roots when Codex sends malformed sandbox-state metadata', async () => {
    const workspace = await temporaryRoot();
    let rootsRequested = false;

    await expectMetadataError(
      resolveTrustedCodexWorkspaceFromSources({
        metadata: { [CODEX_SANDBOX_METADATA_KEY]: { sandboxCwd: 'https://example.com/repo' } },
        listRoots: async () => {
          rootsRequested = true;
          return [{ uri: pathToFileURL(workspace).href }];
        },
      }),
      'workspace_metadata_invalid',
    );
    expect(rootsRequested).toBe(false);
  });

  it('rejects missing, ambiguous, malformed, and unsafe MCP roots', async () => {
    const root = await temporaryRoot();
    const workspace = join(root, 'workspace');
    const otherWorkspace = join(root, 'other-workspace');
    const alias = join(root, 'workspace-alias');
    await mkdir(workspace);
    await mkdir(otherWorkspace);
    await symlink(workspace, alias, 'dir');

    await expectMetadataError(
      resolveTrustedCodexWorkspaceFromSources({
        metadata: undefined,
        listRoots: async () => [],
      }),
      'workspace_metadata_missing',
    );
    await expectMetadataError(
      resolveTrustedCodexWorkspaceFromSources({
        metadata: undefined,
        listRoots: async () => [
          { uri: pathToFileURL(workspace).href },
          { uri: pathToFileURL(otherWorkspace).href },
        ],
      }),
      'workspace_metadata_invalid',
    );
    await expectMetadataError(
      resolveTrustedCodexWorkspaceFromSources({
        metadata: undefined,
        listRoots: async () => [{ uri: 'https://example.com/repo' }],
      }),
      'workspace_metadata_invalid',
    );
    await expectMetadataError(
      resolveTrustedCodexWorkspaceFromSources({
        metadata: undefined,
        listRoots: async () => [{ uri: pathToFileURL(alias).href }],
      }),
      'workspace_metadata_unsafe',
    );
  });

  it.each([
    undefined,
    null,
    {},
    { _meta: null },
    { _meta: {} },
    { _meta: { 'codex/sandbox_state_meta': { sandboxCwd: 'file:///tmp' } } },
  ])('rejects missing or renamed metadata %#', async (input) => {
    await expectMetadataError(input, 'workspace_metadata_missing');
  });

  it('rejects inherited _meta and inherited sandboxCwd properties', async () => {
    const root = await temporaryRoot();
    const workspaceUrl = pathToFileURL(root).href;
    const inheritedMeta = Object.create({
      [CODEX_SANDBOX_METADATA_KEY]: { sandboxCwd: workspaceUrl },
    });
    await expectMetadataError({ _meta: inheritedMeta }, 'workspace_metadata_missing');

    const inheritedWorkspace = Object.create({ sandboxCwd: workspaceUrl });
    await expectMetadataError(
      { _meta: { [CODEX_SANDBOX_METADATA_KEY]: inheritedWorkspace } },
      'workspace_metadata_invalid',
    );
  });

  it.each([
    'tmp/not-an-absolute-path',
    'https://example.com/workspace',
    'file://example.com/tmp/workspace',
    'file:///tmp/workspace?query=yes',
    'file:///tmp/workspace#fragment',
    42,
    null,
  ])('rejects an untrusted sandboxCwd shape: %j', async (sandboxCwd) => {
    await expectMetadataError(requestWithWorkspace(sandboxCwd), 'workspace_metadata_invalid');
  });

  it('rejects a metadata workspace path that reaches the directory through a symlink', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'real-workspace');
    const alias = join(root, 'workspace-alias');
    await mkdir(target);
    await symlink(target, alias, 'dir');

    await expectMetadataError(
      requestWithWorkspace(pathToFileURL(alias).href),
      'workspace_metadata_unsafe',
    );
  });

  it('rejects a workspace path whose parent component is a symlink', async () => {
    const root = await temporaryRoot();
    const realParent = join(root, 'real-parent');
    const aliasParent = join(root, 'alias-parent');
    const workspace = join(realParent, 'workspace');
    await mkdir(workspace, { recursive: true });
    await symlink(realParent, aliasParent, 'dir');

    await expectMetadataError(
      requestWithWorkspace(pathToFileURL(join(aliasParent, 'workspace')).href),
      'workspace_metadata_unsafe',
    );
  });

  it('rejects missing paths, broken symlinks, and ordinary files', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'file.txt');
    const brokenLink = join(root, 'broken-link');
    await writeFile(file, 'not a directory');
    await symlink(join(root, 'missing-target'), brokenLink, 'dir');

    await expectMetadataError(
      requestWithWorkspace(pathToFileURL(join(root, 'missing')).href),
      'workspace_unavailable',
    );
    await expectMetadataError(
      requestWithWorkspace(pathToFileURL(brokenLink).href),
      'workspace_unavailable',
    );
    await expectMetadataError(
      requestWithWorkspace(pathToFileURL(file).href),
      'workspace_not_directory',
    );
  });
});
