import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/claude');
const EXPECTED_CLAUDE_COMMANDS = ['handoff', 'pursue', 'run'];
const RAW_PROGRESS_INVOCATION =
  /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/circuit\.ts" (?!present\b)[^\n]*--progress jsonl/;

const PluginManifest = z
  .object({
    name: z.literal('circuit'),
    version: z.string().min(1),
    description: z.string().min(1),
  })
  .passthrough();

const MarketplaceManifest = z.object({
  name: z.literal('circuit'),
  owner: z.object({ name: z.literal('Pete Petrash') }),
  plugins: z.array(
    z.object({
      name: z.literal('circuit'),
      version: z.string().min(1),
      source: z.literal('./plugins/claude'),
    }),
  ),
});

describe('Claude Code host plugin package', () => {
  it('declares a self-contained Claude Code plugin package', () => {
    const manifestPath = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');
    const manifest = PluginManifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

    expect(manifest.description).toContain('/circuit:run');
    expect(manifest.description).toContain('default Circuit command');
    expect(manifest).not.toHaveProperty('hooks');
    expect(existsSync(resolve(PLUGIN_ROOT, 'hooks/hooks.json'))).toBe(true);
    expect(existsSync(resolve(PLUGIN_ROOT, 'hooks/session-start.ts'))).toBe(true);
    expect(existsSync(resolve(PLUGIN_ROOT, 'scripts/circuit.ts'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'hooks'))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'commands'))).toBe(false);
  });

  it('ships a root Claude marketplace entry that matches the plugin version', () => {
    const versionManifest = VersionManifest.parse(
      JSON.parse(readFileSync(resolve(REPO_ROOT, 'plugins/version.json'), 'utf8')),
    );
    const pluginManifest = PluginManifest.parse(
      JSON.parse(readFileSync(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8')),
    );
    const marketplace = MarketplaceManifest.parse(
      JSON.parse(readFileSync(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'), 'utf8')),
    );

    expect(pluginManifest.version).toBe(versionManifest.version);
    expect(marketplace.plugins).toContainEqual({
      name: 'circuit',
      version: versionManifest.version,
      source: './plugins/claude',
    });
    expect(marketplace.owner.name).toBe('Pete Petrash');
  });

  it('exposes Claude Code command files that invoke the installed plugin wrapper', () => {
    for (const command of EXPECTED_CLAUDE_COMMANDS) {
      const commandPath = resolve(PLUGIN_ROOT, `commands/${command}.md`);
      expect(existsSync(commandPath)).toBe(true);
      const commandMarkdown = readFileSync(commandPath, 'utf8');

      expect(commandMarkdown).toContain('node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts"');
      expect(commandMarkdown).toContain(' present ');
      expect(commandMarkdown).not.toMatch(RAW_PROGRESS_INVOCATION);
      expect(commandMarkdown).not.toContain('Parse the final JSON');
      expect(commandMarkdown).not.toContain("Parse the CLI's final JSON");
      expect(commandMarkdown).not.toContain('./bin/circuit');
      expect(commandMarkdown).not.toContain('repo-local launcher');
      expect(commandMarkdown).not.toContain('invokes `circuit`');
    }
  });

  it('does not publish routed-only flows as Claude Code command files', () => {
    for (const flow of ROUTED_ONLY_FLOWS) {
      expect(existsSync(resolve(PLUGIN_ROOT, `commands/${flow}.md`))).toBe(false);
      expect(existsSync(resolve(PLUGIN_ROOT, `skills/${flow}/circuit.json`))).toBe(true);
    }
  });

  it('keeps CLI-only utilities out of Claude Code command files', () => {
    for (const utility of CLI_ONLY_UTILITIES) {
      expect(existsSync(resolve(REPO_ROOT, `src/commands/${utility}.md`))).toBe(true);
      expect(existsSync(resolve(PLUGIN_ROOT, `commands/${utility}.md`))).toBe(false);
    }
  });

  it('mirrors every public canonical compiled flow JSON file into the Claude package', () => {
    const canonicalRoot = resolve(REPO_ROOT, 'generated/flows');
    const claudeRoot = resolve(PLUGIN_ROOT, 'skills');
    const canonicalFiles = collectJsonFiles(canonicalRoot).sort();
    const claudeFiles = publicHostFlowFiles(collectJsonFiles(claudeRoot)).sort();

    expect(claudeFiles).toEqual(publicHostFlowFiles(canonicalFiles));

    for (const file of claudeFiles) {
      const canonical = readFileSync(resolve(canonicalRoot, file));
      const claude = readFileSync(resolve(claudeRoot, file));
      expect(claude, file).toEqual(canonical);
    }
    expect(existsSync(resolve(PLUGIN_ROOT, 'skills/runtime-proof'))).toBe(false);
  });

  it('syncs and checks the local Claude plugin cache package', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-cache-'));
    const versionManifest = VersionManifest.parse(
      JSON.parse(readFileSync(resolve(REPO_ROOT, 'plugins/version.json'), 'utf8')),
    );
    try {
      const cachePath = join(tempDir, `plugins/cache/circuit/circuit/${versionManifest.version}`);
      const syncResult = spawnSync(
        process.execPath,
        [resolve(REPO_ROOT, 'scripts/plugins/sync-claude-cache.ts'), '--cache-path', cachePath],
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
      expect(syncSummary.commands).toEqual([...EXPECTED_CLAUDE_COMMANDS].sort());
      expect(syncSummary.skills).toContain('pursue');
      expect(syncSummary.skills).toContain('review');
      expect(existsSync(join(cachePath, 'commands/run.md'))).toBe(true);
      expect(existsSync(join(cachePath, 'skills/pursue/circuit.json'))).toBe(true);

      const cleanCheck = spawnSync(
        process.execPath,
        [
          resolve(REPO_ROOT, 'scripts/plugins/sync-claude-cache.ts'),
          '--check',
          '--cache-path',
          cachePath,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(cleanCheck.status, cleanCheck.stderr).toBe(0);
      expect(JSON.parse(cleanCheck.stdout)).toMatchObject({ status: 'ok' });

      writeFileSync(join(cachePath, 'commands/run.md'), 'stale cache');
      const staleCheck = spawnSync(
        process.execPath,
        [
          resolve(REPO_ROOT, 'scripts/plugins/sync-claude-cache.ts'),
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
        join(tempDir, 'plugins/cache/circuit'),
        join(tempDir, 'plugins/cache/circuit/circuit/wrong-version'),
        REPO_ROOT,
      ]) {
        const unsafeSync = spawnSync(
          process.execPath,
          [resolve(REPO_ROOT, 'scripts/plugins/sync-claude-cache.ts'), '--cache-path', unsafePath],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );

        expect(unsafeSync.status).toBe(2);
        expect(unsafeSync.stderr).toContain('refusing');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapper uses the bundled runtime when PATH has no circuit binary', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-bundled-'));
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
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-override-'));
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
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-path-fallback-'));
    try {
      const tempPluginRoot = join(tempDir, 'plugin');
      const scriptsDir = join(tempPluginRoot, 'scripts');
      const binDir = join(tempDir, 'bin');
      const fakeBin = join(binDir, 'circuit');
      // The wrapper imports ./auto-open-policy.ts, ./launcher-core.ts, and
      // ./present-rendering.ts at top-level — copy them so the fixture script
      // can load.
      const wrapperPath = copyWrapperWithSidecars(PLUGIN_ROOT, scriptsDir, [
        'auto-open-policy.ts',
        'launcher-core.ts',
        'present-rendering.ts',
      ]);
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

  it('wrapper runs from a target repo and injects the packaged Claude flow root', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-'));
    try {
      const binDir = join(tempDir, 'bin');
      const argvPath = join(tempDir, 'argv.json');
      const fakeBin = join(binDir, 'circuit');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        fakeBin,
        `#!/usr/bin/env node\nconst { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(
          argvPath,
        )}, JSON.stringify({ argv: process.argv.slice(2), marker: process.env.${GENERATED_FLOW_MIRROR_ROOT_ENV} ?? null, host: process.env.CIRCUIT_HOST_KIND ?? null, cwd: process.cwd() }));\n`,
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
        cwd: string;
      };
      expect(capture.argv).toEqual([
        'run',
        'review',
        '--goal',
        'outside repo',
        '--flow-root',
        resolve(PLUGIN_ROOT, 'skills'),
      ]);
      expect(capture.marker).toBe(resolve(PLUGIN_ROOT, 'skills'));
      expect(capture.host).toBe('claude-code');
      expect(realpathSync(capture.cwd)).toBe(realpathSync(tempDir));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapper preserves child stdout, stderr, and exit status separately', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-streams-'));
    try {
      const binDir = join(tempDir, 'bin');
      const fakeBin = join(binDir, 'circuit');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          'process.stderr.write(\'{"type":"progress","step":"frame"}\\n\');',
          'process.stdout.write(\'{"outcome":"complete","result_path":"reports/result.json"}\\n\');',
          'process.exit(7);',
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [resolve(PLUGIN_ROOT, 'scripts/circuit.ts'), 'run', 'explore', '--goal', 'stream handling'],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin),
        },
      );

      expect(result.status).toBe(7);
      expect(result.stdout).toBe('{"outcome":"complete","result_path":"reports/result.json"}\n');
      expect(result.stderr).toBe('{"type":"progress","step":"frame"}\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('present mode streams clean progress before the child exits', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-present-stream-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const binDir = join(tempDir, 'bin');
      const summaryPath = join(tempDir, 'summary.md');
      const fakeBin = join(binDir, 'circuit');
      const finalJson = JSON.stringify({
        schema_version: 1,
        outcome: 'complete',
        run_folder: tempDir,
        operator_summary_markdown_path: summaryPath,
      });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(summaryPath, '# Clean Summary\n\n- Done.\n');
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          'const progress = { schema_version: 1, type: "run.started", run_id: "87000000-0000-0000-0000-000000000001", flow_id: "explore", recorded_at: "2026-05-07T12:00:00.000Z", label: "Started", display: { text: "Circuit started explore.", importance: "major", tone: "info" }, run_folder: process.cwd() };',
          'process.stderr.write(`${JSON.stringify(progress)}\\n`);',
          'setTimeout(() => {',
          `  process.stdout.write(${JSON.stringify(`${finalJson}\n`)});`,
          '}, 900);',
          'setTimeout(() => process.exit(0), 950);',
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      child = spawn(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'present',
          'run',
          'explore',
          '--goal',
          'stream handling',
        ],
        {
          cwd: tempDir,
          env: envWithOverride(fakeBin),
        },
      );
      const childProcess = child;
      const stdoutPipe = childProcess.stdout;
      if (stdoutPipe === null) throw new Error('expected child stdout pipe');

      let stdout = '';
      let closed = false;
      const closePromise = new Promise<number | null>((resolveClose) => {
        childProcess.on('close', (status) => {
          closed = true;
          resolveClose(status);
        });
      });
      const progressBeforeExit = await new Promise<boolean>((resolveProgress) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveProgress(value);
        };
        const timer = setTimeout(() => finish(false), 5_000);
        childProcess.once('close', () => finish(false));
        stdoutPipe.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (stdout.includes('Circuit started explore.')) {
            finish(!closed);
          }
        });
      });

      expect(progressBeforeExit).toBe(true);
      const status = await closePromise;
      expect(status).toBe(0);
      expect(stdout).toContain('# Clean Summary');
      expect(stdout).not.toContain('schema_version');
      expect(stdout).not.toContain('{"');
    } finally {
      child?.kill();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('present mode renders presentation status blocks then the readable digest', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-status-block-'));
    try {
      const binDir = join(tempDir, 'bin');
      const summaryPath = join(tempDir, 'operator-summary.md');
      const summaryJsonPath = join(tempDir, 'operator-summary.json');
      const fakeBin = join(binDir, 'circuit');
      const runId = '87000000-0000-0000-0000-000000000001';
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        summaryJsonPath,
        JSON.stringify({
          schema_version: 1,
          run_id: runId,
          flow_id: 'review',
          selected_flow: 'review',
          outcome: 'complete',
          headline: 'Circuit · Review',
          status_text: 'Review',
          brief_slots: {
            headline: 'Circuit · Review',
            assessment: 'Reviewer found nothing actionable in scope.',
            key_points: ['Checked the relayed review report'],
            caveats: [],
            next_action: 'nothing required.',
          },
          details: [],
          evidence_warnings: [],
          run_folder: tempDir,
          report_paths: [],
        }),
      );
      writeFileSync(
        summaryPath,
        [
          'Circuit · Review',
          '',
          'Reviewer found nothing actionable in scope.',
          '',
          '- Checked the relayed review report',
          '',
          'Next: nothing required.',
          '',
        ].join('\n'),
      );
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          `const runId = ${JSON.stringify(runId)};`,
          'const route = { schema_version: 1, type: "route.selected", run_id: runId, flow_id: "review", recorded_at: "2026-05-07T12:00:00.000Z", label: "Selected review", display: { text: "Circuit: Chose review.", importance: "major", tone: "info" }, presentation: { block_id: runId, line_mode: "append", status_text: "Chose review." }, selected_flow: "review", routed_by: "explicit", router_reason: "explicit flow positional argument" };',
          'const relay = { schema_version: 1, type: "relay.started", run_id: runId, flow_id: "review", recorded_at: "2026-05-07T12:00:01.000Z", label: "Running review", display: { text: "Circuit: Asking the reviewer to check the result...", importance: "major", tone: "info" }, presentation: { block_id: runId, line_mode: "replace_slot", slot_id: "review-relay", status_text: "Reviewing the result..." }, step_id: "review-step", step_title: "Review", attempt: 1, role: "reviewer", connector_name: "claude-code", connector_kind: "builtin", filesystem_capability: "trusted-write" };',
          'const done = { schema_version: 1, type: "run.completed", run_id: runId, flow_id: "review", recorded_at: "2026-05-07T12:00:02.000Z", label: "Complete", display: { text: "Circuit: Finished Review.", importance: "major", tone: "success" }, presentation: { block_id: runId, line_mode: "append", status_text: "Finished Review." }, outcome: "complete", result_path: "reports/result.json" };',
          'process.stderr.write(`${JSON.stringify(route)}\\n${JSON.stringify(relay)}\\n${JSON.stringify(done)}\\n`);',
          `process.stdout.write(${JSON.stringify(
            `${JSON.stringify({
              schema_version: 1,
              run_id: runId,
              outcome: 'complete',
              run_folder: tempDir,
              operator_summary_path: summaryJsonPath,
              operator_summary_markdown_path: summaryPath,
              operator_summary_status_text: 'Review',
            })}\n`,
          )});`,
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'present',
          'run',
          'review',
          '--goal',
          'render status block',
        ],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      // The live status block records progress (channel B), then the readable
      // digest (the operator summary Markdown) prints at completion so the
      // operator actually sees the result, not just a one-line status.
      expect(result.stdout).toBe(
        [
          'Circuit',
          '⎿ Chose review.',
          '⎿ Reviewing the result...',
          '⎿ Finished Review.',
          '',
          'Circuit · Review',
          '',
          'Reviewer found nothing actionable in scope.',
          '',
          '- Checked the relayed review report',
          '',
          'Next: nothing required.',
          '',
        ].join('\n'),
      );
      expect(result.stdout.match(/^Circuit$/gm)).toHaveLength(1);
      expect(result.stdout).toContain('Reviewer found nothing actionable in scope.');
      expect(result.stdout).not.toContain('\nCIRCUIT\n');
      expect(result.stdout).not.toContain('schema_version');
      expect(result.stdout).not.toContain('{"');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('present mode prints only summary Markdown on success when no progress is emitted', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-present-success-'));
    try {
      const binDir = join(tempDir, 'bin');
      const summaryPath = join(tempDir, 'summary.md');
      const fakeBin = join(binDir, 'circuit');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(summaryPath, '# Clean Summary\n\n- Recommendation: keep it short.\n');
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          `process.stdout.write(${JSON.stringify(
            `${JSON.stringify({
              schema_version: 1,
              outcome: 'complete',
              run_folder: tempDir,
              operator_summary_markdown_path: summaryPath,
            })}\n`,
          )});`,
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'present',
          'run',
          'explore',
          '--goal',
          'clean success',
        ],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('# Clean Summary\n\n- Recommendation: keep it short.\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('present mode prefers the operator summary (readable digest) over the run surface', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-present-digest-wins-'));
    try {
      const binDir = join(tempDir, 'bin');
      const runSurfacePath = join(tempDir, 'run-surface.md');
      const operatorSummaryPath = join(tempDir, 'operator-summary.md');
      const fakeBin = join(binDir, 'circuit');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(runSurfacePath, '# Run Surface\n\n- compact answer.\n');
      writeFileSync(operatorSummaryPath, '# Operator Summary\n\n- verbose brief.\n');
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          `process.stdout.write(${JSON.stringify(
            `${JSON.stringify({
              schema_version: 1,
              outcome: 'complete',
              run_folder: tempDir,
              run_surface_markdown_path: runSurfacePath,
              operator_summary_markdown_path: operatorSummaryPath,
            })}\n`,
          )});`,
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'present',
          'run',
          'explore',
          '--goal',
          'prefer digest',
        ],
        { cwd: tempDir, encoding: 'utf8', env: envWithOverride(fakeBin) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('# Operator Summary');
      expect(result.stdout).not.toContain('# Run Surface');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('present mode falls back to the run surface when the operator summary file is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-present-digest-miss-'));
    try {
      const binDir = join(tempDir, 'bin');
      const runSurfacePath = join(tempDir, 'run-surface.md');
      const fakeBin = join(binDir, 'circuit');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(runSurfacePath, '# Run Surface\n\n- compact answer.\n');
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          `process.stdout.write(${JSON.stringify(
            `${JSON.stringify({
              schema_version: 1,
              outcome: 'complete',
              run_folder: tempDir,
              run_surface_markdown_path: runSurfacePath,
              // The operator summary path is advertised but never written to disk.
              operator_summary_markdown_path: join(tempDir, 'absent-operator-summary.md'),
            })}\n`,
          )});`,
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'present',
          'run',
          'explore',
          '--goal',
          'operator summary missing',
        ],
        { cwd: tempDir, encoding: 'utf8', env: envWithOverride(fakeBin) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('# Run Surface');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('present mode renders the abort reason from result.json when the envelope omits it (F-H-2)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-present-abort-resultjson-'));
    try {
      const binDir = join(tempDir, 'bin');
      const resultPath = join(tempDir, 'reports', 'result.json');
      const fakeBin = join(binDir, 'circuit');
      const specificReason = 'variant-options-step requires circuits.prototype.variant_models';
      mkdirSync(binDir, { recursive: true });
      mkdirSync(join(tempDir, 'reports'), { recursive: true });
      writeFileSync(
        resultPath,
        `${JSON.stringify({ schema_version: 1, outcome: 'aborted', reason: specificReason })}\n`,
      );
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          // No streamed progress (no blocks) and NO `reason` on the envelope, so
          // the no-blocks abort branch must read it from result.json via result_path.
          `process.stdout.write(${JSON.stringify(
            `${JSON.stringify({
              schema_version: 1,
              outcome: 'aborted',
              run_folder: tempDir,
              result_path: resultPath,
            })}\n`,
          )});`,
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'present',
          'run',
          'prototype',
          '--goal',
          'abort reason from result.json',
        ],
        { cwd: tempDir, encoding: 'utf8', env: envWithOverride(fakeBin) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(specificReason);
      expect(result.stdout).not.toContain('Circuit aborted before completing.');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('present mode renders a streamed abort reason once with no duplicate generic line (F-H-2)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-present-abort-stream-'));
    try {
      const binDir = join(tempDir, 'bin');
      const fakeBin = join(binDir, 'circuit');
      const runId = '87000000-0000-0000-0000-000000000001';
      const specificReason = "step 'variant-options-step' requires variant_models config";
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          `const runId = ${JSON.stringify(runId)};`,
          `const reason = ${JSON.stringify(specificReason)};`,
          // The runtime emits a run.aborted progress block carrying the reason; the
          // wrapper renders it as the final status line. The final envelope also
          // carries the reason, but the streamed-block branch must NOT print a
          // second, redundant generic line.
          'const aborted = { schema_version: 1, type: "run.aborted", run_id: runId, flow_id: "prototype", recorded_at: "2026-05-07T12:00:02.000Z", label: "Circuit run aborted", display: { text: `Circuit: Run aborted: ${reason}`, importance: "major", tone: "error" }, presentation: { block_id: runId, line_mode: "append", status_text: `Run aborted: ${reason}` }, outcome: "aborted", reason };',
          'process.stderr.write(`${JSON.stringify(aborted)}\\n`);',
          `process.stdout.write(${JSON.stringify(
            `${JSON.stringify({
              schema_version: 1,
              run_id: runId,
              outcome: 'aborted',
              run_folder: tempDir,
              reason: specificReason,
            })}\n`,
          )});`,
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'present',
          'run',
          'prototype',
          '--goal',
          'streamed abort single line',
        ],
        { cwd: tempDir, encoding: 'utf8', env: envWithOverride(fakeBin) },
      );

      expect(result.status, result.stderr).toBe(0);
      const occurrences = result.stdout.split(`Run aborted: ${specificReason}`).length - 1;
      expect(occurrences).toBe(1);
      expect(result.stdout).not.toContain('Circuit aborted before completing.');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('present mode renders checkpoint choices and a resume command without raw JSON', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-present-checkpoint-'));
    try {
      const binDir = join(tempDir, 'bin');
      const runFolder = join(tempDir, 'run');
      const requestPath = join(runFolder, 'reports/checkpoints/tradeoff-request.json');
      const fakeBin = join(binDir, 'circuit');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(join(requestPath, '..'), { recursive: true });
      writeFileSync(requestPath, JSON.stringify({ prompt: 'Choose the best tradeoff.' }));
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          `process.stdout.write(${JSON.stringify(
            `${JSON.stringify({
              schema_version: 1,
              outcome: 'checkpoint_waiting',
              run_folder: runFolder,
              checkpoint: {
                step_id: 'tradeoff-checkpoint-step',
                request_path: requestPath,
                allowed_choices: ['option-1', 'option-2'],
              },
            })}\n`,
          )});`,
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'present',
          'run',
          'explore',
          '--goal',
          'needs checkpoint',
        ],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Choose the best tradeoff.');
      expect(result.stdout).toContain('Option 1');
      expect(result.stdout).toContain('Option 2');
      expect(result.stdout).toContain(
        `node "\${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present resume --run-folder '${runFolder}' --checkpoint-choice '<choice>'`,
      );
      expect(result.stdout).not.toContain('checkpoint_waiting');
      expect(result.stdout).not.toContain('{"');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('present mode surfaces checkpoint HTML and still prints the resume command when auto-open is skipped', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-present-checkpoint-html-'));
    try {
      const binDir = join(tempDir, 'bin');
      const runFolder = join(tempDir, 'run');
      const requestPath = join(runFolder, 'reports/checkpoints/frame-step-request.json');
      const htmlPath = join(runFolder, 'reports/operator-summary.html');
      const fakeBin = join(binDir, 'circuit');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(join(requestPath, '..'), { recursive: true });
      writeFileSync(requestPath, JSON.stringify({ prompt: 'Confirm the Build brief.' }));
      writeFileSync(htmlPath, '<!doctype html><body>checkpoint</body>');
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          `process.stdout.write(${JSON.stringify(
            `${JSON.stringify({
              schema_version: 1,
              outcome: 'checkpoint_waiting',
              run_folder: runFolder,
              operator_summary_html_path: htmlPath,
              checkpoint: {
                step_id: 'frame-step',
                request_path: requestPath,
                allowed_choices: ['continue'],
              },
            })}\n`,
          )});`,
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'present',
          'run',
          'build',
          '--goal',
          'needs checkpoint',
        ],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin, { CIRCUIT_NO_AUTO_OPEN: '1' }),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Confirm the Build brief.');
      expect(result.stdout).toContain(`Rich summary: ${htmlPath}`);
      expect(result.stdout).toContain(
        `node "\${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present resume --run-folder '${runFolder}' --checkpoint-choice '<choice>'`,
      );
      expect(result.stdout).not.toContain('checkpoint_waiting');
      expect(result.stdout).not.toContain('{"');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('present mode suppresses progress JSONL and prints only a short stderr diagnostic on failure', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-present-failure-'));
    try {
      const binDir = join(tempDir, 'bin');
      const fakeBin = join(binDir, 'circuit');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        fakeBin,
        [
          '#!/usr/bin/env node',
          'const selected = { schema_version: 1, type: "route.selected", run_id: "87000000-0000-0000-0000-000000000001", flow_id: "explore", recorded_at: "2026-05-07T12:00:00.000Z", label: "Selected explore", display: { text: "Circuit selected explore: explicit flow positional argument", importance: "major", tone: "info" }, selected_flow: "explore", routed_by: "explicit", router_reason: "explicit flow positional argument" };',
          'const started = { schema_version: 1, type: "run.started", run_id: "87000000-0000-0000-0000-000000000001", flow_id: "explore", recorded_at: "2026-05-07T12:00:01.000Z", label: "Started", display: { text: "Circuit started explore.", importance: "major", tone: "info" }, run_folder: process.cwd() };',
          'process.stderr.write(`${JSON.stringify(selected)}\\n`);',
          'process.stderr.write(`${JSON.stringify(started)}\\n`);',
          'process.stderr.write("relay crashed loudly\\nmore diagnostic detail\\n");',
          'process.exit(3);',
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          resolve(PLUGIN_ROOT, 'scripts/circuit.ts'),
          'present',
          'run',
          'explore',
          '--goal',
          'fails cleanly',
        ],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: envWithOverride(fakeBin),
        },
      );

      expect(result.status).toBe(3);
      expect(result.stdout).toContain('Circuit started explore.');
      expect(result.stderr).toContain('Circuit run failed');
      expect(result.stderr).toContain('relay crashed loudly');
      expect(result.stdout).not.toContain('Circuit selected explore');
      expect(result.stdout).not.toContain('schema_version');
      expect(result.stderr).not.toContain('schema_version');
      expect(result.stderr).not.toContain('{"');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapper does not inject a flow root for handoff save', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-handoff-'));
    try {
      const binDir = join(tempDir, 'bin');
      const argvPath = join(tempDir, 'argv.json');
      const fakeBin = join(binDir, 'circuit');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        fakeBin,
        `#!/usr/bin/env node\nconst { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(
          argvPath,
        )}, JSON.stringify({ argv: process.argv.slice(2), marker: process.env.${GENERATED_FLOW_MIRROR_ROOT_ENV} ?? null, cwd: process.cwd() }));\n`,
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
        cwd: string;
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
      expect(realpathSync(capture.cwd)).toBe(realpathSync(tempDir));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('doctor verifies the installed Claude Code host package from a target repo', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'circuit-claude-host-doctor-'));
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
        checks: Array<{ name: string; ok: boolean }>;
      };
      expect(output.status).toBe('ok');
      expect(output.runtime_source).toBe('bundled');
      expect(output.runtime_path).toBe(resolve(PLUGIN_ROOT, 'runtime/circuit.js'));
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'plugin_manifest_shape', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'session_start_hook_exists', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'packaged_flow_review', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'runtime_version_executes', ok: true }),
      );
      expect(output.checks).toContainEqual(
        expect.objectContaining({ name: 'temp_repo_review_smoke', ok: true }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
