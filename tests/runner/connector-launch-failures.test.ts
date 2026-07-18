import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  condenseRepeatedLines,
  connectorFailureSummary,
  launchFailureSummary,
} from '../../src/connectors/subprocess.js';

// R1 — connector launch failures must be legible.
//
// When a connector CLI fails at launch, the operator used to see raw stderr
// spew (sandbox-denial WARN storms), a buried "Not logged in", or a bare Node
// ENOENT. These tests pin the fix: every launch-failure error LEADS with one
// plain sentence naming what happened and the fix, and keeps the raw detail
// AFTER that sentence — truncated, never instead of it.
//
// The interpreter lives in src/connectors/subprocess.ts (the shared subprocess
// seam) so all three CLI-agent connectors use one implementation.

describe('launchFailureSummary (spawn-phase interpreter)', () => {
  it('names a missing CLI in plain English for ENOENT', () => {
    const summary = launchFailureSummary('codex', 'spawn codex ENOENT');
    expect(summary).toBe(
      'The codex CLI is not installed or not on your PATH (spawn ENOENT). Run `circuit doctor` to check connector health.',
    );
  });

  it('names a permission problem for EACCES', () => {
    const summary = launchFailureSummary('claude', 'spawn claude EACCES');
    expect(summary).toContain('The claude CLI was found but cannot be executed (EACCES).');
    expect(summary).toContain('circuit doctor');
  });

  it('falls back to a plain failed-to-start sentence for unknown spawn errors', () => {
    const summary = launchFailureSummary('cursor-agent', 'spawn EAGAIN');
    expect(summary).toBe(
      'The cursor-agent CLI failed to start. Run `circuit doctor` to check connector health.',
    );
  });
});

