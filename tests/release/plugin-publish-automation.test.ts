import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageTreeStatus } from '../../scripts/plugins/package-tree.ts';
import { type CommandInvocation, runPublish } from '../../scripts/plugins/publish.ts';

const REPO_ROOT = resolve('.');

type FixtureOptions = {
  version?: string;
  claudeVersion?: string;
  codexVersion?: string;
  marketplaceName?: string;
  packageVersion?: string;
  // Version named by the README install ref; null omits the ref line entirely.
  readmeRefVersion?: string | null;
};

type GitFixture = {
  branch?: string;
  upstream?: string | null;
  head?: string;
  originHead?: string;
  dirty?: string;
};

type RunnerOptions = {
  codexCacheTarget?: string;
  claudeMarketplaceList?: unknown;
  onCall?: (invocation: CommandInvocation) => void;
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function createFixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'circuit-publish-test-'));
  const version = options.version ?? '0.1.0-alpha.2';
  const claudeVersion = options.claudeVersion ?? version;
  const codexVersion = options.codexVersion ?? version;
  const marketplaceName = options.marketplaceName ?? 'circuit';

  writeJson(join(root, 'package.json'), {
    version: options.packageVersion ?? version,
    scripts: {
      'publish:plugins': 'node scripts/plugins/publish.ts check',
      'publish:plugins:bump': 'node scripts/plugins/publish.ts bump',
      'publish:plugins:check': 'node scripts/plugins/publish.ts check',
      'publish:plugins:local': 'node scripts/plugins/publish.ts local',
      'publish:plugins:release':
        'node scripts/plugins/publish.ts release --codex-source petekp/circuit --codex-marketplace circuit',
      'sync:claude-plugin-cache': 'node scripts/plugins/sync-claude-cache.ts',
      'check:claude-plugin-cache': 'node scripts/plugins/sync-claude-cache.ts --check',
      'doctor:plugins:installed': 'node scripts/plugins/installed-doctor.ts',
      'sync:host-plugin-caches':
        'npm run sync:claude-plugin-cache && npm run sync:codex-plugin-cache',
      'check:host-plugin-caches':
        'npm run check:claude-plugin-cache && npm run check:codex-plugin-cache',
      'plugins:refresh-local': 'node scripts/plugins/refresh-local.ts',
    },
  });
  writeJson(join(root, 'plugins/version.json'), { version });
  writeJson(join(root, 'plugins/claude/.claude-plugin/plugin.json'), {
    name: 'circuit',
    version: claudeVersion,
    description: 'Claude plugin',
  });
  writeJson(join(root, 'plugins/codex/.codex-plugin/plugin.json'), {
    name: 'circuit',
    version: codexVersion,
    description: 'Codex plugin',
    homepage: 'https://github.com/petekp/circuit',
    repository: 'https://github.com/petekp/circuit',
    skills: './skills/',
    interface: {
      displayName: 'Circuit',
      shortDescription: 'Choose and run the right Circuit flow',
      longDescription: 'Use @Circuit with a natural-language coding task.',
      category: 'Coding',
      capabilities: ['Interactive', 'Write'],
      defaultPrompt: ['Use Circuit on this task'],
    },
  });
  writeJson(join(root, '.claude-plugin/marketplace.json'), {
    name: 'circuit',
    owner: { name: 'Pete Petrash' },
    plugins: [
      {
        name: 'circuit',
        version: claudeVersion,
        source: './plugins/claude',
      },
    ],
  });
  writeJson(join(root, '.agents/plugins/marketplace.json'), {
    name: marketplaceName,
    plugins: [
      {
        name: 'circuit',
        source: { source: 'local', path: './plugins/codex' },
        policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' },
        category: 'Coding',
      },
    ],
  });
  const readmeRefVersion =
    options.readmeRefVersion === undefined ? version : options.readmeRefVersion;
  writeText(
    join(root, 'README.md'),
    readmeRefVersion === null
      ? '# Circuit\n\nInstall instructions live here.\n'
      : `# Circuit\n\n\`\`\`bash\ncodex plugin marketplace add petekp/circuit --ref circuit--v${readmeRefVersion}\n\`\`\`\n`,
  );
  writeText(join(root, 'plugins/claude/README.md'), 'Claude Circuit plugin\n');
  writeText(join(root, 'plugins/claude/commands/run.md'), '# Run\n');
  writeText(join(root, 'plugins/claude/skills/run/SKILL.md'), '# Run skill\n');
  writeText(join(root, 'plugins/claude/scripts/circuit.ts'), '#!/usr/bin/env node\n');
  writeText(join(root, 'plugins/codex/README.md'), 'Codex Circuit plugin\n');
  writeText(join(root, 'plugins/codex/commands/run.md'), '# Run\n');
  writeText(join(root, 'plugins/codex/skills/run/SKILL.md'), '# Run skill\n');
  writeText(join(root, 'plugins/codex/scripts/circuit.ts'), '#!/usr/bin/env node\n');

  return root;
}

