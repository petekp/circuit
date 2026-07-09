#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { type PackageTreeComparison, packageTreeStatus } from './package-tree.ts';

export type PublishTarget = 'check' | 'local' | 'release' | 'bump';

export type CommandInvocation = {
  id: string;
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type PublishReport = {
  schema_version: number;
  target: PublishTarget;
  dry_run: boolean;
  status: 'passed' | 'published' | 'failed';
  repo_root: string;
  git: {
    branch: string;
    upstream: string;
    head: string;
    origin_main: string;
    dirty_files: string[];
  };
  versions: {
    source: string;
    claude: string;
    codex: string;
    claude_marketplace?: string;
    root_package?: string;
    readme_ref?: string;
    expected?: string;
  };
  commands: Array<{
    id: string;
    argv: string[];
    skipped?: boolean;
    exit_code?: number;
  }>;
  outputs: Record<string, unknown>;
  warnings: string[];
  errors: string[];
};

export type PublishArgs = {
  target: PublishTarget;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  skipVerify: boolean;
  allowDirty: boolean;
  allowUnsafe: boolean;
  writeGenerated: boolean;
  installCodexHook: boolean;
  version?: string;
  codexSource?: string;
  codexMarketplace?: string;
  help?: boolean;
};

type CommandRunner = (invocation: CommandInvocation) => CommandResult;

type RunPublishOptions = {
  repoRoot?: string;
  runner?: CommandRunner;
  homeDir?: string;
  codexHome?: string;
};

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  effect?: boolean;
};

type PluginManifest = { name?: string; version?: string };
type ClaudeMarketplacePlugin = { name?: string; version?: string };
type ClaudeMarketplace = { plugins?: ClaudeMarketplacePlugin[] };
type ClaudeMarketplaceListEntry = {
  name?: string;
  source?: string;
  path?: string;
  installLocation?: string;
};
type CodexMarketplacePluginSource = { source?: string; path?: string };
type CodexMarketplacePlugin = { source?: CodexMarketplacePluginSource };
type CodexMarketplace = { name: string; plugins?: CodexMarketplacePlugin[] };
type DoctorOutput = {
  status?: string;
  runtime_source?: string;
  runtime_path?: string;
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '../..');
const TARGETS = new Set<PublishTarget>(['check', 'local', 'release', 'bump']);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// Matches the install-ref tags embedded in README prose, e.g.
// `--ref circuit--v0.1.0-alpha.10`. The Codex first-run funnel reads this
// ref out of the README at run time, so it must track the release tag.
const README_REF_PATTERN = /circuit--v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/g;

export function extractReadmeRefVersions(content: string): string[] {
  return [...new Set([...content.matchAll(README_REF_PATTERN)].map((match) => match[1] ?? ''))];
}

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function isRemoteCodexSource(source: string | undefined): boolean {
  if (source === undefined || source.trim() === '') return false;
  if (source === '.' || source === './' || source === '..' || source === '../') return false;
  if (source.startsWith('./') || source.startsWith('../')) return false;
  if (source.startsWith('file:') || source.startsWith('~')) return false;
  if (isAbsolute(source)) return false;
  return true;
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function noAmbientCliPath(): string {
  const systemSegments = process.platform === 'win32' ? [] : ['/usr/bin', '/bin'];
  return [dirname(process.execPath), ...systemSegments].join(delimiter);
}

function noAmbientCliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: noAmbientCliPath(),
    CIRCUIT_CLI: undefined,
    CIRCUIT_DEV: undefined,
    ...extra,
  };
}

function findClaudeMarketplacePlugin(
  marketplace: ClaudeMarketplace,
): ClaudeMarketplacePlugin | undefined {
  return marketplace.plugins?.find((plugin) => plugin?.name === 'circuit');
}

function versionFiles(repoRoot: string): {
  source: string;
  claude: string;
  codex: string;
  claudeMarketplace: string;
  rootPackage: string;
  readme: string;
} {
  return {
    source: resolve(repoRoot, 'plugins/version.json'),
    claude: resolve(repoRoot, 'plugins/claude/.claude-plugin/plugin.json'),
    codex: resolve(repoRoot, 'plugins/codex/.codex-plugin/plugin.json'),
    claudeMarketplace: resolve(repoRoot, '.claude-plugin/marketplace.json'),
    rootPackage: resolve(repoRoot, 'package.json'),
    readme: resolve(repoRoot, 'README.md'),
  };
}

