import { describe, expect, it } from 'vitest';

import { LayeredConfig } from '../../src/schemas/config.js';
import type { ResolvedSelection } from '../../src/schemas/selection-policy.js';
import {
  DEFAULT_POWER_TIERS,
  materializePowerSelection,
  resolvePowerDial,
} from '../../src/selection/power-tiers.js';

function layer(name: 'user-global' | 'project' | 'invocation', config: Record<string, unknown>) {
  return LayeredConfig.parse({ layer: name, config: { schema_version: 1, ...config } });
}

function bare(extra: Partial<ResolvedSelection> = {}): ResolvedSelection {
  return { skills: [], invocation_options: {}, ...extra };
}

describe('resolvePowerDial', () => {
  it('defaults to medium when no layer sets the dial (default-on)', () => {
    expect(resolvePowerDial([layer('project', {})])).toBe('medium');
    expect(resolvePowerDial([])).toBe('medium');
  });

  it('reads defaults.power from a config layer', () => {
    expect(resolvePowerDial([layer('project', { defaults: { power: 'low' } })])).toBe('low');
  });

  it('later precedence layers win: invocation over project over user-global', () => {
    expect(
      resolvePowerDial([
        layer('user-global', { defaults: { power: 'high' } }),
        layer('project', { defaults: { power: 'low' } }),
        layer('invocation', { defaults: { power: 'medium' } }),
      ]),
    ).toBe('medium');
    expect(
      resolvePowerDial([
        layer('user-global', { defaults: { power: 'high' } }),
        layer('project', { defaults: { power: 'low' } }),
      ]),
    ).toBe('low');
  });

  it('uses declared precedence even when the array arrives out of order', () => {
    expect(
      resolvePowerDial([
        layer('invocation', { defaults: { power: 'medium' } }),
        layer('project', { defaults: { power: 'low' } }),
      ]),
    ).toBe('medium');
  });
});

describe('materializePowerSelection', () => {
  it('routes the implementer to the small tier at power low on claude-code', () => {
    const out = materializePowerSelection({
      resolved: bare(),
      role: 'implementer',
      connectorName: 'claude-code',
      attempt: 1,
      configLayers: [layer('project', { defaults: { power: 'low' } })],
    });
    expect(out.model).toEqual({ provider: 'anthropic', model: 'haiku' });
    expect(out.power).toBe('low');
    expect(out.power_escalated).toBeUndefined();
  });

  it('keeps the researcher on the big tier at every power level', () => {
    for (const power of ['low', 'medium', 'high'] as const) {
      const out = materializePowerSelection({
        resolved: bare(),
        role: 'researcher',
        connectorName: 'claude-code',
        attempt: 1,
        configLayers: [layer('project', { defaults: { power } })],
      });
      expect(out.model).toEqual({ provider: 'anthropic', model: 'opus' });
    }
  });

  it('routes the reviewer to the mid tier at power low', () => {
    const out = materializePowerSelection({
      resolved: bare(),
      role: 'reviewer',
      connectorName: 'claude-code',
      attempt: 1,
      configLayers: [layer('project', { defaults: { power: 'low' } })],
    });
    expect(out.model).toEqual({ provider: 'anthropic', model: 'sonnet' });
  });

  it('tiers codex by effort only, leaving the model to the operator default', () => {
    const out = materializePowerSelection({
      resolved: bare(),
      role: 'implementer',
      connectorName: 'codex',
      attempt: 1,
      configLayers: [layer('project', { defaults: { power: 'low' } })],
    });
    expect(out.model).toBeUndefined();
    expect(out.effort).toBe('low');
    expect(out.power).toBe('low');
  });

  it('materializes the medium allocation when no layer sets the dial (default-on)', () => {
    const out = materializePowerSelection({
      resolved: bare(),
      role: 'implementer',
      connectorName: 'claude-code',
      attempt: 1,
      configLayers: [],
    });
    expect(out.model).toEqual({ provider: 'anthropic', model: 'sonnet' });
    expect(out.power).toBe('medium');
  });

  it('is inert for a connector with no tier table (cursor-agent, custom)', () => {
    for (const connectorName of ['cursor-agent', 'my-ollama']) {
      const resolved = bare();
      const out = materializePowerSelection({
        resolved,
        role: 'implementer',
        connectorName,
        attempt: 1,
        configLayers: [layer('project', { defaults: { power: 'low' } })],
      });
      expect(out).toEqual(resolved);
    }
  });

  it('never overrides an explicitly configured model', () => {
    const resolved = bare({ model: { provider: 'anthropic', model: 'claude-opus-4-8' } });
    const out = materializePowerSelection({
      resolved,
      role: 'implementer',
      connectorName: 'claude-code',
      attempt: 1,
      configLayers: [layer('project', { defaults: { power: 'low' } })],
    });
    expect(out).toEqual(resolved);
    expect(out.power).toBeUndefined();
  });

  it('keeps an explicitly configured effort over the tier effort', () => {
    const out = materializePowerSelection({
      resolved: bare({ effort: 'xhigh' }),
      role: 'implementer',
      connectorName: 'codex',
      attempt: 1,
      configLayers: [layer('project', { defaults: { power: 'low' } })],
    });
    expect(out.effort).toBe('xhigh');
    expect(out.power).toBe('low');
  });

  it('escalates a retry one tier up and records the escalation', () => {
    const out = materializePowerSelection({
      resolved: bare(),
      role: 'implementer',
      connectorName: 'claude-code',
      attempt: 2,
      configLayers: [layer('project', { defaults: { power: 'low' } })],
    });
    expect(out.model).toEqual({ provider: 'anthropic', model: 'sonnet' });
    expect(out.power_escalated).toBe(true);
  });

  it('caps escalation at the top tier and records no escalation for a role already there', () => {
    const out = materializePowerSelection({
      resolved: bare(),
      role: 'researcher',
      connectorName: 'claude-code',
      attempt: 3,
      configLayers: [layer('project', { defaults: { power: 'low' } })],
    });
    expect(out.model).toEqual({ provider: 'anthropic', model: 'opus' });
    expect(out.power_escalated).toBeUndefined();
  });

  it('lets operator power_tiers config override a single shipped tier', () => {
    const out = materializePowerSelection({
      resolved: bare(),
      role: 'implementer',
      connectorName: 'claude-code',
      attempt: 1,
      configLayers: [
        layer('project', {
          defaults: { power: 'low' },
          power_tiers: {
            'claude-code': { low: { model: { provider: 'anthropic', model: 'claude-haiku-4-5' } } },
          },
        }),
      ],
    });
    expect(out.model).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('gives a custom connector a tier table through config', () => {
    const out = materializePowerSelection({
      resolved: bare(),
      role: 'implementer',
      connectorName: 'my-ollama',
      attempt: 1,
      configLayers: [
        layer('project', {
          defaults: { power: 'low' },
          power_tiers: {
            'my-ollama': { low: { model: { provider: 'custom', model: 'qwen3-coder' } } },
          },
        }),
      ],
    });
    expect(out.model).toEqual({ provider: 'custom', model: 'qwen3-coder' });
    expect(out.power).toBe('low');
  });

  it('ships anthropic tiers as durable aliases, not dated model ids', () => {
    const table = DEFAULT_POWER_TIERS['claude-code'];
    expect(table?.low?.model?.model).toBe('haiku');
    expect(table?.medium?.model?.model).toBe('sonnet');
    expect(table?.high?.model?.model).toBe('opus');
  });
});
