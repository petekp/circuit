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
  it('uses fixed hardened operations without an auxiliary full-index scan', async () => {
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
    expect(result.submodules).toEqual([]);
    expect(calls).toHaveLength(2);
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
        '--ignore-submodules=none',
      ]),
    );
    expect(calls[1]?.argv).not.toContain('--ignore-submodules=all');
    expect(calls[1]?.argv).not.toContain('--stage');
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

  it('provides a bounded hidden-index inspection operation', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-hidden-index');
    git(workspace, 'init', '--quiet');
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          if (request.argv.includes('-v')) return passed('h hidden.ts\0S sparse.ts\0');
          return passed('');
        },
      },
    });

    const result = await reader.read({ operation: 'hidden_index_flags' });

    expect(result).toMatchObject({
      ok: true,
      operation: 'hidden_index_flags',
      stdout: 'h hidden.ts\0S sparse.ts\0',
    });
    const primary = calls.find((call) => call.argv.includes('-v'));
    expect(primary?.argv).toEqual(expect.arrayContaining(['ls-files', '-v', '-z', '--']));
    expect(primary?.argv).not.toContain('--recurse-submodules');
  });

  it('provides exact NUL-delimited raw gitlink change operations', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-changed-gitlinks');
    git(workspace, 'init', '--quiet');
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

    await reader.read({ operation: 'staged_changed_gitlinks' });
    await reader.read({ operation: 'unstaged_changed_gitlinks' });

    const primaryCalls = calls.filter((call) => !call.argv.includes('config'));
    expect(primaryCalls).toHaveLength(2);
    expect(primaryCalls[0]?.argv).toEqual(
      expect.arrayContaining([
        'diff',
        '--raw',
        '-z',
        '--no-abbrev',
        '--no-renames',
        '--ignore-submodules=none',
        '--cached',
        '--',
      ]),
    );
    expect(primaryCalls[1]?.argv).toEqual(
      expect.arrayContaining([
        'diff',
        '--raw',
        '-z',
        '--no-abbrev',
        '--no-renames',
        '--ignore-submodules=none',
        '--',
      ]),
    );
  });

  it('fails closed when a Git read contains a replacement character from lossy decoding', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-invalid-utf8');
    git(workspace, 'init', '--quiet');
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          if (request.argv.includes('config') || request.argv.includes('--stage')) {
            return passed('');
          }
          return passed('diff --git a/invalid.txt b/invalid.txt\n+\uFFFD\n');
        },
      },
    });

    await expect(reader.read({ operation: 'staged_diff' })).rejects.toThrow(
      /UTF-8|replacement|encoding/i,
    );
  });

  it('provides a bounded pinned commit diff with first-parent semantics', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-latest-commit');
    git(workspace, 'init', '--quiet');
    const commit = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const tree = 'c'.repeat(40);
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          if (request.argv.includes('cat-file')) {
            return passed(
              `tree ${tree}\nparent ${parent}\nauthor Circuit <c@example.test> 0 +0000\n\ncommit\n`,
            );
          }
          if (request.argv.includes('--stat')) return passed(' target.ts | 1 +\n');
          return passed('diff --git a/target.ts b/target.ts\n+latest-commit-review-marker\n');
        },
      },
    });

    const diff = await reader.read({
      operation: 'target_diff',
      target: { kind: 'commit', commit },
    });
    const stat = await reader.read({
      operation: 'target_diff_stat',
      target: { kind: 'commit', commit },
    });
    expect(diff).toMatchObject({
      ok: true,
      stdout: expect.stringContaining('latest-commit-review-marker'),
    });
    expect(stat).toMatchObject({ ok: true, stdout: expect.stringContaining('target.ts') });
    const primaryCalls = calls.filter(
      (call) =>
        call.argv.includes('diff') &&
        !call.argv.includes('config') &&
        !call.argv.includes('--stage'),
    );
    expect(primaryCalls[0]?.argv).toEqual(
      expect.arrayContaining([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--submodule=short',
        `${parent}^{commit}`,
        `${commit}^{commit}`,
        '--',
      ]),
    );
    expect(primaryCalls[1]?.argv).toEqual(
      expect.arrayContaining(['diff', '--stat', `${parent}^{commit}`, `${commit}^{commit}`, '--']),
    );
    expect(primaryCalls.flatMap((call) => call.argv)).not.toContain('--recurse-submodules');
  });

  it('does not treat a non-root commit as a root when its pinned parent is unavailable', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-shallow-commit');
    git(workspace, 'init', '--quiet');
    const commit = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const tree = 'c'.repeat(40);
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          if (request.argv.includes('config')) return passed('');
          if (request.argv.includes('cat-file')) {
            return passed(
              `tree ${tree}\nparent ${parent}\nauthor Circuit <c@example.test> 0 +0000\n\nchild\n`,
            );
          }
          if (request.argv.includes('diff')) {
            return {
              ...passed(''),
              status: 'failed',
              exit_code: 128,
              stderr: `fatal: bad object ${parent}`,
            };
          }
          return passed('diff --git a/full-tree.ts b/full-tree.ts\n+wrong-root-diff\n');
        },
      },
    });

    const result = await reader.read({
      operation: 'target_diff',
      target: { kind: 'commit', commit },
    });

    expect(result).toMatchObject({
      ok: false,
      stderr: expect.stringContaining('bad object'),
    });
    const requestedArgv = calls.map((call) => call.argv);
    expect(requestedArgv.some((argv) => argv.includes('cat-file'))).toBe(true);
    expect(requestedArgv.some((argv) => argv.includes(`${parent}^{commit}`))).toBe(true);
    expect(requestedArgv.some((argv) => argv.includes('show'))).toBe(false);
  });

  it('provides bounded explicit target diff operations with validated refs', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-target');
    git(workspace, 'init', '--quiet');
    const baseCommit = 'a'.repeat(40);
    const headCommit = 'b'.repeat(40);
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          if (request.argv.includes('--stat')) return passed(' target.ts | 1 +\n');
          return passed('diff --git a/target.ts b/target.ts\n+target-review-marker\n');
        },
      },
    });

    const diff = await reader.read({
      operation: 'target_diff',
      target: { kind: 'range', base_commit: baseCommit, head_commit: headCommit, dots: '...' },
    });
    const stat = await reader.read({
      operation: 'target_diff_stat',
      target: { kind: 'range', base_commit: baseCommit, head_commit: headCommit, dots: '...' },
    });

    expect(diff).toMatchObject({
      ok: true,
      stdout: expect.stringContaining('target-review-marker'),
    });
    expect(stat).toMatchObject({ ok: true, stdout: expect.stringContaining('target.ts') });
    const primaryCalls = calls.filter(
      (call) => !call.argv.includes('config') && !call.argv.includes('--stage'),
    );
    expect(primaryCalls[0]?.argv).toEqual(
      expect.arrayContaining([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--submodule=short',
        `${baseCommit}^{commit}...${headCommit}^{commit}`,
        '--',
      ]),
    );
    expect(primaryCalls[1]?.argv).toEqual(
      expect.arrayContaining([
        'diff',
        '--stat',
        '--no-ext-diff',
        '--no-textconv',
        '--submodule=short',
        `${baseCommit}^{commit}...${headCommit}^{commit}`,
        '--',
      ]),
    );
    expect(primaryCalls.flatMap((call) => call.argv)).not.toContain('--recurse-submodules');
  });

  it('uses a local PR merge snapshot instead of the current HEAD', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-pr-target');
    git(workspace, 'init', '--quiet');
    const mergeCommit = 'a'.repeat(40);
    const baseCommit = 'b'.repeat(40);
    const headCommit = 'c'.repeat(40);
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

    await reader.read({
      operation: 'target_diff',
      target: {
        kind: 'pull_request',
        number: 123,
        merge_commit: mergeCommit,
        base_commit: baseCommit,
        head_commit: headCommit,
      },
    });
    const primary = calls.find(
      (call) =>
        call.argv.includes('diff') &&
        !call.argv.includes('config') &&
        !call.argv.includes('--stage'),
    );
    expect(primary?.argv).toContain(`${baseCommit}^{commit}...${headCommit}^{commit}`);
    expect(primary?.argv).not.toContain('HEAD...refs/pull/123/head');
  });

  it('returns only sanitized GitHub repository identities from audited remote config', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-remotes');
    git(workspace, 'init', '--quiet');
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          if (request.argv.includes('config')) {
            return passed(
              [
                'remote.origin.url\nhttps://token@example.test@github.com/Acme/Widget.git',
                'remote.upstream.url\ngit@github.com:ACME/widget.git',
                'remote.other.url\nhttps://gitlab.com/acme/other.git',
                '',
              ].join('\0'),
            );
          }
          return passed('');
        },
      },
    });

    const result = await reader.read({ operation: 'remote_repositories' });

    expect(result).toMatchObject({
      ok: true,
      stdout: 'github.com/acme/widget\n',
      cleanup_confirmed: true,
    });
    expect(result.stdout).not.toContain('token');
    expect(calls).toHaveLength(1);
  });

  it('resolves a symbolic range once and requires its pinned commit ids for later reads', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-pinned-range');
    git(workspace, 'init', '--quiet');
    const baseCommit = 'a'.repeat(40);
    const headCommit = 'b'.repeat(40);
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          if (request.argv.includes('config')) return passed('');
          if (request.argv.includes('rev-parse')) {
            return passed(`${headCommit}\n^${baseCommit}\n`);
          }
          if (request.argv.includes('--stat')) return passed(' target.ts | 1 +\n');
          if (request.argv.includes('diff')) {
            return passed('diff --git a/target.ts b/target.ts\n+pinned-target\n');
          }
          return passed('');
        },
      },
    });

    const resolved = await reader.read({
      operation: 'resolve_target',
      target: { kind: 'range', base: 'main', head: 'feature', dots: '...' },
    });
    expect(resolved).toMatchObject({
      ok: true,
      resolved_target: {
        kind: 'range',
        base_commit: baseCommit,
        head_commit: headCommit,
        dots: '...',
      },
    });

    await reader.read({
      operation: 'target_diff',
      target: {
        kind: 'range',
        base_commit: baseCommit,
        head_commit: headCommit,
        dots: '...',
      },
    });
    const resolutionCall = calls.find((call) => call.argv.includes('rev-parse'));
    expect(resolutionCall?.argv).toEqual(
      expect.arrayContaining([
        'rev-parse',
        '--revs-only',
        '--end-of-options',
        'main^{commit}..feature^{commit}',
      ]),
    );
    const diffCall = calls.find(
      (call) => call.argv.includes('diff') && !call.argv.includes('--stat'),
    );
    expect(diffCall?.argv).toContain(`${baseCommit}^{commit}...${headCommit}^{commit}`);
    expect(diffCall?.argv).not.toContain('main^{commit}...feature^{commit}');
  });

  it('resolves commit and PR targets to strict immutable shapes', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-pinned-target-shapes');
    git(workspace, 'init', '--quiet');
    const commit = 'a'.repeat(40);
    const mergeCommit = 'b'.repeat(40);
    const baseCommit = 'c'.repeat(40);
    const headCommit = 'd'.repeat(40);
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          if (request.argv.includes('config')) {
            return passed(
              [
                'remote.origin.url\nhttps://github.com/acme/widget.git',
                'remote.origin.fetch\n+refs/pull/*/merge:refs/circuit/github.com/acme/widget/pull/*/merge',
                '',
              ].join('\0'),
            );
          }
          if (request.argv.some((arg) => arg === 'HEAD^{commit}')) return passed(`${commit}\n`);
          if (request.argv.includes('rev-parse')) {
            return passed(`${mergeCommit}\n${headCommit}\n^${baseCommit}\n`);
          }
          return passed('');
        },
      },
    });

    await expect(
      reader.read({
        operation: 'resolve_target',
        target: { kind: 'commit', ref: 'HEAD' },
      }),
    ).resolves.toMatchObject({
      resolved_target: { kind: 'commit', commit },
    });
    await expect(
      reader.read({
        operation: 'resolve_target',
        target: { kind: 'pull_request', number: 123 },
      }),
    ).resolves.toMatchObject({
      resolved_target: {
        kind: 'pull_request',
        number: 123,
        merge_commit: mergeCommit,
        base_commit: baseCommit,
        head_commit: headCommit,
      },
    });
    expect(calls.filter((call) => call.argv.includes('rev-parse'))).toHaveLength(2);
    expect(
      calls.find((call) =>
        call.argv.includes('refs/circuit/github.com/acme/widget/pull/123/merge^{commit}'),
      )?.argv,
    ).toEqual(
      expect.arrayContaining(['refs/circuit/github.com/acme/widget/pull/123/merge^{commit}']),
    );
  });

  it('selects the repository named by an exact PR URL target when two remotes have that PR number', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-exact-pr-repository');
    git(workspace, 'init', '--quiet');
    const mergeCommit = 'a'.repeat(40);
    const baseCommit = 'b'.repeat(40);
    const headCommit = 'c'.repeat(40);
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          if (request.argv.includes('config')) {
            return passed(
              [
                'remote.origin.url\nhttps://github.com/acme/widget-fork.git',
                'remote.origin.fetch\n+refs/pull/*/merge:refs/circuit/github.com/acme/widget-fork/pull/*/merge',
                'remote.upstream.url\nhttps://github.com/acme/widget.git',
                'remote.upstream.fetch\n+refs/pull/*/merge:refs/circuit/github.com/acme/widget/pull/*/merge',
                '',
              ].join('\0'),
            );
          }
          if (request.argv.includes('rev-parse')) {
            return passed(`${mergeCommit}\n${headCommit}\n^${baseCommit}\n`);
          }
          return passed('');
        },
      },
    });

    await expect(
      reader.read({
        operation: 'resolve_target',
        target: {
          kind: 'pull_request',
          number: 123,
          repository: 'github.com/acme/widget',
        },
      }),
    ).resolves.toMatchObject({
      resolved_target: {
        kind: 'pull_request',
        number: 123,
        repository: 'github.com/acme/widget',
        merge_commit: mergeCommit,
        base_commit: baseCommit,
        head_commit: headCommit,
      },
    });

    const resolution = calls.find((call) => call.argv.includes('rev-parse'));
    expect(resolution?.argv).toContain(
      'refs/circuit/github.com/acme/widget/pull/123/merge^{commit}',
    );
    expect(resolution?.argv).not.toContain(
      'refs/circuit/github.com/acme/widget-fork/pull/123/merge^{commit}',
    );
  });

  it('rejects malformed target resolution output instead of trusting it as an object id', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-malformed-resolution');
    git(workspace, 'init', '--quiet');
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          if (request.argv.includes('config')) return passed('');
          return passed('not-an-object-id\n');
        },
      },
    });

    await expect(
      reader.read({
        operation: 'resolve_target',
        target: { kind: 'commit', ref: 'HEAD' },
      }),
    ).rejects.toThrow(/invalid|unexpected/i);
  });

  it('rejects symbolic or malformed pinned targets before a diff runs', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-pinned-target-input');
    git(workspace, 'init', '--quiet');
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

    await expect(
      reader.read({ operation: 'target_diff', target: { kind: 'commit', ref: 'HEAD' } }),
    ).rejects.toThrow(/pinned|commit id|unknown/i);
    await expect(
      reader.read({
        operation: 'target_diff',
        target: { kind: 'commit', commit: 'abc1234' },
      }),
    ).rejects.toThrow(/commit id|object id|immutable/i);
    expect(calls).toHaveLength(0);
  });

  it('rejects unsafe explicit target refs before Git runs', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-target-input');
    git(workspace, 'init', '--quiet');
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

    await expect(
      reader.read({ operation: 'resolve_target', target: { kind: 'commit', ref: '--help' } }),
    ).rejects.toThrow(/unsafe/i);
    await expect(
      reader.read({
        operation: 'resolve_target',
        target: { kind: 'range', base: 'main..secret', head: 'feature', dots: '..' },
      }),
    ).rejects.toThrow(/unsafe/i);
    await expect(
      reader.read({
        operation: 'resolve_target',
        target: { kind: 'range', base: 'main', head: 'feature:path', dots: '..' },
      }),
    ).rejects.toThrow(/unsafe/i);
    expect(calls).toHaveLength(0);
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

  it('rejects legacy Git graft metadata before any read', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-grafts');
    git(workspace, 'init', '--quiet');
    const grafts = path.join(workspace, '.git', 'info', 'grafts');
    mkdirSync(path.dirname(grafts), { recursive: true });
    writeFileSync(grafts, `${'a'.repeat(40)} ${'b'.repeat(40)}\n`);

    await expect(resolveSafeGitRepository(workspace)).rejects.toThrow(/graft/i);
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

  it('returns a confirmed bounded partial primary diff as reviewable but incomplete', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-partial-primary-diff');
    git(workspace, 'init', '--quiet');
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          if (request.argv.includes('config')) return passed('');
          return {
            ...passed('diff --git a/target.ts b/target.ts\n+bounded-primary\n'),
            status: 'output_limit',
            exit_code: null,
            truncated: true,
          };
        },
      },
    });

    const result = await reader.read({ operation: 'staged_diff' });

    expect(result).toMatchObject({
      ok: true,
      operation: 'staged_diff',
      stdout: expect.stringContaining('bounded-primary'),
      truncated: true,
      cleanup_confirmed: true,
    });
  });

  it('clears auxiliary config output when the audit reaches its bound', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-config-output-limit');
    git(workspace, 'init', '--quiet');
    let calls = 0;
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead() {
          calls += 1;
          return {
            ...passed('credential.helper\nAUXILIARY-CONFIG-SECRET\n'),
            status: 'output_limit',
            exit_code: null,
            truncated: true,
          };
        },
      },
    });

    const result = await reader.read({ operation: 'staged_diff' });

    expect(result).toMatchObject({
      ok: false,
      operation: 'staged_diff',
      stdout: '',
      truncated: true,
      cleanup_confirmed: true,
    });
    expect(result.stderr).toMatch(/configuration|audit/i);
    expect(calls).toBe(1);
  });

  it('does not couple a pinned target diff to the current index submodule scan', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-submodule-output');
    git(workspace, 'init', '--quiet');
    const commit = 'a'.repeat(40);
    const calls: Parameters<SafeGitSandbox['executeGitRead']>[0][] = [];
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          calls.push(request);
          if (request.argv.includes('config')) return passed('');
          if (request.argv.includes('cat-file')) {
            return passed(
              `tree ${'c'.repeat(40)}\nauthor Circuit <c@example.test> 0 +0000\n\nroot\n`,
            );
          }
          return passed('diff --git a/target.ts b/target.ts\n+primary-diff\n');
        },
      },
    });

    const result = await reader.read({
      operation: 'target_diff',
      target: { kind: 'commit', commit },
    });

    expect(result).toMatchObject({
      ok: true,
      operation: 'target_diff',
      stdout: expect.stringContaining('primary-diff'),
      truncated: false,
      cleanup_confirmed: true,
    });
    expect(calls.some((call) => call.argv.includes('--stage'))).toBe(false);
  });

  it('validates regular index entries while returning only submodule gitlinks', async () => {
    const workspace = temporaryDirectory('circuit-mcp-git-valid-mixed-index');
    git(workspace, 'init', '--quiet');
    const regularObject = 'a'.repeat(40);
    const submoduleObject = 'b'.repeat(40);
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          return passed(
            request.argv.includes('--stage')
              ? `100644 ${regularObject} 0\tREADME.md\0` +
                  `160000 ${submoduleObject} 0\tmodules/child\0`
              : '',
          );
        },
      },
    });

    const result = await reader.read({ operation: 'submodules' });

    expect(result.submodules).toEqual([
      {
        path: 'modules/child',
        index_oid: submoduleObject,
        inspection: 'gitlink_only',
      },
    ]);
  });

  it.each([
    {
      name: 'missing final NUL',
      output: `160000 ${'b'.repeat(40)} 0\tmodules/child`,
    },
    {
      name: 'malformed gitlink object id',
      output: '160000 not-an-object-id 0\tmodules/child\0',
    },
    {
      name: 'duplicate path',
      output:
        `160000 ${'b'.repeat(40)} 0\tmodules/child\0` +
        `160000 ${'c'.repeat(40)} 0\tmodules/child\0`,
    },
    {
      name: 'malformed regular-file object id',
      output: '100644 not-an-object-id 0\tREADME.md\0',
    },
    {
      name: 'malformed regular-file stage',
      output: `100644 ${'b'.repeat(40)} 4\tREADME.md\0`,
    },
    {
      name: 'malformed regular-file frame',
      output: 'garbage\0',
    },
  ])('rejects malformed explicit submodule output: $name', async ({ output }) => {
    const workspace = temporaryDirectory('circuit-mcp-git-malformed-submodules');
    git(workspace, 'init', '--quiet');
    const reader = createSafeGitReader({
      workspace,
      gitExecutable: '/usr/bin/git',
      sandbox: {
        async executeGitRead(request) {
          return passed(request.argv.includes('--stage') ? output : '');
        },
      },
    });

    await expect(reader.read({ operation: 'submodules' })).rejects.toThrow(
      /submodule|malformed|duplicate|NUL/i,
    );
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
