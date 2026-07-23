import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertOldHostRoundSucceeded,
  assertPluginTreeMatchesSource,
  assertSupportedSmokeVersions,
  buildMarketplaceInstallPhases,
  buildMarketplaceInstallPlan,
  classifySmokeFailure,
  isRetryablePublishedSmokeOutcome,
  normalizeGitSource,
  parseSmokeOptions,
  runDetachedSmokeCommand,
  writeSmokeOutput,
} from '../../scripts/hosts/smoke/codex-mcp.js';

describe('Codex MCP host smoke automation', () => {
  it('keeps packed mode as the default', () => {
    expect(parseSmokeOptions(['--live'])).toMatchObject({
      live: true,
      mode: 'packed',
      marketplace: 'circuit-fresh-host-probe',
    });
  });

  it('requires an exact remote source, ref, and version for published mode', () => {
    expect(() => parseSmokeOptions(['--live', '--mode', 'published'])).toThrow(
      'published mode requires --source, --ref, and --expected-version',
    );
    expect(() =>
      parseSmokeOptions([
        '--live',
        '--mode',
        'published',
        '--source',
        './local',
        '--ref',
        'main',
        '--expected-version',
        '0.1.2',
      ]),
    ).toThrow('--source must name a remote repository');

    const options = parseSmokeOptions([
      '--live',
      '--mode',
      'published',
      '--source',
      'petekp/circuit',
      '--ref',
      'circuit--v0.1.2',
      '--expected-version',
      '0.1.2',
      '--marketplace',
      'circuit',
    ]);
    expect(buildMarketplaceInstallPlan(options)).toEqual([
      {
        id: 'marketplace_add_published',
        args: [
          'plugin',
          'marketplace',
          'add',
          'petekp/circuit',
          '--ref',
          'circuit--v0.1.2',
          '--json',
        ],
      },
      {
        id: 'plugin_install_published',
        args: ['plugin', 'add', 'circuit@circuit', '--json'],
      },
    ]);
  });

  it('rejects remote URLs that can carry credentials outside URL userinfo', () => {
    const base = [
      '--live',
      '--mode',
      'published',
      '--ref',
      'circuit--v0.1.2',
      '--expected-version',
      '0.1.2',
    ];
    expect(() =>
      parseSmokeOptions([...base, '--source', 'https://github.com/petekp/circuit?token=secret']),
    ).toThrow('--source must name a remote repository without credentials');
    expect(() =>
      parseSmokeOptions([...base, '--source', 'https://github.com/petekp/circuit#secret']),
    ).toThrow('--source must name a remote repository without credentials');
  });

  it('keeps ports and case when comparing exact remote sources', () => {
    expect(normalizeGitSource('https://example.com:8443/Owner/Circuit.git')).toBe(
      'example.com:8443/Owner/Circuit',
    );
    expect(normalizeGitSource('https://example.com/owner/circuit.git')).toBe(
      'example.com/owner/circuit',
    );
    expect(normalizeGitSource('https://example.com:8443/Owner/Circuit.git')).not.toBe(
      normalizeGitSource('https://example.com/owner/circuit.git'),
    );
  });

  it('rejects upgrade-only options in packed mode', () => {
    expect(() =>
      parseSmokeOptions(['--live', '--mode', 'packed', '--old-version', '0.1.1']),
    ).toThrow('packed mode does not accept');
  });

  it('enforces the supported Node and Codex floors', () => {
    expect(() => assertSupportedSmokeVersions('22.17.0', '0.144.3')).toThrow(
      'Node.js 22.18.0 or newer',
    );
    expect(() => assertSupportedSmokeVersions('22.18.0', '0.144.2')).toThrow(
      'Codex 0.144.3 or newer',
    );
    expect(() => assertSupportedSmokeVersions('22.18.0', '0.144.3')).not.toThrow();
    expect(() => assertSupportedSmokeVersions('24.0.0', '0.145.0')).not.toThrow();
  });

  it('replaces an immutable old marketplace ref before explicitly installing the new plugin', () => {
    const options = parseSmokeOptions([
      '--live',
      '--mode',
      'upgrade',
      '--source',
      'petekp/circuit',
      '--old-ref',
      'circuit--v0.1.1',
      '--old-version',
      '0.1.1',
      '--ref',
      'circuit--v0.1.2',
      '--expected-version',
      '0.1.2',
      '--marketplace',
      'circuit',
    ]);

    expect(buildMarketplaceInstallPlan(options)).toEqual([
      {
        id: 'marketplace_add_upgrade_old',
        args: [
          'plugin',
          'marketplace',
          'add',
          'petekp/circuit',
          '--ref',
          'circuit--v0.1.1',
          '--json',
        ],
      },
      {
        id: 'plugin_install_upgrade_old',
        args: ['plugin', 'add', 'circuit@circuit', '--json'],
      },
      {
        id: 'marketplace_remove_upgrade_old',
        args: ['plugin', 'marketplace', 'remove', 'circuit', '--json'],
      },
      {
        id: 'marketplace_add_upgrade_new',
        args: [
          'plugin',
          'marketplace',
          'add',
          'petekp/circuit',
          '--ref',
          'circuit--v0.1.2',
          '--json',
        ],
      },
      {
        id: 'plugin_install_upgrade_new',
        args: ['plugin', 'add', 'circuit@circuit', '--json'],
      },
    ]);

    expect(buildMarketplaceInstallPhases(options)).toEqual({
      beforeOldHost: [
        {
          id: 'marketplace_add_upgrade_old',
          args: [
            'plugin',
            'marketplace',
            'add',
            'petekp/circuit',
            '--ref',
            'circuit--v0.1.1',
            '--json',
          ],
        },
        {
          id: 'plugin_install_upgrade_old',
          args: ['plugin', 'add', 'circuit@circuit', '--json'],
        },
      ],
      afterOldHost: [
        {
          id: 'marketplace_remove_upgrade_old',
          args: ['plugin', 'marketplace', 'remove', 'circuit', '--json'],
        },
        {
          id: 'marketplace_add_upgrade_new',
          args: [
            'plugin',
            'marketplace',
            'add',
            'petekp/circuit',
            '--ref',
            'circuit--v0.1.2',
            '--json',
          ],
        },
        {
          id: 'plugin_install_upgrade_new',
          args: ['plugin', 'add', 'circuit@circuit', '--json'],
        },
      ],
    });
  });

  it('binds installed plugin bytes to the exact source tree, not only its version', () => {
    const root = mkdtempSync(join(tmpdir(), 'circuit-smoke-tree-binding-'));
    const source = join(root, 'source');
    const installed = join(root, 'installed');
    try {
      mkdirSync(join(source, '.codex-plugin'), { recursive: true });
      writeFileSync(
        join(source, '.codex-plugin', 'plugin.json'),
        '{"name":"circuit","version":"0.1.2"}\n',
      );
      writeFileSync(join(source, 'README.md'), 'source bytes\n');
      cpSync(source, installed, { recursive: true });

      expect(assertPluginTreeMatchesSource(source, installed, 'installed plugin')).toMatch(
        /^[a-f0-9]{64}$/,
      );

      writeFileSync(join(installed, 'README.md'), 'different bytes, same version\n');
      expect(() => assertPluginTreeMatchesSource(source, installed, 'installed plugin')).toThrow(
        'installed plugin tree does not match its verified source',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts an old host round only after a real provider request and natural cleanup', () => {
    const passing = {
      status: 0,
      stdout: '{"text":"OLD_CODEX_HOST_READY"}\n',
      stderr: '',
      timed_out: false,
      cleanup_confirmed: true,
      cleanup_intervention_required: false,
      cleanup_after_intervention_confirmed: true,
    } as const;

    expect(() => assertOldHostRoundSucceeded(passing, 1, undefined)).not.toThrow();
    expect(() => assertOldHostRoundSucceeded(passing, 0, undefined)).toThrow(
      'did not reach the loopback provider',
    );
    expect(() =>
      assertOldHostRoundSucceeded(
        { ...passing, cleanup_confirmed: false, cleanup_intervention_required: true },
        1,
        undefined,
      ),
    ).toThrow('cleanup could not be confirmed');
  });

  it('writes a private atomic report with transient paths and URL credentials redacted', () => {
    const root = mkdtempSync(join(tmpdir(), 'circuit-smoke-output-'));
    const output = join(root, 'evidence.json');
    try {
      writeSmokeOutput(
        output,
        {
          schema_version: 1,
          host: 'codex',
          surface: 'mcp',
          mode: 'published',
          status: 'fail',
          reason: `clone failed in ${root} for https://secret@example.com/petekp/circuit.git`,
          failure: { class: 'network', code: 'command_failed', retryable: true },
          versions: {},
          evidence: [],
        },
        [root],
      );

      const contents = readFileSync(output, 'utf8');
      expect(contents).not.toContain(root);
      expect(contents).not.toContain('secret');
      expect(contents).toContain('<redacted-path>');
      expect(contents).toContain('https://<redacted>@example.com');
      expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(readdirSync(root)).toEqual(['evidence.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes configuration failures to the requested output using the requested mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'circuit-smoke-config-output-'));
    const output = join(root, 'evidence.json');
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), 'scripts/hosts/smoke/codex-mcp.ts'),
          '--mode',
          'published',
          '--output',
          output,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        mode: 'published',
        status: 'fail',
        failure: { class: 'configuration', code: 'missing_arguments' },
      });
      expect(statSync(output).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('only marks classified network failures as retryable', () => {
    expect(classifySmokeFailure(new Error('Could not resolve host: github.com'))).toEqual({
      class: 'network',
      code: 'network_unavailable',
      retryable: true,
    });
    expect(
      classifySmokeFailure(new Error('Circuit tools did not match the public roster.')),
    ).toEqual({
      class: 'product',
      code: 'probe_failed',
      retryable: false,
    });
    expect(
      classifySmokeFailure(
        new Error("fatal: unable to access 'https://github.com/private/repo': 403 Forbidden"),
      ),
    ).toEqual({ class: 'product', code: 'probe_failed', retryable: false });
    expect(
      classifySmokeFailure(
        new Error('fatal: unable to access repository: SSL certificate problem'),
      ),
    ).toEqual({ class: 'product', code: 'probe_failed', retryable: false });
    expect(classifySmokeFailure(new Error('spawn node ENOENT'))).toEqual({
      class: 'dependency',
      code: 'node_missing',
      retryable: false,
      next_action:
        'Install Node.js 22.18 or newer, ensure node is on PATH, restart Codex, and try again.',
    });
  });

  it('retries only a classified published-mode network failure', () => {
    const retryable = {
      schema_version: 1,
      host: 'codex',
      surface: 'mcp',
      mode: 'published',
      status: 'fail',
      reason: 'network unavailable',
      failure: { class: 'network', code: 'network_unavailable', retryable: true },
      versions: {},
      evidence: [],
    };

    expect(isRetryablePublishedSmokeOutcome(retryable)).toBe(true);
    expect(isRetryablePublishedSmokeOutcome({ ...retryable, status: 'pass' })).toBe(false);
    expect(isRetryablePublishedSmokeOutcome({ ...retryable, mode: 'packed' })).toBe(false);
    expect(
      isRetryablePublishedSmokeOutcome({
        ...retryable,
        failure: { class: 'product', code: 'probe_failed', retryable: true },
      }),
    ).toBe(false);
    expect(
      isRetryablePublishedSmokeOutcome({
        ...retryable,
        failure: { class: 'network', code: 'network_unavailable', retryable: false },
      }),
    ).toBe(false);
    expect(isRetryablePublishedSmokeOutcome({ ...retryable, failure: undefined })).toBe(false);
    expect(isRetryablePublishedSmokeOutcome('not a report')).toBe(false);
  });

  it('does not count forced harness cleanup as product cleanup', async () => {
    const result = await runDetachedSmokeCommand(
      process.execPath,
      [
        '-e',
        "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();",
      ],
      process.env,
    );

    expect(result.status).toBe(0);
    expect(result.cleanup_confirmed).toBe(false);
    expect(result.cleanup_intervention_required).toBe(true);
    expect(result.cleanup_after_intervention_confirmed).toBe(true);
  });

  it('allows a bounded grace period for product children to exit naturally', async () => {
    const result = await runDetachedSmokeCommand(
      process.execPath,
      [
        '-e',
        "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},1200)'],{stdio:'ignore'});child.unref();",
      ],
      process.env,
      { natural_cleanup_timeout_ms: 2_500 },
    );

    expect(result.status).toBe(0);
    expect(result.cleanup_confirmed).toBe(true);
    expect(result.cleanup_intervention_required).toBe(false);
    expect(result.cleanup_after_intervention_confirmed).toBe(true);
  });

  it('does not hang when a timed-out command leaves an escaped process holding its pipes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'circuit-smoke-pipe-leak-'));
    const escapedPidPath = join(root, 'escaped.pid');
    const run = runDetachedSmokeCommand(
      process.execPath,
      [
        '-e',
        [
          "const {spawn}=require('node:child_process')",
          "const {writeFileSync}=require('node:fs')",
          "const escaped=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']})",
          'writeFileSync(process.argv[1],String(escaped.pid))',
          'escaped.unref()',
          'setInterval(()=>{},1000)',
        ].join(';'),
        escapedPidPath,
      ],
      process.env,
      { timeout_ms: 300, force_kill_delay_ms: 25, settlement_timeout_ms: 100 },
    );

    try {
      const settled = await Promise.race([
        run.then((result) => ({ kind: 'result' as const, result })),
        new Promise<{ readonly kind: 'hung' }>((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ kind: 'hung' }), 1_500),
        ),
      ]);

      expect(settled.kind).toBe('result');
      if (settled.kind === 'result') {
        expect(settled.result.timed_out).toBe(true);
        if (settled.result.cleanup_confirmed) {
          expect(settled.result.cleanup_intervention_required).toBe(false);
          expect(settled.result.cleanup_after_intervention_confirmed).toBe(true);
        } else {
          expect(settled.result.cleanup_intervention_required).toBe(true);
          expect(settled.result.cleanup_after_intervention_confirmed).toBe(false);
        }
      }
    } finally {
      if (statSync(escapedPidPath, { throwIfNoEntry: false }) !== undefined) {
        const escapedPid = Number(readFileSync(escapedPidPath, 'utf8'));
        try {
          process.kill(-escapedPid, 'SIGKILL');
        } catch {}
      }
      await run;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
