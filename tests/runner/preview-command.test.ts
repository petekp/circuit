import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowSelectionPreview } from '../../src/cli/flow-selection-preview.js';
import { runPreviewCommand, sourceCellText } from '../../src/cli/preview.js';

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

// Text assertions are made on the raw characters: strip any ANSI styling so
// the tests hold whether or not the environment reports color support.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function plainStdout(): string {
  return stdout.join('').replace(ANSI_PATTERN, '');
}

const PUBLIC_FLOW_IDS = ['review', 'fix', 'prototype', 'build', 'explore'];

describe('circuit preview: front door', () => {
  it('bare preview renders an overview of every public flow at the default dial', () => {
    const code = runPreviewCommand([]);
    expect(code).toBe(0);
    const out = plainStdout();
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
    expect(plainStdout()).toContain('dial: high');
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
    // Effort provenance is machine-independent (unlike the codex model, which
    // reads the operator's cache): dial-filled reports power-tier, absent unset.
    expect(byId['implement-step']?.effortSource).toBe('power-tier');
    expect(byId['review-proposal-step']?.effortSource).toBe('unset');
  });

  it('the SOURCE cell notes effort provenance only when it differs in kind from the model', () => {
    // Both defaults (tier-filled effort on a codex-default model): the note
    // would be noise — every out-of-the-box row is a default, and that is
    // exactly what an unannotated row means.
    expect(sourceCellText('codex-default', 'power-tier')).toBe('codex-default');
    expect(sourceCellText('power-tier', 'unset')).toBe('power-tier');
    // Explicit and default mixed: the cell must say which half is which, in
    // plain characters — brightness alone would hide it from pipes/NO_COLOR.
    expect(sourceCellText('codex-default', 'pinned')).toBe('codex-default · effort:pinned');
    expect(sourceCellText('pinned', 'power-tier')).toBe('pinned · effort:power-tier');
    // Both explicit collapses back to one word.
    expect(sourceCellText('pinned', 'pinned')).toBe('pinned');
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

  it('a single-flow preview displays the process the dial word derives', () => {
    const code = runPreviewCommand(['build', '--power', 'low']);
    expect(code).toBe(0);
    expect(plainStdout()).toContain('process: low');
  });

  it('a single-flow JSON preview carries the derived, per-flow-clamped process', () => {
    // review pins to medium regardless of the dial (Path A per-flow clamp).
    const code = runPreviewCommand(['review', '--power', 'high', '--json']);
    expect(code).toBe(0);
    const preview = json<FlowSelectionPreview>();
    expect(preview.dial).toBe('high');
    expect(preview.process).toBe('medium');
  });

  it('--matrix displays a process row alongside the dial columns, clamped per flow', () => {
    // prototype floors process at medium, so the LOW column still reads medium.
    const code = runPreviewCommand(['prototype', '--matrix']);
    expect(code).toBe(0);
    const out = plainStdout();
    expect(out).toContain('dial matrix: high / medium / low');
    const processLine = out.split('\n').find((line) => line.trim().startsWith('process'));
    expect(processLine).toBeDefined();
    expect((processLine as string).split(/\s+/).filter(Boolean)).toEqual([
      'process',
      'high',
      'medium',
      'medium',
    ]);
  });

  it('--matrix --json carries process per dial column, clamped per flow', () => {
    const code = runPreviewCommand(['prototype', '--matrix', '--json']);
    expect(code).toBe(0);
    const previews = json<FlowSelectionPreview[]>();
    expect(previews.map((p) => ({ dial: p.dial, process: p.process }))).toEqual([
      { dial: 'high', process: 'high' },
      { dial: 'medium', process: 'medium' },
      { dial: 'low', process: 'medium' },
    ]);
  });
});
