import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CommandInvocation,
  circuitPluginCacheRoots,
  clearCircuitPluginCaches,
  runLocalPluginRefresh,
} from '../../scripts/plugins/refresh-local.ts';

const tempRoots: string[] = [];
const refreshScript = resolve(__dirname, '../../scripts/plugins/refresh-local.ts');

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function touch(path: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, 'fixture');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('local plugin refresh', () => {
  it('clears only Circuit plugin cache roots for Claude and Codex', () => {
    const homeDir = tempDir('circuit-refresh-home-');
    const codexHome = tempDir('circuit-refresh-codex-');
    const roots = circuitPluginCacheRoots({ homeDir, codexHome });
    for (const root of roots) {
      touch(join(root.path, 'circuit/0.1.0-alpha.1/runtime/circuit.js'));
    }
    touch(join(homeDir, '.claude/plugins/cache/other/other/1.0.0/plugin.json'));
    touch(join(codexHome, 'plugins/cache/other/other/1.0.0/plugin.json'));
    touch(join(codexHome, 'plugins/cache/circuit-next-local/circuit/1.0.0/plugin.json'));

    const cleared = clearCircuitPluginCaches(roots);

    expect(cleared).toEqual(roots.map((root) => ({ ...root, existed: true })));
    for (const root of roots) {
      expect(existsSync(root.path), root.path).toBe(false);
    }
    expect(existsSync(join(homeDir, '.claude/plugins/cache/other'))).toBe(true);
    expect(existsSync(join(codexHome, 'plugins/cache/other'))).toBe(true);
    expect(existsSync(join(codexHome, 'plugins/cache/circuit-next-local'))).toBe(true);
  });

  it('refuses cache roots outside the known Circuit plugin cache paths', () => {
    const root = tempDir('circuit-refresh-unsafe-');

    expect(() =>
      clearCircuitPluginCaches([{ host: 'codex', purpose: 'codex-local-marketplace', path: root }]),
    ).toThrow('refusing to clear codex cache outside Circuit plugin cache root');
  });

  it('rebuilds before clearing caches, then syncs, checks, and doctors installed plugins', () => {
    const homeDir = tempDir('circuit-refresh-home-');
    const codexHome = tempDir('circuit-refresh-codex-');
    for (const root of circuitPluginCacheRoots({ homeDir, codexHome })) {
      touch(join(root.path, 'circuit/0.1.0-alpha.1/runtime/circuit.js'));
    }
    const calls: CommandInvocation[] = [];

    const result = runLocalPluginRefresh({
      repoRoot: '/tmp/circuit-refresh-repo',
      homeDir,
      codexHome,
      runner(invocation) {
        calls.push(invocation);
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe('ok');
    expect(result.commands).toEqual([
      'emit_flows',
      'sync_host_plugin_caches',
      'check_host_plugin_caches',
      'doctor_plugins_installed',
    ]);
    expect(calls.map((call) => call.argv.join(' '))).toEqual([
      'npm run emit-flows',
      'npm run sync:host-plugin-caches',
      'npm run check:host-plugin-caches',
      'npm run doctor:plugins:installed',
    ]);
    expect(calls.every((call) => call.env.HOME === homeDir)).toBe(true);
    expect(calls.every((call) => call.env.CODEX_HOME === codexHome)).toBe(true);
    for (const root of circuitPluginCacheRoots({ homeDir, codexHome })) {
      expect(existsSync(root.path), root.path).toBe(false);
    }
  });

  it('does not clear caches when generated output cannot rebuild', () => {
    const homeDir = tempDir('circuit-refresh-home-');
    const codexHome = tempDir('circuit-refresh-codex-');
    const roots = circuitPluginCacheRoots({ homeDir, codexHome });
    for (const root of roots) {
      touch(join(root.path, 'circuit/0.1.0-alpha.1/runtime/circuit.js'));
    }

    expect(() =>
      runLocalPluginRefresh({
        repoRoot: '/tmp/circuit-refresh-repo',
        homeDir,
        codexHome,
        runner(invocation) {
          return { exitCode: invocation.id === 'emit_flows' ? 1 : 0 };
        },
      }),
    ).toThrow('emit_flows failed with exit code 1');

    for (const root of roots) {
      expect(existsSync(root.path), root.path).toBe(true);
    }
  });

  it('uses the standard Commander help and rejects unknown options before refreshing', () => {
    const help = spawnSync('node', [refreshScript, '--help'], {
      cwd: resolve(__dirname, '../..'),
      encoding: 'utf8',
    });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: refresh-local');
    expect(help.stdout).toContain('Rebuild generated plugin output');
    expect(help.stderr).toBe('');

    const unknown = spawnSync('node', [refreshScript, '--bogus'], {
      cwd: resolve(__dirname, '../..'),
      encoding: 'utf8',
    });

    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown option '--bogus'");
  });
});
