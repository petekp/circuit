import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
  it('pins the sandbox, approvals, configuration, history, plugins, and disabled search', () => {
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

    expect(args).toEqual([
      'exec',
      '--json',
      '-s',
      'workspace-write',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--cd',
      '/repo',
      '-c',
      'approval_policy="never"',
      '-c',
      'history.persistence="none"',
      '-c',
      'features.plugins=false',
      '-c',
      'features.hooks=false',
      '-c',
      'features.codex_hooks=false',
      '-c',
      'features.plugin_hooks=false',
      '-c',
      'mcp_servers={}',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      'sandbox_workspace_write.writable_roots=[]',
      '-c',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      '-c',
      'sandbox_workspace_write.exclude_tmpdir_env_var=false',
      '-c',
      'web_search="disabled"',
      '-m',
      'gpt-5.2-codex',
      '-c',
      'model_reasoning_effort="low"',
      'repair the test',
    ]);
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
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
        detached: false,
        env: { PATH: '/bin', CODEX_HOME: '/home/.codex', TMPDIR: tempRoot },
      }),
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
