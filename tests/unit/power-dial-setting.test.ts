import { describe, expect, it } from 'vitest';

import { Config, LayeredConfig } from '../../src/schemas/config.js';
import { resolvePowerDial, resolvePowerDialSetting } from '../../src/selection/power-tiers.js';

function layer(name: 'user-global' | 'project' | 'invocation', config: Record<string, unknown>) {
  return LayeredConfig.parse({ layer: name, config: { schema_version: 1, ...config } });
}

describe('config schema: auto dial setting', () => {
  it('accepts defaults.power: auto', () => {
    const parsed = Config.parse({ schema_version: 1, defaults: { power: 'auto' } });
    expect(parsed.defaults.power).toBe('auto');
  });

  it('accepts a power_auto bounds block', () => {
    const parsed = Config.parse({
      schema_version: 1,
      power_auto: { floor: 'low', ceiling: 'medium' },
    });
    expect(parsed.power_auto).toEqual({ floor: 'low', ceiling: 'medium' });
  });

  it('rejects bounds where floor is above ceiling', () => {
    expect(() =>
      Config.parse({ schema_version: 1, power_auto: { floor: 'high', ceiling: 'low' } }),
    ).toThrow(/floor/i);
  });

  it('rejects auto as a power_auto bound', () => {
    expect(() => Config.parse({ schema_version: 1, power_auto: { floor: 'auto' } })).toThrow();
  });

  it('rejects unknown keys in power_auto', () => {
    expect(() => Config.parse({ schema_version: 1, power_auto: { target: 'low' } })).toThrow();
  });
});

describe('resolvePowerDialSetting', () => {
  it('resolves to fixed medium when no layer has an opinion (default-on unchanged)', () => {
    expect(resolvePowerDialSetting([])).toEqual({ kind: 'fixed', value: 'medium' });
    expect(resolvePowerDialSetting([layer('project', {})])).toEqual({
      kind: 'fixed',
      value: 'medium',
    });
  });

  it('resolves an explicit tier to fixed', () => {
    expect(resolvePowerDialSetting([layer('project', { defaults: { power: 'low' } })])).toEqual({
      kind: 'fixed',
      value: 'low',
    });
  });

  it('resolves auto with full-range default bounds', () => {
    expect(resolvePowerDialSetting([layer('project', { defaults: { power: 'auto' } })])).toEqual({
      kind: 'auto',
      floor: 'low',
      ceiling: 'high',
    });
  });

  it('reads declared bounds and layers them per field', () => {
    expect(
      resolvePowerDialSetting([
        layer('user-global', { defaults: { power: 'auto' }, power_auto: { floor: 'medium' } }),
        layer('project', { power_auto: { ceiling: 'medium' } }),
      ]),
    ).toEqual({ kind: 'auto', floor: 'medium', ceiling: 'medium' });
  });

  it('lets a higher-precedence fixed setting beat a lower auto, and vice versa', () => {
    expect(
      resolvePowerDialSetting([
        layer('project', { defaults: { power: 'auto' } }),
        layer('invocation', { defaults: { power: 'high' } }),
      ]),
    ).toEqual({ kind: 'fixed', value: 'high' });
    expect(
      resolvePowerDialSetting([
        layer('project', { defaults: { power: 'high' } }),
        layer('invocation', { defaults: { power: 'auto' } }),
      ]),
    ).toEqual({ kind: 'auto', floor: 'low', ceiling: 'high' });
  });

  it('resolves cross-layer inverted bounds with the ceiling winning (spend cap)', () => {
    // Schema validation catches floor > ceiling inside one document, but two
    // documents can compose into an inverted range. The ceiling is the spend
    // cap, so it wins and the floor lowers to meet it.
    expect(
      resolvePowerDialSetting([
        layer('user-global', { defaults: { power: 'auto' }, power_auto: { floor: 'high' } }),
        layer('project', { power_auto: { ceiling: 'low' } }),
      ]),
    ).toEqual({ kind: 'auto', floor: 'low', ceiling: 'low' });
  });
});

describe('resolvePowerDial with an auto setting', () => {
  it('falls back to medium until an inference threads in', () => {
    // The legacy single-value resolver is what materialization uses when no
    // inferred tier is supplied; auto without an inference behaves as the
    // default-on medium, never as a crash or a surprise high.
    expect(resolvePowerDial([layer('project', { defaults: { power: 'auto' } })])).toBe('medium');
  });
});
