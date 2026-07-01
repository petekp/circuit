import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CI-safe seam test for the codex default-model resolver's dispatch wiring.
// It proves the whole resolve-thread-record path inside relayCodex WITHOUT a
// real `codex exec` spawn:
//   - resolve: an unpinned selection falls back to the flagship read from
//     <CODEX_HOME>/models_cache.json,
//   - thread: that model reaches the subprocess argv as `-m <flagship>`,
//   - record: the returned RelayResult.model equals the model actually used,
//   - short-circuit: a selection-pinned model wins and the cache is never
//     consulted (proven by pointing CODEX_HOME at an empty dir — a stray
//     resolve would throw CodexDefaultModelUnavailableError).
//
// The two module-level side effects relayCodex owns are mocked: the shared
// subprocess helper (so nothing spawns) and `codex --version` capture. Each
// test resets the module graph so the resolver's success-memoization and the
// version-capture memo start clean — that is what makes the "cache not
// consulted" proof airtight rather than masked by a prior test's memo.

const { runConnectorSubprocessMock } = vi.hoisted(() => ({
  runConnectorSubprocessMock: vi.fn(),
}));

vi.mock('../../src/connectors/subprocess.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/connectors/subprocess.js')>();
  return {
    ...actual,
    runConnectorSubprocess: (input: unknown) => runConnectorSubprocessMock(input),
  };
});

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    // captureCodexVersion() calls execFileSync('codex', ['--version']); stub a
    // plausible version so nothing spawns and the connector proceeds.
    execFileSync: () => 'codex-cli 0.142.4\n',
  };
});

// A well-formed codex `--json` stdout for a single-turn relay, mirroring the
// parseCodexStdout fixture used in the connector schema tests.
function codexNdjsonStdout(): string {
  return `${[
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-seam-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: '{"verdict":"ok"}' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
    }),
  ].join('\n')}\n`;
}

function cannedSubprocessResult() {
  return {
    stdout: codexNdjsonStdout(),
    stderr: '',
    stdoutCapped: false,
    stderrCapped: false,
    timedOut: false,
    killGroupSucceeded: true,
    code: 0,
    signal: null,
    durationMs: 7,
  };
}

// The real-shaped cache: gpt-5.5 (priority 7) is the flagship among API-listed
// models; gpt-5.4 is lower-prominence.
function realShapedCache(): string {
  return JSON.stringify({
    fetched_at: '2026-07-01T00:00:00Z',
    etag: 'seam',
    client_version: '0.142.4',
    models: [
      {
        slug: 'gpt-5.4',
        display_name: 'gpt-5.4',
        visibility: 'list',
        supported_in_api: true,
        priority: 16,
      },
      {
        slug: 'gpt-5.5',
        display_name: 'gpt-5.5',
        visibility: 'list',
        supported_in_api: true,
        priority: 7,
      },
    ],
  });
}

function argsPassedToSubprocess(): readonly string[] {
  expect(runConnectorSubprocessMock).toHaveBeenCalledTimes(1);
  const call = runConnectorSubprocessMock.mock.calls[0]?.[0] as { args: readonly string[] };
  return call.args;
}

function modelFlagValue(args: readonly string[]): string | undefined {
  const i = args.indexOf('-m');
  return i >= 0 ? args[i + 1] : undefined;
}

let originalCodexHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  vi.resetModules();
  runConnectorSubprocessMock.mockReset();
  runConnectorSubprocessMock.mockResolvedValue(cannedSubprocessResult());
  originalCodexHome = process.env.CODEX_HOME;
  tempHome = mkdtempSync(join(tmpdir(), 'codex-seam-home-'));
  process.env.CODEX_HOME = tempHome;
});

afterEach(() => {
  if (originalCodexHome === undefined) Reflect.deleteProperty(process.env, 'CODEX_HOME');
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe('relayCodex resolves + threads + records the cache default (unpinned selection)', () => {
  it('spawns with `-m <flagship>` and records that model on the RelayResult', async () => {
    writeFileSync(join(tempHome, 'models_cache.json'), realShapedCache(), 'utf8');
    const { relayCodex } = await import('../../src/connectors/codex.js');

    const result = await relayCodex({ prompt: 'do the thing' });

    // resolve + thread: the flagship reached the argv.
    expect(modelFlagValue(argsPassedToSubprocess())).toBe('gpt-5.5');
    // record: the receipt-bound RelayResult carries the model actually used.
    expect(result.model).toBe('gpt-5.5');
  });

  it('fails loud BEFORE spawning when no default can be resolved', async () => {
    // No cache written to tempHome — the resolver must throw and nothing spawns.
    const { relayCodex } = await import('../../src/connectors/codex.js');
    const { CodexDefaultModelUnavailableError } = await import(
      '../../src/connectors/codex-default-model.js'
    );

    await expect(relayCodex({ prompt: 'do the thing' })).rejects.toBeInstanceOf(
      CodexDefaultModelUnavailableError,
    );
    expect(runConnectorSubprocessMock).not.toHaveBeenCalled();
  });
});

describe('relayCodex prefers a selection-pinned model and never consults the cache', () => {
  it('uses the pinned model and does not throw even with an empty CODEX_HOME', async () => {
    // No cache in tempHome: if relayCodex wrongly resolved a default it would
    // throw. A pinned selection must short-circuit that entirely.
    const { relayCodex } = await import('../../src/connectors/codex.js');

    const result = await relayCodex({
      prompt: 'do the thing',
      resolvedSelection: {
        model: { provider: 'openai', model: 'gpt-5.4' },
        skills: [],
        invocation_options: {},
      },
    });

    const args = argsPassedToSubprocess();
    expect(modelFlagValue(args)).toBe('gpt-5.4');
    // Exactly one -m pair: the default was never appended.
    expect(args.filter((a) => a === '-m')).toHaveLength(1);
    expect(result.model).toBe('gpt-5.4');
  });
});