describe('connectorFailureSummary (captured-output interpreter)', () => {
  it('leads with a not-logged-in sentence when stderr says so', () => {
    const summary = connectorFailureSummary({
      cli: 'codex',
      signInHint: 'Run `codex login` to sign in',
      stderr: 'ERROR: Not logged in\n',
      stdout: '',
      streamError: undefined,
    });
    expect(summary).toBe(
      'The codex CLI is not logged in. Run `codex login` to sign in, or run `circuit doctor` to check connector health.',
    );
  });

  it('detects sign-in problems reported through a stream error instead of stderr', () => {
    const summary = connectorFailureSummary({
      cli: 'claude',
      signInHint: 'Run `claude` once to sign in',
      stderr: '',
      stdout: '',
      streamError: 'Not logged in - Please run /login',
    });
    expect(summary).toContain('The claude CLI is not logged in.');
    expect(summary).toContain('Run `claude` once to sign in');
  });

  it('names a sandbox denial storm and surfaces the real failure line drowned by it', () => {
    const warn = 'WARN codex_core: Operation not permitted (os error 1)';
    const stderr = `${Array(10).fill(warn).join('\n')}\nERROR: failed to create session directory\n`;
    const summary = connectorFailureSummary({
      cli: 'codex',
      signInHint: 'Run `codex login` to sign in',
      stderr,
      stdout: '',
      streamError: undefined,
    });
    expect(summary).toContain(
      'The codex CLI was blocked by this machine\'s sandbox (10 "Operation not permitted" errors).',
    );
    expect(summary).toContain('Last error: "ERROR: failed to create session directory"');
    expect(summary).toContain('circuit doctor');
  });

  // Verbatim stderr from a real failed run (e9a0f62a, 2026-07-16): Circuit was
  // launched inside a sandboxed host session, codex could not write
  // ~/.codex/state_5.sqlite, and died ~2s in. Only 2 "Operation not permitted"
  // lines appear, below the denial-storm threshold, so this class needs its
  // own signature.
  const READONLY_STATE_DB_STDERR = [
    'WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)',
    '2026-07-16T17:31:59.179476Z  WARN codex_state::runtime: failed to open state db at /Users/petepetrash/.codex/state_5.sqlite: failed to open state DB at /Users/petepetrash/.codex/state_5.sqlite: error returned from database: (code: 8) attempt to write a readonly database',
    '2026-07-16T17:31:59.179520Z  WARN codex_rollout::state_db: failed to initialize state runtime: failed to initialize state runtime at /Users/petepetrash/.codex: failed to open state DB at /Users/petepetrash/.codex/state_5.sqlite: error returned from database: (code: 8) attempt to write a readonly database: error returned from database: (code: 8) attempt to write a readonly database: (code: 8) attempt to write a readonly database',
    'Reading additional input from stdin...',
    'Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)',
    '',
  ].join('\n');

  it('names an unwritable codex state directory from the readonly-database signature', () => {
    const summary = connectorFailureSummary({
      cli: 'codex',
      signInHint: 'Run `codex login` to sign in',
      stderr: READONLY_STATE_DB_STDERR,
      stdout: '',
      streamError: undefined,
    });
    expect(summary).toContain(
      'The codex CLI could not write its state directory (/Users/petepetrash/.codex).',
    );
    expect(summary).toContain('setup problem, not a task failure');
    expect(summary).toContain('sandbox');
    expect(summary).toContain('circuit doctor');
  });

  it('prefers the state-directory diagnosis over the denial-storm one when both appear', () => {
    const storm = Array(5).fill('WARN codex_core: Operation not permitted (os error 1)').join('\n');
    const summary = connectorFailureSummary({
      cli: 'codex',
      signInHint: 'Run `codex login` to sign in',
      stderr: `${storm}\n${READONLY_STATE_DB_STDERR}`,
      stdout: '',
      streamError: undefined,
    });
    expect(summary).toContain('could not write its state directory');
    expect(summary).not.toContain('was blocked by this machine');
  });

  it('ignores readonly-database wording on stdout, which is conversation content', () => {
    const summary = connectorFailureSummary({
      cli: 'codex',
      signInHint: 'Run `codex login` to sign in',
      stderr: '',
      stdout: 'the bug: sqlite says attempt to write a readonly database',
      streamError: undefined,
    });
    expect(summary).toBeUndefined();
  });

  it('falls back to the reported stream error when no known class matches', () => {
    const summary = connectorFailureSummary({
      cli: 'codex',
      signInHint: 'Run `codex login` to sign in',
      stderr: '',
      stdout: '',
      streamError: 'unexpected status 400 Bad Request',
    });
    expect(summary).toBe('The codex CLI reported an error: unexpected status 400 Bad Request.');
  });

  it('returns undefined when nothing recognizable failed', () => {
    const summary = connectorFailureSummary({
      cli: 'codex',
      signInHint: 'Run `codex login` to sign in',
      stderr: 'some benign warning\n',
      stdout: '',
      streamError: undefined,
    });
    expect(summary).toBeUndefined();
  });
});

describe('condenseRepeatedLines', () => {
  it('collapses consecutive identical lines so spam cannot drown the tail', () => {
    const warn = 'WARN: Operation not permitted';
    const text = `${Array(10).fill(warn).join('\n')}\nERROR: the real failure`;
    const condensed = condenseRepeatedLines(text);
    expect(condensed).toBe(`${warn} [repeated 10 times]\nERROR: the real failure`);
  });

  it('leaves non-repeating text untouched', () => {
    expect(condenseRepeatedLines('a\nb\nc')).toBe('a\nb\nc');
  });
});

// End-to-end: the connectors assemble those sentences into their relay errors.

let fakeBinDir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  fakeBinDir = await mkdtemp(join(tmpdir(), 'circuit-launch-failure-'));
  originalPath = process.env.PATH;
});

