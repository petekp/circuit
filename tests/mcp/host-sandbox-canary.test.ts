import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectorSubprocessResult } from '../../src/connectors/subprocess.js';
import {
  runCodexNestedSandboxCanary,
  runCodexToolSurfaceCanary,
} from '../../src/hosts/codex-mcp/host-sandbox-canary.js';
import type { RunMcpCodexSubprocessInput } from '../../src/hosts/codex-mcp/nested-codex-subprocess.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'circuit-host-sandbox-canary-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const tempRoot = join(root, 'control', 'private');
  const codexHome = join(root, 'control', 'codex-home');
  const sharedTempRoots = [join(root, 'shared-temp-a'), join(root, 'shared-temp-b')];
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(tempRoot, { recursive: true, mode: 0o700 }),
    ...sharedTempRoots.map(async (path) => await mkdir(path, { recursive: true, mode: 0o700 })),
  ]);
  const nodeExecutable = process.execPath;
  return {
    policy: {
      executable: '/trusted/codex',
      cliVersion: '0.144.3',
      workspace,
      tempRoot,
      nodeExecutable,
      nodeInstallationRoot: dirname(dirname(nodeExecutable)),
      gitExecutable: '/usr/bin/git',
      searchMode: 'off' as const,
      defaultModel: 'gpt-5.4',
      allowedModels: new Set(['gpt-5.4']),
    },
    codexHome,
    sharedTempRoots,
    environment: {
      PATH: '/usr/bin:/bin',
      CODEX_HOME: '/operator/.codex',
      OPENAI_API_KEY: 'host-secret',
      HTTPS_PROXY: 'https://host-proxy',
    },
  };
}

function result(stdout: string): ConnectorSubprocessResult {
  return {
    stdout,
    stderr: '',
    stdoutCapped: false,
    stderrCapped: false,
    timedOut: false,
    killGroupSucceeded: false,
    code: 0,
    signal: null,
    durationMs: 10,
  };
}

function toolSurfaceRunner(
  tools: readonly Record<string, unknown>[],
  leakProjectDoc = false,
): (invocation: RunMcpCodexSubprocessInput) => Promise<ConnectorSubprocessResult> {
  return async (invocation) => {
    if (!invocation.args.includes('features.shell_snapshot=false')) {
      throw new Error('shell snapshot was not disabled');
    }
    if (!invocation.args.includes('project_doc_max_bytes=0')) {
      throw new Error('project instructions were not disabled');
    }
    const provider = invocation.args.find((arg) =>
      arg.startsWith('model_providers.circuit_probe='),
    );
    const baseUrl = /base_url="(http:\/\/127\.0\.0\.1:\d+\/v1)"/.exec(provider ?? '')?.[1];
    if (baseUrl === undefined) throw new Error('missing local probe provider');
    const leakedProjectDoc = leakProjectDoc
      ? await readFile(join(invocation.cwd, 'AGENTS.md'), 'utf8')
      : undefined;
    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tools, instructions: leakedProjectDoc }),
    });
    await response.text();
    return result('{}\n');
  };
}

const BASE_TOOL_SURFACE = [
  'apply_patch',
  'exec_command',
  'request_user_input',
  'update_plan',
  'view_image',
  'write_stdin',
].map((name) => ({ type: 'function', name }));

const REQUIRED_MARKERS = [
  'AUTH_READ_DENIED',
  'ENV_CLEAN',
  'GIT_EXEC',
  'NETWORK_DENIED',
  'NODE_EXEC',
  'PRIVATE_WRITE',
  'SIBLING_READ_DENIED',
  'SYMLINK_READ_DENIED',
  'WORKSPACE_WRITE',
] as const;

const SHARED_TEMP_MARKERS = ['SHARED_TEMP_READ_DENIED', 'SHARED_TEMP_WRITE_DENIED'] as const;

function canaryMarkers(overrides: Readonly<Record<string, 'pass' | 'fail'>> = {}): string {
  return [...REQUIRED_MARKERS, ...SHARED_TEMP_MARKERS]
    .map((name) => `CIRCUIT_CANARY_${name}=${overrides[name] ?? 'pass'}`)
    .join('\n');
}

const PASS_MARKERS = canaryMarkers();

