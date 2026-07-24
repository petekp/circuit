import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { relayClaudeCode } from '../../src/connectors/claude-code.js';
import { relayCodex } from '../../src/connectors/codex.js';
import { relayCursorAgent } from '../../src/connectors/cursor-agent.js';
import type { ConnectorRelayInput } from '../../src/shared/connector-relay.js';

/**
 * Family contract: EVERY builtin CLI-agent connector must forward `input.cwd`
 * to the subprocess it spawns.
 *
 * This is the regression net for the "dropped cwd" defect: a flow that fans a
 * step out into an isolated worktree passes that worktree as `input.cwd`, and a
 * connector that ignores it runs the worker in the parent process's directory
 * instead — isolation silently fails and the step reads/writes the main
 * checkout. `codex` and `cursor-agent` already forwarded it; `claude-code` did
 * not, which is the bug this test first reproduced.
 *
 * TECHNIQUE: we intercept the single shared seam every connector funnels
 * through — `runConnectorSubprocess` in src/connectors/subprocess.ts — and
 * record the `cwd` each connector hands it. We do NOT spawn a real CLI. The
 * canned result has empty stdout, so each connector's parser throws afterward
 * and the relay rejects; that is irrelevant here because `cwd` is captured at
 * the spawn boundary BEFORE any parsing. `execFileSync` is stubbed so the
 * `codex`/`cursor-agent` `--version` probes resolve without the CLI installed.
 */

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ readonly args: readonly string[]; readonly cwd: string | undefined }>,
}));

vi.mock('../../src/connectors/subprocess.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/connectors/subprocess.js')>();
  return {
    ...actual,
    // Capture the working directory the connector asked the subprocess to run
    // in, then return a minimal well-formed result. Empty stdout makes the
    // connector's own parser throw, but the relay has already recorded the cwd.
    runConnectorSubprocess: async (input: {
      readonly args: readonly string[];
      readonly cwd?: string;
    }) => {
      hoisted.calls.push({ args: input.args, cwd: input.cwd });
      return {
        stdout: '',
        stderr: '',
        stdoutCapped: false,
        stderrCapped: false,
        timedOut: false,
        killGroupSucceeded: false,
        code: 0,
        signal: null,
        durationMs: 1,
      };
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // `codex --version` / `cursor-agent --version` capture happens before the
    // spawn; stub it so the version probe never touches a real CLI.
    execFileSync: () => '1.2.3\n',
  };
});

const EXPECTED_CWD = '/tmp/circuit-isolated-worktree';
const ORIGINAL_TMPDIR = process.env.TMPDIR;
const temporaryRoots: string[] = [];

function temporaryDirectory(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  temporaryRoots.push(root);
  return root;
}

// Codex resolves its default model from a cache before spawning unless the
// selection pins one; pin an openai model so the relay reaches the spawn seam
// without a live cache read.
const CODEX_PINNED_SELECTION: ConnectorRelayInput['resolvedSelection'] = {
  model: { provider: 'openai', model: 'gpt-5-codex' },
  skills: [],
  invocation_options: {},
};

type ConnectorCase = {
  readonly name: string;
  readonly relay: (input: ConnectorRelayInput) => Promise<unknown>;
  readonly extra?: Partial<ConnectorRelayInput>;
};

const CONNECTORS: readonly ConnectorCase[] = [
  { name: 'claude-code', relay: relayClaudeCode },
  { name: 'codex', relay: relayCodex, extra: { resolvedSelection: CODEX_PINNED_SELECTION } },
  { name: 'cursor-agent', relay: relayCursorAgent },
];