afterEach(async () => {
  process.env.PATH = originalPath;
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

describe('connector launch failures end-to-end', () => {
  it('claude-code: a missing CLI leads with the plain not-installed sentence', async () => {
    // An empty PATH dir: `claude` cannot be found, so spawn fails with ENOENT.
    const emptyDir = join(fakeBinDir, 'empty');
    await mkdir(emptyDir, { recursive: true });
    process.env.PATH = emptyDir;
    const { relayClaudeCode } = await import('../../src/connectors/claude-code.js');

    const message = await messageFrom(relayClaudeCode({ prompt: 'x', timeoutMs: 5_000 }));

    expect(message.startsWith('The claude CLI is not installed or not on your PATH')).toBe(true);
    expect(message).toContain('circuit doctor');
    // Raw detail preserved after the plain sentence.
    expect(message).toContain('ENOENT');
    expect(message).toContain('claude-code subprocess');
  });

  it('codex: a missing CLI fails the version capture with the plain not-installed sentence', async () => {
    const emptyDir = join(fakeBinDir, 'empty');
    await mkdir(emptyDir, { recursive: true });
    process.env.PATH = emptyDir;
    const { relayCodex } = await import('../../src/connectors/codex.js');

    const message = await messageFrom(
      relayCodex({
        prompt: 'x',
        timeoutMs: 5_000,
        resolvedSelection: {
          model: { provider: 'openai', model: 'gpt-5.4' },
          skills: [],
          invocation_options: {},
        },
      }),
    );

    expect(message.startsWith('The codex CLI is not installed or not on your PATH')).toBe(true);
    expect(message).toContain('circuit doctor');
    expect(message).toContain('codex --version failed');
  });

  it('claude-code: a not-logged-in CLI leads with the sign-in sentence', async () => {
    await installFakeCli(
      'claude',
      ['#!/bin/sh', "printf '%s\\n' 'Error: Not logged in. Please run /login.' >&2", 'exit 1'].join(
        '\n',
      ),
    );
    const { relayClaudeCode } = await import('../../src/connectors/claude-code.js');

    const message = await messageFrom(relayClaudeCode({ prompt: 'x', timeoutMs: 10_000 }));

    expect(
      message.startsWith(
        'The claude CLI is not logged in. Run `claude` once to sign in, or run `circuit doctor` to check connector health.',
      ),
    ).toBe(true);
    // The raw detail stays after the plain sentence.
    expect(message).toContain('claude-code subprocess exited with code 1');
    expect(message).toContain('Not logged in. Please run /login.');
  });

  it('cursor-agent: a not-logged-in CLI leads with the sign-in sentence', async () => {
    await installFakeCli(
      'cursor-agent',
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "2026.01.01-abcdef"; exit 0; fi',
        "printf '%s\\n' 'Not logged in. Run cursor-agent login.'",
        'exit 1',
      ].join('\n'),
    );
    const { relayCursorAgent } = await import('../../src/connectors/cursor-agent.js');

    const message = await messageFrom(relayCursorAgent({ prompt: 'x', timeoutMs: 10_000 }));

    expect(
      message.startsWith(
        'The cursor-agent CLI is not logged in. Run `cursor-agent login` to sign in, or run `circuit doctor` to check connector health.',
      ),
    ).toBe(true);
    expect(message).toContain('cursor-agent subprocess exited with code 1');
  });

  it('codex: a sandbox denial storm leads with the sandbox sentence and condenses the spam', async () => {
    const warn = 'WARN codex_core: Operation not permitted (os error 1)';
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0"; exit 0; fi',
      ...Array(10).fill(`printf '%s\\n' '${warn}' >&2`),
      "printf '%s\\n' 'ERROR: failed to create session directory' >&2",
      'exit 1',
    ].join('\n');
    await installFakeCli('codex', script);
    const { relayCodex } = await import('../../src/connectors/codex.js');

    const message = await messageFrom(
      relayCodex({
        prompt: 'x',
        timeoutMs: 10_000,
        resolvedSelection: {
          model: { provider: 'openai', model: 'gpt-5.4' },
          skills: [],
          invocation_options: {},
        },
      }),
    );

    expect(
      message.startsWith(
        'The codex CLI was blocked by this machine\'s sandbox (10 "Operation not permitted" errors).',
      ),
    ).toBe(true);
    expect(message).toContain('Last error: "ERROR: failed to create session directory"');
    // The stderr detail collapses the repeated WARN lines so the real failure
    // survives truncation.
    expect(message).toContain('[repeated 10 times]');
    expect(message).toContain('codex subprocess exited with code 1');
  });
});
