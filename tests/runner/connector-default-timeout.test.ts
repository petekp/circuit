import { beforeEach, describe, expect, it, vi } from 'vitest';

// Default timeout bounds the CLI-agent connectors hand to the shared subprocess
// helper. Two bounds guard every relay (see subprocess.ts createTimeoutController):
//   - an INACTIVITY bound (idleTimeoutMs) reset on every chunk of output; a
//     streaming agent that goes silent is what a hang looks like, and this is
//     the primary reclaimer.
//   - an ABSOLUTE backstop (timeoutMs) that never resets; it only catches a
//     runaway that keeps dribbling output so the inactivity bound never fires.
//
// This replaced a single fixed wall-clock cap. Regression context: in the
// multi-file build probe (experiments/build-probe-multifile/VERDICT.md) the
// heavy `diff` slice of a genuine 6-file build was group-killed mid-write at the
// fixed 600s ceiling while still making progress — a live-but-slow step read as
// a hang purely because the cap bounded total time, not liveness. The inactivity
// bound reclaims true hangs (silence) without punishing slow-but-alive work.
//
// The inactivity default itself has regression context: at 3 minutes it killed
// a healthy implementation relay in Build run 37a27314 (2026-07-11) while the
// agent sat in a long silent tool call — this repo's own verify suite runs
// ~223s with no output, and a long thinking turn emits nothing on the
// stream-json channel either. Silence and death are not locally
// distinguishable (a child waiting on the network and a wedged child both show
// a live PID and no output), so the default must accommodate legitimate silent
// stretches, and a step that expects even longer silence declares
// budgets.inactivity_ms.
//
// These pin the bounds as observable BEHAVIOR — the values actually handed to
// the shared subprocess helper — not as private-constant change detectors. The
// three CLI-agent connectors (claude-code, cursor-agent, codex) are peers and
// must share the same bounds; all three are asserted here.

const EXPECTED_ABSOLUTE_TIMEOUT_MS = 3_600_000; // 60-minute wall-clock backstop
const EXPECTED_IDLE_TIMEOUT_MS = 600_000; // 10-minute inactivity bound

const { runConnectorSubprocessMock } = vi.hoisted(() => ({
  runConnectorSubprocessMock: vi.fn(),
}));

// Mock the shared subprocess helper so nothing spawns. The relay may reject
// while parsing the (benign) canned result, but the bounds are captured on the
// way IN — before any parse — so the assertions are unaffected.
vi.mock('../../src/connectors/subprocess.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/connectors/subprocess.js')>();
  return {
    ...actual,
    runConnectorSubprocess: (input: unknown) => runConnectorSubprocessMock(input),
  };
});

// cursor-agent and codex shell out to `<cli> --version` before the subprocess
// seam; stub it so their relays reach runConnectorSubprocess without a real CLI
// on PATH. (claude-code captures its version in-band and needs no stub.)
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, execFileSync: () => 'cli 0.0.0\n' };
});

function boundsPassedToSubprocess(): { timeoutMs?: number; idleTimeoutMs?: number } {
  expect(runConnectorSubprocessMock).toHaveBeenCalledTimes(1);
  return runConnectorSubprocessMock.mock.calls[0]?.[0] as {
    timeoutMs?: number;
    idleTimeoutMs?: number;
  };
}

beforeEach(() => {
  vi.resetModules();
  runConnectorSubprocessMock.mockReset();
  runConnectorSubprocessMock.mockResolvedValue({
    stdout: '',
    stderr: '',
    stdoutCapped: false,
    stderrCapped: false,
    timedOut: false,
    killGroupSucceeded: true,
    code: 0,
    signal: null,
    durationMs: 1,
  });
});

describe('CLI-agent connectors default to a 10-minute inactivity bound + 60-minute backstop', () => {
  it('claude-code uses both default bounds when no per-step budget is supplied', async () => {
    const { relayClaudeCode } = await import('../../src/connectors/claude-code.js');
    await relayClaudeCode({ prompt: 'x' }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(EXPECTED_ABSOLUTE_TIMEOUT_MS);
    expect(bounds.idleTimeoutMs).toBe(EXPECTED_IDLE_TIMEOUT_MS);
  });

  it('cursor-agent uses both default bounds when no per-step budget is supplied', async () => {
    const { relayCursorAgent } = await import('../../src/connectors/cursor-agent.js');
    await relayCursorAgent({ prompt: 'x' }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(EXPECTED_ABSOLUTE_TIMEOUT_MS);
    expect(bounds.idleTimeoutMs).toBe(EXPECTED_IDLE_TIMEOUT_MS);
  });

  it('codex uses both default bounds when no per-step budget is supplied', async () => {
    const { relayCodex } = await import('../../src/connectors/codex.js');
    await relayCodex({
      prompt: 'x',
      resolvedSelection: {
        model: { provider: 'openai', model: 'gpt-5.4' },
        skills: [],
        invocation_options: {},
      },
    }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(EXPECTED_ABSOLUTE_TIMEOUT_MS);
    expect(bounds.idleTimeoutMs).toBe(EXPECTED_IDLE_TIMEOUT_MS);
  });

  it('an explicit per-step wall-clock budget overrides the absolute backstop but not the inactivity bound', async () => {
    const { relayClaudeCode } = await import('../../src/connectors/claude-code.js');
    await relayClaudeCode({ prompt: 'x', timeoutMs: 5_000 }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(5_000);
    expect(bounds.idleTimeoutMs).toBe(EXPECTED_IDLE_TIMEOUT_MS);
  });

  it('claude-code forwards a per-step inactivity override without touching the backstop', async () => {
    const { relayClaudeCode } = await import('../../src/connectors/claude-code.js');
    await relayClaudeCode({ prompt: 'x', idleTimeoutMs: 900_000 }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(EXPECTED_ABSOLUTE_TIMEOUT_MS);
    expect(bounds.idleTimeoutMs).toBe(900_000);
  });

  it('cursor-agent forwards a per-step inactivity override without touching the backstop', async () => {
    const { relayCursorAgent } = await import('../../src/connectors/cursor-agent.js');
    await relayCursorAgent({ prompt: 'x', idleTimeoutMs: 900_000 }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(EXPECTED_ABSOLUTE_TIMEOUT_MS);
    expect(bounds.idleTimeoutMs).toBe(900_000);
  });

  it('codex forwards a per-step inactivity override without touching the backstop', async () => {
    const { relayCodex } = await import('../../src/connectors/codex.js');
    await relayCodex({
      prompt: 'x',
      idleTimeoutMs: 900_000,
      resolvedSelection: {
        model: { provider: 'openai', model: 'gpt-5.4' },
        skills: [],
        invocation_options: {},
      },
    }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(EXPECTED_ABSOLUTE_TIMEOUT_MS);
    expect(bounds.idleTimeoutMs).toBe(900_000);
  });

  it('a step may override both bounds independently', async () => {
    const { relayClaudeCode } = await import('../../src/connectors/claude-code.js');
    await relayClaudeCode({ prompt: 'x', timeoutMs: 5_000, idleTimeoutMs: 7_000 }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(5_000);
    expect(bounds.idleTimeoutMs).toBe(7_000);
  });
});