export function parseArgs(argv: string[]): PublishArgs {
  const args: PublishArgs = {
    target: 'check',
    yes: false,
    dryRun: false,
    json: false,
    skipVerify: false,
    allowDirty: false,
    allowUnsafe: false,
    writeGenerated: false,
    installCodexHook: false,
  };

  const program = new Command('publish-plugins')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .argument('[target]')
    .option('--yes')
    .option('--dry-run')
    .option('--json')
    .option('--skip-verify')
    .option('--allow-dirty')
    .option('--allow-unsafe')
    .option('--write-generated')
    .option('--install-codex-hook')
    .option('--version <version>')
    .option('--codex-source <source>')
    .option('--codex-marketplace <marketplace>')
    .option('-h, --help');
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError && err.code === 'commander.helpDisplayed') {
      args.help = true;
      return args;
    }
    if (err instanceof CommanderError) throw new Error(err.message.replace(/^error: /, ''));
    throw err;
  }

  const opts = program.opts<{
    yes?: boolean;
    dryRun?: boolean;
    json?: boolean;
    skipVerify?: boolean;
    allowDirty?: boolean;
    allowUnsafe?: boolean;
    writeGenerated?: boolean;
    installCodexHook?: boolean;
    version?: string;
    codexSource?: string;
    codexMarketplace?: string;
    help?: boolean;
  }>();
  const target = program.args[0];
  if (target !== undefined && TARGETS.has(target as PublishTarget)) {
    args.target = target as PublishTarget;
  } else if (target !== undefined) {
    throw new Error(`unknown publish target: ${target}`);
  }

  args.yes = opts.yes === true;
  args.dryRun = opts.dryRun === true;
  args.json = opts.json === true;
  args.skipVerify = opts.skipVerify === true;
  args.allowDirty = opts.allowDirty === true;
  args.allowUnsafe = opts.allowUnsafe === true;
  args.writeGenerated = opts.writeGenerated === true;
  args.installCodexHook = opts.installCodexHook === true;
  if (opts.version !== undefined) args.version = opts.version;
  if (opts.codexSource !== undefined) args.codexSource = opts.codexSource;
  if (opts.codexMarketplace !== undefined) args.codexMarketplace = opts.codexMarketplace;
  if (opts.help === true) args.help = true;

  args.dryRun = args.target === 'release' ? !args.yes : args.dryRun;
  return args;
}