describe('Codex named sandbox canary', () => {
  it('uses the exact named profile with bounded output and a clean shell environment', async () => {
    const input = await fixture();
    let probeScript = '';
    const run = vi.fn(async (invocation: RunMcpCodexSubprocessInput) => {
      const script = invocation.args.at(-1);
      if (script === undefined) throw new Error('missing probe script');
      probeScript = await readFile(script, 'utf8');
      return result(PASS_MARKERS);
    });

    await expect(
      runCodexNestedSandboxCanary(input, {
        run,
        sharedTempRootCandidates: input.sharedTempRoots,
      }),
    ).resolves.toEqual({ shared_temp_isolation: 'isolated' });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: '/trusted/codex',
        timeoutMs: 10_000,
        stdoutMaxBytes: 1024 * 1024,
        args: expect.arrayContaining([
          'sandbox',
          '-P',
          'circuit_mcp',
          'default_permissions="circuit_mcp"',
          'shell_environment_policy.inherit="none"',
        ]),
        env: expect.objectContaining({
          CODEX_HOME: input.codexHome,
          CIRCUIT_CANARY_SECRET: 'canary-not-a-secret',
        }),
      }),
    );
    const invocation = run.mock.calls[0]?.[0];
    expect(invocation?.args).not.toContain('-s');
    expect(invocation?.args.some((arg) => arg.startsWith('sandbox_workspace_write.'))).toBe(false);
    expect(
      invocation?.args.some((arg) =>
        arg.startsWith('permissions.circuit_mcp.filesystem={":minimal"="read"'),
      ),
    ).toBe(true);
    expect(invocation?.env.OPENAI_API_KEY).toBe('canary-not-a-secret');
    expect(invocation?.env.HTTPS_PROXY).toBe('http://127.0.0.1:9');
    expect(invocation?.env.https_proxy).toBe('http://127.0.0.1:9');
    expect(invocation?.env.SSL_CERT_DIR).toBe('/outside/canary-certs');
    for (const name of [
      'CODEX_HOME',
      'CIRCUIT_CANARY_SECRET',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_ORGANIZATION',
      'OPENAI_PROJECT',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'no_proxy',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      expect(probeScript).toContain(`\${${name}+x}`);
    }
    for (const root of input.sharedTempRoots) {
      expect(probeScript).toContain(`${root}/.circuit-mcp-shared-read-`);
      expect(probeScript).toContain(`${root}/.circuit-mcp-shared-write-`);
    }
  });

  it.each([
    ['read', { SHARED_TEMP_READ_DENIED: 'fail' }],
    ['write', { SHARED_TEMP_WRITE_DENIED: 'fail' }],
    ['read and write', { SHARED_TEMP_READ_DENIED: 'fail', SHARED_TEMP_WRITE_DENIED: 'fail' }],
  ] as const)(
    'records shared temporary %s exposure without blocking the host',
    async (_label, overrides) => {
      const input = await fixture();
      await expect(
        runCodexNestedSandboxCanary(input, {
          run: async () => result(canaryMarkers(overrides)),
          sharedTempRootCandidates: input.sharedTempRoots,
        }),
      ).resolves.toEqual({ shared_temp_isolation: 'exposed' });
    },
  );

  it.each(REQUIRED_MARKERS)(
    'still fails closed when the required %s check fails',
    async (marker) => {
      const input = await fixture();
      await expect(
        runCodexNestedSandboxCanary(input, {
          run: async () => result(canaryMarkers({ [marker]: 'fail' })),
          sharedTempRootCandidates: input.sharedTempRoots,
        }),
      ).rejects.toThrow(/did not confine files/);
    },
  );

  it('fails closed when output omits a required marker', async () => {
    const input = await fixture();
    const missing = PASS_MARKERS.replace('CIRCUIT_CANARY_NODE_EXEC=pass\n', '');
    await expect(
      runCodexNestedSandboxCanary(input, {
        run: async () => result(missing),
        sharedTempRootCandidates: input.sharedTempRoots,
      }),
    ).rejects.toThrow(/canary|confine/i);
  });

  it('fails closed when output repeats a marker', async () => {
    const input = await fixture();
    await expect(
      runCodexNestedSandboxCanary(input, {
        run: async () => result(`${PASS_MARKERS}\nCIRCUIT_CANARY_NODE_EXEC=pass`),
        sharedTempRootCandidates: input.sharedTempRoots,
      }),
    ).rejects.toThrow(/repeated canary marker/);
  });

  it('fails closed when output adds an unknown marker', async () => {
    const input = await fixture();
    await expect(
      runCodexNestedSandboxCanary(input, {
        run: async () => result(`${PASS_MARKERS}\nCIRCUIT_CANARY_UNREVIEWED=pass`),
        sharedTempRootCandidates: input.sharedTempRoots,
      }),
    ).rejects.toThrow(/canary|confine/i);
  });

  it('fails closed instead of ignoring a malformed canary marker', async () => {
    const input = await fixture();
    await expect(
      runCodexNestedSandboxCanary(input, {
        run: async () => result(`${PASS_MARKERS}\nCIRCUIT_CANARY_UNREVIEWED=maybe`),
        sharedTempRootCandidates: input.sharedTempRoots,
      }),
    ).rejects.toThrow(/canary/i);
  });

  it('fails closed on timeout or uncertain process cleanup', async () => {
    const input = await fixture();
    await expect(
      runCodexNestedSandboxCanary(input, {
        run: async () => ({
          ...result(''),
          timedOut: true,
          timeoutKind: 'absolute',
          killGroupSucceeded: false,
        }),
        sharedTempRootCandidates: input.sharedTempRoots,
      }),
    ).rejects.toThrow(/could not prove/);
  });

  it("never uses or removes the operator's real Codex auth file", async () => {
    const input = await fixture();
    const operatorHome = join(dirname(input.codexHome), 'operator-codex-home');
    const operatorAuth = join(operatorHome, 'auth.json');
    await mkdir(operatorHome, { recursive: true, mode: 0o700 });
    await writeFile(operatorAuth, 'real-auth-must-survive\n', { mode: 0o600 });
    await symlink(operatorHome, input.codexHome, 'dir');
    const run = vi.fn(async () => result(PASS_MARKERS));

    await expect(
      runCodexNestedSandboxCanary(
        {
          ...input,
          environment: { ...input.environment, CODEX_HOME: operatorHome },
        },
        { run, sharedTempRootCandidates: input.sharedTempRoots },
      ),
    ).rejects.toThrow(/linked|Codex home/i);
    expect(run).not.toHaveBeenCalled();
    await expect(readFile(operatorAuth, 'utf8')).resolves.toBe('real-auth-must-survive\n');
  });

  it('rejects a probe path that exactly matches the configured Codex home', async () => {
    const input = await fixture();
    const run = vi.fn(async () => result(PASS_MARKERS));
    await expect(
      runCodexNestedSandboxCanary(
        {
          ...input,
          environment: { ...input.environment, CODEX_HOME: input.codexHome },
        },
        { run, sharedTempRootCandidates: input.sharedTempRoots },
      ),
    ).rejects.toThrow(/operator's Codex home/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts only a cached web-search wire shape with external access disabled', async () => {
    const input = await fixture();
    const cachedInput = {
      ...input,
      policy: { ...input.policy, searchMode: 'cached' as const },
    };
    await expect(
      runCodexToolSurfaceCanary(cachedInput, {
        run: toolSurfaceRunner([
          ...BASE_TOOL_SURFACE,
          { type: 'web_search', external_web_access: false },
        ]),
      }),
    ).resolves.toBeUndefined();
    await expect(
      runCodexToolSurfaceCanary(cachedInput, {
        run: toolSurfaceRunner([
          ...BASE_TOOL_SURFACE,
          {
            type: 'web_search',
            external_web_access: false,
            search_content_types: ['text', 'image'],
          },
        ]),
      }),
    ).resolves.toBeUndefined();

    await expect(
      runCodexToolSurfaceCanary(cachedInput, {
        run: toolSurfaceRunner([
          ...BASE_TOOL_SURFACE,
          { type: 'web_search', external_web_access: true },
        ]),
      }),
    ).rejects.toThrow(/tool surface changed/i);
  });

  it('fails closed on an unknown cached-search wire field', async () => {
    const input = await fixture();
    await expect(
      runCodexToolSurfaceCanary(
        {
          ...input,
          policy: { ...input.policy, searchMode: 'cached' as const },
        },
        {
          run: toolSurfaceRunner([
            ...BASE_TOOL_SURFACE,
            {
              type: 'web_search',
              external_web_access: false,
              indexed_web_access: true,
            },
          ]),
        },
      ),
    ).rejects.toThrow(/tool surface changed/i);
  });

  it('fails closed if Codex follows the canary AGENTS.md symlink outside the workspace', async () => {
    const input = await fixture();
    await expect(
      runCodexToolSurfaceCanary(input, {
        run: toolSurfaceRunner(BASE_TOOL_SURFACE, true),
      }),
    ).rejects.toThrow(/project instructions outside/i);
  });
});
