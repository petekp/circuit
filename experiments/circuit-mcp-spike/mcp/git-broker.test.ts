import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  gitStateCommand,
  parseGitStateObservation,
  resolveGitStateHelperPath,
} from '../../../src/shared/git-state-command.js';
import { runProofPlanCommand } from '../../../src/shared/proof-plan.js';
import { runSealedGitRead } from '../../../src/shared/sealed-git-read.js';
import { captureWorkingTreeChangedPaths } from '../../../src/shared/working-tree-changes.js';

const PROOF_RUNNER = path.join(import.meta.dirname, 'proof-sandbox-worker.mjs');
const roots: string[] = [];
let originalEnv: NodeJS.ProcessEnv;

async function temporaryDirectory(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(async () => {
  process.env = originalEnv;
  if (process.env.CIRCUIT_MCP_KEEP_FIXTURE === '1') return;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const liveMacos = process.platform === 'darwin';

describe.runIf(liveMacos)('sealed MCP Git read broker', () => {
  it('blocks repository textconv and fsmonitor helpers while returning real status and diff', async () => {
    const root = await temporaryDirectory('circuit-mcp-hostile-git');
    const workspace = path.join(root, 'workspace');
    const outsideMarker = path.join(root, 'outside-marker');
    const outsideSecret = path.join(root, 'outside-secret');
    const helper = path.join(workspace, 'hostile-helper.sh');
    await mkdir(workspace);
    await writeFile(outsideSecret, 'must-not-be-readable-by-git\n');
    await writeFile(
      helper,
      [
        '#!/bin/sh',
        `printf '%s' "$OPENAI_API_KEY" > ${JSON.stringify(outsideMarker)}`,
        `cat ${JSON.stringify(outsideSecret)} 2>/dev/null || printf 'safe changed\\n'`,
      ].join('\n'),
    );
    await chmod(helper, 0o700);
    await writeFile(path.join(workspace, '.gitattributes'), '*.txt diff=hostile filter=hostile\n');
    await writeFile(path.join(workspace, 'target.txt'), 'safe base\n');
    git(workspace, 'init', '--quiet');
    git(workspace, 'config', '--local', 'user.email', 'circuit@example.test');
    git(workspace, 'config', '--local', 'user.name', 'Circuit Test');
    git(workspace, 'add', '.gitattributes', 'target.txt');
    git(workspace, 'commit', '--quiet', '-m', 'fixture');
    git(workspace, 'config', '--local', 'diff.hostile.textconv', helper);
    git(workspace, 'config', '--local', 'filter.hostile.clean', helper);
    git(workspace, 'config', '--local', 'core.fsmonitor', helper);
    await writeFile(path.join(workspace, 'target.txt'), 'safe changed\n');

    process.env.CIRCUIT_MCP_SEALED = '1';
    process.env.CIRCUIT_MCP_PROOF_RUNNER = PROOF_RUNNER;
    process.env.CIRCUIT_MCP_CANCEL_FILE = path.join(root, 'cancel');
    process.env.CIRCUIT_MCP_GIT_STATE_HELPER = resolveGitStateHelperPath();
    process.env.OPENAI_API_KEY = 'must-not-reach-git';

    const status = runSealedGitRead(workspace, 'review-status');
    expect(
      status.status,
      `${JSON.stringify(status, null, 2)}\n${status.error?.message ?? ''}`,
    ).toBe(0);
    const diff = runSealedGitRead(workspace, 'review-unstaged-diff');
    expect(diff.status, `${JSON.stringify(diff, null, 2)}\n${diff.error?.message ?? ''}`).toBe(0);
    const workingStatus = runSealedGitRead(workspace, 'working-tree-status');

    expect(
      workingStatus.status,
      `${JSON.stringify(workingStatus, null, 2)}\n${workingStatus.error?.message ?? ''}`,
    ).toBe(0);
    const changed = captureWorkingTreeChangedPaths(workspace);
    const gitStateObservation = runProofPlanCommand(
      gitStateCommand('build-baseline-snapshot-git-state'),
      workspace,
    );
    const gitState = parseGitStateObservation(
      gitStateObservation,
      'test.git-state-hostile-repository@v1',
    );

    expect(status.stdout).toContain('target.txt');
    expect(diff.stdout).toContain('+safe changed');
    expect(diff.stdout).not.toContain('must-not-reach-git');
    expect(`${status.stdout}\n${diff.stdout}\n${workingStatus.stdout}`).not.toContain(
      'must-not-be-readable-by-git',
    );
    expect(changed).toContain('target.txt');
    expect(gitState.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'target.txt',
          fingerprint: expect.stringMatching(/^[a-f0-9]{40}$/),
        }),
      ]),
    );
    expect(gitStateObservation.mcp_execution).toMatchObject({
      access: 'git-read-only',
      network: 'denied',
      cleanup_confirmed: true,
    });
    expect(existsSync(outsideMarker)).toBe(false);
  }, 60_000);
});
