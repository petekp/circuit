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

const PUBLIC_FLOW_IDS = ['review', 'fix', 'pursue', 'prototype', 'build', 'explore'];

describe('circuit preview: front door', () => {
  it('bare preview renders an overview of every public flow at the default dial', () => {
    const code = runPreviewCommand([]);
    expect(code).toBe(0);
    const out = stdout.join('');
    for (const flowId of PUBLIC_FLOW_IDS) {
      expect(out).toContain(flowId);
    }
    expect(out).toContain('dial: medium');
    // Internal flows stay off the overview.
    expect(out).not.toContain('cross-tool-build');
    expect(out).not.toContain('converge-proof');
    // The overview points at the per-flow deep dive.
    expect(out).toContain('circuit preview <flow>');
  });

  it('bare preview with --json returns one preview per public flow', () => {
    const code = runPreviewCommand(['--json']);
    expect(code).toBe(0);
    const previews = json<FlowSelectionPreview[]>();
    expect(previews.map((p) => p.flowId).sort()).toEqual([...PUBLIC_FLOW_IDS].sort());
    for (const preview of previews) {
      expect(preview.visibility).toBe('public');
      expect(preview.relaySteps.length).toBeGreaterThan(0);
    }
  });

  it('bare preview honors --power', () => {
    const code = runPreviewCommand(['--power', 'high']);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('dial: high');
  });

  it('rejects --matrix without a flow name with exit 2', () => {
    const code = runPreviewCommand(['--matrix']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('needs a flow name');
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
    // is machine-independent even though the codex model is not. `model` is the
    // bare slug; the provider rides its own field.
    expect(byId['review-proposal-step']?.model).toBe('opus');
    expect(byId['review-proposal-step']?.provider).toBe('anthropic');
    expect(preview.nonRelaySteps.map((s) => s.stepId).sort()).toEqual([
      'close-step',
      'plan-step',
      'verify-step',
    ]);
  });

  it('--matrix returns one preview per fixed tier, high first, and the dial moves the implementer effort', () => {
    const code = runPreviewCommand(['cross-tool-build', '--matrix', '--json']);
    expect(code).toBe(0);
    const previews = json<FlowSelectionPreview[]>();
    expect(previews.map((p) => p.dial)).toEqual(['high', 'medium', 'low']);

    const implEffort = (p: FlowSelectionPreview) =>
      p.relaySteps.find((s) => s.stepId === 'implement-step')?.effort;
    expect(previews.map(implEffort)).toEqual(['high', 'medium', 'low']);

    const reviewerModel = (p: FlowSelectionPreview) =>
      p.relaySteps.find((s) => s.stepId === 'review-proposal-step')?.model;
    expect(reviewerModel(previews[0] as FlowSelectionPreview)).toBe('opus');
    expect(reviewerModel(previews[2] as FlowSelectionPreview)).toBe('sonnet');
  });
});
