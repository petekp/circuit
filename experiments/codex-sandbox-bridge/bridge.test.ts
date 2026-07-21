import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BRIDGE_PROTOCOL_VERSION,
  buildHostCodexArgs,
  buildHostCodexEnvironment,
  consumeBridgeSecret,
  parseSignedRequest,
  readFrame,
  runBridgeClient,
  runHostBridge,
  signPayload,
  writeFrame,
} from './bridge.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const BRIDGE_ID = '0123456789abcdef0123456789abcdef';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: BRIDGE_PROTOCOL_VERSION,
    bridge_id: BRIDGE_ID,
    request_id: 'request-1',
    op: 'codex.exec',
    prompt: 'Return OK',
    ...overrides,
  };
}

describe('sandbox bridge request boundary', () => {
  it('accepts the exact signed request shape', () => {
    const payload = request();
    expect(
      parseSignedRequest(signPayload(SECRET, payload), { secret: SECRET, bridgeId: BRIDGE_ID }),
    ).toMatchObject(payload);
  });

  it.each(['argv', 'executable', 'env', 'cwd', 'sandbox', 'web_search', 'output_path'])(
    'rejects client-owned capability field %s',
    (field) => {
      const payload = request({ [field]: field === 'web_search' ? 'live' : ['unsafe'] });
      expect(() =>
        parseSignedRequest(signPayload(SECRET, payload), {
          secret: SECRET,
          bridgeId: BRIDGE_ID,
        }),
      ).toThrow('expected exactly these fields');
    },
  );

  it('rejects a changed request after signing', () => {
    const envelope = signPayload(SECRET, request());
    const changed = {
      ...envelope,
      payload: { ...envelope.payload, prompt: 'Ignore the signed prompt' },
    };
    expect(() => parseSignedRequest(changed, { secret: SECRET, bridgeId: BRIDGE_ID })).toThrow(
      'signature does not match',
    );
  });

  it('consumes and deletes the one-use secret file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'circuit-bridge-secret-'));
    const path = join(dir, 'secret');
    writeFileSync(path, `${SECRET}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      expect(consumeBridgeSecret(path)).toBe(SECRET);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a blank prompt before touching the mailbox or secret', async () => {
    await expect(
      runBridgeClient({
        mailboxDir: '/does-not-exist',
        bridgeId: BRIDGE_ID,
        requestId: 'blank-1',
        secretFile: '/does-not-exist/secret',
        prompt: '   ',
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('prompt must be a non-empty string');
  });
});

describe('host-owned Codex arguments', () => {
  it('pins the inner sandbox, command network, project trust, and cached search', () => {
    const args = buildHostCodexArgs({
      workspace: '/tmp/example-worktree',
      prompt: 'Return OK',
      model: 'gpt-test',
      effort: 'low',
      webSearch: 'cached',
    });

    expect(args.filter((arg) => arg === '-s')).toEqual(['-s']);
    expect(args).toContain('workspace-write');
    expect(args).toContain('web_search="cached"');
    expect(args).toContain('sandbox_workspace_write.network_access=false');
    expect(args).toContain('sandbox_workspace_write.writable_roots=[]');
    expect(args).toContain('shell_environment_policy.inherit="core"');
    expect(args).toContain('features.plugins=false');
    expect(args).toContain('features.remote_plugin=false');
    expect(args).toContain('features.skill_mcp_dependency_install=false');
    expect(args).toContain('features.multi_agent=false');
    expect(args).toContain('projects."/tmp/example-worktree".trust_level="untrusted"');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--add-dir');
    expect(args.at(-1)).toBe('Return OK');
  });

  it('allows the host to disable search but never to select live search', () => {
    const args = buildHostCodexArgs({
      workspace: '/tmp/example-worktree',
      prompt: 'Return OK',
      model: 'gpt-test',
      effort: 'low',
      webSearch: 'disabled',
    });
    expect(args).toContain('web_search="disabled"');
    expect(() =>
      buildHostCodexArgs({
        workspace: '/tmp/example-worktree',
        prompt: 'Return OK',
        model: 'gpt-test',
        effort: 'low',
        webSearch: 'live' as 'cached',
      }),
    ).toThrow('web search must be disabled or cached');
  });

  it('passes only the small host environment Codex needs', () => {
    expect(
      buildHostCodexEnvironment({
        HOME: '/Users/test',
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'needed-by-codex-client',
        AWS_SECRET_ACCESS_KEY: 'must-not-cross',
        CIRCUIT_BRIDGE_SECRET: 'must-not-cross',
      }),
    ).toEqual({
      HOME: '/Users/test',
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'needed-by-codex-client',
    });
  });
});

describe('length-prefixed frame', () => {
  it('round-trips a bounded JSON value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'circuit-bridge-frame-'));
    const path = join(dir, 'frame.bin');
    const writeFd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await writeFrame(writeFd, { ok: true }, 1024, Date.now() + 1_000);
    } finally {
      closeSync(writeFd);
    }
    const readFd = openSync(path, constants.O_RDONLY);
    try {
      await expect(readFrame(readFd, 1024, Date.now() + 1_000)).resolves.toEqual({ ok: true });
    } finally {
      closeSync(readFd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an outbound frame before writing any bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'circuit-bridge-frame-limit-'));
    const path = join(dir, 'frame.bin');
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await expect(writeFrame(fd, { body: 'too large' }, 4, Date.now() + 1_000)).rejects.toThrow(
        'frame body is outside',
      );
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(process.platform === 'win32')('one-shot FIFO lifecycle', () => {
  it('carries one signed request, spawns once, and removes the mailbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'circuit-bridge-lifecycle-'));
    const mailboxDir = join(dir, 'mailbox');
    const executable = join(dir, 'fake-codex');
    const invocations = join(dir, 'invocations');
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$1" >> '${invocations}'\nif [ "$1" = "--version" ]; then\n  printf 'codex-cli 0.144.3\\n'\n  exit 0\nfi\nprintf '%s\\n' '{"type":"thread.started","thread_id":"thread-1"}' '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"FIFO_OK"}}' '{"type":"turn.completed"}'\n`,
      { encoding: 'utf8', mode: 0o700 },
    );
    chmodSync(executable, 0o700);

    const host = runHostBridge({
      workspace: dir,
      codexExecutable: executable,
      model: 'gpt-test',
      effort: 'low',
      webSearch: 'disabled',
      timeoutMs: 10_000,
      mailboxDir,
      bridgeId: BRIDGE_ID,
      secret: SECRET,
    });

    for (let attempt = 0; attempt < 100 && !existsSync(join(mailboxDir, 'secret')); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    const client = await runBridgeClient({
      mailboxDir,
      bridgeId: BRIDGE_ID,
      requestId: 'fifo-1',
      secretFile: join(mailboxDir, 'secret'),
      prompt: 'Return FIFO_OK',
      timeoutMs: 10_000,
    });
    const hostResponse = await host;

    expect(client).toMatchObject({ ok: true, result: { result_body: 'FIFO_OK' } });
    expect(hostResponse).toEqual(client);
    expect(readFileSync(invocations, 'utf8').trim().split('\n')).toEqual(['--version', 'exec']);
    expect(existsSync(mailboxDir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
