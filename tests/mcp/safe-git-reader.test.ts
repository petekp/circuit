import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProofSandboxResult } from '../../src/hosts/codex-mcp/proof-sandbox.js';
import {
  type SafeGitSandbox,
  createSafeGitReader,
  resolveSafeGitRepository,
} from '../../src/hosts/codex-mcp/safe-git-reader.js';

const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  const canonical = realpathSync(root);
  roots.push(canonical);
  return canonical;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function passed(stdout: string): ProofSandboxResult {
  return {
    schema_version: 1,
    status: 'passed',
    exit_code: 0,
    signal: null,
    stdout,
    stderr: '',
    truncated: false,
    duration_ms: 1,
    cleanup: { required: false, confirmed: true, observed_pids: [], remaining_pids: [] },
    sandbox: {
      provider: 'macos-seatbelt',
      network: 'denied',
      access: 'git-read-only',
      writable_roots: ['/tmp/private'],
      mach_services: [],
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex MCP safe Git reader', () => {
  it('uses only fixed operations, hardened Git flags, and explicit submodule inspection', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-shape');
    git(workspace, 'init', '--quiet');
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const fakeSandbox: SafeGitSandbox = {
      async executeGitRead(request) {
        calls.push(request);
        return passed(
          request.argv.includes('ls-files') ? '160000 deadbeef 0\tmodules/child\0' : '',
        );
      },
    };
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: fakeSandbox,
    });

    const result = await reader.read({ operation: 'unstaged_diff' });
    expect(result.submodules).toEqual([
      { path: 'modules/child', index_oid: 'deadbeef', inspection: 'gitlink_only' },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.argv).toEqual(
      expect.arrayContaining([
        '--no-pager',
        '--no-optional-locks',
        'core.hooksPath=/dev/null',
        'core.fsmonitor=false',
        'core.attributesFile=/dev/null',
        'diff.external=',
        '--no-ext-diff',
        '--no-textconv',
        '--submodule=short',
      ]),
    );
    expect(calls[1]?.argv).not.toContain('--ignore-submodules=all');
    expect(calls[1]?.access).toBe('git-read-only');
  });

  it('provides bounded staged-stat and NUL-delimited untracked intake operations', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-review-intake');
    git(workspace, 'init', '--quiet');
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          if (request.argv.includes('--stat')) return passed(' target.ts | 2 +-\n');
          if (request.argv.includes('--others')) return passed('new file.ts\0');
          return passed('');
        },
      },
    });

    const stat = await reader.read({ operation: 'staged_diff_stat' });
    const untracked = await reader.read({ operation: 'untracked_files' });
    expect(stat).toMatchObject({ ok: true, stdout: expect.stringContaining('target.ts') });
    expect(untracked).toMatchObject({ ok: true, stdout: 'new file.ts\0' });
    const primaryCalls = calls.filter(
      (call) => !call.argv.includes('config') && !call.argv.includes('--stage'),
    );
    expect(primaryCalls[0]?.argv).toEqual(
      expect.arrayContaining(['--stat', '--cached', '--no-ext-diff', '--no-textconv']),
    );
    expect(primaryCalls[1]?.argv).toEqual(
      expect.arrayContaining(['ls-files', '--others', '--exclude-standard', '-z']),
    );
    expect(primaryCalls.flatMap((call) => call.argv)).not.toContain('--recurse-submodules');
  });

  it('rejects arbitrary arguments, unknown request fields, and arbitrary Git-dir pointers', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-input');
    const outsideGit = temporaryDirectory('circuit-mcp-git-outside');
    writeFileSync(path.join(workspace, '.git'), `gitdir: ${outsideGit}\n`);

    await expect(resolveSafeGitRepository(workspace)).rejects.toThrow(/linked worktree|Git dir/i);

    const normalWorkspace = temporaryDirectory('circuit-mcp-git-normal');
    git(normalWorkspace, 'init', '--quiet');
    const reader = createSafeGitReader({
      workspace: normalWorkspace,
      gitExecutable: '/usr/bin/git',
      sandbox: { executeGitRead: async () => passed('') },
    });
    await expect(reader.read({ operation: 'status', args: ['fetch'] })).rejects.toThrow(
      /unknown field/i,
    );
    await expect(reader.read({ operation: 'fetch' })).rejects.toThrow(/operation/i);
  });

  it('accepts the exact linked-worktree metadata shape and rejects escaped alternates', async () => {
    const main = temporaryDirectory('circuit-mcp-git-main');
    const linked = temporaryDirectory('circuit-mcp-git-linked');
    git(main, 'init', '--quiet');
    writeFileSync(path.join(main, 'tracked.txt'), 'base\n');
    git(main, 'add', 'tracked.txt');
    git(
      main,
      '-c',
      'user.name=Circuit',
      '-c',
      'user.email=circuit@example.test',
      'commit',
      '-m',
      'base',
      '--quiet',
    );
    rmSync(linked, { recursive: true, force: true });
    git(main, 'worktree', 'add', '--quiet', linked, 'HEAD');

    const repository = await resolveSafeGitRepository(linked);
    expect(repository.workspace).toBe(linked);
    expect(repository.read_roots).toContain(repository.git_dir);
    expect(repository.common_dir).not.toBe(repository.workspace);

    const alternates = path.join(repository.common_dir, 'objects', 'info', 'alternates');
    mkdirSync(path.dirname(alternates), { recursive: true });
    writeFileSync(alternates, '/tmp/escaped-objects\n');
    await expect(resolveSafeGitRepository(linked)).rejects.toThrow(/alternates/i);
  });

  it('rejects Git metadata symlinks and local config includes before the read', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-metadata-symlink');
    const outside = temporaryDirectory('circuit-mcp-git-metadata-outside');
    git(workspace, 'init', '--quiet');
    rmSync(path.join(workspace, '.git', 'objects'), { recursive: true, force: true });
    symlinkSync(outside, path.join(workspace, '.git', 'objects'));
    await expect(resolveSafeGitRepository(workspace)).rejects.toThrow(/symbolic link|symlink/i);

    const configWorkspace = temporaryDirectory('circuit-mcp-git-config-include');
    git(configWorkspace, 'init', '--quiet');
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace: configWorkspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          return passed(request.argv.includes('config') ? 'include.path\n/tmp/hostile\0' : '');
        },
      },
    });
    await expect(reader.read({ operation: 'status' })).rejects.toThrow(/include/i);
    expect(calls).toHaveLength(1);
  });

  it('reports output truncation as a failed bounded read', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-output');
    git(workspace, 'init', '--quiet');
    const fakeSandbox: SafeGitSandbox = {
      async executeGitRead(request) {
        return {
          ...passed('x'.repeat(request.max_output_bytes)),
          status: 'output_limit',
          exit_code: null,
          truncated: true,
        };
      },
    };
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: fakeSandbox,
    });

    const result = await reader.read({ operation: 'status' });
    expect(result).toMatchObject({ ok: false, truncated: true, limit_bytes: expect.any(Number) });
  });

  it('does not run repository hooks, text converters, external diffs, fsmonitor, or host config', async () => {
    // The live Seatbelt-backed form of this test is in safe-git-reader-live.test.ts.
    const workspace = temporaryDirectory('circuit-mcp-git-hostile-shape');
    git(workspace, 'init', '--quiet');
    const marker = path.join(workspace, 'marker');
    const helper = path.join(workspace, 'hostile.sh');
    writeFileSync(helper, `#!/bin/sh\nprintf hostile > ${JSON.stringify(marker)}\n`);
    chmodSync(helper, 0o700);
    git(workspace, 'config', '--local', 'core.hooksPath', workspace);
    git(workspace, 'config', '--local', 'core.fsmonitor', helper);
    git(workspace, 'config', '--local', 'diff.hostile.command', helper);
    writeFileSync(path.join(workspace, '.gitattributes'), '*.txt diff=hostile\n');

    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          return passed('');
        },
      },
    });
    await reader.read({ operation: 'unstaged_diff' });

    expect(existsSync(marker)).toBe(false);
    expect(calls[0]?.git_environment).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
    });
  });
});
