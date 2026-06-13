import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { main } from '../../src/cli/circuit.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayInput } from '../../src/shared/relay-runtime-types.js';
import {
  CLI_ONLY_UTILITIES,
  GENERATED_FLOW_MIRROR_ROOT_ENV,
  REPO_ROOT,
  ROUTED_ONLY_FLOWS,
  VersionManifest,
  cleanPluginEnv,
  collectJsonFiles,
  copyWrapperWithSidecars,
  envWithOverride,
  noAmbientCliPath,
  publicHostFlowFiles,
} from '../helpers/host-plugin-fixtures.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/codex');
const EXPECTED_CODEX_COMMANDS = ['handoff', 'pursue', 'run'];
const EXPECTED_CODEX_SKILL_TITLES: Record<string, string> = {
  handoff: 'Circuit Handoff',
  pursue: 'Circuit Pursue',
  run: 'Circuit Run',
};
// Flow-owned command sources live in the flow package; direct command
// sources live under src/commands/.
const COMMAND_SOURCE_PATHS: Record<string, string> = {
  pursue: 'src/flows/pursue/command.md',
};

const PluginManifest = z.looseObject({
  name: z.literal('circuit'),
  version: z.string().min(1),
  description: z.string().min(1),
  homepage: z.literal('https://github.com/petekp/circuit'),
  repository: z.literal('https://github.com/petekp/circuit'),
  skills: z.literal('./skills/'),
  interface: z.object({
    displayName: z.literal('Circuit'),
    shortDescription: z.string().min(1),
    longDescription: z.string().min(1),
    category: z.literal('Coding'),
    capabilities: z.array(z.string()).min(1),
    defaultPrompt: z.array(z.string().max(128)).max(3),
  }),
});

function sourceCommandPath(command: string): string {
  return resolve(REPO_ROOT, COMMAND_SOURCE_PATHS[command] ?? `src/commands/${command}.md`);
}

