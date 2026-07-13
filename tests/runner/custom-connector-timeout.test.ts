import { beforeEach, describe, expect, it, vi } from 'vitest';

// Timeout bounds the CUSTOM connector hands to the shared subprocess helper.
//
// Custom connectors share the built-in CLI-agent connectors' 60-minute
// wall-clock backstop (tests/runner/connector-default-timeout.test.ts pins the
// built-ins). Regression context: the custom default used to be a 2-minute
// absolute kill — 30x tighter than the built-ins — so a slow-but-healthy
// custom connector died mid-work with no override that helped.
//
// Deliberate asymmetry with the built-ins: custom connectors arm NO default
// inactivity bound. A custom command may legitimately produce no stdout or
// stderr for its whole life (its durable result travels through the output
// file), so silence is not evidence of a hang here. Only an explicit per-step
// `budgets.inactivity_ms` arms the idle watchdog.
//
// Like the built-in bounds test, these pin observable BEHAVIOR — the values
// handed to the shared subprocess helper — via the mocked-subprocess capture
// pattern, not private-constant change detection.

const EXPECTED_ABSOLUTE_TIMEOUT_MS = 3_600_000; // 60-minute wall-clock backstop

const { runConnectorSubprocessMock } = vi.hoisted(() => ({
  runConnectorSubprocessMock: vi.fn(),
}));

// Mock the shared subprocess helper so nothing spawns. The relay rejects while
// reading the (never-written) output file, but the bounds are captured on the
// way IN — before any file IO — so the assertions are unaffected.
vi.mock('../../src/connectors/subprocess.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/connectors/subprocess.js')>();
  return {
    ...actual,
    runConnectorSubprocess: (input: unknown) => runConnectorSubprocessMock(input),
  };
});

function descriptor() {
  return {
    kind: 'custom',
    name: 'test-reviewer',
    command: ['/usr/bin/true'],
    prompt_transport: 'prompt-file',
    output: { kind: 'output-file' },
    capabilities: { filesystem: 'read-only', structured_output: 'json' },
  };
}

async function relayCustomWith(input: {
  timeoutMs?: number;
  idleTimeoutMs?: number;
}): Promise<unknown> {
  const { relayCustom } = await import('../../src/connectors/custom.js');
  const { CustomConnectorDescriptor } = await import('../../src/schemas/connector.js');
  return relayCustom({
    descriptor: CustomConnectorDescriptor.parse(descriptor()),
    prompt: 'x',
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
    resolvedSelection: { skills: [], invocation_options: {} },
  });
}

function boundsPassedToSubprocess(): { timeoutMs?: number; idleTimeoutMs?: number } {
  expect(runConnectorSubprocessMock).toHaveBeenCalledTimes(1);
  return runConnectorSubprocessMock.mock.calls[0]?.[0] as {
    timeoutMs?: number;
    idleTimeoutMs?: number;
  };
}

function subprocessResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stdout: '',
    stderr: '',
    stdoutCapped: false,
    stderrCapped: false,
    timedOut: false,
    killGroupSucceeded: true,
    code: 0,
    signal: null,
    durationMs: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  runConnectorSubprocessMock.mockReset();
  runConnectorSubprocessMock.mockResolvedValue(subprocessResult());
});

describe('custom connector timeout bounds', () => {
  it('defaults to the shared 60-minute wall-clock backstop with NO idle bound', async () => {
    await relayCustomWith({}).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(EXPECTED_ABSOLUTE_TIMEOUT_MS);
    // The asymmetry under test: no default inactivity bound for custom
    // connectors — a custom command may be legitimately silent its whole life.
    expect(bounds.idleTimeoutMs).toBeUndefined();
  });

  it('an explicit per-step wall-clock budget overrides the backstop and still arms no idle bound', async () => {
    await relayCustomWith({ timeoutMs: 5_000 }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(5_000);
    expect(bounds.idleTimeoutMs).toBeUndefined();
  });

  it('an explicit per-step inactivity budget arms the idle watchdog without touching the backstop', async () => {
    await relayCustomWith({ idleTimeoutMs: 900_000 }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(EXPECTED_ABSOLUTE_TIMEOUT_MS);
    expect(bounds.idleTimeoutMs).toBe(900_000);
  });

  it('a step may set both bounds independently', async () => {
    await relayCustomWith({ timeoutMs: 5_000, idleTimeoutMs: 7_000 }).catch(() => {});
    const bounds = boundsPassedToSubprocess();
    expect(bounds.timeoutMs).toBe(5_000);
    expect(bounds.idleTimeoutMs).toBe(7_000);
  });

  it('an inactivity kill names the idle bound and the budgets.inactivity_ms remedy', async () => {
    runConnectorSubprocessMock.mockResolvedValue(
      subprocessResult({
        timedOut: true,
        timeoutKind: 'idle',
        code: null,
        signal: 'SIGTERM',
        stderr: 'quiet worker',
      }),
    );
    await expect(relayCustomWith({ idleTimeoutMs: 60_000 })).rejects.toThrow(
      /custom connector 'test-reviewer' timed out: no output for 60000ms \(inactivity; a step that legitimately goes silent longer can raise budgets\.inactivity_ms\)/,
    );
  });

  it('a wall-clock kill names the absolute backstop and the budgets.wall_clock_ms remedy', async () => {
    runConnectorSubprocessMock.mockResolvedValue(
      subprocessResult({
        timedOut: true,
        timeoutKind: 'absolute',
        code: null,
        signal: 'SIGTERM',
        stderr: 'busy worker',
      }),
    );
    await expect(relayCustomWith({})).rejects.toThrow(
      /custom connector 'test-reviewer' timed out: exceeded the 3600000ms wall-clock backstop.*budgets\.wall_clock_ms/,
    );
  });
});
