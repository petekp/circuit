// Config + LayeredConfig schemas — see docs/contracts/config.md.

import { describe, expect, it } from 'vitest';
import { Config, ConfigLayer, FlowOverride, LayeredConfig } from '../../src/index.js';

describe('Config strict surface (CONFIG-I1)', () => {
  it('accepts bare `{schema_version: 1}` and applies all defaults (CONFIG-I7)', () => {
    const ok = Config.safeParse({ schema_version: 1 });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.host).toBeUndefined();
      expect(ok.data.relay.default).toBe('auto');
      expect(ok.data.skills).toEqual({ bindings: {} });
      expect(ok.data.skill_hooks).toEqual({ policy: {}, detection: { disabled_patterns: {} } });
      expect(ok.data.flows).toEqual({});
      expect(ok.data.defaults).toEqual({});
    }
  });

  it('distinguishes omitted host from an explicit generic-shell host', () => {
    const omitted = Config.parse({ schema_version: 1 });
    const explicit = Config.parse({ schema_version: 1, host: {} });

    expect(omitted.host).toBeUndefined();
    expect(explicit.host?.kind).toBe('generic-shell');
  });

  it('rejects surplus top-level key (CONFIG-I1 — `defuults` typo at root)', () => {
    const bad = Config.safeParse({
      schema_version: 1,
      defuults: { selection: {} },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus top-level key (CONFIG-I1 — `dispath` typo at root)', () => {
    const bad = Config.safeParse({
      schema_version: 1,
      dispath: { default: 'codex' },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects schema_version other than 1 (CONFIG-I6)', () => {
    const bad = Config.safeParse({ schema_version: 2 });
    expect(bad.success).toBe(false);
  });

  it('rejects missing schema_version', () => {
    const bad = Config.safeParse({});
    expect(bad.success).toBe(false);
  });
});

describe('Config.defaults nested strict surface (CONFIG-I4)', () => {
  it('accepts empty defaults object', () => {
    const ok = Config.safeParse({ schema_version: 1, defaults: {} });
    expect(ok.success).toBe(true);
  });

  it('accepts defaults.selection as a valid SelectionOverride', () => {
    const ok = Config.safeParse({
      schema_version: 1,
      defaults: { selection: { effort: 'medium' } },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects surplus key inside defaults (CONFIG-I4 — `selections` plural typo)', () => {
    const bad = Config.safeParse({
      schema_version: 1,
      defaults: { selections: { effort: 'medium' } },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects unexpected nested field in defaults (CONFIG-I4 — attempted smuggle)', () => {
    const bad = Config.safeParse({
      schema_version: 1,
      defaults: { selection: {}, depth: 'crucible' },
    });
    expect(bad.success).toBe(false);
  });
});

describe('Config.skills bindings', () => {
  it('accepts top-level skill slot bindings', () => {
    const ok = Config.safeParse({
      schema_version: 1,
      skills: {
        bindings: {
          'review-assistant': 'react-change-review',
          'test-discipline': 'tdd',
        },
      },
    });

    expect(ok.success).toBe(true);
  });

  it('rejects invalid top-level skill binding values', () => {
    const bad = Config.safeParse({
      schema_version: 1,
      skills: {
        bindings: {
          'review-assistant': 'ReactDoctor',
        },
      },
    });

    expect(bad.success).toBe(false);
  });

  it('rejects the old top-level `skills: string[]` shortcut', () => {
    const bad = Config.safeParse({
      schema_version: 1,
      skills: ['tdd'],
    });

    expect(bad.success).toBe(false);
  });
});

describe('FlowOverride strict surface (CONFIG-I3)', () => {
  it('accepts empty circuit override', () => {
    const ok = FlowOverride.safeParse({});
    expect(ok.success).toBe(true);
  });

  it('accepts circuit override with selection field', () => {
    const ok = FlowOverride.safeParse({ selection: { effort: 'high' } });
    expect(ok.success).toBe(true);
  });

  it('accepts circuit skill bindings', () => {
    const ok = FlowOverride.safeParse({
      skill_bindings: { 'review-assistant': 'react-change-review' },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts typed Prototype variant model matrices', () => {
    const ok = FlowOverride.safeParse({
      variant_models: [
        {
          id: 'variant-a',
          label: 'Variant A',
          connector: { kind: 'builtin', name: 'claude-code' },
          selection: {
            model: { provider: 'anthropic', model: 'local-fixture-a' },
            effort: 'medium',
          },
        },
        {
          id: 'variant-b',
          label: 'Variant B',
          selection: {
            model: { provider: 'anthropic', model: 'local-fixture-b' },
            effort: 'high',
          },
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts connector-aware Prototype tournament defaults', () => {
    const ok = FlowOverride.safeParse({
      variant_models: [
        {
          id: 'codex-55-xhigh',
          label: 'Codex 5.5 xhigh',
          connector: { kind: 'builtin', name: 'codex' },
          selection: {
            model: { provider: 'openai', model: 'gpt-5.5' },
            effort: 'xhigh',
          },
        },
        {
          id: 'opus-47-max',
          label: 'Claude Opus 4.7 max',
          connector: { kind: 'builtin', name: 'claude-code' },
          selection: {
            model: { provider: 'anthropic', model: 'claude-opus-4-7' },
            effort: 'max',
          },
        },
        {
          id: 'gemini-35-flash-cursor',
          label: 'Gemini 3.5 Flash via Cursor',
          connector: { kind: 'builtin', name: 'cursor-agent' },
          selection: {
            model: { provider: 'gemini', model: 'gemini-3.5-flash' },
            effort: 'none',
          },
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects unsafe or incomplete Prototype variant model matrices', () => {
    expect(
      FlowOverride.safeParse({
        variant_models: [
          {
            id: 'variant-a',
            label: 'Variant A',
            selection: {
              model: { provider: 'anthropic', model: 'local-fixture-a' },
              effort: 'medium',
            },
          },
          {
            id: 'variant-a',
            label: 'Duplicate Variant A',
            selection: {
              model: { provider: 'anthropic', model: 'local-fixture-b' },
              effort: 'medium',
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      FlowOverride.safeParse({
        variant_models: [
          {
            id: '../escape',
            label: 'Bad id',
            selection: {
              model: { provider: 'anthropic', model: 'local-fixture-a' },
              effort: 'medium',
            },
          },
          {
            id: 'variant-b',
            label: 'Missing effort',
            selection: {
              model: { provider: 'anthropic', model: 'local-fixture-b' },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects circuit override with `skills: string[]` v0.0 shortcut (CONFIG-I3)', () => {
    const bad = FlowOverride.safeParse({ skills: ['runtime-proof'] });
    expect(bad.success).toBe(false);
  });

  it('rejects invalid circuit skill binding keys', () => {
    const bad = FlowOverride.safeParse({
      skill_bindings: { review_assistant: 'react-change-review' },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects circuit override with surplus key (CONFIG-I3 — typo smuggle)', () => {
    const bad = FlowOverride.safeParse({ selection: {}, priority: 'high' });
    expect(bad.success).toBe(false);
  });
});

describe('LayeredConfig strict surface (CONFIG-I2)', () => {
  it('accepts minimal LayeredConfig with required fields only', () => {
    const ok = LayeredConfig.safeParse({
      layer: 'user-global',
      config: { schema_version: 1 },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts LayeredConfig with optional source_path', () => {
    const ok = LayeredConfig.safeParse({
      layer: 'project',
      source_path: '/workspace/.circuit/config.yaml',
      config: { schema_version: 1 },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects LayeredConfig with surplus wrapper-level key (CONFIG-I2)', () => {
    const bad = LayeredConfig.safeParse({
      layer: 'project',
      source_path: '/workspace/.circuit/config.yaml',
      config: { schema_version: 1 },
      checksum: 'sha256:deadbeef',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects LayeredConfig with `souce_path` typo (CONFIG-I2 — silent-strip defense)', () => {
    const bad = LayeredConfig.safeParse({
      layer: 'project',
      souce_path: '/workspace/.circuit/config.yaml',
      config: { schema_version: 1 },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects LayeredConfig whose config payload carries a surplus key (CONFIG-I1 transitivity)', () => {
    const bad = LayeredConfig.safeParse({
      layer: 'default',
      config: { schema_version: 1, defuults: {} },
    });
    expect(bad.success).toBe(false);
  });
});

describe('ConfigLayer closed enum (CONFIG-I5)', () => {
  it('accepts the four documented layers', () => {
    for (const layer of ['default', 'user-global', 'project', 'invocation']) {
      expect(ConfigLayer.safeParse(layer).success).toBe(true);
    }
  });

  it('rejects an undocumented layer name (CONFIG-I5)', () => {
    expect(ConfigLayer.safeParse('environment').success).toBe(false);
    expect(ConfigLayer.safeParse('remote').success).toBe(false);
    expect(ConfigLayer.safeParse('').success).toBe(false);
  });
});

describe('Config.flows key closure (CONFIG-I8)', () => {
  it('accepts a valid slug CompiledFlowId as a flows key', () => {
    const ok = Config.safeParse({
      schema_version: 1,
      flows: { explore: { selection: { effort: 'medium' } } },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a flows key that fails CompiledFlowId regex (CONFIG-I8 — whitespace)', () => {
    const bad = Config.safeParse({
      schema_version: 1,
      flows: { 'Bad Id': {} },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a flows key that fails CompiledFlowId regex (CONFIG-I8 — path separator)', () => {
    const bad = Config.safeParse({
      schema_version: 1,
      flows: { 'flow/name': {} },
    });
    expect(bad.success).toBe(false);
  });
});

describe('Config strictness scoped to declared shapes', () => {
  it('rejects a typo INSIDE SelectionOverride (declared shape — `rigr` for `depth`)', () => {
    const bad = Config.safeParse({
      schema_version: 1,
      defaults: { selection: { rigr: 'crucible' } },
    });
    expect(bad.success).toBe(false);
  });

  it('accepts arbitrary keys INSIDE invocation_options (open data-map value by design)', () => {
    const ok = Config.safeParse({
      schema_version: 1,
      defaults: {
        selection: {
          invocation_options: {
            some_connector_key: 'value',
            another_knob: 42,
            nested_payload: { a: 1, b: [2, 3] },
          },
        },
      },
    });
    expect(ok.success).toBe(true);
  });
});

describe('LayeredConfig default-layer ergonomic (CONFIG-I7 + CONFIG-I2 composition)', () => {
  it('`{layer: "default", config: {schema_version: 1}}` parses and produces all schema-level defaults', () => {
    const ok = LayeredConfig.safeParse({
      layer: 'default',
      config: { schema_version: 1 },
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.layer).toBe('default');
      expect(ok.data.config.schema_version).toBe(1);
      expect(ok.data.config.relay.default).toBe('auto');
      expect(ok.data.config.relay.roles).toEqual({});
      expect(ok.data.config.relay.flows).toEqual({});
      expect(ok.data.config.relay.connectors).toEqual({});
      expect(ok.data.config.skill_hooks).toEqual({
        policy: {},
        detection: { disabled_patterns: {} },
      });
      expect(ok.data.config.flows).toEqual({});
      expect(ok.data.config.defaults).toEqual({});
    }
  });
});
