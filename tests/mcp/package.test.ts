import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isPackageOwnedFile, packageTreeStatus } from '../../scripts/plugins/package-tree.js';
import { checkCodexMcpPackage } from '../../scripts/release/check-codex-mcp-package.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const CODEX_ROOT = resolve(REPO_ROOT, 'plugins/codex');

describe('dormant Codex MCP package', () => {
  it('owns the MCP config and generated runtime tree during cache comparison', () => {
    expect(isPackageOwnedFile('.mcp.json')).toBe(true);
    expect(isPackageOwnedFile('mcp/server.cjs')).toBe(true);
    expect(isPackageOwnedFile('mcp/server.mjs')).toBe(true);
  });

  it('ships a relocatable config without ambient environment activation', () => {
    const config = JSON.parse(readFileSync(resolve(CODEX_ROOT, '.mcp.json'), 'utf8'));
    expect(config).toEqual({
      mcpServers: {
        circuit: {
          command: 'node',
          args: ['./mcp/server.cjs'],
          cwd: '.',
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('env');
    expect(existsSync(resolve(CODEX_ROOT, 'mcp/server.cjs'))).toBe(true);
    expect(existsSync(resolve(CODEX_ROOT, 'mcp/server.mjs'))).toBe(true);
  });

  it('keeps the dormant MCP config unlinked from the plugin manifest', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(CODEX_ROOT, '.codex-plugin/plugin.json'), 'utf8'),
    );
    expect(manifest).not.toHaveProperty('mcpServers');
  });

  it('detects stale and unexpected files anywhere in the owned MCP tree', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-tree-'));
    const target = resolve(temp, 'target');
    try {
      cpSync(CODEX_ROOT, target, { recursive: true });
      expect(packageTreeStatus(CODEX_ROOT, target).status).toBe('ok');

      writeFileSync(resolve(target, 'mcp/server.mjs'), 'stale');
      expect(packageTreeStatus(CODEX_ROOT, target)).toMatchObject({
        status: 'stale',
        stale: ['mcp/server.mjs'],
      });

      cpSync(resolve(CODEX_ROOT, 'mcp/server.mjs'), resolve(target, 'mcp/server.mjs'));
      writeFileSync(resolve(target, 'mcp/unexpected.mjs'), 'extra');
      expect(packageTreeStatus(CODEX_ROOT, target)).toMatchObject({
        status: 'extra-owned-files',
        extra_owned_files: ['mcp/unexpected.mjs'],
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('starts after relocation without node_modules or a source-checkout path', async () => {
    await expect(checkCodexMcpPackage()).resolves.toEqual({
      tool_count: 6,
      relocated: true,
      self_contained: true,
    });
  });
});
