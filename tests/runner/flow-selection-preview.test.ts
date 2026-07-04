import { describe, expect, it } from 'vitest';
import {
  type FlowSelectionPreview,
  resolveFlowSelectionPreview,
} from '../../src/cli/flow-selection-preview.js';
import { LayeredConfig } from '../../src/schemas/config.js';

// A deterministic stand-in for the codex default-model cache read, so these
// tests never touch ~/.codex or spawn anything. The real CLI reads the cache
// read-only; here we pin the flagship slug so assertions are stable.
const codexStub = () => 'gpt-5.5';

function preview(
  power: 'low' | 'medium' | 'high' | 'auto',
  opts: Partial<Parameters<typeof resolveFlowSelectionPreview>[0]> = {},
): FlowSelectionPreview {
  return resolveFlowSelectionPreview({
    flowId: 'cross-tool-build',
    power,
    // Empty base layers keep the preview independent of the machine's config.
    configLayers: [],
    hostKind: 'claude-code',
    codexDefaultModel: codexStub,
    ...opts,
  });
}

function relayStep(p: FlowSelectionPreview, id: string) {
  const step = p.relaySteps.find((candidate) => candidate.stepId === id);
  if (step === undefined) throw new Error(`no relay step ${id} in preview`);
  return step;
}

describe('resolveFlowSelectionPreview: cross-tool-build shape', () => {
  it('lists the five relay steps and three non-relay steps', () => {
    const p = preview('medium');
    expect(p.flowId).toBe('cross-tool-build');
    expect(p.visibility).toBe('internal');
    expect(p.relaySteps.map((s) => s.stepId).sort()).toEqual([
      'implement-step',
      'propose-step',
      'review-proposal-step',
      'review-spec-step',
      'spec-step',
    ]);
    expect(p.nonRelaySteps.map((s) => s.stepId).sort()).toEqual([
      'close-step',
      'plan-step',
      'verify-step',
    ]);
  });
});

describe('resolveFlowSelectionPreview: cross-tool-build dial matrix', () => {
  it('at --power low: implementer effort low, reviewers on sonnet, researcher pinned high', () => {
    const p = preview('low');

    const impl = relayStep(p, 'implement-step');
    expect(impl.role).toBe('implementer');
    expect(impl.connector).toBe('codex');
    expect(impl.effort).toBe('low');
    expect(impl.model).toBe('gpt-5.5');
    expect(impl.modelSource).toBe('codex-default');

    const review = relayStep(p, 'review-proposal-step');
    expect(review.role).toBe('reviewer');
    expect(review.connector).toBe('claude-code');
    // `model` is the bare slug; the provider rides a separate field so the
    // readout stays clean while the structured record keeps it.
    expect(review.model).toBe('sonnet');
    expect(review.provider).toBe('anthropic');

    // Researcher stays on the top tier at every dial by design ("judgment
    // compounds"), so codex runs it at effort high even at --power low.
    const propose = relayStep(p, 'propose-step');
    expect(propose.role).toBe('researcher');
    expect(propose.connector).toBe('codex');
    expect(propose.effort).toBe('high');
    expect(propose.model).toBe('gpt-5.5');
    expect(propose.provider).toBe('openai');
  });

  it('at --power medium: implementer effort medium, reviewers on sonnet', () => {
    const p = preview('medium');
    expect(relayStep(p, 'implement-step').effort).toBe('medium');
    expect(relayStep(p, 'review-proposal-step').model).toBe('sonnet');
    expect(relayStep(p, 'review-spec-step').model).toBe('sonnet');
  });

  it('at --power high: implementer effort high, reviewers on opus', () => {
    const p = preview('high');
    expect(relayStep(p, 'implement-step').effort).toBe('high');
    expect(relayStep(p, 'review-proposal-step').model).toBe('opus');
    expect(relayStep(p, 'review-spec-step').model).toBe('opus');
  });

  it('the dial moves the implementer effort low -> medium -> high', () => {
    expect(relayStep(preview('low'), 'implement-step').effort).toBe('low');
    expect(relayStep(preview('medium'), 'implement-step').effort).toBe('medium');
    expect(relayStep(preview('high'), 'implement-step').effort).toBe('high');
  });

  it('the dial moves the reviewer model sonnet -> opus at high', () => {
    expect(relayStep(preview('low'), 'review-proposal-step').model).toBe('sonnet');
    expect(relayStep(preview('medium'), 'review-proposal-step').model).toBe('sonnet');
    expect(relayStep(preview('high'), 'review-proposal-step').model).toBe('opus');
  });
});

describe('resolveFlowSelectionPreview: auto dial and graceful codex-unresolved', () => {
  it('--power auto previews as medium with powerSource auto', () => {
    const p = preview('auto');
    expect(p.dial).toBe('auto');
    expect(p.dialResolvesTo).toBe('medium');
    const impl = relayStep(p, 'implement-step');
    expect(impl.effort).toBe('medium');
    expect(impl.powerSource).toBe('auto');
  });

  it('reports codex steps as unresolved (no spawn, no crash) when the cache is unavailable', () => {
    const throwing = () => {
      throw new Error('codex models cache unavailable');
    };
    const p = preview('low', { codexDefaultModel: throwing });
    const impl = relayStep(p, 'implement-step');
    expect(impl.model).toBeUndefined();
    expect(impl.modelSource).toBe('codex-default-unresolved');
    // The claude-code reviewer still resolves fine; one unresolved connector
    // must not sink the whole preview.
    expect(relayStep(p, 'review-proposal-step').model).toBe('sonnet');
  });
});

describe('resolveFlowSelectionPreview: effort provenance', () => {
  it('dial-filled effort reports power-tier; absent effort reports unset', () => {
    const p = preview('low');
    expect(relayStep(p, 'implement-step').effortSource).toBe('power-tier');
    // The researcher's constant `high` is the role allocation inside the tier
    // machinery, not a pin — still a dial default, and it must say so.
    expect(relayStep(p, 'propose-step').effortSource).toBe('power-tier');
    const review = relayStep(p, 'review-proposal-step');
    expect(review.effort).toBeUndefined();
    expect(review.effortSource).toBe('unset');
  });

  it('an explicit config effort pin reports config and wins over the dial', () => {
    const pin = LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        circuits: { 'cross-tool-build': { selection: { effort: 'low' } } },
      },
    });
    const p = preview('high', { configLayers: [pin] });
    const impl = relayStep(p, 'implement-step');
    expect(impl.effort).toBe('low');
    expect(impl.effortSource).toBe('config');
    // The pin does not launder the model's provenance.
    expect(impl.modelSource).toBe('codex-default');
  });
});

describe('resolveFlowSelectionPreview: generality on another flow', () => {
  it('the dial is not globally inert for fix (resolved selection differs low vs high)', () => {
    const shared = {
      flowId: 'fix',
      configLayers: [],
      hostKind: 'claude-code',
      codexDefaultModel: codexStub,
    } as const;
    const low = resolveFlowSelectionPreview({ ...shared, power: 'low' });
    const high = resolveFlowSelectionPreview({ ...shared, power: 'high' });
    const key = (p: FlowSelectionPreview) =>
      p.relaySteps
        .map((s) => `${s.stepId}:${s.connector}:${s.model ?? '-'}:${s.effort ?? '-'}`)
        .join('|');
    expect(key(low)).not.toBe(key(high));
    expect(low.relaySteps.every((s) => s.problem === undefined)).toBe(true);
    expect(high.relaySteps.every((s) => s.problem === undefined)).toBe(true);
  });
});