export function defaultRunner(invocation: CommandInvocation): CommandResult {
  const [command, ...args] = invocation.argv;
  if (command === undefined) {
    return { exitCode: 1, stdout: '', stderr: 'empty argv' };
  }
  const result = spawnSync(command, args, {
    cwd: invocation.cwd,
    env: { ...process.env, ...(invocation.env ?? {}) },
    encoding: 'utf8',
  });
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

function createReport(args: PublishArgs, repoRoot: string): PublishReport {
  return {
    schema_version: 1,
    target: args.target,
    dry_run: args.dryRun,
    status: 'failed',
    repo_root: repoRoot,
    git: {
      branch: '',
      upstream: '',
      head: '',
      origin_main: '',
      dirty_files: [],
    },
    versions: {
      source: '',
      claude: '',
      codex: '',
      ...(args.version !== undefined ? { expected: args.version } : {}),
    },
    commands: [],
    outputs: {},
    warnings: [],
    errors: [],
  };
}

export function runPublish(
  argv: string[] = process.argv.slice(2),
  options: RunPublishOptions = {},
): PublishReport {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : DEFAULT_REPO_ROOT;
  const runner = options.runner ?? defaultRunner;
  const home = options.homeDir ? resolve(options.homeDir) : homedir();
  const codexHome = options.codexHome
    ? resolve(options.codexHome)
    : (process.env.CODEX_HOME ?? resolve(home, '.codex'));
  const args = parseArgs(argv);
  const report = createReport(args, repoRoot);
  let releaseCodexHome: string | undefined;
  let claudeSmokeHome: string | undefined;
  let claudeSmokeProject: string | undefined;

  function addWarning(message: string): void {
    report.warnings.push(message);
  }

  function fail(message: string): never {
    throw new Error(message);
  }

  function runCommand(
    id: string,
    argvForCommand: string[],
    commandOptions: CommandOptions = {},
  ): CommandResult {
    const entry: PublishReport['commands'][number] = {
      id,
      argv: argvForCommand,
    };
    report.commands.push(entry);

    if (report.dry_run && commandOptions.effect === true) {
      entry.skipped = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    const result = runner({
      id,
      argv: argvForCommand,
      cwd: commandOptions.cwd ?? repoRoot,
      ...(commandOptions.env !== undefined ? { env: commandOptions.env } : {}),
    });
    entry.exit_code = result.exitCode;

    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
      fail(`${id} failed: ${detail}`);
    }

    return result;
  }

  function runOptionalCommand(
    id: string,
    argvForCommand: string[],
    commandOptions: CommandOptions = {},
  ): CommandResult {
    const entry: PublishReport['commands'][number] = {
      id,
      argv: argvForCommand,
    };
    report.commands.push(entry);

    if (report.dry_run && commandOptions.effect === true) {
      entry.skipped = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    const result = runner({
      id,
      argv: argvForCommand,
      cwd: commandOptions.cwd ?? repoRoot,
      ...(commandOptions.env !== undefined ? { env: commandOptions.env } : {}),
    });
    entry.exit_code = result.exitCode;
    return result;
  }

  function recordSkippedCommand(id: string, argvForCommand: string[]): void {
    report.commands.push({
      id,
      argv: argvForCommand,
      skipped: true,
    });
  }

  function parseLastJsonObject(value: string): Record<string, unknown> | undefined {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start < 0 || end < start) return undefined;
    try {
      return JSON.parse(value.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  function assertPackageTreeOk(label: string, tree: PackageTreeComparison): void {
    if (tree.status !== 'ok') {
      fail(
        `${label} package bytes are ${tree.status}; missing=${tree.missing.length}, stale=${tree.stale.length}, extra-owned-files=${tree.extra_owned_files.length}`,
      );
    }
  }

  function claudeInstalledRoot(): string {
    return resolve(home, '.claude/plugins/cache/circuit/circuit', report.versions.source);
  }

  function defaultCodexCacheTarget(): string {
    return resolve(codexHome, 'plugins/cache/circuit-local/circuit', report.versions.source);
  }

  function claudeUserEnv(): NodeJS.ProcessEnv | undefined {
    return options.homeDir === undefined ? undefined : { HOME: home };
  }

  function codexUserEnv(): NodeJS.ProcessEnv | undefined {
    return options.codexHome === undefined ? undefined : { CODEX_HOME: codexHome };
  }

  function commandOptions(input: {
    effect?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv | undefined;
  }): CommandOptions {
    const output: CommandOptions = {};
    if (input.effect !== undefined) output.effect = input.effect;
    if (input.cwd !== undefined) output.cwd = input.cwd;
    if (input.env !== undefined) output.env = input.env;
    return output;
  }

  function parseClaudeMarketplaceList(result: CommandResult): ClaudeMarketplaceListEntry[] {
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(parsed)) fail('claude_marketplace_list_user did not return an array');
      return parsed as ClaudeMarketplaceListEntry[];
    } catch {
      fail('claude_marketplace_list_user did not return parseable marketplace JSON');
    }
  }

  function readClaudeMarketplaceList(
    id: 'claude_marketplace_list_user' | 'claude_marketplace_verify_user',
    claudeEnv: NodeJS.ProcessEnv | undefined,
  ): ClaudeMarketplaceListEntry[] {
    const list = runCommand(
      id,
      ['claude', 'plugin', 'marketplace', 'list', '--json'],
      commandOptions({ env: claudeEnv }),
    );
    return parseClaudeMarketplaceList(list);
  }

  function claudeMarketplaceEntryPath(entry: ClaudeMarketplaceListEntry): string | undefined {
    return entry.path ?? (entry.source === 'directory' ? entry.installLocation : undefined);
  }

  function claudeMarketplacePointsAtRepo(entry: ClaudeMarketplaceListEntry): boolean {
    const path = claudeMarketplaceEntryPath(entry);
    return path !== undefined && resolve(path) === repoRoot;
  }

  function refreshClaudeUserMarketplace(claudeEnv: NodeJS.ProcessEnv | undefined): void {
    const current = readClaudeMarketplaceList('claude_marketplace_list_user', claudeEnv).find(
      (entry) => entry.name === 'circuit',
    );
    if (current !== undefined && !claudeMarketplacePointsAtRepo(current)) {
      runCommand(
        'claude_marketplace_remove_user',
        ['claude', 'plugin', 'marketplace', 'remove', 'circuit'],
        commandOptions({ effect: true, env: claudeEnv }),
      );
    }

    if (current === undefined || !claudeMarketplacePointsAtRepo(current)) {
      runCommand(
        'claude_marketplace_add_user',
        ['claude', 'plugin', 'marketplace', 'add', repoRoot, '--scope', 'user'],
        commandOptions({ effect: true, env: claudeEnv }),
      );
      return;
    }

    runCommand(
      'claude_marketplace_update_user',
      ['claude', 'plugin', 'marketplace', 'update', 'circuit'],
      commandOptions({ effect: true, env: claudeEnv }),
    );
  }

  function assertClaudeUserMarketplacePointsAtRepo(claudeEnv: NodeJS.ProcessEnv | undefined): void {
    const current = readClaudeMarketplaceList('claude_marketplace_verify_user', claudeEnv).find(
      (entry) => entry.name === 'circuit',
    );
    if (current === undefined) {
      fail('Claude user marketplace circuit is missing after refresh');
    }

    const path = claudeMarketplaceEntryPath(current);
    if (path === undefined) {
      fail('Claude user marketplace circuit has no directory path after refresh');
    }

    const resolvedPath = resolve(path);
    report.outputs.claude_marketplace_path = resolvedPath;
    if (resolvedPath !== repoRoot) {
      fail(`Claude user marketplace circuit points at ${resolvedPath}; expected ${repoRoot}`);
    }
  }

  function assertBundledDoctor(id: string, result: CommandResult): void {
    let output: DoctorOutput;
    try {
      output = JSON.parse(result.stdout) as DoctorOutput;
    } catch {
      fail(`${id} did not return parseable doctor JSON`);
    }
    if (output.status !== 'ok') {
      fail(`${id} did not report ok status`);
    }
    if (output.runtime_source !== 'bundled') {
      fail(
        `${id} must use bundled runtime; got ${output.runtime_source ?? '<missing>'} (${output.runtime_path ?? 'no path'})`,
      );
    }
  }

  function inspectMetadata(): void {
    const sourceVersion = readJson<{ version: string }>(resolve(repoRoot, 'plugins/version.json'));
    const claudeManifest = readJson<PluginManifest>(
      resolve(repoRoot, 'plugins/claude/.claude-plugin/plugin.json'),
    );
    const codexManifest = readJson<PluginManifest>(
      resolve(repoRoot, 'plugins/codex/.codex-plugin/plugin.json'),
    );
    const codexMarketplace = readJson<CodexMarketplace>(
      resolve(repoRoot, '.agents/plugins/marketplace.json'),
    );
    const claudeMarketplacePath = resolve(repoRoot, '.claude-plugin/marketplace.json');
    const claudeMarketplace = existsSync(claudeMarketplacePath)
      ? readJson<ClaudeMarketplace>(claudeMarketplacePath)
      : undefined;
    const claudeMarketplacePlugin = claudeMarketplace
      ? findClaudeMarketplacePlugin(claudeMarketplace)
      : undefined;

    const rootPackage = readJson<{ version?: string }>(resolve(repoRoot, 'package.json'));
    const readmePath = resolve(repoRoot, 'README.md');
    const readmeRefVersions = existsSync(readmePath)
      ? extractReadmeRefVersions(readFileSync(readmePath, 'utf8'))
      : [];

    report.versions.source = sourceVersion.version;
    report.versions.claude = claudeManifest.version ?? '';
    report.versions.codex = codexManifest.version ?? '';
    if (rootPackage.version !== undefined) report.versions.root_package = rootPackage.version;
    report.versions.readme_ref = readmeRefVersions.join(', ');
    if (claudeMarketplacePlugin?.version !== undefined) {
      report.versions.claude_marketplace = claudeMarketplacePlugin.version;
    }
    report.outputs.codex_marketplace = codexMarketplace.name;
    report.outputs.codex_source = args.codexSource;

    if (claudeManifest.name !== 'circuit') fail('Claude plugin manifest name must be circuit');
    if (codexManifest.name !== 'circuit') fail('Codex plugin manifest name must be circuit');
    if (
      codexMarketplace.plugins?.some((plugin) => plugin?.source?.path === './plugins/codex') !==
      true
    ) {
      fail('Codex marketplace must point at ./plugins/codex');
    }

    const versionValues: Array<[string, string | undefined]> = [
      ['plugins/version.json', sourceVersion.version],
      ['Claude plugin manifest', claudeManifest.version],
      ['Codex plugin manifest', codexManifest.version],
      ['Claude marketplace entry', claudeMarketplacePlugin?.version],
      ['root package.json', rootPackage.version],
      ['--version', args.version ?? sourceVersion.version],
    ];
    // Every install ref in the README must name the current version; a
    // stale ref breaks the Codex install funnel for new users.
    if (readmeRefVersions.length === 0) {
      versionValues.push(['README install ref', undefined]);
    } else {
      for (const refVersion of readmeRefVersions) {
        versionValues.push(['README install ref', refVersion]);
      }
    }
    const mismatches = versionValues.filter(([, version]) => version !== sourceVersion.version);
    if (mismatches.length > 0) {
      const message = `version mismatch: ${versionValues
        .map(([label, version]) => `${label}=${version ?? '<missing>'}`)
        .join(', ')}`;
      if (args.target === 'release') fail(message);
      addWarning(message);
    }

    if (args.target === 'release') {
      if (!isRemoteCodexSource(args.codexSource)) {
        fail('release requires a remote Codex source');
      }
      if (!args.codexMarketplace) fail('release requires --codex-marketplace');
      if (args.codexMarketplace.endsWith('-local')) {
        fail('Codex release marketplace name must not end in -local');
      }
      if (codexMarketplace.name.endsWith('-local')) {
        fail('resolved Codex marketplace name must not end in -local');
      }
      if (args.codexMarketplace !== codexMarketplace.name) {
        fail('--codex-marketplace must match .agents/plugins/marketplace.json name');
      }
    }
  }

  function validateOptions(): void {
    if (args.target === 'bump') {
      if (!args.version) fail('bump requires --version');
      if (!VERSION_PATTERN.test(args.version)) fail('--version must be a semver string');
      if (args.skipVerify) fail('bump does not allow --skip-verify');
      if (args.writeGenerated) fail('bump does not allow --write-generated');
      if (args.installCodexHook) fail('bump does not allow --install-codex-hook');
      return;
    }

    if (args.target === 'release') {
      if (args.allowDirty) fail('release does not allow --allow-dirty');
      if (args.writeGenerated) fail('release does not allow --write-generated');
      if (args.skipVerify) fail('release does not allow --skip-verify');
      if (args.allowUnsafe) fail('release does not allow --allow-unsafe');
      if (args.installCodexHook) fail('release does not allow --install-codex-hook');
      return;
    }

    if (args.installCodexHook && args.target !== 'local') {
      fail('--install-codex-hook is only supported for local');
    }
    if (args.writeGenerated && args.target !== 'local') {
      fail('--write-generated is only supported for local');
    }
    if (args.allowDirty && args.target === 'check') {
      addWarning('--allow-dirty has no effect for check');
    }
    if (args.skipVerify && !args.allowUnsafe) {
      fail('--skip-verify requires --allow-unsafe');
    }
  }

  function collectGitState(): void {
    const status = runCommand('git_status', ['git', 'status', '--short']).stdout;
    const branch = runCommand('git_branch', ['git', 'branch', '--show-current']).stdout.trim();
    const upstreamArgv = ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'];
    const upstreamResult =
      args.target === 'release'
        ? runCommand('git_upstream', upstreamArgv)
        : runOptionalCommand('git_upstream', upstreamArgv);
    const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : '';
    const head = runCommand('git_head', ['git', 'rev-parse', 'HEAD']).stdout.trim();

    report.git.branch = branch;
    report.git.upstream = upstream;
    report.git.head = head;
    report.git.dirty_files = splitLines(status);
    if (args.target !== 'release' && upstreamResult.exitCode !== 0) {
      addWarning('git upstream is unavailable; continuing because this is not a release');
    }

    if (args.target === 'local' && report.git.dirty_files.length > 0 && !args.allowDirty) {
      fail('local publish requires a clean working tree unless --allow-dirty is set');
    }

    if (args.target !== 'release') return;

    if (report.git.dirty_files.length > 0) fail('working tree must be clean for release');
    if (branch !== 'main') fail('release requires branch main');
    if (upstream !== 'origin/main') fail('release requires upstream origin/main');

    runCommand('git_fetch_origin_main', ['git', 'fetch', 'origin', 'main']);
    const originHead = runCommand('git_origin_head', [
      'git',
      'rev-parse',
      'origin/main',
    ]).stdout.trim();
    report.git.origin_main = originHead;
    if (head !== originHead) fail('HEAD must match origin/main');
  }

  function runValidation(): void {
    if (args.writeGenerated) {
      runCommand('emit_flows', ['npm', 'run', 'emit-flows']);
    }

    if (!args.skipVerify) {
      runCommand('check_flow_drift', ['npm', 'run', 'check-flow-drift']);
      runCommand('verify', ['npm', 'run', 'verify']);
      runCommand('check_release_ready', ['npm', 'run', 'check-release-ready']);
      runCommand('claude_validate_root', ['claude', 'plugin', 'validate', '.']);
      runCommand('claude_validate_plugin', ['claude', 'plugin', 'validate', 'plugins/claude']);
      const claudeDoctor = runCommand(
        'claude_doctor',
        [process.execPath, 'plugins/claude/scripts/circuit.ts', 'doctor'],
        { env: noAmbientCliEnv() },
      );
      assertBundledDoctor('claude_doctor', claudeDoctor);
      const codexDoctor = runCommand(
        'codex_doctor',
        [process.execPath, 'plugins/codex/scripts/circuit.ts', 'doctor'],
        { env: noAmbientCliEnv() },
      );
      assertBundledDoctor('codex_doctor', codexDoctor);
      runClaudeInstallSmoke();
    }
  }

  function runClaudeInstallSmoke(): void {
    claudeSmokeHome = mkdtempSync(join(tmpdir(), 'circuit-claude-home-'));
    claudeSmokeProject = mkdtempSync(join(tmpdir(), 'circuit-claude-install-'));
    const smokeEnv = { HOME: claudeSmokeHome };
    runCommand(
      'claude_install_smoke_marketplace_add',
      ['claude', 'plugin', 'marketplace', 'add', repoRoot, '--scope', 'local'],
      { cwd: claudeSmokeProject, env: smokeEnv },
    );
    runCommand(
      'claude_install_smoke_install',
      ['claude', 'plugin', 'install', 'circuit@circuit', '--scope', 'local'],
      { cwd: claudeSmokeProject, env: smokeEnv },
    );
    const list = runCommand('claude_install_smoke_list', ['claude', 'plugin', 'list'], {
      cwd: claudeSmokeProject,
      env: smokeEnv,
    });
    const listOutput = `${list.stdout}\n${list.stderr}`;
    if (/Failed to load hooks|Duplicate hooks file detected/i.test(listOutput)) {
      fail('Claude install smoke reported duplicate or failed hook loading');
    }
    const installedPluginRoot = resolve(
      claudeSmokeHome,
      '.claude/plugins/cache/circuit/circuit',
      report.versions.source,
    );
    const installedDoctor = runCommand(
      'claude_install_smoke_doctor',
      [process.execPath, resolve(installedPluginRoot, 'scripts/circuit.ts'), 'doctor'],
      {
        cwd: claudeSmokeProject,
        env: noAmbientCliEnv({
          HOME: claudeSmokeHome,
          CLAUDE_PROJECT_DIR: claudeSmokeProject,
        }),
      },
    );
    assertBundledDoctor('claude_install_smoke_doctor', installedDoctor);
    report.outputs.claude_install_smoke_status = 'ok';
  }

  function runBump(): void {
    const paths = versionFiles(repoRoot);
    const sourceVersion = readJson<{ version: string }>(paths.source);
    const claudeManifest = readJson<PluginManifest>(paths.claude);
    const codexManifest = readJson<PluginManifest>(paths.codex);
    const claudeMarketplace = readJson<ClaudeMarketplace>(paths.claudeMarketplace);
    const rootPackage = readJson<{ version?: string }>(paths.rootPackage);
    const claudeMarketplacePlugin = findClaudeMarketplacePlugin(claudeMarketplace);
    if (claudeMarketplacePlugin === undefined) {
      fail('Claude marketplace entry must include circuit plugin');
    }
    const readmeContent = readFileSync(paths.readme, 'utf8');
    if (extractReadmeRefVersions(readmeContent).length === 0) {
      fail('README.md has no circuit--v install ref to bump');
    }

    const nextVersion = args.version;
    if (nextVersion === undefined) fail('bump requires --version');
    sourceVersion.version = nextVersion;
    claudeManifest.version = nextVersion;
    codexManifest.version = nextVersion;
    claudeMarketplacePlugin.version = nextVersion;
    rootPackage.version = nextVersion;
    const nextReadme = readmeContent.replace(README_REF_PATTERN, `circuit--v${nextVersion}`);

    const formattedFiles = [
      'plugins/version.json',
      'plugins/claude/.claude-plugin/plugin.json',
      'plugins/codex/.codex-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      'package.json',
    ];
    // README.md is rewritten but kept out of the biome pass; biome does not
    // format markdown.
    const touchedFiles = [...formattedFiles, 'README.md'];

    if (args.dryRun) {
      report.commands.push({
        id: 'bump_versions',
        argv: ['write plugin versions', nextVersion],
        skipped: true,
      });
    } else {
      writeJson(paths.source, sourceVersion);
      writeJson(paths.claude, claudeManifest);
      writeJson(paths.codex, codexManifest);
      writeJson(paths.claudeMarketplace, claudeMarketplace);
      writeJson(paths.rootPackage, rootPackage);
      writeFileSync(paths.readme, nextReadme);
      runCommand('format_bumped_versions', [
        'npm',
        'exec',
        'biome',
        '--',
        'check',
        '--write',
        ...formattedFiles,
      ]);
    }

    report.outputs.bumped_version = nextVersion;
    report.outputs.bumped_files = touchedFiles;
  }

  function runLocalPublish(): void {
    const claudeRoot = claudeInstalledRoot();
    const codexSourceRoot = resolve(repoRoot, 'plugins/codex');
    const claudeSourceRoot = resolve(repoRoot, 'plugins/claude');
    const codexTarget = defaultCodexCacheTarget();
    // The launcher path is written verbatim into the Codex user hooks.json and
    // is spawned directly by the Codex host on SessionStart. It must be the
    // .js shim so an old-Node host gets a legible version error instead of a
    // parse-time crash on the .ts wrapper.
    const codexLauncher = resolve(codexTarget, 'scripts/circuit.js');
    const claudeEnv = claudeUserEnv();
    const codexEnv = codexUserEnv();

    if (report.dry_run) {
      refreshClaudeUserMarketplace(claudeEnv);
      runCommand(
        'claude_plugin_update_user',
        ['claude', 'plugin', 'update', 'circuit@circuit', '--scope', 'user'],
        commandOptions({ effect: true, env: claudeEnv }),
      );
      runCommand(
        'codex_cache_sync',
        ['npm', 'run', 'sync:codex-plugin-cache'],
        commandOptions({ effect: true, env: codexEnv }),
      );
      recordSkippedCommand('codex_cache_check', ['npm', 'run', 'check:codex-plugin-cache']);
      if (args.installCodexHook) {
        runCommand(
          'codex_handoff_hook_install',
          [
            process.execPath,
            codexLauncher,
            'handoff',
            'hooks',
            'install',
            '--host',
            'codex',
            '--launcher',
            codexLauncher,
          ],
          commandOptions({ effect: true, env: codexEnv }),
        );
      }
      report.outputs.local_dry_run_skipped_checks = [
        'claude_package_bytes',
        'claude_installed_doctor',
        'codex_cache_check',
        'codex_package_bytes',
        'codex_installed_doctor',
      ];
      report.outputs.codex_cache_target = codexTarget;
      return;
    }

    refreshClaudeUserMarketplace(claudeEnv);
    assertClaudeUserMarketplacePointsAtRepo(claudeEnv);
    const claudeUpdate = runOptionalCommand(
      'claude_plugin_update_user',
      ['claude', 'plugin', 'update', 'circuit@circuit', '--scope', 'user'],
      commandOptions({ effect: true, env: claudeEnv }),
    );
    const claudeUpdateOutput = `${claudeUpdate.stdout}\n${claudeUpdate.stderr}`;
    const claudePluginMissing = /not installed|not found/i.test(claudeUpdateOutput);
    if (claudeUpdate.exitCode !== 0) {
      report.outputs.claude_update_status = 'failed';
      addWarning(
        `Claude plugin update failed; falling back to install: ${
          claudeUpdate.stderr.trim() ||
          claudeUpdate.stdout.trim() ||
          `exit ${claudeUpdate.exitCode}`
        }`,
      );
    }

    let claudeTree = packageTreeStatus(claudeSourceRoot, claudeRoot);
    if (claudeTree.status !== 'ok') {
      report.outputs.claude_package_status_after_update = claudeTree.status;
      if (existsSync(claudeRoot) && !claudePluginMissing) {
        runCommand(
          'claude_plugin_uninstall_user',
          [
            'claude',
            'plugin',
            'uninstall',
            'circuit@circuit',
            '--scope',
            'user',
            '--keep-data',
            '--yes',
          ],
          commandOptions({ effect: true, env: claudeEnv }),
        );
      }
      runCommand(
        'claude_plugin_install_user',
        ['claude', 'plugin', 'install', 'circuit@circuit', '--scope', 'user'],
        commandOptions({ effect: true, env: claudeEnv }),
      );
      claudeTree = packageTreeStatus(claudeSourceRoot, claudeRoot);
    }
    assertPackageTreeOk('installed Claude', claudeTree);
    report.outputs.claude_package_status = claudeTree.status;

    const claudeInstalledDoctor = runCommand(
      'claude_installed_doctor',
      [process.execPath, resolve(claudeRoot, 'scripts/circuit.ts'), 'doctor'],
      {
        env: noAmbientCliEnv({
          HOME: home,
        }),
      },
    );
    assertBundledDoctor('claude_installed_doctor', claudeInstalledDoctor);

    runCommand(
      'codex_cache_sync',
      ['npm', 'run', 'sync:codex-plugin-cache'],
      commandOptions({ effect: true, env: codexEnv }),
    );
    const cacheCheck = runCommand(
      'codex_cache_check',
      ['npm', 'run', 'check:codex-plugin-cache'],
      commandOptions({ env: codexEnv }),
    );
    const cacheCheckJson = parseLastJsonObject(cacheCheck.stdout);
    const checkedTarget =
      typeof cacheCheckJson?.target === 'string' ? cacheCheckJson.target : codexTarget;
    const codexTree = packageTreeStatus(codexSourceRoot, checkedTarget);
    assertPackageTreeOk('synced Codex cache', codexTree);
    report.outputs.codex_cache_status = codexTree.status;
    report.outputs.codex_cache_target = checkedTarget;

    const codexInstalledDoctor = runCommand(
      'codex_installed_doctor',
      [process.execPath, resolve(checkedTarget, 'scripts/circuit.ts'), 'doctor'],
      {
        env: noAmbientCliEnv({
          CODEX_HOME: codexHome,
        }),
      },
    );
    assertBundledDoctor('codex_installed_doctor', codexInstalledDoctor);

    if (args.installCodexHook) {
      // Host-spawned launcher written into the Codex user hooks.json: use the
      // .js shim so an old-Node host degrades to a legible error.
      const launcher = resolve(checkedTarget, 'scripts/circuit.js');
      runCommand(
        'codex_handoff_hook_install',
        [
          process.execPath,
          launcher,
          'handoff',
          'hooks',
          'install',
          '--host',
          'codex',
          '--launcher',
          launcher,
        ],
        commandOptions({ effect: true, env: codexEnv }),
      );
    }
  }

  // Pre-flight: a release pushes the git tag `tag`, then publishes the Codex
  // marketplace from that same ref. If the tag is already on origin, the push
  // either fails or silently reuses an old commit — the two release halves then
  // disagree about what shipped. Refuse to start when the tag is already taken.
  // This is a read-only probe, so it also runs during a release dry-run.
  function assertReleaseTagAbsentFromRemote(tag: string): void {
    const existing = runCommand('git_tag_remote_check', [
      'git',
      'ls-remote',
      '--tags',
      'origin',
      `refs/tags/${tag}`,
    ]).stdout.trim();
    if (existing !== '') {
      fail(
        `release tag ${tag} already exists on origin; bump the version or delete the remote tag before publishing (git push origin :refs/tags/${tag}).`,
      );
    }
  }

  // Reached only after the git tag was pushed (Claude half done) but the Codex
  // marketplace publish failed. Try to undo the push so a release is
  // all-or-nothing. If the rollback also fails, stop loudly with the exact
  // commands an operator must run to reconcile the half-published release.
  function reconcileHalfPublishedRelease(tag: string, codexError: unknown): never {
    const detail = codexError instanceof Error ? codexError.message : String(codexError);
    const rollback = runOptionalCommand(
      'git_tag_rollback',
      ['git', 'push', 'origin', `:refs/tags/${tag}`],
      { effect: true },
    );
    if (rollback.exitCode === 0) {
      report.outputs.tag_rolled_back = tag;
      fail(
        `Codex marketplace publish failed after the git tag was pushed; rolled back tag ${tag} so no half-published release remains. Original failure: ${detail}`,
      );
    }
    const rollbackDetail =
      rollback.stderr.trim() || rollback.stdout.trim() || `exit ${rollback.exitCode}`;
    report.outputs.half_published = {
      tag,
      codex_error: detail,
      rollback_error: rollbackDetail,
    };
    fail(
      [
        'HALF-PUBLISHED RELEASE — manual reconcile required.',
        `The git tag ${tag} is pushed to origin, but the Codex marketplace publish failed and the automatic tag rollback also failed.`,
        `Codex failure: ${detail}`,
        `Rollback failure: ${rollbackDetail}`,
        'To finish the release, re-run the Codex publish:',
        `  codex plugin marketplace add ${args.codexSource} --ref ${tag}`,
        `  codex plugin marketplace upgrade ${args.codexMarketplace}`,
        'Or to abandon it, delete the remote tag:',
        `  git push origin :refs/tags/${tag}`,
      ].join('\n'),
    );
  }

  function runReleasePublish(): void {
    const tag = `circuit--v${report.versions.source}`;
    report.outputs.claude_tag = tag;

    assertReleaseTagAbsentFromRemote(tag);

    runCommand('claude_tag_dry_run', ['claude', 'plugin', 'tag', 'plugins/claude', '--dry-run']);
    runCommand('claude_tag_push', ['claude', 'plugin', 'tag', 'plugins/claude', '--push'], {
      effect: true,
    });

    releaseCodexHome = mkdtempSync(join(tmpdir(), 'circuit-codex-release-'));
    const codexEnv = { CODEX_HOME: releaseCodexHome };
    if (args.codexSource === undefined) fail('release requires --codex-source');
    if (args.codexMarketplace === undefined) fail('release requires --codex-marketplace');
    try {
      runCommand(
        'codex_marketplace_add_release',
        ['codex', 'plugin', 'marketplace', 'add', args.codexSource, '--ref', tag],
        { effect: true, env: codexEnv },
      );
      runCommand(
        'codex_marketplace_upgrade_release',
        ['codex', 'plugin', 'marketplace', 'upgrade', args.codexMarketplace],
        { effect: true, env: codexEnv },
      );
    } catch (codexError) {
      // In a dry-run the two Codex commands and the tag push are all skipped,
      // so nothing throws here; this compensation only trips on a real (--yes)
      // publish where the tag push already took effect.
      reconcileHalfPublishedRelease(tag, codexError);
    }
  }

  try {
    if (args.help) {
      report.status = 'passed';
      return report;
    }

    validateOptions();
    if (args.target === 'bump') {
      runBump();
      inspectMetadata();
      collectGitState();
      report.status = 'passed';
      return report;
    }

    inspectMetadata();
    collectGitState();
    runValidation();

    if (args.target === 'local') runLocalPublish();
    if (args.target === 'release') runReleasePublish();

    report.status = args.target === 'release' && args.yes ? 'published' : 'passed';
  } catch (err) {
    report.status = 'failed';
    report.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (releaseCodexHome !== undefined) {
      rmSync(releaseCodexHome, { recursive: true, force: true });
    }
    if (claudeSmokeHome !== undefined) {
      rmSync(claudeSmokeHome, { recursive: true, force: true });
    }
    if (claudeSmokeProject !== undefined) {
      rmSync(claudeSmokeProject, { recursive: true, force: true });
    }
    writeJson(resolve(repoRoot, '.circuit/release/plugin-publish-report.json'), report);
  }

  return report;
}

function printHumanSummary(report: PublishReport): void {
  const status = report.status.toUpperCase();
  console.log(`${status}: ${report.target} plugin publish ${report.dry_run ? '(dry-run)' : ''}`);
  if (report.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of report.warnings) console.log(`- ${warning}`);
  }
  if (report.errors.length > 0) {
    console.log('\nErrors:');
    for (const error of report.errors) console.log(`- ${error}`);
  }
  console.log(
    `\nReport: ${resolve(report.repo_root, '.circuit/release/plugin-publish-report.json')}`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  const argv = process.argv.slice(2);
  const report = runPublish(argv);
  const jsonOnly = parseArgs(argv).json;
  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanSummary(report);
  }
  process.exit(report.status === 'failed' ? 1 : 0);
}
