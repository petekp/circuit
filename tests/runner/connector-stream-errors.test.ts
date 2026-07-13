import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lastStreamErrorMessage } from '../../src/connectors/subprocess.js';

// R3 — fatal model-id (and other in-stream) errors must not be truncated away.
//
// A failed stream-json relay used to embed only the FIRST ~500 bytes of stdout
// in the relay error. For stream-json output that head is the init handshake,
// so the actual error — an error-typed stream event near the END — was cut
// off. These tests pin the fix: the connectors scan the captured stdout for
// the LAST error-typed stream event and surface THAT message first.

describe('lastStreamErrorMessage', () => {
  it('returns undefined for a clean stream', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'result', is_error: false, result: 'ok' }),
    ].join('\n');
    expect(lastStreamErrorMessage(stdout)).toBeUndefined();
  });

  it('picks the LAST error-typed event, not the first', () => {
    const stdout = [
      JSON.stringify({ type: 'error', message: 'first error' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'error', message: 'the terminal error' }),
    ].join('\n');
    expect(lastStreamErrorMessage(stdout)).toBe('the terminal error');
  });

  it('reads a claude-code error event whose message nests under error.message', () => {
    const stdout = JSON.stringify({
      type: 'error',
      error: { type: 'not_found_error', message: 'model: claude-nope-9 not found' },
    });
    expect(lastStreamErrorMessage(stdout)).toBe('model: claude-nope-9 not found');
  });

  it('reads a claude-code result event flagged is_error', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Not logged in - Please run /login',
      }),
    ].join('\n');
    expect(lastStreamErrorMessage(stdout)).toBe('Not logged in - Please run /login');
  });

  it('reads codex turn.failed and top-level error events', () => {
    expect(
      lastStreamErrorMessage(JSON.stringify({ type: 'turn.failed', error: 'stream disconnected' })),
    ).toBe('stream disconnected');
    expect(
      lastStreamErrorMessage(
        JSON.stringify({ type: 'error', message: '400 model gpt-nope-1 is not supported' }),
      ),
    ).toBe('400 model gpt-nope-1 is not supported');
  });

  it('reads a codex nested error item', () => {
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'error', message: 'sandbox denied the write' },
    });
    expect(lastStreamErrorMessage(stdout)).toBe('sandbox denied the write');
  });

  it('skips lines that are not valid JSON instead of aborting the scan', () => {
    const stdout = ['not json at all {', JSON.stringify({ type: 'error', message: 'real' })].join(
      '\n',
    );
    expect(lastStreamErrorMessage(stdout)).toBe('real');
  });
});

// End-to-end: the terminal stream error must lead the relay error even when
// the stdout head is hundreds of bytes of init JSON.

let fakeBinDir: string;
let originalPath: string | undefined;
let originalCodexHome: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  fakeBinDir = await mkdtemp(join(tmpdir(), 'circuit-stream-error-'));
  originalPath = process.env.PATH;
  originalCodexHome = process.env.CODEX_HOME;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalCodexHome === undefined) {
    Reflect.deleteProperty(process.env, 'CODEX_HOME');
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  await rm(fakeBinDir, { recursive: true, force: true });
});

async function installFakeCli(name: string, script: string): Promise<void> {
  const path = join(fakeBinDir, name);
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;
}

async function messageFrom(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the relay to reject');
}

describe('stream errors lead the relay error end-to-end', () => {
  it('claude-code: a bad-model error at the stream end is surfaced before the stdout head', async () => {
    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'session-model-error',
      claude_code_version: '2.1.150',
      mcp_servers: [],
      slash_commands: [],
      padding: 'x'.repeat(800),
    });
    const errorEvent = JSON.stringify({
      type: 'error',
      error: { type: 'not_found_error', message: 'model: claude-nope-9 not found' },
    });
    await installFakeCli(
      'claude',
      ['#!/bin/sh', `printf '%s\\n' '${init}'`, `printf '%s\\n' '${errorEvent}'`, 'exit 1'].join(
        '\n',
      ),
    );
    const { relayClaudeCode } = await import('../../src/connectors/claude-code.js');

    const message = await messageFrom(
      relayClaudeCode({ prompt: 'relay with a bad model id', timeoutMs: 10_000 }),
    );

    expect(message).toContain('The claude CLI reported an error: model: claude-nope-9 not found.');
    // The terminal stream error appears BEFORE the raw stdout head, so the
    // init handshake padding can no longer push it out of view.
    expect(message.indexOf('model: claude-nope-9 not found')).toBeLessThan(
      message.indexOf('stdout[:500]='),
    );
    expect(message).toContain('claude-code subprocess exited with code 1');
  });

  it('codex: a bad-model error is surfaced first, with a local models-cache hint', async () => {
    // A models cache that does NOT contain the pinned model: the hint can be
    // validated entirely locally, no network.
    const codexHome = join(fakeBinDir, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [{ slug: 'gpt-5.4', visibility: 'list', supported_in_api: true, priority: 0 }],
      }),
      'utf8',
    );
    process.env.CODEX_HOME = codexHome;

    const threadStarted = JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' });
    const errorEvent = JSON.stringify({
      type: 'error',
      message: 'unexpected status 400 Bad Request: model gpt-nope-1 is not supported',
    });
    await installFakeCli(
      'codex',
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0"; exit 0; fi',
        `printf '%s\\n' '${threadStarted}'`,
        `printf '%s\\n' '${errorEvent}'`,
        'exit 1',
      ].join('\n'),
    );
    const { relayCodex } = await import('../../src/connectors/codex.js');

    const message = await messageFrom(
      relayCodex({
        prompt: 'relay with a bad model id',
        timeoutMs: 10_000,
        resolvedSelection: {
          model: { provider: 'openai', model: 'gpt-nope-1' },
          skills: [],
          invocation_options: {},
        },
      }),
    );

    expect(message).toContain(
      'The codex CLI reported an error: unexpected status 400 Bad Request: model gpt-nope-1 is not supported.',
    );
    expect(message).toContain("The model id 'gpt-nope-1' is not in the local Codex models cache");
    expect(message.indexOf('model gpt-nope-1 is not supported')).toBeLessThan(
      message.indexOf('stdout[:500]='),
    );
    expect(message).toContain('codex subprocess exited with code 1');
  });

  it('codex: the cache hint stays silent when the pinned model IS in the cache', async () => {
    const codexHome = join(fakeBinDir, 'codex-home-known');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [{ slug: 'gpt-5.4', visibility: 'list', supported_in_api: true, priority: 0 }],
      }),
      'utf8',
    );
    process.env.CODEX_HOME = codexHome;

    const threadStarted = JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' });
    const errorEvent = JSON.stringify({
      type: 'error',
      message: 'model backend rejected the request',
    });
    await installFakeCli(
      'codex',
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0"; exit 0; fi',
        `printf '%s\\n' '${threadStarted}'`,
        `printf '%s\\n' '${errorEvent}'`,
        'exit 1',
      ].join('\n'),
    );
    const { relayCodex } = await import('../../src/connectors/codex.js');

    const message = await messageFrom(
      relayCodex({
        prompt: 'relay with a healthy model id',
        timeoutMs: 10_000,
        resolvedSelection: {
          model: { provider: 'openai', model: 'gpt-5.4' },
          skills: [],
          invocation_options: {},
        },
      }),
    );

    expect(message).toContain(
      'The codex CLI reported an error: model backend rejected the request.',
    );
    expect(message).not.toContain('is not in the local Codex models cache');
  });
});
