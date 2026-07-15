#!/usr/bin/env node
//
// Proves the published tarball is actually installable and runnable outside
// this checkout, the way a real `npm install -g @petepetrash/circuit` user would
// experience it. `npm pack` only proves the tarball builds; it says nothing
// about whether the packed bin launcher can find its compiled CLI and its
// declared dependencies once unpacked somewhere else.
//
// The dependency install step is done by symlinking this checkout's already-
// resolved node_modules into the extracted package, not by running a second
// `npm install` against the registry. A real registry install would make
// this gate network-dependent and flaky in CI; the files this checkout's
// node_modules already holds are the same dependency versions package.json
// declares, so the symlink proves the same resolution a global install
// would produce without leaving the machine.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type PackageInstallCheckResult = {
  ok: boolean;
  detail: string;
};

function isolatedEnv(): NodeJS.ProcessEnv {
  // Strip env vars this checkout's own build/runtime could have set so the
  // extracted CLI cannot pass by silently inheriting repo context instead of
  // resolving its own bundled plugins/version.json.
  const { CIRCUIT_VERSION, CIRCUIT_PLUGIN_ROOT, CIRCUIT_CLI, CIRCUIT_DEV, ...rest } = process.env;
  return rest;
}

export function checkNpmPackageInstall(repoRoot: string): PackageInstallCheckResult {
  const compiledCli = resolve(repoRoot, 'dist/cli/circuit.js');
  if (!existsSync(compiledCli)) {
    return {
      ok: false,
      detail: `compiled CLI is missing at ${compiledCli}; run npm run build before this check`,
    };
  }

  const expectedVersion = (
    JSON.parse(readFileSync(resolve(repoRoot, 'plugins/version.json'), 'utf8')) as {
      version: string;
    }
  ).version;

  const workDir = mkdtempSync(join(tmpdir(), 'circuit-npm-pack-'));
  const isolatedCwd = mkdtempSync(join(tmpdir(), 'circuit-npm-pack-cwd-'));
  try {
    const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', workDir], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (pack.status !== 0) {
      return { ok: false, detail: `npm pack failed: ${pack.stderr.trim() || pack.stdout.trim()}` };
    }

    const tarball = readdirSync(workDir).find((entry) => entry.endsWith('.tgz'));
    if (tarball === undefined) {
      return { ok: false, detail: `npm pack did not produce a .tgz in ${workDir}` };
    }

    const extractDir = join(workDir, 'extract');
    mkdirSync(extractDir, { recursive: true });
    const tar = spawnSync('tar', ['xzf', join(workDir, tarball), '-C', extractDir], {
      encoding: 'utf8',
    });
    if (tar.status !== 0) {
      return { ok: false, detail: `tar extraction failed: ${tar.stderr.trim()}` };
    }

    // Place the package under a node_modules directory the way a real
    // `npm install -g` does (<prefix>/lib/node_modules/<name>). Node treats
    // files under node_modules specially (for example, it refuses to
    // type-strip .ts files there), so probing from a bare extract dir would
    // miss failures that only appear in the installed layout.
    const extractedDir = join(extractDir, 'package');
    const packageName = (
      JSON.parse(readFileSync(join(extractedDir, 'package.json'), 'utf8')) as { name: string }
    ).name;
    const packageDir = join(workDir, 'install', 'node_modules', ...packageName.split('/'));
    mkdirSync(dirname(packageDir), { recursive: true });
    renameSync(extractedDir, packageDir);
    symlinkSync(resolve(repoRoot, 'node_modules'), join(packageDir, 'node_modules'), 'dir');

    const launcher = join(packageDir, 'bin/circuit');
    const env = isolatedEnv();

    const version = spawnSync(process.execPath, [launcher, 'version'], {
      cwd: isolatedCwd,
      env,
      encoding: 'utf8',
    });
    if (version.status !== 0) {
      return {
        ok: false,
        detail: `circuit version failed from packed install: ${version.stderr.trim() || version.stdout.trim()}`,
      };
    }
    if (version.stdout.trim() !== expectedVersion) {
      return {
        ok: false,
        detail: `circuit version reported "${version.stdout.trim()}" from packed install; expected "${expectedVersion}" (plugins/version.json)`,
      };
    }

    const preview = spawnSync(process.execPath, [launcher, 'preview', 'build'], {
      cwd: isolatedCwd,
      env,
      encoding: 'utf8',
    });
    if (preview.status !== 0) {
      return {
        ok: false,
        detail: `circuit preview build failed from packed install: ${preview.stderr.trim() || preview.stdout.trim()}`,
      };
    }
    if (!preview.stdout.includes('circuit preview')) {
      return {
        ok: false,
        detail: `circuit preview build produced unexpected output from packed install: ${preview.stdout.trim()}`,
      };
    }

    // Prove the packed install can load a bundled compiled flow from an
    // unrelated working directory, the way `circuit run <flow>` is
    // advertised. Preview cannot prove this: it reads the catalog compiled
    // into dist/, not the generated/flows files the run path loads.
    // The probe asks fix for --tournament, which fix's allow-list rejects,
    // so the rejection is only reachable after the packaged flow file
    // loaded, and the probe can never start a real (spending) run.
    const packedFlowPath = join(packageDir, 'generated/flows/fix/circuit.json');
    if (!existsSync(packedFlowPath)) {
      return { ok: false, detail: `packed tarball ships no compiled flow at ${packedFlowPath}` };
    }
    const packedFlow = JSON.parse(readFileSync(packedFlowPath, 'utf8')) as {
      axes?: { supports_tournament?: boolean };
    };
    if (packedFlow.axes?.supports_tournament !== false) {
      return {
        ok: false,
        detail:
          'flow-load probe assumes fix rejects --tournament; fix now supports it, so point the probe at a flow whose allow-list still rejects an axis',
      };
    }
    const flowLoad = spawnSync(
      process.execPath,
      [launcher, 'run', 'fix', '--goal', 'packaged flow load probe', '--tournament'],
      { cwd: isolatedCwd, env, encoding: 'utf8' },
    );
    const flowLoadOutput = `${flowLoad.stdout}\n${flowLoad.stderr}`;
    if (flowLoadOutput.includes('No flows were found')) {
      return {
        ok: false,
        detail: `packed install cannot find its bundled flows from an unrelated directory: ${flowLoadOutput.trim()}`,
      };
    }
    if (
      flowLoad.status === 0 ||
      !flowLoadOutput.includes("--tournament is not supported by flow 'fix'")
    ) {
      return {
        ok: false,
        detail: `flow-load probe expected the fix allow-list rejection (exit != 0); got exit ${flowLoad.status}: ${flowLoadOutput.trim()}`,
      };
    }

    // Prove the packed install can actually run the git-state helper that
    // fix/build spawn for their baseline snapshots. The helper runs as a
    // child process resolved next to the compiled module, and only the
    // node_modules layout above reveals resolution bugs like spawning a .ts
    // file Node refuses to type-strip under node_modules. The probe imports
    // gitStateCommand from the packed dist and spawns its argv exactly the
    // way the verification runtime does.
    const probeRepo = join(workDir, 'git-state-probe-repo');
    mkdirSync(probeRepo, { recursive: true });
    const gitInit = spawnSync('git', ['init', '--quiet'], { cwd: probeRepo, encoding: 'utf8' });
    if (gitInit.status !== 0) {
      return {
        ok: false,
        detail: `git init failed for the git-state probe: ${gitInit.stderr.trim()}`,
      };
    }
    const gitCommit = spawnSync(
      'git',
      [
        '-c',
        'user.email=probe@circuit.invalid',
        '-c',
        'user.name=circuit-probe',
        'commit',
        '--allow-empty',
        '-m',
        'probe',
      ],
      { cwd: probeRepo, encoding: 'utf8' },
    );
    if (gitCommit.status !== 0) {
      return {
        ok: false,
        detail: `git commit failed for the git-state probe: ${gitCommit.stderr.trim()}`,
      };
    }
    const commandModuleUrl = pathToFileURL(join(packageDir, 'dist/shared/git-state-command.js'));
    const probeScript = join(workDir, 'git-state-probe.mjs');
    writeFileSync(
      probeScript,
      [
        "import { spawnSync } from 'node:child_process';",
        `const { gitStateCommand } = await import(${JSON.stringify(commandModuleUrl.href)});`,
        "const command = gitStateCommand('npm-install-probe');",
        'const helper = spawnSync(command.argv[0], command.argv.slice(1), {',
        '  cwd: process.cwd(),',
        "  encoding: 'utf8',",
        '});',
        'if (helper.status !== 0) {',
        "  process.stderr.write(helper.stderr ?? String(helper.error ?? 'spawn failed'));",
        '  process.exit(1);',
        '}',
        'process.stdout.write(helper.stdout);',
        '',
      ].join('\n'),
    );
    const gitState = spawnSync(process.execPath, [probeScript], {
      cwd: probeRepo,
      env,
      encoding: 'utf8',
    });
    if (gitState.status !== 0) {
      return {
        ok: false,
        detail: `git-state helper failed from packed install: ${
          gitState.stderr.trim() || gitState.stdout.trim()
        }`,
      };
    }
    let snapshot: { head_sha?: unknown };
    try {
      snapshot = JSON.parse(gitState.stdout) as { head_sha?: unknown };
    } catch {
      return {
        ok: false,
        detail: `git-state helper stdout from packed install was not JSON: ${gitState.stdout.trim()}`,
      };
    }
    if (typeof snapshot.head_sha !== 'string' || !/^[0-9a-f]{40}$/.test(snapshot.head_sha)) {
      return {
        ok: false,
        detail: `git-state helper snapshot is missing a valid head_sha: ${gitState.stdout.trim()}`,
      };
    }

    return {
      ok: true,
      detail: `packed install ok: version ${expectedVersion}, preview rendered, bundled flow loads from an unrelated cwd, git-state helper runs`,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

function main(): void {
  const result = checkNpmPackageInstall(REPO_ROOT);
  if (result.ok) {
    process.stdout.write(`ok: ${result.detail}\n`);
    process.exit(0);
  }
  process.stderr.write(`fail: ${result.detail}\n`);
  process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
