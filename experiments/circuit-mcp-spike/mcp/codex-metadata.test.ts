import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_SANDBOX_METADATA_KEY,
  inspectCodexSandboxMetadata,
  trustedWorkspaceFromCodexMetadata,
} from './codex-metadata.mjs';

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'circuit-mcp-metadata-')));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex sandbox metadata compatibility canary', () => {
  it('accepts additive fields while pinning the one workspace field Circuit uses', () => {
    expect(
      inspectCodexSandboxMetadata({
        _meta: {
          [CODEX_SANDBOX_METADATA_KEY]: {
            sandboxCwd: '/tmp/workspace',
            futureField: { added: true },
          },
        },
      }),
    ).toEqual({
      compatible: true,
      contract: 'sandbox-cwd-v1',
      metadata_key: CODEX_SANDBOX_METADATA_KEY,
      sandbox_cwd: '/tmp/workspace',
      observed_fields: ['futureField', 'sandboxCwd'],
    });
  });

  it('fails closed and reports a renamed private Codex key', () => {
    expect(
      inspectCodexSandboxMetadata({
        _meta: { 'codex/new-sandbox-meta': { sandboxCwd: '/tmp/workspace' } },
      }),
    ).toMatchObject({
      compatible: false,
      reason: 'missing codex/sandbox-state-meta',
      observed_codex_keys: ['codex/new-sandbox-meta'],
    });
  });

  it('rejects inherited sandboxCwd values', () => {
    const inherited = Object.create({ sandboxCwd: '/tmp/workspace' }) as Record<string, unknown>;
    expect(
      inspectCodexSandboxMetadata({ _meta: { [CODEX_SANDBOX_METADATA_KEY]: inherited } }),
    ).toMatchObject({ compatible: false, reason: expect.stringContaining('own sandboxCwd') });
  });

  it('canonicalizes a trusted directory from a file URL', async () => {
    const root = await tempRoot();
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    await expect(
      trustedWorkspaceFromCodexMetadata({
        _meta: {
          [CODEX_SANDBOX_METADATA_KEY]: { sandboxCwd: pathToFileURL(workspace).href },
        },
      }),
    ).resolves.toMatchObject({
      workspace,
      canary: { compatible: true, sandbox_cwd: pathToFileURL(workspace).href },
    });
  });

  it('rejects file URLs with extra URL data and paths that are not directories', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'file.txt');
    await writeFile(file, 'not a directory');
    await expect(
      trustedWorkspaceFromCodexMetadata({
        _meta: {
          [CODEX_SANDBOX_METADATA_KEY]: { sandboxCwd: `${pathToFileURL(root).href}?escape=1` },
        },
      }),
    ).rejects.toThrow('must not contain');
    await expect(
      trustedWorkspaceFromCodexMetadata({
        _meta: { [CODEX_SANDBOX_METADATA_KEY]: { sandboxCwd: file } },
      }),
    ).rejects.toThrow('does not name a directory');
  });
});