beforeEach(() => {
  hoisted.calls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_TMPDIR === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
  else process.env.TMPDIR = ORIGINAL_TMPDIR;
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('builtin connectors forward input.cwd to the spawned subprocess', () => {
  it.each(CONNECTORS)('$name forwards input.cwd', async ({ relay, extra }) => {
    const input: ConnectorRelayInput = {
      prompt: 'noop',
      cwd: EXPECTED_CWD,
      ...extra,
    };

    // The canned subprocess result has empty stdout, so the relay rejects while
    // parsing. That is fine — we only assert on the captured spawn cwd.
    await relay(input).catch(() => undefined);

    expect(hoisted.calls).toHaveLength(1);
    expect(hoisted.calls[0]?.cwd).toBe(EXPECTED_CWD);
  });

  it.each(CONNECTORS)(
    '$name passes no cwd when input.cwd is undefined (no fabricated directory)',
    async ({ relay, extra }) => {
      const input: ConnectorRelayInput = {
        prompt: 'noop',
        ...extra,
      };

      await relay(input).catch(() => undefined);

      expect(hoisted.calls).toHaveLength(1);
      expect(hoisted.calls[0]?.cwd).toBeUndefined();
    },
  );
});

describe('prompt-only connectors replace the repository cwd', () => {
  it.each(CONNECTORS.filter(({ name }) => name !== 'cursor-agent'))(
    '$name uses and cleans a private cwd',
    async ({ relay, extra }) => {
      const workspace = temporaryDirectory('circuit-prompt-only-workspace');
      await relay({
        prompt: 'review only supplied evidence',
        cwd: workspace,
        promptOnly: true,
        ...extra,
      }).catch(() => undefined);

      expect(hoisted.calls).toHaveLength(1);
      const call = hoisted.calls[0];
      expect(call?.cwd).toBeDefined();
      expect(call?.cwd).not.toBe(workspace);
      expect(call?.args).not.toContain(workspace);
      expect(existsSync(call?.cwd ?? '')).toBe(false);
    },
  );

  it.each(CONNECTORS.filter(({ name }) => name !== 'cursor-agent'))(
    '$name fails before spawn when TMPDIR would place the private cwd inside the repository',
    async ({ relay, extra }) => {
      const workspace = temporaryDirectory('circuit-hostile-tmpdir-workspace');
      process.env.TMPDIR = workspace;

      await expect(
        relay({
          prompt: 'review only supplied evidence',
          cwd: workspace,
          promptOnly: true,
          ...extra,
        }),
      ).rejects.toThrow(/prompt-only|private|overlap|separate/i);

      expect(hoisted.calls).toHaveLength(0);
      expect(readdirSync(workspace)).toEqual([]);
    },
  );

  it.each(CONNECTORS.filter(({ name }) => name !== 'cursor-agent'))(
    '$name rejects an in-repository TMPDIR whose name starts with two dots',
    async ({ relay, extra }) => {
      const workspace = temporaryDirectory('circuit-dot-prefix-tmpdir-workspace');
      const hostileTmp = join(workspace, '..relay-tmp');
      mkdirSync(hostileTmp);
      process.env.TMPDIR = hostileTmp;

      await expect(
        relay({
          prompt: 'review only supplied evidence',
          cwd: workspace,
          promptOnly: true,
          ...extra,
        }),
      ).rejects.toThrow(/prompt-only|private|overlap|separate/i);

      expect(hoisted.calls).toHaveLength(0);
      expect(readdirSync(hostileTmp)).toEqual([]);
    },
  );

  it.each(CONNECTORS.filter(({ name }) => name !== 'cursor-agent'))(
    '$name resolves a symlinked TMPDIR before checking repository overlap',
    async ({ relay, extra }) => {
      const workspace = temporaryDirectory('circuit-symlinked-tmpdir-workspace');
      const linkRoot = temporaryDirectory('circuit-symlinked-tmpdir-parent');
      const linkedTmp = join(linkRoot, 'tmp');
      symlinkSync(workspace, linkedTmp, 'dir');
      process.env.TMPDIR = linkedTmp;

      await expect(
        relay({
          prompt: 'review only supplied evidence',
          cwd: workspace,
          promptOnly: true,
          ...extra,
        }),
      ).rejects.toThrow(/prompt-only|private|overlap|separate/i);

      expect(hoisted.calls).toHaveLength(0);
      expect(readdirSync(workspace)).toEqual([]);
    },
  );
});
