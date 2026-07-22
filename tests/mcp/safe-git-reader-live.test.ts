import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMacosProofSandbox } from '../../src/hosts/codex-mcp/proof-sandbox.js';
import { createSafeGitReader } from '../../src/hosts/codex-mcp/safe-git-reader.js';

const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `${label}-`)));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function realGitExecutable(): string {
  const result = spawnSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return realpathSync(result.stdout.trim());
}

function reader(workspace: string) {
  const sandbox = createMacosProofSandbox({
    workspace,
    privateRoot: temporaryDirectory('circuit-mcp-live-git-private'),
    pathEntries: [path.dirname(process.execPath), '/usr/bin', '/bin'],
  });
  return createSafeGitReader({
    workspace,
    gitExecutable: realGitExecutable(),
    sandbox,
  });
}

function commitFixture(workspace: string): void {
  git(workspace, 'init', '--quiet');
  git(workspace, 'config', '--local', 'user.name', 'Circuit');
  git(workspace, 'config', '--local', 'user.email', 'circuit@example.test');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === 'darwin')('live macOS Codex MCP safe Git reader', () => {
  it('neutralizes hooks, textconv, external diff, fsmonitor, attributes, and host config', async () => {
    const workspace = temporaryDirectory('circuit-mcp-live-git-hostile');
    const outside = temporaryDirectory('circuit-mcp-live-git-hostile-outside');
    const marker = path.join(outside, 'helper-ran');
    const helper = path.join(workspace, 'hostile.sh');
    const hook = path.join(workspace, 'post-index-change');
    const globalConfig = path.join(workspace, 'hostile-global-config');
    commitFixture(workspace);
    writeFileSync(
      helper,
      `#!/bin/sh\nprintf hostile > ${JSON.stringify(marker)}\nprintf converted\n`,
    );
    writeFileSync(hook, `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`);
    chmodSync(helper, 0o700);
    chmodSync(hook, 0o700);
    writeFileSync(path.join(workspace, '.gitattributes'), '*.txt diff=hostile filter=hostile\n');
    writeFileSync(path.join(workspace, 'target.txt'), 'base\n');
    git(workspace, 'add', '.gitattributes', 'target.txt');
    git(workspace, 'commit', '--quiet', '-m', 'base');
    git(workspace, 'config', '--local', 'core.hooksPath', workspace);
    git(workspace, 'config', '--local', 'core.fsmonitor', helper);
    git(workspace, 'config', '--local', 'diff.external', helper);
    git(workspace, 'config', '--local', 'diff.hostile.command', helper);
    git(workspace, 'config', '--local', 'diff.hostile.textconv', helper);
    git(workspace, 'config', '--local', 'filter.hostile.clean', helper);
    git(workspace, 'config', '--local', 'filter.hostile.smudge', helper);
    git(workspace, 'config', '--local', 'filter.hostile.process', helper);
    git(workspace, 'config', '--local', 'filter.hostile.required', 'true');
    writeFileSync(
      globalConfig,
      `[core]\n\tfsmonitor = ${helper}\n[diff]\n\texternal = ${helper}\n`,
    );
    writeFileSync(path.join(workspace, 'target.txt'), 'changed\n');
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    try {
      const status = await reader(workspace).read({ operation: 'status' });
      const diff = await reader(workspace).read({ operation: 'unstaged_diff' });
      expect(status.ok, status.stderr).toBe(true);
      expect(diff.ok, diff.stderr).toBe(true);
      expect(status.stdout).toContain('target.txt');
      expect(diff.stdout).toContain('+changed');
      expect(diff.stdout).not.toContain('converted');
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previousGlobal === undefined) Reflect.deleteProperty(process.env, 'GIT_CONFIG_GLOBAL');
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    }
  }, 90_000);

  it('reports submodule gitlinks without recursively executing submodule configuration', async () => {
    const root = temporaryDirectory('circuit-mcp-live-git-submodules');
    const workspace = path.join(root, 'workspace');
    const child = path.join(root, 'child');
    git(root, 'init', '--quiet', workspace);
    git(root, 'init', '--quiet', child);
    commitFixture(workspace);
    git(child, 'config', 'user.name', 'Circuit');
    git(child, 'config', 'user.email', 'circuit@example.test');
    writeFileSync(path.join(child, 'child.txt'), 'base\n');
    git(child, 'add', 'child.txt');
    git(child, 'commit', '--quiet', '-m', 'child base');
    git(
      workspace,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      child,
      'modules/child',
    );
    git(workspace, 'commit', '--quiet', '-am', 'add child');
    writeFileSync(path.join(workspace, 'modules', 'child', 'child.txt'), 'changed\n');

    const status = await reader(realpathSync(workspace)).read({ operation: 'status' });
    const diff = await reader(realpathSync(workspace)).read({ operation: 'unstaged_diff' });
    expect(status.ok, status.stderr).toBe(true);
    expect(diff.ok, diff.stderr).toBe(true);
    expect(status.stdout).toContain('modules/child');
    expect(diff.stdout).toContain('modules/child');
    expect(diff.submodules).toEqual([
      expect.objectContaining({ path: 'modules/child', inspection: 'gitlink_only' }),
    ]);
    expect(diff.submodule_policy).toBe('reported_without_recursive_execution');
  }, 90_000);

  it('returns staged stats and NUL-delimited untracked paths for Review intake', async () => {
    const workspace = temporaryDirectory('circuit-mcp-live-git-review-intake');
    commitFixture(workspace);
    writeFileSync(path.join(workspace, 'staged.txt'), 'staged\n');
    git(workspace, 'add', 'staged.txt');
    writeFileSync(path.join(workspace, 'untracked file.txt'), 'untracked\n');
    const safeReader = reader(workspace);

    const stat = await safeReader.read({ operation: 'staged_diff_stat' });
    const untracked = await safeReader.read({ operation: 'untracked_files' });
    expect(stat.ok, stat.stderr).toBe(true);
    expect(stat.stdout).toContain('staged.txt');
    expect(untracked.ok, untracked.stderr).toBe(true);
    expect(untracked.stdout).toBe('untracked file.txt\0');
  }, 90_000);
});
