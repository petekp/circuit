import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli/circuit.js';

// Bare `circuit` is the front door. In a terminal it opens the interactive
// shell; piped or in CI it prints a static orientation page instead of the
// old "missing command" error, so agents running bare `circuit` get
// discovery, not a failure. Explicit commands are untouched.

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function plainStdout(): string {
  return stdout.join('').replace(ANSI_PATTERN, '');
}

describe('bare circuit front door', () => {
  it('prints the static front door and exits 0 when not attached to a TTY', async () => {
    // vitest runs without a TTY on stdin/stdout, so this is the piped path.
    const code = await main([]);
    expect(code).toBe(0);
    const out = plainStdout();
    expect(out).toContain('circuit');
    // Discovery: the major verbs are all named.
    for (const command of ['run', 'preview', 'config', 'create', 'generate', 'inbox']) {
      expect(out).toContain(command);
    }
    // The page points at the interactive shell and the deep dives.
    expect(out).toContain('interactive');
    expect(stderr.join('')).toBe('');
  });

  it('launches the interactive shell when both stdin and stdout are TTYs', async () => {
    const restoreProps: Array<() => void> = [];
    for (const stream of [process.stdin, process.stdout] as const) {
      const original = Object.getOwnPropertyDescriptor(stream, 'isTTY');
      Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
      restoreProps.push(() => {
        if (original === undefined) {
          Reflect.deleteProperty(stream, 'isTTY');
        } else {
          Object.defineProperty(stream, 'isTTY', original);
        }
      });
    }
    try {
      const shell = vi.fn(async () => 0);
      const code = await main([], { interactiveShell: shell });
      expect(code).toBe(0);
      expect(shell).toHaveBeenCalledOnce();
    } finally {
      for (const restore of restoreProps) restore();
    }
  });

  it('keeps the missing-command error for piped invocations with unknown words', async () => {
    const code = await main(['frobnicate']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('unknown command');
  });
});
