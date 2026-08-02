// A standing per-flow process choice.
//
// The interactive front door offered "<flow> depth" as a picker with
// low/medium/high and wrote `flows.<id>.selection.depth`. The schema accepted
// it and nothing read it: a run's process comes from `--process` or from the
// power dial, and when a flow binds execution depth the relay overwrites that
// selection value outright. Setting it low and setting it high produced a
// byte-identical `circuit preview build`, still reporting process: medium.
//
// A person who tells the front door they want shallow builds means it, so the
// setting is now real and carries the operator's word for it. `depth` is
// retired vocabulary (UBIQUITOUS_LANGUAGE.md) and stays internal.

import { describe, expect, it } from 'vitest';

import { Config, LayeredConfig } from '../../src/schemas/config.js';
import { resolveFlowProcessSetting } from '../../src/selection/flow-process.js';

function layer(name: 'user-global' | 'project' | 'invocation', config: Record<string, unknown>) {
  return LayeredConfig.parse({
    layer: name,
    source_path: `/${name}.yaml`,
    config: Config.parse({ schema_version: 1, ...config }),
  });
}

describe('flows.<id>.process', () => {
  it('parses as a config key', () => {
    expect(() =>
      Config.parse({ schema_version: 1, flows: { build: { process: 'low' } } }),
    ).not.toThrow();
  });

  it('rejects a value that is not a process', () => {
    expect(() =>
      Config.parse({ schema_version: 1, flows: { build: { process: 'shallow' } } }),
    ).toThrow();
  });

  it('is absent when no layer sets one', () => {
    expect(resolveFlowProcessSetting([], 'build')).toBeUndefined();
    expect(resolveFlowProcessSetting([layer('project', {})], 'build')).toBeUndefined();
  });

  it('reads the value a layer set for that flow', () => {
    const layers = [layer('project', { flows: { build: { process: 'low' } } })];
    expect(resolveFlowProcessSetting(layers, 'build')).toBe('low');
  });

  it('is per flow, not global', () => {
    const layers = [layer('project', { flows: { build: { process: 'low' } } })];
    expect(resolveFlowProcessSetting(layers, 'review')).toBeUndefined();
  });

  it('lets the higher-precedence layer win regardless of array order', () => {
    const layers = [
      layer('project', { flows: { build: { process: 'high' } } }),
      layer('user-global', { flows: { build: { process: 'low' } } }),
    ];
    expect(resolveFlowProcessSetting(layers, 'build')).toBe('high');
  });

  it('lets an invocation layer outrank the project', () => {
    const layers = [
      layer('project', { flows: { build: { process: 'low' } } }),
      layer('invocation', { flows: { build: { process: 'high' } } }),
    ];
    expect(resolveFlowProcessSetting(layers, 'build')).toBe('high');
  });
});
