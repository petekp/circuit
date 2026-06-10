import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import { pathEndsWithSegments } from '../shared/path-suffix.ts';
import { listCommandIds, listPackageDirs, packageTreeStatus } from './package-tree.ts';

// Shared skeleton for the per-host plugin-cache sync scripts. The Claude and
// Codex scripts were ~85% identical twins; the deltas live in the config a
// wrapper passes in: plugin root, manifest dir, the Codex-only --marketplace
// option, the legacy-name rejection, and the cache path layout. The CLI
// surface, output JSON, and exit codes (0 ok, 1 drift in --check, 2 error)
// are owned here so a fix lands in both hosts at once.

export type HostPluginManifest = {
  name: string;
  version: string;
};

export type SyncHostCacheConfig = {
  // CLI program name, e.g. 'sync-claude-cache'.
  readonly programName: string;
  // Host word used in the refusal message, e.g. 'Claude' or 'Codex'.
  readonly hostLabel: string;
  // Absolute path to the generated host plugin package (the sync source).
  readonly pluginRoot: string;
  // Manifest directory name inside the plugin root, e.g. '.claude-plugin'.
  readonly manifestDirName: string;
  // npm entry points echoed in the summary JSON.
  readonly checkCommand: string;
  readonly localSyncCommand: string;
  // Present only for hosts whose cache layout is keyed by a marketplace name
  // (Codex). Registers the --marketplace CLI option with this default.
  readonly marketplace?: { readonly defaultName: string };
  // Codex refuses legacy circuit-next names in every validated path segment.
  readonly rejectLegacyCircuitNextSegments?: boolean;
  // Default cache target when --cache-path is not given. `marketplace` is the
  // resolved marketplace name, or undefined for hosts without one.
  readonly defaultCachePath: (
    manifest: HostPluginManifest,
    marketplace: string | undefined,
  ) => string;
  // Path segments every cache target must end with.
  readonly expectedCacheSuffix: (
    manifest: HostPluginManifest,
    marketplace: string | undefined,
  ) => readonly string[];
};

type SyncArgs = {
  check: boolean;
  marketplace: string | undefined;
  cachePath: string | undefined;
};

function parseArgs(config: SyncHostCacheConfig, argv: readonly string[]): SyncArgs {
  const program = new Command(config.programName)
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .option('--check');
  if (config.marketplace) program.option('--marketplace <name>');
  program.option('--cache-path <path>').option('-h, --help');
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError && err.code === 'commander.helpDisplayed') process.exit(0);
    if (err instanceof CommanderError) throw new Error(err.message.replace(/^error: /, ''));
    throw err;
  }

  const opts = program.opts<{
    check?: boolean;
    marketplace?: string;
    cachePath?: string;
    help?: boolean;
  }>();
  return {
    check: opts.check === true,
    marketplace: config.marketplace
      ? (opts.marketplace ?? config.marketplace.defaultName)
      : undefined,
    cachePath: opts.cachePath,
  };
}

function readManifest(config: SyncHostCacheConfig): HostPluginManifest {
  const manifestPath = resolve(config.pluginRoot, config.manifestDirName, 'plugin.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as HostPluginManifest;
}

function assertSafePathSegment(config: SyncHostCacheConfig, value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} must be a single safe path segment; got ${JSON.stringify(value)}`);
  }
  if (config.rejectLegacyCircuitNextSegments === true && value.includes('circuit-next')) {
    throw new Error(
      `${label} must use the canonical Circuit package name; legacy circuit-next cache names are not supported`,
    );
  }
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function assertSafeCacheTarget(
  config: SyncHostCacheConfig,
  target: string,
  args: SyncArgs,
  manifest: HostPluginManifest,
): void {
  if (config.marketplace && args.marketplace !== undefined) {
    assertSafePathSegment(config, args.marketplace, 'marketplace');
  }
  assertSafePathSegment(config, manifest.name, 'plugin name');
  assertSafePathSegment(config, manifest.version, 'plugin version');

  const expectedSuffix = config.expectedCacheSuffix(manifest, args.marketplace);
  if (!pathEndsWithSegments(target, expectedSuffix)) {
    throw new Error(
      `refusing to sync ${config.hostLabel} plugin cache outside expected package path suffix: ${expectedSuffix.join('/')}`,
    );
  }

  if (args.cachePath === undefined) {
    const expectedDefault = config.defaultCachePath(manifest, args.marketplace);
    if (target !== expectedDefault) {
      throw new Error(`refusing to sync unexpected default cache target: ${target}`);
    }
    return;
  }

  const tempRoot = resolve(tmpdir());
  if (!isPathInside(tempRoot, target)) {
    throw new Error('refusing explicit --cache-path outside the system temp directory');
  }
}

function summary(
  config: SyncHostCacheConfig,
  status: string,
  target: string,
  tree: ReturnType<typeof packageTreeStatus>,
): Record<string, unknown> {
  return {
    status,
    source: config.pluginRoot,
    target,
    package_tree: tree,
    check_command: config.checkCommand,
    local_sync_command: config.localSyncCommand,
    commands: listCommandIds(config.pluginRoot),
    skills: listPackageDirs(config.pluginRoot, 'skills'),
  };
}

export function runSyncHostCache(config: SyncHostCacheConfig): void {
  try {
    const args = parseArgs(config, process.argv.slice(2));
    const manifest = readManifest(config);
    const target = args.cachePath
      ? resolve(args.cachePath)
      : config.defaultCachePath(manifest, args.marketplace);
    assertSafeCacheTarget(config, target, args, manifest);
    const beforeTree = packageTreeStatus(config.pluginRoot, target);

    if (args.check) {
      console.log(JSON.stringify(summary(config, beforeTree.status, target, beforeTree), null, 2));
      process.exit(beforeTree.status === 'ok' ? 0 : 1);
    }

    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    cpSync(config.pluginRoot, target, { recursive: true });
    const afterTree = packageTreeStatus(config.pluginRoot, target);
    console.log(
      JSON.stringify(
        summary(config, afterTree.status === 'ok' ? 'synced' : afterTree.status, target, afterTree),
        null,
        2,
      ),
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
