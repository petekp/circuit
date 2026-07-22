import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  isPackageOwnedFile,
  packageGitTreeSha256,
  packageTreeSha256,
  packageTreeStatus,
} from '../../scripts/plugins/package-tree.js';
import { checkCodexMcpPackage } from '../../scripts/release/check-codex-mcp-package.js';
import { MCP_TRANSIENT_ENVIRONMENT_NAMES } from '../../src/hosts/codex-mcp/transient-environment.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const CODEX_ROOT = resolve(REPO_ROOT, 'plugins/codex');

describe('production Codex MCP package', () => {
  it('owns the MCP config and generated runtime tree during cache comparison', () => {
    expect(isPackageOwnedFile('.mcp.json')).toBe(true);
    expect(isPackageOwnedFile('mcp/server.cjs')).toBe(true);
    expect(isPackageOwnedFile('mcp/server.mjs')).toBe(true);
    expect(isPackageOwnedFile('mcp/supervisor.mjs')).toBe(true);
    expect(isPackageOwnedFile('mcp/worker.mjs')).toBe(true);
  });

  it('ships a relocatable config without ambient environment activation', () => {
    const config = JSON.parse(readFileSync(resolve(CODEX_ROOT, '.mcp.json'), 'utf8'));
    expect(config.mcpServers.circuit).toMatchObject({
      command: '/bin/sh',
      cwd: '.',
      required: true,
      enabled_tools: [
        'circuit_start',
        'circuit_status',
        'circuit_resume',
        'circuit_cancel',
        'circuit_list',
        'circuit_recover',
      ],
    });
    expect(config.mcpServers.circuit.args).toHaveLength(2);
    expect(config.mcpServers.circuit.args[0]).toBe('-c');
    expect(config.mcpServers.circuit.args[1]).toContain('exec node ./mcp/server.cjs');
    expect(config.mcpServers.circuit.args[1]).toContain(
      'Install Node.js 22.18 or newer, ensure node is on PATH, restart Codex, and try again.',
    );
    expect(config.mcpServers.circuit.env_vars).toEqual(MCP_TRANSIENT_ENVIRONMENT_NAMES);
    expect(JSON.stringify(config)).not.toContain('CIRCUIT_MCP_');
    expect(existsSync(resolve(CODEX_ROOT, 'mcp/server.cjs'))).toBe(true);
    expect(existsSync(resolve(CODEX_ROOT, 'mcp/server.mjs'))).toBe(true);
    expect(existsSync(resolve(CODEX_ROOT, 'mcp/supervisor.mjs'))).toBe(true);
    expect(existsSync(resolve(CODEX_ROOT, 'mcp/worker.mjs'))).toBe(true);
  });

  it('activates the real MCP config through the Codex plugin manifest', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(CODEX_ROOT, '.codex-plugin/plugin.json'), 'utf8'),
    );
    expect(manifest.mcpServers).toBe('./.mcp.json');
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

  it('uses every installed plugin file in a stable tree digest', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-digest-'));
    const target = resolve(temp, 'target');
    try {
      cpSync(CODEX_ROOT, target, { recursive: true });
      expect(packageTreeSha256(target)).toBe(packageTreeSha256(CODEX_ROOT));

      writeFileSync(resolve(target, 'operator-notes.txt'), 'unexpected bytes\n');
      expect(packageTreeSha256(target)).not.toBe(packageTreeSha256(CODEX_ROOT));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('recomputes the same plugin digest from an immutable Git commit', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-git-digest-'));
    const plugin = resolve(temp, 'plugins/codex');
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: temp, encoding: 'utf8' });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      return result.stdout.trim();
    };
    try {
      mkdirSync(resolve(plugin, 'mcp'), { recursive: true });
      writeFileSync(resolve(plugin, 'README.md'), 'candidate\n');
      writeFileSync(resolve(plugin, 'mcp/server.mjs'), 'export {};\n');
      symlinkSync('server.mjs', resolve(plugin, 'mcp/current.mjs'));
      git('init', '-q');
      git('config', 'user.name', 'Circuit Test');
      git('config', 'user.email', 'circuit@example.invalid');
      git('add', '.');
      git('commit', '-qm', 'candidate');
      const candidate = git('rev-parse', 'HEAD');

      expect(packageGitTreeSha256(temp, candidate, 'plugins/codex')).toBe(
        packageTreeSha256(plugin),
      );

      writeFileSync(resolve(plugin, 'mcp/server.mjs'), 'changed after proof\n');
      expect(packageGitTreeSha256(temp, candidate, 'plugins/codex')).not.toBe(
        packageTreeSha256(plugin),
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('starts from an extracted local archive without node_modules or a source-checkout path', async () => {
    await expect(checkCodexMcpPackage()).resolves.toEqual({
      tool_count: 6,
      packed: true,
      relocated: true,
      self_contained: true,
    });
  });

  it('exposes an explicit worker launch seam from the relocated package', async () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-worker-export-'));
    const target = resolve(temp, 'plugin');
    try {
      cpSync(CODEX_ROOT, target, { recursive: true });
      const worker: unknown = await import(
        /* @vite-ignore */
        `${pathToFileURL(resolve(target, 'mcp/worker.mjs')).href}?relocated=${Date.now()}`
      );
      expect(worker).toMatchObject({ runPackagedMcpWorkerLaunch: expect.any(Function) });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
