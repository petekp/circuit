import childProcess, { execFileSync } from 'node:child_process';
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { ReviewIntake, ReviewResult } from '../../src/flows/review/reports.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RuntimeGitReader } from '../../src/shared/runtime-git-reader.js';
import {
  cleanRelayResult,
  loadFixture,
  relayerWith,
  reviewRunFolderBase,
  runCompiledFlow,
  useReviewRunFolders,
} from './review-wiring-harness.js';

// Review reads a repository it does not control. These cases feed it hostile
// Git configuration, redirected object stores, rewritten ancestry, and files
// that change under it mid-read, and assert it refuses rather than relays.
describe('review under hostile Git conditions', () => {
  useReviewRunFolders();

  it('ignores hostile inherited Git environment when collecting direct Review evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'hostile-git-environment');
    const projectRoot = join(reviewRunFolderBase(), 'hostile-git-environment-project-a');
    const hostileRoot = join(reviewRunFolderBase(), 'hostile-git-environment-project-b');
    const projectMarker = 'selected-project-a-marker';
    const hostileMarker = 'hostile-project-b-marker';

    for (const [root, marker] of [
      [projectRoot, projectMarker],
      [hostileRoot, hostileMarker],
    ] as const) {
      mkdirSync(root, { recursive: true });
      execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
      writeFileSync(join(root, 'review-target.ts'), `export const marker = '${marker}';\n`);
      execFileSync('git', ['add', 'review-target.ts'], { cwd: root, stdio: 'pipe' });
    }

    const hostileEnvironment = {
      GIT_DIR: join(hostileRoot, '.git'),
      GIT_WORK_TREE: hostileRoot,
      GIT_INDEX_FILE: join(hostileRoot, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: join(hostileRoot, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(hostileRoot, '.git', 'objects'),
      GIT_NAMESPACE: 'hostile-project-b',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: hostileRoot,
    } as const;
    const originalEnvironment = Object.fromEntries(
      Object.keys(hostileEnvironment).map((key) => [key, process.env[key]]),
    );
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    let relayedPrompt = '';

    try {
      Object.assign(process.env, hostileEnvironment);
      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-00000000003a',
        goal: 'review the staged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 23, 9, 0, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayedPrompt = input.prompt;
            return {
              request_payload: input.prompt,
              receipt_id: 'stub-receipt-hostile-git-environment',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      for (const [key, originalValue] of Object.entries(originalEnvironment)) {
        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    }

    expect(outcome?.outcome).toBe('complete');
    expect(relayedPrompt).toContain(projectMarker);
    expect(relayedPrompt).not.toContain(hostileMarker);
    for (const [key, originalValue] of Object.entries(originalEnvironment)) {
      expect(process.env[key]).toBe(originalValue);
    }
  });

  it('does not execute a repository-configured fsmonitor during direct Review Git reads', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'hostile-git-fsmonitor');
    const projectRoot = join(reviewRunFolderBase(), 'hostile-git-fsmonitor-project');
    const probePath = join(projectRoot, '.git', 'fsmonitor-probe.sh');
    const markerPath = join(projectRoot, 'fsmonitor-ran');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(
      probePath,
      `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\nprintf '\\n'\n`,
    );
    chmodSync(probePath, 0o755);
    writeFileSync(join(projectRoot, 'review-target.ts'), 'export const selected = true;\n');
    execFileSync('git', ['add', 'review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['config', '--local', 'core.fsmonitor', probePath], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000003c',
      goal: 'review the staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 23, 9, 10, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');
    expect(existsSync(markerPath)).toBe(false);
  });

  it.each([
    {
      helper: 'clean',
      scriptBody: (markerPath: string) =>
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\n/bin/cat\n`,
    },
    {
      helper: 'process',
      scriptBody: (markerPath: string) =>
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\nexit 1\n`,
    },
  ])(
    'does not execute a repository-configured filter.$helper helper during direct Review Git reads',
    async ({ helper, scriptBody }) => {
      const { bytes } = loadFixture();
      const runFolder = join(reviewRunFolderBase(), `hostile-git-filter-${helper}`);
      const projectRoot = join(reviewRunFolderBase(), `hostile-git-filter-${helper}-project`);
      const helperPath = join(projectRoot, '.git', `filter-${helper}-probe.sh`);
      const markerPath = join(projectRoot, `filter-${helper}-ran`);
      mkdirSync(projectRoot, { recursive: true });
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
      writeFileSync(join(projectRoot, '.gitattributes'), '*.txt filter=circuit-probe\n');
      writeFileSync(join(projectRoot, 'review-target.txt'), 'base\n');
      execFileSync('git', ['add', '.gitattributes', 'review-target.txt'], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Circuit',
          '-c',
          'user.email=circuit@example.test',
          'commit',
          '-m',
          'base',
        ],
        { cwd: projectRoot, stdio: 'pipe' },
      );
      writeFileSync(helperPath, scriptBody(markerPath));
      chmodSync(helperPath, 0o755);
      execFileSync('git', ['config', '--local', `filter.circuit-probe.${helper}`, helperPath], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      execFileSync('git', ['config', '--local', 'filter.circuit-probe.required', 'true'], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      writeFileSync(join(projectRoot, 'review-target.txt'), 'changed\n');

      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId:
          helper === 'clean'
            ? '79000000-0000-0000-0000-000000000090'
            : '79000000-0000-0000-0000-000000000091',
        goal: 'review unstaged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 0, 0)),
        projectRoot,
        relayer: relayerWith(cleanRelayResult()),
      });

      expect(existsSync(markerPath)).toBe(false);
    },
  );

  it.each([
    { scope: 'local', configScope: '--local', runSuffix: '97' },
    { scope: 'worktree', configScope: '--worktree', runSuffix: '9a' },
  ])(
    'rejects repository $scope Git config includes before they can add an executable filter',
    async ({ scope, configScope, runSuffix }) => {
      const { bytes } = loadFixture();
      const runFolder = join(reviewRunFolderBase(), `hostile-git-config-include-${scope}`);
      const projectRoot = join(
        reviewRunFolderBase(),
        `hostile-git-config-include-${scope}-project`,
      );
      const includedConfigPath = join(reviewRunFolderBase(), `hostile-filter-${scope}.gitconfig`);
      const helperPath = join(projectRoot, '.git', 'included-filter-probe.sh');
      const markerPath = join(projectRoot, 'included-filter-ran');
      mkdirSync(projectRoot, { recursive: true });
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
      writeFileSync(join(projectRoot, '.gitattributes'), '*.txt filter=circuit-probe\n');
      writeFileSync(join(projectRoot, 'review-target.txt'), 'base\n');
      execFileSync('git', ['add', '.gitattributes', 'review-target.txt'], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Circuit',
          '-c',
          'user.email=circuit@example.test',
          'commit',
          '-m',
          'base',
        ],
        { cwd: projectRoot, stdio: 'pipe' },
      );
      writeFileSync(
        helperPath,
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\n/bin/cat\n`,
      );
      chmodSync(helperPath, 0o755);
      writeFileSync(
        includedConfigPath,
        `[filter "circuit-probe"]\n\tclean = ${helperPath}\n\trequired = true\n`,
      );
      if (configScope === '--worktree') {
        execFileSync('git', ['config', '--local', 'extensions.worktreeConfig', 'true'], {
          cwd: projectRoot,
          stdio: 'pipe',
        });
      }
      execFileSync('git', ['config', configScope, 'include.path', includedConfigPath], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      writeFileSync(join(projectRoot, 'review-target.txt'), 'changed\n');
      let relayCalls = 0;

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: `79000000-0000-0000-0000-0000000000${runSuffix}`,
        goal: 'review unstaged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 5, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            return {
              request_payload: 'unsafe included filter must not be relayed',
              receipt_id: 'stub-receipt-hostile-git-config-include',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/include/i);
      expect(existsSync(markerPath)).toBe(false);
      expect(relayCalls).toBe(0);
    },
  );

  it('does not let repository core.worktree redirect direct Review evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'hostile-core-worktree');
    const projectRoot = join(reviewRunFolderBase(), 'hostile-core-worktree-project');
    const hostileRoot = join(reviewRunFolderBase(), 'hostile-core-worktree-outside');
    const selectedMarker = 'selected-worktree-marker';
    const hostileMarker = 'redirected-worktree-marker';
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(hostileRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'review-target.ts'), 'export const value = "base";\n');
    execFileSync('git', ['add', 'review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(
      join(projectRoot, 'review-target.ts'),
      `export const value = '${selectedMarker}';\n`,
    );
    writeFileSync(
      join(hostileRoot, 'review-target.ts'),
      `export const value = '${hostileMarker}';\n`,
    );
    execFileSync('git', ['config', '--local', 'core.worktree', hostileRoot], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    let relayedPrompt = '';

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000003d',
      goal: 'review the current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 23, 9, 15, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayedPrompt = input.prompt;
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-hostile-core-worktree',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayedPrompt).toContain(selectedMarker);
    expect(relayedPrompt).not.toContain(hostileMarker);
  });

  it('rejects an on-disk Git object alternate before direct Review can inspect another repository', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'hostile-git-object-alternate');
    const projectRoot = join(reviewRunFolderBase(), 'hostile-git-object-alternate-project');
    const alternateRoot = join(reviewRunFolderBase(), 'hostile-git-object-alternate-source');
    const alternateMarker = 'alternate-repository-commit-marker';
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(alternateRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['init'], { cwd: alternateRoot, stdio: 'pipe' });
    writeFileSync(
      join(alternateRoot, 'alternate.ts'),
      `export const marker = '${alternateMarker}';\n`,
    );
    execFileSync('git', ['add', 'alternate.ts'], { cwd: alternateRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-m',
        'alternate root',
      ],
      { cwd: alternateRoot, stdio: 'pipe' },
    );
    const alternateCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: alternateRoot,
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(projectRoot, '.git', 'objects', 'info', 'alternates'),
      `${join(alternateRoot, '.git', 'objects')}\n`,
    );
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000092',
      goal: `review commit ${alternateCommit}`,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 9, 5, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: alternateMarker,
            receipt_id: 'stub-receipt-hostile-git-object-alternate',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/alternate|object|repository/i);
    expect(relayCalls).toBe(0);
  });

  it('rejects a symbolic-link Git object directory before direct Review reads evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'hostile-git-object-symlink');
    const projectRoot = join(reviewRunFolderBase(), 'hostile-git-object-symlink-project');
    const objectPath = join(projectRoot, '.git', 'objects');
    const movedObjectPath = join(projectRoot, '.git', 'objects.real');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'review-target.ts'), 'export const selected = true;\n');
    execFileSync('git', ['add', 'review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    fs.renameSync(objectPath, movedObjectPath);
    fs.symlinkSync(movedObjectPath, objectPath);
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000098',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 9, 7, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'unsafe object directory must not be relayed',
            receipt_id: 'stub-receipt-hostile-git-object-symlink',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/objects|symbolic link/i);
    expect(relayCalls).toBe(0);
  });

  it('uses the real Git worktree when Review starts from a nested directory', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'nested-direct-review');
    const repositoryRoot = join(reviewRunFolderBase(), 'nested-direct-review-project');
    const projectRoot = join(repositoryRoot, 'packages', 'app');
    const marker = 'nested-review-marker';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: repositoryRoot, stdio: 'pipe' });
    writeFileSync(join(repositoryRoot, 'root.ts'), 'export const root = true;\n');
    writeFileSync(join(projectRoot, 'app.ts'), 'export const app = "base";\n');
    execFileSync('git', ['add', '-A'], { cwd: repositoryRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: repositoryRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'app.ts'), `export const app = '${marker}';\n`);
    let relayedPrompt = '';

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000101',
      goal: 'review my current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 9, 40, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayedPrompt = input.prompt;
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-nested-direct-review',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayedPrompt).toContain(marker);
    expect(relayedPrompt).not.toContain('deleted file mode');
    expect(relayedPrompt).not.toContain('root.ts |');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence).toMatchObject({
      kind: 'git-working-tree',
      project_root: fs.realpathSync(repositoryRoot),
    });
  });

  it('preserves an exact global safe.directory for direct Review Git reads', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'safe-directory-direct-review');
    const projectRoot = join(reviewRunFolderBase(), 'safe-directory-direct-review-project');
    const home = mkdtempSync(join(tmpdir(), 'circuit-review-safe-directory-'));
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'tracked.ts'), 'export const tracked = "base";\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'tracked.ts'), 'export const tracked = "changed";\n');
    writeFileSync(join(home, '.gitconfig'), `[safe]\n\tdirectory = ${projectRoot}\n`);

    const mutableChildProcess = childProcess as unknown as {
      spawnSync: (...args: unknown[]) => unknown;
    };
    const originalSpawnSync = mutableChildProcess.spawnSync;
    const previousHome = process.env.HOME;
    let relayCalls = 0;
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    try {
      process.env.HOME = home;
      mutableChildProcess.spawnSync = (...args: unknown[]): unknown => {
        const options = (args[2] ?? {}) as { readonly env?: NodeJS.ProcessEnv };
        return Reflect.apply(originalSpawnSync, childProcess, [
          args[0],
          args[1],
          {
            ...options,
            env: {
              ...options.env,
              GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
            },
          },
        ]);
      };
      syncBuiltinESMExports();

      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000102',
        goal: 'review unstaged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 45, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            return {
              request_payload: 'safe directory review',
              receipt_id: 'stub-receipt-safe-directory-direct-review',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      mutableChildProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
      if (previousHome === undefined) Reflect.deleteProperty(process.env, 'HOME');
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }

    expect(outcome?.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
  });

  it('does not restore a global safe.directory that a later empty value revoked', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'revoked-safe-directory-direct-review');
    const projectRoot = join(reviewRunFolderBase(), 'revoked-safe-directory-direct-review-project');
    const home = mkdtempSync(join(tmpdir(), 'circuit-review-revoked-safe-directory-'));
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'tracked.ts'), 'export const tracked = "base";\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'tracked.ts'), 'export const tracked = "changed";\n');
    writeFileSync(
      join(home, '.gitconfig'),
      `[safe]\n\tdirectory = ${projectRoot}\n\tdirectory =\n`,
    );

    const mutableChildProcess = childProcess as unknown as {
      spawnSync: (...args: unknown[]) => unknown;
    };
    const originalSpawnSync = mutableChildProcess.spawnSync;
    const previousHome = process.env.HOME;
    let relayCalls = 0;
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    try {
      process.env.HOME = home;
      mutableChildProcess.spawnSync = (...args: unknown[]): unknown => {
        const options = (args[2] ?? {}) as { readonly env?: NodeJS.ProcessEnv };
        return Reflect.apply(originalSpawnSync, childProcess, [
          args[0],
          args[1],
          {
            ...options,
            env: {
              ...options.env,
              GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
            },
          },
        ]);
      };
      syncBuiltinESMExports();

      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000103',
        goal: 'review unstaged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 50, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            return {
              request_payload: 'revoked safe directory must not be reviewed',
              receipt_id: 'stub-receipt-revoked-safe-directory-direct-review',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      mutableChildProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
      if (previousHome === undefined) Reflect.deleteProperty(process.env, 'HOME');
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }

    expect(outcome?.outcome).toBe('aborted');
    expect(outcome?.reason).toMatch(/dubious ownership|safe\.directory/i);
    expect(relayCalls).toBe(0);
  });

  it('stops before relay when a shallow clone is missing the requested commit parent', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'shallow-commit-target');
    const sourceRoot = join(reviewRunFolderBase(), 'shallow-source-project');
    const projectRoot = join(reviewRunFolderBase(), 'shallow-clone-project');
    mkdirSync(sourceRoot, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: sourceRoot, stdio: 'pipe' });
    writeFileSync(join(sourceRoot, 'base.ts'), 'export const base = true;\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: sourceRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: sourceRoot, stdio: 'pipe' },
    );
    writeFileSync(join(sourceRoot, 'child.ts'), 'export const child = true;\n');
    execFileSync('git', ['add', 'child.ts'], { cwd: sourceRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'child'],
      { cwd: sourceRoot, stdio: 'pipe' },
    );
    execFileSync('git', ['clone', '--depth=1', `file://${sourceRoot}`, projectRoot], {
      cwd: reviewRunFolderBase(),
      stdio: 'pipe',
    });
    expect(
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim(),
    ).toBe('true');
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000039',
      goal: 'review the latest commit',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'unexpected shallow diff',
            receipt_id: 'stub-receipt-shallow-commit',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/parent|shallow|unavailable/i);
    expect(relayCalls).toBe(0);
  });

  it('ignores replacement refs when reviewing a pinned commit', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'replacement-ref-target');
    const projectRoot = join(reviewRunFolderBase(), 'replacement-ref-project');
    const originalMarker = 'original-commit-marker';
    const replacementMarker = 'replacement-commit-marker';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'original.ts'), `export const value = '${originalMarker}';\n`);
    execFileSync('git', ['add', 'original.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'root'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    const originalCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    const replacementIndex = join(projectRoot, '.replacement-index');
    writeFileSync(
      join(projectRoot, 'replacement.ts'),
      `export const value = '${replacementMarker}';\n`,
    );
    const replacementEnvironment = {
      ...process.env,
      GIT_INDEX_FILE: replacementIndex,
    };
    execFileSync('git', ['add', 'replacement.ts'], {
      cwd: projectRoot,
      env: replacementEnvironment,
      stdio: 'pipe',
    });
    const replacementTree = execFileSync('git', ['write-tree'], {
      cwd: projectRoot,
      env: replacementEnvironment,
      encoding: 'utf8',
    }).trim();
    const replacementCommit = execFileSync('git', ['commit-tree', replacementTree], {
      cwd: projectRoot,
      env: replacementEnvironment,
      input: 'replacement\n',
      encoding: 'utf8',
    }).trim();
    rmSync(replacementIndex, { force: true });
    rmSync(join(projectRoot, 'replacement.ts'), { force: true });
    execFileSync('git', ['replace', originalCommit, replacementCommit], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    let relayedPrompt = '';

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000003a',
      goal: `review commit ${originalCommit}`,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayedPrompt = input.prompt;
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-replacement-ref',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayedPrompt).toContain(originalMarker);
    expect(relayedPrompt).not.toContain(replacementMarker);
  });

  it('stops before relay when legacy graft metadata can rewrite commit ancestry', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'grafted-commit-target');
    const projectRoot = join(reviewRunFolderBase(), 'grafted-commit-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'base.ts'), 'export const base = true;\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'child.ts'), 'export const child = true;\n');
    execFileSync('git', ['add', 'child.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'child'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    const childCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    mkdirSync(join(projectRoot, '.git', 'info'), { recursive: true });
    writeFileSync(join(projectRoot, '.git', 'info', 'grafts'), `${childCommit}\n`);
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000003b',
      goal: 'review the latest commit',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'unexpected grafted diff',
            receipt_id: 'stub-receipt-grafted-commit',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/graft/i);
    expect(relayCalls).toBe(0);
  });

  it('fails closed when an untracked file becomes a symlink immediately before open', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'untracked-final-symlink-swap');
    const projectRoot = join(reviewRunFolderBase(), 'untracked-final-symlink-swap-project');
    const scratchPath = join(projectRoot, 'scratch.txt');
    const movedScratchPath = join(projectRoot, 'scratch.original.txt');
    const outsidePath = join(reviewRunFolderBase(), 'outside-untracked-secret.txt');
    const outsideSecret = 'outside-secret-must-not-be-relayed';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(scratchPath, `${'x'.repeat(outsideSecret.length)}\n`);
    writeFileSync(outsidePath, `${outsideSecret}\n`);
    const canonicalScratchPath = fs.realpathSync(scratchPath);

    const mutableFs = fs as unknown as { openSync: (...args: unknown[]) => number };
    const originalOpenSync = mutableFs.openSync;
    let swapped = false;
    let relayedPrompt = '';
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    try {
      mutableFs.openSync = (...args: unknown[]): number => {
        if (!swapped && args[0] === canonicalScratchPath) {
          swapped = true;
          fs.renameSync(scratchPath, movedScratchPath);
          fs.symlinkSync(outsidePath, scratchPath);
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      };
      syncBuiltinESMExports();

      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000094',
        goal: 'review my current changes, including untracked files',
        depth: 'medium',
        evidencePolicy: { includeUntrackedFileContent: true },
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 15, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayedPrompt = input.prompt;
            return {
              request_payload: input.prompt,
              receipt_id: 'stub-receipt-untracked-final-symlink-swap',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      mutableFs.openSync = originalOpenSync;
      syncBuiltinESMExports();
    }

    expect(swapped).toBe(true);
    expect(relayedPrompt).not.toContain(outsideSecret);
    expect(outcome?.outcome).not.toBe('complete');
    const reportPath = join(runFolder, 'reports', 'review-result.json');
    if (existsSync(reportPath)) {
      const report = ReviewResult.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
      expect(report).toMatchObject({
        verdict: 'ISSUES_FOUND',
        outcome: 'stopped',
        findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
      });
    }
  });

  it('fails closed when an untracked file parent becomes an outside symlink before open', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'untracked-parent-symlink-swap');
    const projectRoot = join(reviewRunFolderBase(), 'untracked-parent-symlink-swap-project');
    const nestedRoot = join(projectRoot, 'nested');
    const movedNestedRoot = join(projectRoot, 'nested.original');
    const scratchPath = join(nestedRoot, 'scratch.txt');
    const outsideRoot = join(reviewRunFolderBase(), 'outside-untracked-parent');
    const outsidePath = join(outsideRoot, 'scratch.txt');
    const outsideSecret = 'outside-parent-secret-must-not-be-relayed';
    mkdirSync(nestedRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(scratchPath, 'safe content before parent swap\n');
    writeFileSync(outsidePath, `${outsideSecret}\n`);
    const canonicalScratchPath = fs.realpathSync(scratchPath);

    const mutableFs = fs as unknown as { openSync: (...args: unknown[]) => number };
    const originalOpenSync = mutableFs.openSync;
    let swapped = false;
    let relayedPrompt = '';
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    try {
      mutableFs.openSync = (...args: unknown[]): number => {
        if (!swapped && args[0] === canonicalScratchPath) {
          swapped = true;
          fs.renameSync(nestedRoot, movedNestedRoot);
          fs.symlinkSync(outsideRoot, nestedRoot);
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      };
      syncBuiltinESMExports();

      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000096',
        goal: 'review my current changes, including untracked files',
        depth: 'medium',
        evidencePolicy: { includeUntrackedFileContent: true },
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 17, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayedPrompt = input.prompt;
            return {
              request_payload: input.prompt,
              receipt_id: 'stub-receipt-untracked-parent-symlink-swap',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      mutableFs.openSync = originalOpenSync;
      syncBuiltinESMExports();
    }

    expect(swapped).toBe(true);
    expect(relayedPrompt).not.toContain(outsideSecret);
    expect(outcome?.outcome).not.toBe('complete');
  });

  it('fails closed when an untracked file grows after inspection but before open', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'untracked-final-growth-swap');
    const projectRoot = join(reviewRunFolderBase(), 'untracked-final-growth-swap-project');
    const scratchPath = join(projectRoot, 'scratch.txt');
    const initialContent = 'short\n';
    const omittedMarker = 'changed-after-inspection-marker';
    const replacementContent = `${initialContent}${'x'.repeat(25_000)}${omittedMarker}\n`;
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(scratchPath, initialContent);
    const canonicalScratchPath = fs.realpathSync(scratchPath);

    const mutableFs = fs as unknown as { openSync: (...args: unknown[]) => number };
    const originalOpenSync = mutableFs.openSync;
    let swapped = false;
    let relayedPrompt = '';
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    try {
      mutableFs.openSync = (...args: unknown[]): number => {
        if (!swapped && args[0] === canonicalScratchPath) {
          swapped = true;
          fs.writeFileSync(scratchPath, replacementContent);
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      };
      syncBuiltinESMExports();

      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000095',
        goal: 'review my current changes, including untracked files',
        depth: 'medium',
        evidencePolicy: { includeUntrackedFileContent: true },
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 20, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayedPrompt = input.prompt;
            return {
              request_payload: input.prompt,
              receipt_id: 'stub-receipt-untracked-final-growth-swap',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      mutableFs.openSync = originalOpenSync;
      syncBuiltinESMExports();
    }

    expect(swapped).toBe(true);
    expect(relayedPrompt).not.toContain(omittedMarker);
    expect(outcome?.outcome).not.toBe('complete');
    const reportPath = join(runFolder, 'reports', 'review-result.json');
    if (existsSync(reportPath)) {
      const report = ReviewResult.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
      expect(report).toMatchObject({
        verdict: 'ISSUES_FOUND',
        outcome: 'stopped',
        findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
      });
    }
  });

  it.each(['--assume-unchanged', '--skip-worktree'] as const)(
    'stops direct working-tree Review when a tracked path uses %s',
    async (flag) => {
      const { bytes } = loadFixture();
      const label = flag.slice(2);
      const runFolder = join(reviewRunFolderBase(), `direct-hidden-index-${label}`);
      const projectRoot = join(reviewRunFolderBase(), `direct-hidden-index-${label}-project`);
      mkdirSync(projectRoot, { recursive: true });
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
      writeFileSync(join(projectRoot, 'hidden.ts'), 'export const value = 1;\n');
      execFileSync('git', ['add', 'hidden.ts'], { cwd: projectRoot, stdio: 'pipe' });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Circuit',
          '-c',
          'user.email=circuit@example.test',
          'commit',
          '-m',
          'base',
        ],
        { cwd: projectRoot, stdio: 'pipe' },
      );
      execFileSync('git', ['update-index', flag, 'hidden.ts'], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      writeFileSync(join(projectRoot, 'hidden.ts'), 'export const value = 2;\n');
      let relayCalls = 0;

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId:
          flag === '--assume-unchanged'
            ? '79000000-0000-0000-0000-00000000010b'
            : '79000000-0000-0000-0000-00000000010c',
        goal: 'review unstaged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 10, 35, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            return {
              request_payload: 'hidden index state must not reach the reviewer',
              receipt_id: 'stub-receipt-hidden-index-direct',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/assume-unchanged|skip-worktree|hidden index/i);
      expect(relayCalls).toBe(0);
    },
  );

  it('never relays auxiliary Git configuration output as a truncated staged diff', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'auxiliary-config-output');
    const projectRoot = join(reviewRunFolderBase(), 'auxiliary-config-output-project');
    const secretMarker = 'AUXILIARY_GIT_CONFIG_MUST_NOT_REACH_REVIEW';
    mkdirSync(projectRoot, { recursive: true });
    const gitReader: RuntimeGitReader = {
      read: async (request) => ({
        schema_version: 1,
        ok: request.operation !== 'staged_diff',
        operation: request.operation,
        stdout:
          request.operation === 'staged_diff'
            ? `credential.helper\n${secretMarker}\n`
            : request.operation === 'staged_diff_stat'
              ? ' source.ts | 1 +\n'
              : '',
        stderr: request.operation === 'staged_diff' ? 'Git configuration output was limited.' : '',
        exit_code: request.operation === 'staged_diff' ? null : 0,
        truncated: request.operation === 'staged_diff',
        limit_bytes: 2 * 1024 * 1024,
        cleanup_confirmed: true,
      }),
    };
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000115',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 15, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'auxiliary config must not be relayed',
            receipt_id: 'stub-receipt-auxiliary-config-output',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/configuration|staged changes could not be read|failed/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
    expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(secretMarker);
  });
});
