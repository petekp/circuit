import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve('.');
const VERSION = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, 'plugins/version.json'), 'utf8')) as {
    version: string;
  }
).version;

type DoctorOutput = {
  status: string;
  codex: {
    status: string;
    mcp: {
      status: string;
      manifest: { status: string; path: string; config_path?: string };
      config: { status: string; path: string; server_entrypoint?: string };
      runtime_files: {
        status: string;
        expected: string[];
        missing: string[];
        unsafe: string[];
      };
      private_state: {
        status: string;
        state_root: string;
        initialized: boolean;
        checked_directories: number;
        checked_files: number;
        violations: Array<{
          path: string;
          reason: string;
          expected_mode?: string;
          actual_mode?: string;
        }>;
      };
    };
  };
};

type Fixture = {
  root: string;
  home: string;
  codexHome: string;
  codexInstalledRoot: string;
  stateRoot: string;
};

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'circuit-installed-doctor-'));
  fixtures.push(root);
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const claudeInstalledRoot = join(
    home,
    '.claude',
    'plugins',
    'cache',
    'circuit',
    'circuit',
    VERSION,
  );
  const codexInstalledRoot = join(
    codexHome,
    'plugins',
    'cache',
    'circuit-local',
    'circuit',
    VERSION,
  );
  mkdirSync(dirname(claudeInstalledRoot), { recursive: true });
  mkdirSync(dirname(codexInstalledRoot), { recursive: true });
  cpSync(resolve(REPO_ROOT, 'plugins/claude'), claudeInstalledRoot, { recursive: true });
  cpSync(resolve(REPO_ROOT, 'plugins/codex'), codexInstalledRoot, { recursive: true });
  return {
    root,
    home,
    codexHome,
    codexInstalledRoot,
    stateRoot: join(codexHome, 'circuit', 'mcp', 'v1'),
  };
}

function runInstalledDoctor(input: Fixture): {
  status: number | null;
  stderr: string;
  output: DoctorOutput;
} {
  const result = spawnSync(process.execPath, ['scripts/plugins/installed-doctor.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: input.home,
      CODEX_HOME: input.codexHome,
      CIRCUIT_CLI: undefined,
      CIRCUIT_DEV: undefined,
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    output: JSON.parse(result.stdout) as DoctorOutput,
  };
}

function createPrivateState(input: Fixture): string {
  const runs = join(input.stateRoot, 'runs');
  const leases = join(input.stateRoot, 'leases');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  mkdirSync(leases, { mode: 0o700 });
  chmodSync(input.stateRoot, 0o700);
  chmodSync(runs, 0o700);
  chmodSync(leases, 0o700);
  const lease = join(leases, 'doctor-fixture.json');
  writeFileSync(lease, '{}\n', { mode: 0o600 });
  chmodSync(lease, 0o600);
  return lease;
}

describe('installed plugin doctor Codex MCP checks', () => {
  it('reports the active generated manifest, config, runtimes, and private state without a model turn', () => {
    const input = fixture();
    createPrivateState(input);

    const result = runInstalledDoctor(input);

    expect(result.status, result.stderr).toBe(0);
    expect(result.output.status).toBe('ok');
    expect(result.output.codex.mcp).toMatchObject({
      status: 'ok',
      manifest: {
        status: 'ok',
        path: join(input.codexInstalledRoot, '.codex-plugin', 'plugin.json'),
        config_path: join(input.codexInstalledRoot, '.mcp.json'),
      },
      config: {
        status: 'ok',
        path: join(input.codexInstalledRoot, '.mcp.json'),
        server_entrypoint: join(input.codexInstalledRoot, 'mcp', 'server.cjs'),
      },
      runtime_files: {
        status: 'ok',
        expected: ['mcp/server.cjs', 'mcp/server.mjs', 'mcp/supervisor.mjs', 'mcp/worker.mjs'],
        missing: [],
        unsafe: [],
      },
      private_state: {
        status: 'ok',
        state_root: input.stateRoot,
        initialized: true,
        checked_directories: 3,
        checked_files: 1,
        violations: [],
      },
    });
  }, 30_000);

  it('fails with the exact unsafe private state file instead of starting the MCP server', () => {
    const input = fixture();
    const lease = createPrivateState(input);
    chmodSync(lease, 0o644);

    const result = runInstalledDoctor(input);

    expect(result.status).toBe(1);
    expect(result.output.status).toBe('invalid');
    expect(result.output.codex.status).toBe('invalid');
    expect(result.output.codex.mcp.private_state).toMatchObject({
      status: 'invalid',
      initialized: true,
      violations: [
        {
          path: lease,
          reason: 'file_mode',
          expected_mode: '0600',
          actual_mode: '0644',
        },
      ],
    });
  }, 30_000);

  it('names broken MCP activation, config, and generated runtime files', () => {
    const input = fixture();
    const manifestPath = join(input.codexInstalledRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, mcpServers: './wrong-mcp.json' }, null, 2)}\n`,
    );
    const configPath = join(input.codexInstalledRoot, '.mcp.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: { circuit: Record<string, unknown> };
    };
    config.mcpServers.circuit.command = 'python';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    rmSync(join(input.codexInstalledRoot, 'mcp', 'supervisor.mjs'));

    const result = runInstalledDoctor(input);

    expect(result.status).toBe(1);
    expect(result.output.codex.mcp).toMatchObject({
      status: 'invalid',
      manifest: { status: 'invalid' },
      config: { status: 'invalid' },
      runtime_files: {
        status: 'invalid',
        missing: ['mcp/supervisor.mjs'],
        unsafe: [],
      },
      private_state: { status: 'not_initialized', initialized: false },
    });
  }, 30_000);
});