function localInstallRoots(root: string, homeDir: string, codexHome: string) {
  const version = JSON.parse(readFileSync(join(root, 'plugins/version.json'), 'utf8')) as {
    version: string;
  };
  return {
    claude: join(homeDir, '.claude/plugins/cache/circuit/circuit', version.version),
    codex: join(codexHome, 'plugins/cache/circuit-local/circuit', version.version),
  };
}

function copyPackage(source: string, target: string): void {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function primeInstalledPackages(root: string) {
  const homeDir = mkdtempSync(join(tmpdir(), 'circuit-publish-home-'));
  const codexHome = mkdtempSync(join(tmpdir(), 'circuit-publish-codex-'));
  const roots = localInstallRoots(root, homeDir, codexHome);
  copyPackage(join(root, 'plugins/claude'), roots.claude);
  copyPackage(join(root, 'plugins/codex'), roots.codex);
  return { homeDir, codexHome, ...roots };
}

function createRunner(git: GitFixture = {}, options: RunnerOptions = {}) {
  const calls: CommandInvocation[] = [];
  const branch = git.branch ?? 'main';
  const upstream = git.upstream === undefined ? 'origin/main' : git.upstream;
  const head = git.head ?? 'abc123';
  const originHead = git.originHead ?? head;
  const dirty = git.dirty ?? '';
  let claudeMarketplaceList = JSON.parse(
    JSON.stringify(options.claudeMarketplaceList ?? []),
  ) as unknown[];

  return {
    calls,
    runner(invocation: CommandInvocation) {
      calls.push(invocation);
      options.onCall?.(invocation);
      switch (invocation.id) {
        case 'git_status':
          return { exitCode: 0, stdout: dirty, stderr: '' };
        case 'git_branch':
          return { exitCode: 0, stdout: `${branch}\n`, stderr: '' };
        case 'git_upstream':
          if (upstream === null) return { exitCode: 1, stdout: '', stderr: 'no upstream\n' };
          return { exitCode: 0, stdout: `${upstream}\n`, stderr: '' };
        case 'git_head':
          return { exitCode: 0, stdout: `${head}\n`, stderr: '' };
        case 'git_origin_head':
          return { exitCode: 0, stdout: `${originHead}\n`, stderr: '' };
        case 'claude_marketplace_remove_user': {
          const name = invocation.argv[4];
          claudeMarketplaceList = claudeMarketplaceList.filter(
            (entry) =>
              typeof entry !== 'object' ||
              entry === null ||
              Array.isArray(entry) ||
              (entry as { name?: unknown }).name !== name,
          );
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        case 'claude_marketplace_add_user': {
          const path = invocation.argv[4];
          claudeMarketplaceList = [
            ...claudeMarketplaceList.filter(
              (entry) =>
                typeof entry !== 'object' ||
                entry === null ||
                Array.isArray(entry) ||
                (entry as { name?: unknown }).name !== 'circuit',
            ),
            {
              name: 'circuit',
              source: 'directory',
              path,
              installLocation: path,
            },
          ];
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        case 'claude_marketplace_update_user':
          return { exitCode: 0, stdout: '', stderr: '' };
        case 'claude_doctor':
        case 'codex_doctor':
        case 'claude_install_smoke_doctor':
        case 'claude_installed_doctor':
        case 'codex_installed_doctor':
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              status: 'ok',
              runtime_source: 'bundled',
              runtime_path: '/tmp/plugin/runtime/circuit.js',
            })}\n`,
            stderr: '',
          };
        case 'claude_marketplace_list_user':
        case 'claude_marketplace_verify_user':
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(claudeMarketplaceList)}\n`,
            stderr: '',
          };
        case 'codex_cache_sync':
          return {
            exitCode: 0,
            stdout:
              options.codexCacheTarget === undefined
                ? ''
                : `${JSON.stringify({ status: 'synced', target: options.codexCacheTarget })}\n`,
            stderr: '',
          };
        case 'codex_cache_check':
          return {
            exitCode: 0,
            stdout:
              options.codexCacheTarget === undefined
                ? ''
                : `${JSON.stringify({
                    status: 'ok',
                    target: options.codexCacheTarget,
                    package_tree: { status: 'ok' },
                  })}\n`,
            stderr: '',
          };
        default:
          return { exitCode: 0, stdout: '', stderr: '' };
      }
    },
  };
}

function ids(calls: CommandInvocation[]): string[] {
  return calls.map((call) => call.id);
}