describe('Codex host plugin package', () => {
  it('declares an installable Codex plugin manifest', () => {
    const manifestPath = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');
    const manifest = PluginManifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    const versionManifest = VersionManifest.parse(
      JSON.parse(readFileSync(resolve(REPO_ROOT, 'plugins/version.json'), 'utf8')),
    );

    expect(manifest.version).toBe(versionManifest.version);
    expect(manifest.homepage).toBe('https://github.com/petekp/circuit');
    expect(manifest.repository).toBe('https://github.com/petekp/circuit');
    expect(manifest.interface.capabilities).toContain('Interactive');
    expect(manifest.interface.capabilities).toContain('Write');
    expect(manifest.description).toContain('coding intents');
    expect(manifest.interface.shortDescription).toContain('coding intents');
    expect(manifest.interface.longDescription).toContain('/circuit:run');
    expect(manifest.interface.longDescription).toContain('by default');
    expect(manifest.interface.longDescription).not.toContain('@Circuit');
    expect(manifest.interface.longDescription).toContain('recommend a Circuit flow');
    expect(manifest.interface.longDescription).toContain('default Circuit entry point');
    expect(manifest.interface.longDescription).toContain('/circuit:pursue');
    expect(manifest.interface.defaultPrompt).toEqual([
      'Use Circuit on this task',
      'Use Circuit to fix this bug',
      'Use Circuit to review this change',
    ]);
    expect(manifest).not.toHaveProperty('hooks');
    expect(existsSync(resolve(PLUGIN_ROOT, 'hooks/hooks.json'))).toBe(false);
  });

  it('ships a public marketplace entry for Codex plugin discovery', () => {
    const marketplace = JSON.parse(
      readFileSync(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'), 'utf8'),
    ) as {
      name: string;
      interface: { displayName: string };
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
        policy: { installation: string; authentication: string };
        category: string;
      }>;
    };

    expect(marketplace.name).toBe('circuit');
    expect(marketplace.interface.displayName).toBe('Circuit');
    expect(marketplace.plugins).toContainEqual({
      name: 'circuit',
      source: { source: 'local', path: './plugins/codex' },
      policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' },
      category: 'Coding',
    });
  });

  it('does not keep a legacy Codex package path or shim', () => {
    const legacyCodexPackageRel = ['plugins', 'circuit'].join('/');
    const legacyRoot = resolve(REPO_ROOT, legacyCodexPackageRel);
    const marketplace = JSON.parse(
      readFileSync(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'), 'utf8'),
    ) as {
      plugins: Array<{ source?: { path?: string } }>;
    };

    expect(existsSync(legacyRoot)).toBe(false);
    expect(marketplace.plugins.map((plugin) => plugin.source?.path)).toEqual(['./plugins/codex']);
  });

  it('syncs and checks the local Codex plugin cache package', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-cache-'));
    const versionManifest = VersionManifest.parse(
      JSON.parse(readFileSync(resolve(REPO_ROOT, 'plugins/version.json'), 'utf8')),
    );
    try {
      const cachePath = join(
        tempDir,
        `plugins/cache/circuit-local/circuit/${versionManifest.version}`,
      );
      const syncResult = spawnSync(
        process.execPath,
        [resolve(REPO_ROOT, 'scripts/plugins/sync-codex-cache.ts'), '--cache-path', cachePath],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(syncResult.status, syncResult.stderr).toBe(0);

      const syncSummary = JSON.parse(syncResult.stdout) as {
        status: string;
        source: string;
        commands: string[];
        skills: string[];
      };
      expect(syncSummary.status).toBe('synced');
      expect(syncSummary.source).toBe(PLUGIN_ROOT);
      expect(JSON.stringify(syncSummary)).not.toContain(['plugins', 'circuit'].join('/'));
      expect(syncSummary.commands).toEqual([...EXPECTED_CODEX_COMMANDS].sort());
      expect(syncSummary.skills).toEqual([...EXPECTED_CODEX_COMMANDS].sort());
      expect(existsSync(join(cachePath, 'skills/run/SKILL.md'))).toBe(true);
      expect(existsSync(join(cachePath, 'skills/fix/SKILL.md'))).toBe(false);

      const cleanCheck = spawnSync(
        process.execPath,
        [
          resolve(REPO_ROOT, 'scripts/plugins/sync-codex-cache.ts'),
          '--check',
          '--cache-path',
          cachePath,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(cleanCheck.status, cleanCheck.stderr).toBe(0);
      expect(JSON.parse(cleanCheck.stdout)).toMatchObject({ status: 'ok' });

      writeFileSync(join(cachePath, 'skills/run/SKILL.md'), 'stale cache');
      const staleCheck = spawnSync(
        process.execPath,
        [
          resolve(REPO_ROOT, 'scripts/plugins/sync-codex-cache.ts'),
          '--check',
          '--cache-path',
          cachePath,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(staleCheck.status).toBe(1);
      expect(JSON.parse(staleCheck.stdout)).toMatchObject({ status: 'stale' });

      for (const unsafePath of [
        tempDir,
        join(tempDir, 'plugins/cache/circuit-local'),
        join(tempDir, 'plugins/cache/circuit-local/circuit/wrong-version'),
        REPO_ROOT,
      ]) {
        const unsafeSync = spawnSync(
          process.execPath,
          [resolve(REPO_ROOT, 'scripts/plugins/sync-codex-cache.ts'), '--cache-path', unsafePath],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );

        expect(unsafeSync.status).toBe(2);
        expect(unsafeSync.stderr).toContain('refusing');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('documents the host adapter contract', () => {
    const contract = readFileSync(resolve(REPO_ROOT, 'docs/contracts/host-adapter.md'), 'utf8');
    const rendering = readFileSync(resolve(REPO_ROOT, 'docs/contracts/host-rendering.md'), 'utf8');

    expect(contract).toContain('contract: host-adapter');
    expect(contract).toContain('Explicit runs');
    expect(contract).toContain('--progress jsonl');
    expect(contract).toContain("node '<plugin root>/scripts/circuit.ts' doctor");
    expect(contract).toContain('final user-facing answer');
    expect(contract).toContain('run_surface_markdown_path');
    expect(rendering).toContain('contract: host-rendering');
    expect(rendering).toContain('Prefer `presentation` when present');
    expect(rendering).toContain('run_surface_status_text');
    expect(rendering).toContain('run_surface_markdown_path');
    expect(rendering).toContain('operator_summary_status_text');
    expect(rendering).toContain('operator_summary_markdown_path');
  });

  it('exposes Codex skill and command surfaces backed by the Circuit CLI protocol', () => {
    expect(existsSync(resolve(PLUGIN_ROOT, 'scripts/circuit.ts'))).toBe(true);

    for (const command of EXPECTED_CODEX_COMMANDS) {
      expect(existsSync(resolve(PLUGIN_ROOT, `commands/${command}.md`))).toBe(true);
      expect(existsSync(resolve(PLUGIN_ROOT, `skills/${command}/SKILL.md`))).toBe(true);
    }

    const skill = readFileSync(resolve(PLUGIN_ROOT, 'skills/run/SKILL.md'), 'utf8');
    expect(skill).toContain('name: run');
    expect(skill).not.toContain('name: circuit-run');
    expect(skill).toContain('# Circuit Run');
    expect(skill).toContain('## Use Case');
    expect(skill).toContain(
      'Runs Circuit on any coding task by default — the intent front door with recorded flow selection, trace, reports, and evidence.',
    );
    expect(skill).toContain("node '<plugin root>/scripts/circuit.ts' run fix --goal");
    expect(skill).toContain('--progress jsonl');
    expect(skill).toContain('new visible progress as the status block itself');
    expect(skill).toContain('not as separate prose updates');
    expect(skill).toContain('`CIRCUIT` block');
    expect(skill).toContain('display.text');
    expect(skill).toContain('task_list.updated');
    expect(skill).toContain('user_input.requested');
    expect(skill).toContain('run_surface_markdown_path');
    expect(skill).toContain('operator_summary_markdown_path');
    expect(skill).toContain('not published as separate host commands');
    expect(skill).toContain('Do not use a path relative to the user');
    expect(skill).not.toMatch(/^# \/circuit:/m);
    expect(skill).not.toContain('/circuit:');
    expect(skill).not.toMatch(/\bslash command\b/i);
    expect(skill).not.toContain('slash-command');
    expect(skill).not.toContain('node plugins/codex/scripts/circuit.ts');
    expect(skill).toContain(
      "node '<plugin root>/scripts/circuit.ts' resume --run-folder '<run_folder>' --checkpoint-choice '<choice>'",
    );
  });

  it('uses plugin-local skill names so Codex resolves Circuit:<skill>', () => {
    const skillsRoot = resolve(PLUGIN_ROOT, 'skills');
    const skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillDirs).toEqual([...EXPECTED_CODEX_COMMANDS].sort());

    for (const skillDir of skillDirs) {
      const skillPath = resolve(skillsRoot, skillDir, 'SKILL.md');
      const skill = readFileSync(skillPath, 'utf8');
      const name = /^name:\s*(\S+)\s*$/m.exec(skill)?.[1];

      expect(name).toBe(skillDir);
      expect(name).not.toMatch(/^circuit[:-]/);
    }
  });

  it('does not publish routed-only flows as Codex commands or skills', () => {
    for (const flow of ROUTED_ONLY_FLOWS) {
      expect(existsSync(resolve(PLUGIN_ROOT, `commands/${flow}.md`))).toBe(false);
      expect(existsSync(resolve(PLUGIN_ROOT, `skills/${flow}/SKILL.md`))).toBe(false);
      expect(existsSync(resolve(PLUGIN_ROOT, `flows/${flow}/circuit.json`))).toBe(true);
    }
  });

  it('keeps CLI-only utilities out of Codex command and skill surfaces', () => {
    for (const utility of CLI_ONLY_UTILITIES) {
      expect(existsSync(sourceCommandPath(utility))).toBe(true);
      expect(existsSync(resolve(PLUGIN_ROOT, `commands/${utility}.md`))).toBe(false);
      expect(existsSync(resolve(PLUGIN_ROOT, `skills/${utility}/SKILL.md`))).toBe(false);
    }
  });

  it('wrapper uses the bundled runtime when PATH has no circuit binary', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-host-bundled-'));
    try {
      const result = spawnSync(
        process.execPath,
        [resolve(PLUGIN_ROOT, 'scripts/circuit.ts'), 'version', '--json'],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: cleanPluginEnv(),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as {
        runtime_source: string;
        runtime_path: string;
        version: string;
      };
      expect(output.runtime_source).toBe('bundled');
      expect(output.runtime_path).toBe(resolve(PLUGIN_ROOT, 'runtime/circuit.js'));
      expect(output.version).toBe(
        VersionManifest.parse(
          JSON.parse(readFileSync(resolve(REPO_ROOT, 'plugins/version.json'), 'utf8')),
        ).version,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapper reports CIRCUIT_CLI as an explicit override', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-host-override-'));
    try {
      const binDir = join(tempDir, 'bin');
      const fakeBin = join(binDir, 'circuit');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          'process.stdout.write(JSON.stringify({ runtime_source: process.env.CIRCUIT_RUNTIME_SOURCE, argv: process.argv.slice(2) }) + "\\n");',
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [resolve(PLUGIN_ROOT, 'scripts/circuit.ts'), 'version', '--json'],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        runtime_source: 'override',
        argv: ['version', '--json'],
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapper refuses PATH fallback unless CIRCUIT_DEV is set', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-host-path-fallback-'));
    try {
      const tempPluginRoot = join(tempDir, 'plugin');
      const scriptsDir = join(tempPluginRoot, 'scripts');
      const binDir = join(tempDir, 'bin');
      const fakeBin = join(binDir, 'circuit');
      // The wrapper imports ./launcher-core.ts at top-level — copy it so the
      // fixture script can load.
      const wrapperPath = copyWrapperWithSidecars(PLUGIN_ROOT, scriptsDir, ['launcher-core.ts']);
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          'process.stdout.write(JSON.stringify({ runtime_source: process.env.CIRCUIT_RUNTIME_SOURCE, argv: process.argv.slice(2) }) + "\\n");',
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const noDev = spawnSync(process.execPath, [wrapperPath, 'version', '--json'], {
        cwd: tempDir,
        encoding: 'utf8',
        env: cleanPluginEnv({ PATH: `${binDir}${delimiter}${noAmbientCliPath()}` }),
      });
      expect(noDev.status).toBe(1);
      expect(noDev.stderr).toContain('bundled runtime is missing');
      expect(noDev.stderr).not.toContain('install a package');

      const withDev = spawnSync(process.execPath, [wrapperPath, 'version', '--json'], {
        cwd: tempDir,
        encoding: 'utf8',
        env: cleanPluginEnv({
          PATH: `${binDir}${delimiter}${noAmbientCliPath()}`,
          CIRCUIT_DEV: '1',
        }),
      });
      expect(withDev.status, withDev.stderr).toBe(0);
      expect(JSON.parse(withDev.stdout)).toEqual({
        runtime_source: 'dev-fallback',
        argv: ['version', '--json'],
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapper runs from a target repo and injects the packaged flow root for routed runs', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-host-'));
    try {
      const binDir = join(tempDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const argvPath = join(tempDir, 'argv.json');
      const fakeBin = join(binDir, 'circuit');
      writeFileSync(
        fakeBin,
        `#!/usr/bin/env node\nconst { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(
          argvPath,
        )}, JSON.stringify({ argv: process.argv.slice(2), marker: process.env.${GENERATED_FLOW_MIRROR_ROOT_ENV} ?? null, host: process.env.CIRCUIT_HOST_KIND ?? null }));\n`,
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [resolve(PLUGIN_ROOT, 'scripts/circuit.ts'), 'run', 'review', '--goal', 'outside repo'],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin, {
            [GENERATED_FLOW_MIRROR_ROOT_ENV]: 'stale-parent-marker',
          }),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const capture = JSON.parse(readFileSync(argvPath, 'utf8')) as {
        argv: string[];
        marker: string | null;
        host: string | null;
      };
      expect(capture.argv).toEqual([
        'run',
        'review',
        '--goal',
        'outside repo',
        '--flow-root',
        resolve(PLUGIN_ROOT, 'flows'),
      ]);
      expect(capture.marker).toBe(resolve(PLUGIN_ROOT, 'flows'));
      expect(capture.host).toBe('codex');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapper does not set the trusted mirror marker for caller-supplied flow roots', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-host-custom-root-'));
    try {
      const binDir = join(tempDir, 'bin');
      const customRoot = join(tempDir, 'custom-flows');
      mkdirSync(binDir, { recursive: true });
      const argvPath = join(tempDir, 'argv.json');
      const fakeBin = join(binDir, 'circuit');
      writeFileSync(
        fakeBin,
        `#!/usr/bin/env node\nconst { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(
          argvPath,
        )}, JSON.stringify({ argv: process.argv.slice(2), marker: process.env.${GENERATED_FLOW_MIRROR_ROOT_ENV} ?? null }));\n`,
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'run',
          'review',
          '--goal',
          'outside repo custom root',
          '--flow-root',
          customRoot,
        ],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin, {
            [GENERATED_FLOW_MIRROR_ROOT_ENV]: 'stale-parent-marker',
          }),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const capture = JSON.parse(readFileSync(argvPath, 'utf8')) as {
        argv: string[];
        marker: string | null;
      };
      expect(capture.argv).toEqual([
        'run',
        'review',
        '--goal',
        'outside repo custom root',
        '--flow-root',
        customRoot,
      ]);
      expect(capture.marker).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapper does not inject a flow root for checkpoint resume', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-host-resume-'));
    try {
      const binDir = join(tempDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const argvPath = join(tempDir, 'argv.json');
      const fakeBin = join(binDir, 'circuit');
      writeFileSync(
        fakeBin,
        `#!/usr/bin/env node\nconst { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(
          argvPath,
        )}, JSON.stringify({ argv: process.argv.slice(2), marker: process.env.${GENERATED_FLOW_MIRROR_ROOT_ENV} ?? null }));\n`,
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'resume',
          '--run-folder',
          '/tmp/run',
          '--checkpoint-choice',
          'continue',
        ],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin, {
            [GENERATED_FLOW_MIRROR_ROOT_ENV]: 'stale-parent-marker',
          }),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const capture = JSON.parse(readFileSync(argvPath, 'utf8')) as {
        argv: string[];
        marker: string | null;
      };
      expect(capture.argv).toEqual([
        'resume',
        '--run-folder',
        '/tmp/run',
        '--checkpoint-choice',
        'continue',
      ]);
      expect(capture.marker).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapper does not inject a flow root for handoff save', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-host-handoff-'));
    try {
      const binDir = join(tempDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const argvPath = join(tempDir, 'argv.json');
      const fakeBin = join(binDir, 'circuit');
      writeFileSync(
        fakeBin,
        `#!/usr/bin/env node\nconst { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(
          argvPath,
        )}, JSON.stringify({ argv: process.argv.slice(2), marker: process.env.${GENERATED_FLOW_MIRROR_ROOT_ENV} ?? null }));\n`,
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'handoff',
          'save',
          '--goal',
          'preserve continuity',
          '--next',
          'resume carefully',
        ],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin, {
            [GENERATED_FLOW_MIRROR_ROOT_ENV]: 'stale-parent-marker',
          }),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const capture = JSON.parse(readFileSync(argvPath, 'utf8')) as {
        argv: string[];
        marker: string | null;
      };
      expect(capture.argv).toEqual([
        'handoff',
        'save',
        '--goal',
        'preserve continuity',
        '--next',
        'resume carefully',
      ]);
      expect(capture.marker).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('doctor verifies the installed Codex host package from a target repo', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-host-doctor-'));
    try {
      const result = spawnSync(
        process.execPath,
        [resolve(PLUGIN_ROOT, 'scripts/circuit.ts'), 'doctor'],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: cleanPluginEnv(),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as {
        status: string;
        runtime_source: string;
        runtime_path: string;
        checks: Array<{ name: string; ok: boolean; severity?: string }>;
      };
      expect(output.status).toBe('ok');
      expect(output.runtime_source).toBe('bundled');
      expect(output.runtime_path).toBe(resolve(PLUGIN_ROOT, 'runtime/circuit.js'));
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'bundled_hooks_config_absent', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'session_start_hook_exists', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({
          name: 'codex_hooks_feature_flag_visible',
          severity: 'warning',
        }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({
          name: 'codex_user_handoff_hook_installed',
          severity: 'warning',
        }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'temp_repo_review_smoke', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'temp_repo_review_progress', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'temp_repo_review_progress_display', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'temp_repo_review_operator_summary', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'temp_repo_checkpoint_user_input_requested', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'runtime_version_executes', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'bundled_runtime_exists', ok: true }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Circuit CLI can load routed flows from the packaged Codex flow root outside this checkout', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-cli-root-'));
    const runFolder = join(tempDir, 'run');
    const originalGeneratedMirrorRoot = process.env.CIRCUIT_GENERATED_FLOW_MIRROR_ROOT;
    try {
      const { result: exit, stdout: captured } = await captureStreams(async () => {
        process.env.CIRCUIT_GENERATED_FLOW_MIRROR_ROOT = resolve(PLUGIN_ROOT, 'flows');
        return main(
          [
            'run',
            'review',
            '--goal',
            'review this patch',
            '--flow-root',
            resolve(PLUGIN_ROOT, 'flows'),
            '--run-folder',
            runFolder,
          ],
          {
            configCwd: tempDir,
            configHomeDir: join(tempDir, 'home'),
            runId: '85000000-0000-0000-0000-000000000001',
            now: () => new Date(Date.UTC(2026, 3, 28, 12, 0, 0)),
            relayer: {
              connectorName: 'claude-code',
              relay: async (_input: RelayInput): Promise<RelayResult> => ({
                request_payload: 'stub-request',
                receipt_id: 'stub-receipt',
                result_body: JSON.stringify({
                  verdict: 'NO_ISSUES_FOUND',
                  findings: [],
                  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
                  verification: ['Inspected the relayed intake report.'],
                  confidence_limitations: [],
                }),
                duration_ms: 1,
                cli_version: '0.0.0-stub',
              }),
            },
          },
        );
      });

      expect(exit).toBe(0);
      const output = JSON.parse(captured) as { flow_id: string; selected_flow: string };
      expect(output.flow_id).toBe('review');
      expect(output.selected_flow).toBe('review');
      expect(existsSync(join(runFolder, 'reports/review-result.json'))).toBe(true);
    } finally {
      process.env.CIRCUIT_GENERATED_FLOW_MIRROR_ROOT = originalGeneratedMirrorRoot;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('mirrors every public canonical compiled flow JSON file into the Codex host output tree', () => {
    const canonicalRoot = resolve(REPO_ROOT, 'generated/flows');
    const codexRoot = resolve(PLUGIN_ROOT, 'flows');
    const canonicalFiles = collectJsonFiles(canonicalRoot).sort();
    const codexFiles = publicHostFlowFiles(collectJsonFiles(codexRoot)).sort();

    expect(codexFiles).toEqual(publicHostFlowFiles(canonicalFiles));

    for (const file of codexFiles) {
      const canonical = readFileSync(resolve(canonicalRoot, file));
      const codex = readFileSync(resolve(codexRoot, file));
      expect(codex, file).toEqual(canonical);
    }
    expect(existsSync(resolve(PLUGIN_ROOT, 'flows/runtime-proof'))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'plugins/claude/skills/runtime-proof'))).toBe(false);
  });

  it('generates Codex host command files that invoke the installed plugin wrapper', () => {
    for (const command of EXPECTED_CODEX_COMMANDS) {
      const source = readFileSync(sourceCommandPath(command), 'utf8');
      const codex = readFileSync(resolve(PLUGIN_ROOT, `commands/${command}.md`), 'utf8');
      expect(source).toContain('./bin/circuit');
      expect(source).toContain('--progress jsonl');
      expect(source).toContain('presentation');
      expect(source).toContain('display.text');
      expect(source).toContain('task_list.updated');
      expect(source).toContain('user_input.requested');
      expect(source).toContain('operator_summary_markdown_path');
      expect(source).not.toContain("node '<plugin root>/scripts/circuit.ts'");
      expect(codex).toContain("node '<plugin root>/scripts/circuit.ts'");
      expect(codex).toContain('--progress jsonl');
      expect(codex).toContain('presentation');
      expect(codex).toContain('display.text');
      expect(codex).toContain('task_list.updated');
      expect(codex).toContain('user_input.requested');
      expect(codex).toContain('operator_summary_markdown_path');
      expect(codex).not.toContain('./bin/circuit');
      expect(codex).not.toContain('repo-local launcher');
      expect(codex).not.toContain('invokes `circuit`');
    }
  });

  it('generates Codex host skills from the same command surfaces', () => {
    for (const command of EXPECTED_CODEX_COMMANDS) {
      const commandMarkdown = readFileSync(resolve(PLUGIN_ROOT, `commands/${command}.md`), 'utf8');
      const skill = readFileSync(resolve(PLUGIN_ROOT, `skills/${command}/SKILL.md`), 'utf8');

      expect(skill).toContain(`name: ${command}`);
      expect(skill).toContain(`# ${EXPECTED_CODEX_SKILL_TITLES[command]}`);
      expect(skill).toContain('## Use Case');
      expect(skill).toMatch(/description: "(Runs Circuit|Chooses and runs)/);
      expect(skill).toContain("node '<plugin root>/scripts/circuit.ts'");
      expect(skill).toContain('--progress jsonl');
      expect(skill).toContain('presentation');
      expect(skill).toContain('display.text');
      expect(skill).toContain('task_list.updated');
      expect(skill).toContain('user_input.requested');
      expect(skill).toContain('operator_summary_markdown_path');
      expect(skill).not.toContain('./bin/circuit');
      expect(skill).not.toContain('invokes `circuit`');
      expect(skill).not.toContain('argument-hint:');
      expect(skill).not.toContain('$ARGUMENTS');
      expect(skill).not.toContain('substituted below');
      expect(skill).not.toMatch(/^# \/circuit:/m);
      expect(skill).not.toContain('/circuit:');
      expect(skill).not.toMatch(/\bslash command\b/i);
      expect(skill).not.toContain('slash-command');
      expect(skill).toContain("Use the user's current request as the command input.");
      expect(commandMarkdown).toContain("node '<plugin root>/scripts/circuit.ts'");
    }
  });

  it('does not publish mode/depth pairs rejected by the wrapper', () => {
    const rejectedPair = '--entry-mode deep --depth medium';
    const surfaces = [
      resolve(PLUGIN_ROOT, 'skills/run/SKILL.md'),
      resolve(PLUGIN_ROOT, 'commands/run.md'),
    ];

    for (const surface of surfaces) {
      expect(readFileSync(surface, 'utf8'), surface).not.toContain(rejectedPair);
    }
  });
});
