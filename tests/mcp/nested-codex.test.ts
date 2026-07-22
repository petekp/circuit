import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectorSubprocessResult } from '../../src/connectors/subprocess.js';
import {
  MCP_CODEX_STDERR_LIMIT_BYTES,
  MCP_CODEX_STDOUT_LIMIT_BYTES,
  buildMcpCodexArgs,
  createMcpCodexRelayer,
  safeMcpCodexEnvironment,
} from '../../src/hosts/codex-mcp/nested-codex.js';

const roots: string[] = [];

async function privateTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'circuit-mcp-codex-'));
  roots.push(root);
  await mkdir(join(root, 'schemas'), { mode: 0o700 });
  return root;
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    executable: '/opt/codex/bin/codex',
    cliVersion: 'codex-cli 0.144.3',
    workspace: '/repo',
    tempRoot: '/private/tmp/circuit-run',
    nodeExecutable: '/opt/node/bin/node',
    nodeInstallationRoot: '/opt/node',
    gitExecutable: '/usr/bin/git',
    searchMode: 'off' as const,
    defaultModel: 'gpt-5.1-codex-mini',
    allowedModels: new Set(['gpt-5.1-codex-mini', 'gpt-5.2-codex']),
    ...overrides,
  };
}

function successfulProcess(stdout: string): ConnectorSubprocessResult {
  return {
    stdout,
    stderr: '',
    stdoutCapped: false,
    stderrCapped: false,
    timedOut: false,
    killGroupSucceeded: false,
    code: 0,
    signal: null,
    durationMs: 25,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MCP nested Codex policy', () => {
  it('pins a named minimal sandbox, sealed shell environment, external tools, and disabled search', () => {
    const args = buildMcpCodexArgs(
      {
        prompt: 'repair the test',
        resolvedSelection: {
          model: { provider: 'openai', model: 'gpt-5.2-codex' },
          effort: 'low',
          skills: [],
          invocation_options: {},
        },
      },
      policy(),
    );

    expect(args.slice(0, 8)).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--cd',
    ]);
    expect(args).toEqual(
      expect.arrayContaining([
        'default_permissions="circuit_mcp"',
        'permissions.circuit_mcp.filesystem={":minimal"="read",":workspace_roots"="write",":slash_tmp"="deny","/private/tmp/circuit-run"="write","/opt/node"="read","/System/Library/OpenSSL"="read","/usr/bin/git"="read"}',
        'permissions.circuit_mcp.network.enabled=false',
        'allow_login_shell=false',
        'project_doc_max_bytes=0',
        'shell_environment_policy.inherit="none"',
        'shell_environment_policy.set.PATH="/opt/node/bin:/usr/bin:/bin"',
        'shell_environment_policy.set.HOME="/private/tmp/circuit-run/nested-home"',
        'shell_environment_policy.set.TMPDIR="/private/tmp/circuit-run/nested-tmp"',
        'shell_environment_policy.set.TMP="/private/tmp/circuit-run/nested-tmp"',
        'shell_environment_policy.set.TEMP="/private/tmp/circuit-run/nested-tmp"',
        'shell_environment_policy.set.LANG="C"',
        'shell_environment_policy.set.LC_ALL="C"',
        'shell_environment_policy.set.TERM="dumb"',
        'features.apps=false',
        'features.auth_elicitation=false',
        'features.browser_use=false',
        'features.browser_use_external=false',
        'features.browser_use_full_cdp_access=false',
        'features.computer_use=false',
        'features.hooks=false',
        'features.image_generation=false',
        'features.in_app_browser=false',
        'features.memories=false',
        'features.multi_agent=false',
        'features.plugin_sharing=false',
        'features.plugins=false',
        'features.remote_plugin=false',
        'features.shell_snapshot=false',
        'features.shell_tool=true',
        'features.skill_mcp_dependency_install=false',
        'features.tool_call_mcp_elicitation=false',
        'features.workspace_dependencies=false',
        'mcp_servers={}',
        'web_search="disabled"',
      ]),
    );
    expect(args).not.toContain('-s');
    expect(args.some((arg) => arg.startsWith('sandbox_workspace_write.'))).toBe(false);
    expect(
      args.some((arg) => /codex_hooks|plugin_hooks|memory_tool|external_agent_memory/.test(arg)),
    ).toBe(false);
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('puts the pinned developer Git ahead of the Apple shim in the worker shell', () => {
    const args = buildMcpCodexArgs(
      { prompt: 'inspect git state' },
      policy({
        gitExecutable: '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
      }),
    );

    expect(args).toEqual(
      expect.arrayContaining([
        'permissions.circuit_mcp.filesystem={":minimal"="read",":workspace_roots"="write",":slash_tmp"="deny","/private/tmp/circuit-run"="write","/opt/node"="read","/System/Library/OpenSSL"="read","/Applications/Xcode.app/Contents/Developer"="read","/Applications/Xcode.app/Contents/Developer/usr/bin/git"="read"}',
        'shell_environment_policy.set.PATH="/opt/node/bin:/Applications/Xcode.app/Contents/Developer/usr/bin:/usr/bin:/bin"',
      ]),
    );
  });

  it('quotes adversarial dynamic TOML paths without creating another assignment', () => {
    const args = buildMcpCodexArgs(
      { prompt: 'test' },
      policy({
        workspace: '/repo/quote"\nnext = true',
        tempRoot: '/private/run\\line\n[features]\napps = true',
        nodeExecutable: '/node root/quote"\nfeatures.apps=true/bin/node',
        nodeInstallationRoot: '/node root/quote"\nfeatures.apps=true',
      }),
    );
    const config = args.filter((_arg, index) => args[index - 1] === '-c');
    expect(config).toContain(
      'permissions.circuit_mcp.filesystem={":minimal"="read",":workspace_roots"="write",":slash_tmp"="deny","/private/run\\\\line\\n[features]\\napps = true"="write","/node root/quote\\"\\nfeatures.apps=true"="read","/System/Library/OpenSSL"="read","/usr/bin/git"="read"}',
    );
    expect(config.filter((arg) => arg === 'features.apps=false')).toHaveLength(1);
  });

  it('enables only cached search when the start contract already recorded consent', () => {
    const args = buildMcpCodexArgs({ prompt: 'research this' }, policy({ searchMode: 'cached' }));
    expect(args).toContain('web_search="cached"');
    expect(args).not.toContain('web_search="live"');
  });

  it.each([
    [{ provider: 'anthropic' as const, model: 'claude' }, 'provider'],
    [{ provider: 'openai' as const, model: 'unknown-model' }, 'roster'],
  ])('rejects an unsupported selected model before spawn', (model, message) => {
    expect(() =>
      buildMcpCodexArgs(
        {
          prompt: 'test',
          resolvedSelection: { model, skills: [], invocation_options: {} },
        },
        policy(),
      ),
    ).toThrow(message);
  });

  it.each(['none', 'minimal', 'max'] as const)(
    'rejects unsupported effort %s before spawn',
    (effort) => {
      expect(() =>
        buildMcpCodexArgs(
          {
            prompt: 'test',
            resolvedSelection: {
              effort,
              skills: [],
              invocation_options: {},
            },
          },
          policy(),
        ),
      ).toThrow('supported effort');
    },
  );

  it('keeps the ordinary connector output limits and passes only transient host values', () => {
    expect(MCP_CODEX_STDOUT_LIMIT_BYTES).toBe(16 * 1024 * 1024);
    expect(MCP_CODEX_STDERR_LIMIT_BYTES).toBe(1024 * 1024);
    expect(
      safeMcpCodexEnvironment({
        PATH: '/bin',
        CODEX_HOME: '/home/operator/.codex',
        OPENAI_API_KEY: 'secret',
        HTTPS_PROXY: 'https://proxy',
        SSL_CERT_FILE: '/certs/ca.pem',
        NODE_OPTIONS: '--require /tmp/hostile.js',
        DYLD_INSERT_LIBRARIES: '/tmp/hostile.dylib',
        CIRCUIT_MCP_PROOF_RUNNER: '/tmp/ambient',
      }),
    ).toEqual({
      PATH: '/bin',
      CODEX_HOME: '/home/operator/.codex',
      OPENAI_API_KEY: 'secret',
      HTTPS_PROXY: 'https://proxy',
      SSL_CERT_FILE: '/certs/ca.pem',
    });
  });

  it('uses the pinned executable and parses the reviewed JSONL protocol', async () => {
    const tempRoot = await privateTempRoot();
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: '{"ok":true}' },
      }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n');
    const run = vi.fn(async () => successfulProcess(stdout));
    const relayer = createMcpCodexRelayer(policy({ workspace: tempRoot, tempRoot }), {
      run,
      environment: { PATH: '/bin', CODEX_HOME: '/home/.codex', TMPDIR: '/host/tmp' },
    });

    await expect(relayer.relay({ prompt: 'return json' })).resolves.toMatchObject({
      receipt_id: 'thread-1',
      result_body: '{"ok":true}',
      cli_version: 'codex-cli 0.144.3',
      model: 'gpt-5.1-codex-mini',
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: '/opt/codex/bin/codex',
        cwd: tempRoot,
        stdoutMaxBytes: MCP_CODEX_STDOUT_LIMIT_BYTES,
        stderrMaxBytes: MCP_CODEX_STDERR_LIMIT_BYTES,
        env: { PATH: '/bin', CODEX_HOME: '/home/.codex', TMPDIR: tempRoot },
      }),
    );
    await expect(
      Promise.all([stat(join(tempRoot, 'nested-home')), stat(join(tempRoot, 'nested-tmp'))]),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ mode: expect.any(Number) })]),
    );
  });

  it('fails closed on truncated output, timeouts, and nonzero exits', async () => {
    const base = successfulProcess('');
    for (const result of [
      { ...base, stdoutCapped: true },
      { ...base, timedOut: true, timeoutKind: 'absolute' as const },
      { ...base, code: 1 },
    ]) {
      const relayer = createMcpCodexRelayer(policy(), {
        run: async () => result,
        environment: {},
      });
      await expect(relayer.relay({ prompt: 'test' })).rejects.toThrow();
    }
  });
});