describe('plugin publish automation', () => {
  it('exposes package scripts for check, local, and release targets', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['publish:plugins']).toBe('node scripts/plugins/publish.ts check');
    expect(pkg.scripts['publish:plugins:bump']).toBe('node scripts/plugins/publish.ts bump');
    expect(pkg.scripts['publish:plugins:check']).toBe('node scripts/plugins/publish.ts check');
    expect(pkg.scripts['publish:plugins:local']).toBe('node scripts/plugins/publish.ts local');
    expect(pkg.scripts['publish:plugins:release']).toBe(
      'node scripts/plugins/publish.ts release --codex-source petekp/circuit --codex-marketplace circuit',
    );
    expect(pkg.scripts['sync:claude-plugin-cache']).toBe(
      'node scripts/plugins/sync-claude-cache.ts',
    );
    expect(pkg.scripts['check:claude-plugin-cache']).toBe(
      'node scripts/plugins/sync-claude-cache.ts --check',
    );
    expect(pkg.scripts['doctor:plugins:installed']).toBe(
      'node scripts/plugins/installed-doctor.ts',
    );
    expect(pkg.scripts['plugins:refresh-local']).toBe('node scripts/plugins/refresh-local.ts');
    expect(pkg.scripts['sync:host-plugin-caches']).toBe(
      'npm run sync:claude-plugin-cache && npm run sync:codex-plugin-cache',
    );
    expect(pkg.scripts['check:host-plugin-caches']).toBe(
      'npm run check:claude-plugin-cache && npm run check:codex-plugin-cache',
    );
  });

  it('reads plugin manifests and marketplace metadata into the report', () => {
    const root = createFixture();
    const { runner } = createRunner();
    try {
      const report = runPublish(['check', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner,
      });

      expect(report.status).toBe('passed');
      expect(report.versions).toMatchObject({
        source: '0.1.0-alpha.2',
        claude: '0.1.0-alpha.2',
        codex: '0.1.0-alpha.2',
        claude_marketplace: '0.1.0-alpha.2',
      });
      expect(report.outputs).toMatchObject({
        codex_marketplace: 'circuit',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bumps every plugin version file explicitly without running validation', () => {
    const root = createFixture();
    const { calls, runner } = createRunner();
    try {
      const report = runPublish(['bump', '--version', '0.1.0-alpha.3'], {
        repoRoot: root,
        runner,
      });

      expect(report.status).toBe('passed');
      expect(report.outputs).toMatchObject({
        bumped_version: '0.1.0-alpha.3',
      });
      expect(ids(calls)).not.toContain('verify');
      expect(JSON.parse(readFileSync(join(root, 'plugins/version.json'), 'utf8'))).toMatchObject({
        version: '0.1.0-alpha.3',
      });
      expect(
        JSON.parse(readFileSync(join(root, 'plugins/claude/.claude-plugin/plugin.json'), 'utf8')),
      ).toMatchObject({ version: '0.1.0-alpha.3' });
      expect(
        JSON.parse(readFileSync(join(root, 'plugins/codex/.codex-plugin/plugin.json'), 'utf8')),
      ).toMatchObject({ version: '0.1.0-alpha.3' });
      expect(
        JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8')),
      ).toMatchObject({
        plugins: [expect.objectContaining({ name: 'circuit', version: '0.1.0-alpha.3' })],
      });
      expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toMatchObject({
        version: '0.1.0-alpha.3',
      });
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(
        '--ref circuit--v0.1.0-alpha.3',
      );
      expect(readFileSync(join(root, 'README.md'), 'utf8')).not.toContain('0.1.0-alpha.2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails bump when the README has no install ref to rewrite', () => {
    const root = createFixture({ readmeRefVersion: null });
    const { runner } = createRunner();
    try {
      const report = runPublish(['bump', '--version', '0.1.0-alpha.3'], {
        repoRoot: root,
        runner,
      });
      expect(report.status).toBe('failed');
      expect(report.errors.join('\n')).toContain('README.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a drifted README install ref as a version mismatch', () => {
    const root = createFixture({ readmeRefVersion: '0.1.0-alpha.1' });
    const { runner } = createRunner();
    try {
      const check = runPublish(['check', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner,
      });
      expect(check.status).toBe('passed');
      expect(check.warnings.join('\n')).toContain('version mismatch');
      expect(check.warnings.join('\n')).toContain('README install ref');

      const release = runPublish(
        ['release', '--codex-source', 'petekp/circuit', '--codex-marketplace', 'circuit'],
        { repoRoot: root, runner },
      );
      expect(release.status).toBe('failed');
      expect(release.errors.join('\n')).toContain('version mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a drifted root package.json version as a version mismatch', () => {
    const root = createFixture({ packageVersion: '0.0.1' });
    const { runner } = createRunner();
    try {
      const check = runPublish(['check', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner,
      });
      expect(check.status).toBe('passed');
      expect(check.warnings.join('\n')).toContain('version mismatch');
      expect(check.warnings.join('\n')).toContain('package.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects plugin bumps without an explicit semver version', () => {
    const root = createFixture();
    const { runner } = createRunner();
    try {
      const missing = runPublish(['bump'], { repoRoot: root, runner });
      const invalid = runPublish(['bump', '--version', 'next'], { repoRoot: root, runner });

      expect(missing.status).toBe('failed');
      expect(missing.errors.join('\n')).toContain('bump requires --version');
      expect(invalid.status).toBe('failed');
      expect(invalid.errors.join('\n')).toContain('--version must be a semver string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails release on version mismatch but only warns for check/local', () => {
    const root = createFixture({ codexVersion: '0.1.0' });
    const { runner } = createRunner();
    try {
      const check = runPublish(['check', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner,
      });
      expect(check.status).toBe('passed');
      expect(check.warnings.join('\n')).toContain('version mismatch');

      const release = runPublish(
        ['release', '--codex-source', 'petekp/circuit', '--codex-marketplace', 'circuit'],
        {
          repoRoot: root,
          runner,
        },
      );
      expect(release.status).toBe('failed');
      expect(release.errors.join('\n')).toContain('version mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks unsafe release preconditions before publish effects', () => {
    const cases: Array<{ name: string; git?: GitFixture; args?: string[]; error: string }> = [
      { name: 'dirty tree', git: { dirty: '?? file\n' }, error: 'working tree must be clean' },
      {
        name: 'non-main branch',
        git: { branch: 'feature' },
        error: 'release requires branch main',
      },
      {
        name: 'stale origin/main',
        git: { originHead: 'def456' },
        error: 'HEAD must match origin/main',
      },
      {
        name: 'local source',
        args: ['--codex-source', './', '--codex-marketplace', 'circuit'],
        error: 'remote Codex source',
      },
      {
        name: 'local marketplace name',
        args: ['--codex-source', 'petekp/circuit', '--codex-marketplace', 'circuit-local'],
        error: 'must not end in -local',
      },
      {
        name: 'allow dirty option',
        args: [
          '--allow-dirty',
          '--codex-source',
          'petekp/circuit',
          '--codex-marketplace',
          'circuit',
        ],
        error: 'release does not allow --allow-dirty',
      },
    ];

    for (const testCase of cases) {
      const root = createFixture({
        marketplaceName: testCase.args?.includes('circuit-local') ? 'circuit-local' : 'circuit',
      });
      const { calls, runner } = createRunner(testCase.git);
      try {
        const report = runPublish(
          [
            'release',
            ...(testCase.args ?? [
              '--codex-source',
              'petekp/circuit',
              '--codex-marketplace',
              'circuit',
            ]),
          ],
          {
            repoRoot: root,
            runner,
          },
        );

        expect(report.status, testCase.name).toBe('failed');
        expect(report.errors.join('\n'), testCase.name).toContain(testCase.error);
        expect(ids(calls), testCase.name).not.toContain('claude_tag_push');
        expect(ids(calls), testCase.name).not.toContain('codex_marketplace_add_release');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('keeps check and release read-only with respect to generated surfaces', () => {
    const root = createFixture();
    const { calls, runner } = createRunner();
    try {
      runPublish(['check'], { repoRoot: root, runner });
      runPublish(
        ['release', '--codex-source', 'petekp/circuit', '--codex-marketplace', 'circuit'],
        {
          repoRoot: root,
          runner,
        },
      );

      expect(ids(calls)).toContain('check_flow_drift');
      expect(ids(calls)).not.toContain('emit_flows');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets local publish opt into generated writes and Codex cache sync', () => {
    const root = createFixture();
    const installed = primeInstalledPackages(root);
    const { calls, runner } = createRunner(
      {},
      {
        codexCacheTarget: installed.codex,
        claudeMarketplaceList: [
          {
            name: 'circuit',
            source: 'directory',
            path: '/tmp/old-circuit',
          },
        ],
      },
    );
    try {
      const report = runPublish(['local', '--write-generated'], {
        repoRoot: root,
        runner,
        homeDir: installed.homeDir,
        codexHome: installed.codexHome,
      });

      expect(report.status).toBe('passed');
      expect(ids(calls)).toEqual(
        expect.arrayContaining([
          'emit_flows',
          'claude_marketplace_add_user',
          'claude_plugin_update_user',
          'codex_cache_sync',
          'codex_cache_check',
        ]),
      );
      expect(ids(calls)).not.toContain('codex_marketplace_add_local');
      expect(ids(calls)).not.toContain('codex_handoff_hook_install');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(installed.homeDir, { recursive: true, force: true });
      rmSync(installed.codexHome, { recursive: true, force: true });
    }
  });

  it('allows local publish from a detached checkout with no upstream', () => {
    const root = createFixture();
    const installed = primeInstalledPackages(root);
    const { calls, runner } = createRunner(
      { branch: '', upstream: null },
      { codexCacheTarget: installed.codex },
    );
    try {
      const report = runPublish(['local', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner,
        homeDir: installed.homeDir,
        codexHome: installed.codexHome,
      });

      expect(report.status).toBe('passed');
      expect(report.warnings.join('\n')).toContain('git upstream is unavailable');
      expect(ids(calls)).toContain('git_upstream');
      expect(ids(calls)).toContain('claude_plugin_update_user');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(installed.homeDir, { recursive: true, force: true });
      rmSync(installed.codexHome, { recursive: true, force: true });
    }
  });

  it('still rejects release from a detached checkout', () => {
    const root = createFixture();
    const { calls, runner } = createRunner({ branch: '', upstream: null });
    try {
      const report = runPublish(
        ['release', '--codex-source', 'petekp/circuit', '--codex-marketplace', 'circuit'],
        { repoRoot: root, runner },
      );

      expect(report.status).toBe('failed');
      expect(report.errors.join('\n')).toContain('git_upstream failed');
      expect(ids(calls)).not.toContain('claude_tag_push');
      expect(ids(calls)).not.toContain('codex_marketplace_add_release');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records but skips user install mutations during local dry-run with hook install', () => {
    const root = createFixture();
    const homeDir = mkdtempSync(join(tmpdir(), 'circuit-publish-home-'));
    const codexHome = mkdtempSync(join(tmpdir(), 'circuit-publish-codex-'));
    const codexTarget = localInstallRoots(root, homeDir, codexHome).codex;
    const { runner } = createRunner({}, { codexCacheTarget: codexTarget });
    try {
      const report = runPublish(
        ['local', '--dry-run', '--install-codex-hook', '--skip-verify', '--allow-unsafe'],
        {
          repoRoot: root,
          runner,
          homeDir,
          codexHome,
        },
      );

      expect(report.status).toBe('passed');
      expect(report.commands).toContainEqual(
        expect.objectContaining({ id: 'claude_marketplace_add_user', skipped: true }),
      );
      expect(report.commands).toContainEqual(
        expect.objectContaining({ id: 'claude_plugin_update_user', skipped: true }),
      );
      expect(report.commands).toContainEqual(
        expect.objectContaining({ id: 'codex_cache_sync', skipped: true }),
      );
      expect(report.commands).toContainEqual(
        expect.objectContaining({ id: 'codex_handoff_hook_install', skipped: true }),
      );
      expect(report.commands.map((command) => command.id)).not.toContain(
        'claude_plugin_uninstall_user',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('adds the Claude user marketplace from repo root before updating the install', () => {
    const root = createFixture();
    const installed = primeInstalledPackages(root);
    const { calls, runner } = createRunner(
      {},
      {
        codexCacheTarget: installed.codex,
        claudeMarketplaceList: [
          {
            name: 'circuit',
            source: 'directory',
            path: '/tmp/old-circuit',
          },
        ],
      },
    );
    try {
      const report = runPublish(['local', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner,
        homeDir: installed.homeDir,
        codexHome: installed.codexHome,
      });

      expect(report.status).toBe('passed');
      const removeIndex = ids(calls).indexOf('claude_marketplace_remove_user');
      const addIndex = ids(calls).indexOf('claude_marketplace_add_user');
      const updateIndex = ids(calls).indexOf('claude_plugin_update_user');
      expect(removeIndex).toBeGreaterThanOrEqual(0);
      expect(addIndex).toBeGreaterThanOrEqual(0);
      expect(addIndex).toBeGreaterThan(removeIndex);
      expect(updateIndex).toBeGreaterThan(addIndex);
      expect(calls[addIndex]?.argv).toEqual([
        'claude',
        'plugin',
        'marketplace',
        'add',
        root,
        '--scope',
        'user',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(installed.homeDir, { recursive: true, force: true });
      rmSync(installed.codexHome, { recursive: true, force: true });
    }
  });

  it('updates the Claude user marketplace when it already points at repo root', () => {
    const root = createFixture();
    const installed = primeInstalledPackages(root);
    const { calls, runner } = createRunner(
      {},
      {
        codexCacheTarget: installed.codex,
        claudeMarketplaceList: [
          {
            name: 'circuit',
            source: 'directory',
            path: root,
          },
        ],
      },
    );
    try {
      const report = runPublish(['local', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner,
        homeDir: installed.homeDir,
        codexHome: installed.codexHome,
      });

      expect(report.status).toBe('passed');
      expect(ids(calls)).toContain('claude_marketplace_update_user');
      expect(ids(calls)).not.toContain('claude_marketplace_add_user');
      expect(ids(calls).indexOf('claude_plugin_update_user')).toBeGreaterThan(
        ids(calls).indexOf('claude_marketplace_update_user'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(installed.homeDir, { recursive: true, force: true });
      rmSync(installed.codexHome, { recursive: true, force: true });
    }
  });

  it('fails local publish when the Claude user marketplace still points away after refresh', () => {
    const root = createFixture();
    const installed = primeInstalledPackages(root);
    const staleEntry = [
      {
        name: 'circuit',
        source: 'directory',
        path: '/tmp/old-circuit',
      },
    ];
    const base = createRunner(
      {},
      {
        codexCacheTarget: installed.codex,
        claudeMarketplaceList: staleEntry,
      },
    );
    const runner = (invocation: CommandInvocation) => {
      if (invocation.id === 'claude_marketplace_verify_user') {
        base.calls.push(invocation);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(staleEntry)}\n`,
          stderr: '',
        };
      }
      return base.runner(invocation);
    };
    try {
      const report = runPublish(['local', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner,
        homeDir: installed.homeDir,
        codexHome: installed.codexHome,
      });

      expect(report.status).toBe('failed');
      expect(report.errors.join('\n')).toContain('Claude user marketplace circuit points at');
      expect(report.errors.join('\n')).toContain(root);
      expect(ids(base.calls)).toContain('claude_marketplace_verify_user');
      expect(ids(base.calls)).not.toContain('claude_plugin_update_user');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(installed.homeDir, { recursive: true, force: true });
      rmSync(installed.codexHome, { recursive: true, force: true });
    }
  });

  it('installs Claude when update reports not installed even if stale bytes exist', () => {
    const root = createFixture();
    const homeDir = mkdtempSync(join(tmpdir(), 'circuit-publish-home-'));
    const codexHome = mkdtempSync(join(tmpdir(), 'circuit-publish-codex-'));
    const roots = localInstallRoots(root, homeDir, codexHome);
    copyPackage(join(root, 'plugins/claude'), roots.claude);
    writeText(join(roots.claude, 'README.md'), 'orphaned stale Claude package\n');
    copyPackage(join(root, 'plugins/codex'), roots.codex);
    const base = createRunner(
      {},
      {
        codexCacheTarget: roots.codex,
        onCall(invocation) {
          if (invocation.id === 'claude_plugin_install_user') {
            copyPackage(join(root, 'plugins/claude'), roots.claude);
          }
        },
      },
    );
    const runner = (invocation: CommandInvocation) => {
      if (invocation.id === 'claude_plugin_update_user') {
        base.calls.push(invocation);
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Plugin "circuit" is not installed\n',
        };
      }
      return base.runner(invocation);
    };
    try {
      const report = runPublish(['local', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner,
        homeDir,
        codexHome,
      });

      expect(report.status).toBe('passed');
      expect(report.warnings.join('\n')).toContain('falling back to install');
      expect(ids(base.calls)).toContain('claude_plugin_install_user');
      expect(ids(base.calls)).not.toContain('claude_plugin_uninstall_user');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('reinstalls the Claude user package when same-version bytes stay stale', () => {
    const root = createFixture();
    const installed = primeInstalledPackages(root);
    writeText(join(installed.claude, 'README.md'), 'stale Claude package\n');
    const { calls, runner } = createRunner(
      {},
      {
        codexCacheTarget: installed.codex,
        onCall(invocation) {
          if (invocation.id === 'claude_plugin_install_user') {
            copyPackage(join(root, 'plugins/claude'), installed.claude);
          }
        },
      },
    );
    try {
      const report = runPublish(['local', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner,
        homeDir: installed.homeDir,
        codexHome: installed.codexHome,
      });

      expect(report.status).toBe('passed');
      expect(ids(calls)).toEqual(
        expect.arrayContaining(['claude_plugin_uninstall_user', 'claude_plugin_install_user']),
      );
      const uninstall = calls.find((call) => call.id === 'claude_plugin_uninstall_user');
      expect(uninstall?.argv).toEqual(expect.arrayContaining(['--keep-data', '--yes']));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(installed.homeDir, { recursive: true, force: true });
      rmSync(installed.codexHome, { recursive: true, force: true });
    }
  });

  it('installs the Codex hook only when explicitly requested and after cache sync', () => {
    const root = createFixture();
    const installed = primeInstalledPackages(root);
    const base = createRunner({}, { codexCacheTarget: installed.codex });
    try {
      const defaultReport = runPublish(['local', '--skip-verify', '--allow-unsafe'], {
        repoRoot: root,
        runner: base.runner,
        homeDir: installed.homeDir,
        codexHome: installed.codexHome,
      });
      expect(defaultReport.status).toBe('passed');
      expect(ids(base.calls)).not.toContain('codex_handoff_hook_install');

      const explicit = createRunner({}, { codexCacheTarget: installed.codex });
      const hookReport = runPublish(
        ['local', '--install-codex-hook', '--skip-verify', '--allow-unsafe'],
        {
          repoRoot: root,
          runner: explicit.runner,
          homeDir: installed.homeDir,
          codexHome: installed.codexHome,
        },
      );

      expect(hookReport.status).toBe('passed');
      const callIds = ids(explicit.calls);
      expect(callIds.indexOf('codex_handoff_hook_install')).toBeGreaterThan(
        callIds.indexOf('codex_cache_check'),
      );
      const hook = explicit.calls.find((call) => call.id === 'codex_handoff_hook_install');
      expect(hook?.argv).toContain(join(installed.codex, 'scripts/circuit.js'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(installed.homeDir, { recursive: true, force: true });
      rmSync(installed.codexHome, { recursive: true, force: true });
    }
  });

  it('rejects release hook installation before effects', () => {
    const root = createFixture();
    const { calls, runner } = createRunner();
    try {
      const report = runPublish(
        [
          'release',
          '--install-codex-hook',
          '--codex-source',
          'petekp/circuit',
          '--codex-marketplace',
          'circuit',
        ],
        { repoRoot: root, runner },
      );

      expect(report.status).toBe('failed');
      expect(report.errors.join('\n')).toContain('release does not allow --install-codex-hook');
      expect(ids(calls)).not.toContain('claude_tag_push');
      expect(ids(calls)).not.toContain('codex_handoff_hook_install');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs Claude in a temporary home and fails duplicate hook load errors', () => {
    const root = createFixture();
    const { calls, runner: baseRunner } = createRunner();
    const runner = (invocation: CommandInvocation) => {
      if (invocation.id === 'claude_install_smoke_list') {
        calls.push(invocation);
        return {
          exitCode: 0,
          stdout: '1 error:\nFailed to load hooks: Duplicate hooks file detected\n',
          stderr: '',
        };
      }
      return baseRunner(invocation);
    };
    try {
      const report = runPublish(['check'], { repoRoot: root, runner });

      expect(report.status).toBe('failed');
      expect(report.errors.join('\n')).toContain('Claude install smoke');
      expect(ids(calls)).toEqual(
        expect.arrayContaining([
          'claude_install_smoke_marketplace_add',
          'claude_install_smoke_install',
          'claude_install_smoke_list',
        ]),
      );
      const smokeAdd = calls.find((call) => call.id === 'claude_install_smoke_marketplace_add');
      expect(smokeAdd?.cwd).toContain('circuit-claude-install-');
      expect(smokeAdd?.env?.HOME).toContain('circuit-claude-home-');
      expect(smokeAdd?.env?.HOME).not.toBe(process.env.HOME);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails validation when a plugin doctor does not use the bundled runtime', () => {
    const root = createFixture();
    const { calls, runner: baseRunner } = createRunner();
    const runner = (invocation: CommandInvocation) => {
      if (invocation.id === 'codex_doctor') {
        calls.push(invocation);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            status: 'ok',
            runtime_source: 'dev-fallback',
            runtime_path: '/tmp/bin/circuit',
          })}\n`,
          stderr: '',
        };
      }
      return baseRunner(invocation);
    };
    try {
      const report = runPublish(['check'], { repoRoot: root, runner });

      expect(report.status).toBe('failed');
      expect(report.errors.join('\n')).toContain('must use bundled runtime');
      const doctor = calls.find((call) => call.id === 'codex_doctor');
      expect(doctor?.env?.PATH).not.toContain('.local/bin');
      expect(doctor?.env?.CIRCUIT_CLI).toBeUndefined();
      expect(doctor?.env?.CIRCUIT_DEV).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dry-runs release effects and executes them only with --yes using temp CODEX_HOME', () => {
    const root = createFixture();
    const dry = createRunner();
    const yes = createRunner();
    try {
      const dryRun = runPublish(
        ['release', '--codex-source', 'petekp/circuit', '--codex-marketplace', 'circuit'],
        {
          repoRoot: root,
          runner: dry.runner,
        },
      );
      expect(dryRun.status).toBe('passed');
      expect(dryRun.commands).toContainEqual(
        expect.objectContaining({ id: 'claude_tag_push', skipped: true }),
      );
      expect(ids(dry.calls)).not.toContain('claude_tag_push');

      const published = runPublish(
        ['release', '--yes', '--codex-source', 'petekp/circuit', '--codex-marketplace', 'circuit'],
        {
          repoRoot: root,
          runner: yes.runner,
        },
      );

      expect(published.status).toBe('published');
      expect(ids(yes.calls)).toContain('claude_tag_push');
      const codexAdd = yes.calls.find((call) => call.id === 'codex_marketplace_add_release');
      expect(codexAdd?.env?.CODEX_HOME).toContain('circuit-codex-release-');
      expect(codexAdd?.env?.CODEX_HOME).not.toBe(process.env.CODEX_HOME);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to release when the git tag already exists on origin', () => {
    const root = createFixture();
    const base = createRunner();
    // The pre-flight tag probe finds the release tag already on origin.
    const runner = (invocation: CommandInvocation) => {
      if (invocation.id === 'git_tag_remote_check') {
        base.calls.push(invocation);
        return {
          exitCode: 0,
          stdout: 'abc123def\trefs/tags/circuit--v0.1.0-alpha.2\n',
          stderr: '',
        };
      }
      return base.runner(invocation);
    };
    try {
      const report = runPublish(
        ['release', '--yes', '--codex-source', 'petekp/circuit', '--codex-marketplace', 'circuit'],
        { repoRoot: root, runner },
      );

      expect(report.status).toBe('failed');
      expect(report.errors.join('\n')).toContain('already exists on origin');
      expect(ids(base.calls)).toContain('git_tag_remote_check');
      // The collision must be caught before any irreversible effect.
      expect(ids(base.calls)).not.toContain('claude_tag_push');
      expect(ids(base.calls)).not.toContain('codex_marketplace_add_release');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back the pushed git tag when the Codex marketplace publish fails', () => {
    const root = createFixture();
    const base = createRunner();
    // Tag push succeeds (default runner), then the Codex publish fails.
    const runner = (invocation: CommandInvocation) => {
      if (invocation.id === 'codex_marketplace_add_release') {
        base.calls.push(invocation);
        return { exitCode: 1, stdout: '', stderr: 'codex marketplace unreachable\n' };
      }
      return base.runner(invocation);
    };
    try {
      const report = runPublish(
        ['release', '--yes', '--codex-source', 'petekp/circuit', '--codex-marketplace', 'circuit'],
        { repoRoot: root, runner },
      );

      expect(report.status).toBe('failed');
      expect(ids(base.calls)).toContain('claude_tag_push');
      expect(ids(base.calls)).toContain('git_tag_rollback');
      const rollback = base.calls.find((call) => call.id === 'git_tag_rollback');
      expect(rollback?.argv).toEqual([
        'git',
        'push',
        'origin',
        ':refs/tags/circuit--v0.1.0-alpha.2',
      ]);
      expect(report.outputs.tag_rolled_back).toBe('circuit--v0.1.0-alpha.2');
      expect(report.errors.join('\n')).toContain('rolled back tag');
      // A clean rollback is not a half-published state.
      expect(report.outputs.half_published).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a half-published release when the tag rollback also fails', () => {
    const root = createFixture();
    const base = createRunner();
    // Both the Codex publish and the compensating tag rollback fail.
    const runner = (invocation: CommandInvocation) => {
      if (invocation.id === 'codex_marketplace_add_release') {
        base.calls.push(invocation);
        return { exitCode: 1, stdout: '', stderr: 'codex marketplace unreachable\n' };
      }
      if (invocation.id === 'git_tag_rollback') {
        base.calls.push(invocation);
        return { exitCode: 1, stdout: '', stderr: 'remote rejected tag deletion\n' };
      }
      return base.runner(invocation);
    };
    try {
      const report = runPublish(
        ['release', '--yes', '--codex-source', 'petekp/circuit', '--codex-marketplace', 'circuit'],
        { repoRoot: root, runner },
      );

      expect(report.status).toBe('failed');
      expect(ids(base.calls)).toContain('claude_tag_push');
      expect(ids(base.calls)).toContain('git_tag_rollback');
      const errors = report.errors.join('\n');
      expect(errors).toContain('HALF-PUBLISHED RELEASE');
      expect(errors).toContain('manual reconcile required');
      // The loud message must carry the exact commands to reconcile by hand.
      expect(errors).toContain(
        'codex plugin marketplace add petekp/circuit --ref circuit--v0.1.0-alpha.2',
      );
      expect(errors).toContain('git push origin :refs/tags/circuit--v0.1.0-alpha.2');
      const half = report.outputs.half_published as { tag?: string } | undefined;
      expect(half?.tag).toBe('circuit--v0.1.0-alpha.2');
      expect(report.outputs.tag_rolled_back).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a local report with commands, warnings, and errors', () => {
    const root = createFixture({ codexVersion: '0.1.0' });
    const { runner } = createRunner();
    try {
      const report = runPublish(['check'], { repoRoot: root, runner });
      const reportPath = join(root, '.circuit/release/plugin-publish-report.json');

      expect(report.status).toBe('passed');
      expect(existsSync(reportPath)).toBe(true);
      const written = JSON.parse(readFileSync(reportPath, 'utf8')) as typeof report;
      expect(written.commands.length).toBeGreaterThan(0);
      expect(written.warnings.join('\n')).toContain('version mismatch');
      expect(written.errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('compares only package-owned files for installed package checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'circuit-package-tree-'));
    const source = join(root, 'source');
    const target = join(root, 'target');
    try {
      writeText(join(source, '.codex-plugin/plugin.json'), '{"name":"circuit"}\n');
      writeText(join(source, 'commands/run.md'), '# Run\n');
      writeText(join(source, 'skills/run/SKILL.md'), '# Run skill\n');
      writeText(join(source, 'scripts/circuit.ts'), '#!/usr/bin/env node\n');
      writeText(join(source, 'README.md'), 'Read me\n');

      expect(packageTreeStatus(source, target)).toMatchObject({ status: 'missing' });

      copyPackage(source, target);
      writeText(join(target, 'operator-notes/local.txt'), 'ignored\n');
      expect(packageTreeStatus(source, target)).toMatchObject({ status: 'ok' });

      writeText(join(target, 'commands/run.md'), '# stale\n');
      expect(packageTreeStatus(source, target)).toMatchObject({
        status: 'stale',
        stale: ['commands/run.md'],
      });

      copyPackage(source, target);
      writeText(join(target, 'skills/extra/SKILL.md'), '# Extra\n');
      expect(packageTreeStatus(source, target)).toMatchObject({
        status: 'extra-owned-files',
        extra_owned_files: ['skills/extra/SKILL.md'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
