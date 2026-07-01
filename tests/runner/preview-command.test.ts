import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowSelectionPreview } from '../../src/cli/flow-selection-preview.js';
import { runPreviewCommand } from '../../src/cli/preview.js';

// End-to-end coverage of the `circuit preview` front door: argument parsing,
// the real selection resolution, and rendering. Assertions stay on values that
// do not depend on the machine (connector pins from the schematic, dial-driven
// effort from the shipped tier tables, exit codes) — never on the codex default
// model, which is read from the operator's local cache and varies by machine.

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

function json<T>(): T {
  const joined = stdout.join('');
  return JSON.parse(joined) as T;
}

describe('circuit preview: front door', () => {
  it('rejects a missing flow name with exit 2', () => {
    const code = runPreviewCommand([]);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('requires a flow name');
  });

  it('rejects an unknown flow with exit 2', () => {
    const code = runPreviewCommand(['no-such-flow']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain("unknown flow 'no-such-flow'");
  });

  it('rejects an out-of-range --power with exit 2', () => {
    const code = runPreviewCommand(['cross-tool-build', '--power', 'ludicrous']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('--power must be one of');
  });

  it('emits a JSON preview whose connector pins and step split are stable', () => {
    const code = runPreviewCommand(['cross-tool-build', '--power', 'high', '--json']);
    expect(code).toBe(0);
    const preview = json<FlowSelectionPreview>();
    expect(preview.flowId).toBe('cross-tool-build');
    expect(preview.visibility).toBe('internal');
    expect(preview.dial).toBe('high');
    expect(preview.dialResolvesTo).toBe('high');

    const byId = Object.fromEntries(preview.relaySteps.map((s) => [s.stepId, s]));
    // Connector pins come from the schematic, not config — stable everywhere.
    expect(byId['propose-step']?.connector).toBe('codex');
    expect(byId['implement-step']?.connector).toBe('codex');
    expect(byId['review-proposal-step']?.connector).toBe('claude-code');
    // The claude-code reviewer's model comes from the shipped tier table, so it
    // is machine-independent even though the codex model is not.
    expect(byId['review-proposal-step']?.model).toBe('anthropic/opus');
    expect(preview.nonRelaySteps.map((s) => s.stepId).sort()).toEqual([
      'close-step',
      'plan-step',
      'verify-step',
    ]);
  });

  it('--matrix returns one preview per fixed tier and the dial moves the implementer effort', () => {
    const code = runPreviewCommand(['cross-tool-build', '--matrix', '--json']);
    expect(code).toBe(0);
    const previews = json<FlowSelectionPreview[]>();
    expect(previews.map((p) => p.dial)).toEqual(['low', 'medium', 'high']);

    const implEffort = (p: FlowSelectionPreview) =>
      p.relaySteps.find((s) => s.stepId === 'implement-step')?.effort;
    expect(previews.map(implEffort)).toEqual(['low', 'medium', 'high']);

    const reviewerModel = (p: FlowSelectionPreview) =>
      p.relaySteps.find((s) => s.stepId === 'review-proposal-step')?.model;
    expect(reviewerModel(previews[0] as FlowSelectionPreview)).toBe('anthropic/sonnet');
    expect(reviewerModel(previews[2] as FlowSelectionPreview)).toBe('anthropic/opus');
  });
});
