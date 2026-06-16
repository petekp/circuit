import { describe, expect, it } from 'vitest';

import { Config, LayeredConfig, PolicyEnvelopeV2, PolicyLayer } from '../../src/index.js';
import {
  composePolicyHardConstraints,
  policyRefsForConfigLayers,
  projectConfigV1ToPolicyEnvelopeV2,
} from '../../src/policy/policy-envelope.js';

const customConnector = {
  kind: 'custom' as const,
  name: 'local-reviewer',
  command: ['node', 'reviewer.js'],
  prompt_transport: 'prompt-file' as const,
  output: { kind: 'output-file' as const },
  capabilities: {
    filesystem: 'read-only' as const,
    structured_output: 'json' as const,
    tool_scope: 'none' as const,
  },
};

describe('PolicyEnvelopeV2 schema foundation', () => {
  it('accepts schema_version 2 with empty policy buckets', () => {
    const ok = PolicyEnvelopeV2.safeParse({
      schema_version: 2,
      policy: {},
    });

    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.policy.rules.connectors.deny).toEqual([]);
      expect(ok.data.policy.preferences.relay.flow_connector_hints).toEqual([]);
      expect(ok.data.policy.defaults).toEqual({});
    }
  });

  it('keeps config v1 parsing intact while PolicyEnvelopeV2 rejects v1 payloads', () => {
    expect(Config.safeParse({ schema_version: 1 }).success).toBe(true);
    expect(
      LayeredConfig.safeParse({ layer: 'project', config: { schema_version: 1 } }).success,
    ).toBe(true);

    expect(PolicyEnvelopeV2.safeParse({ schema_version: 1, policy: {} }).success).toBe(false);
    expect(
      PolicyEnvelopeV2.safeParse({
        schema_version: 2,
        relay: { default: 'codex' },
        policy: {},
      }).success,
    ).toBe(false);
  });

  it('rejects hard rules shaped like preferences and preferences shaped like hard permissions', () => {
    expect(
      PolicyEnvelopeV2.safeParse({
        schema_version: 2,
        policy: {
          rules: {
            connectors: {
              prefer_connector: { kind: 'builtin', name: 'codex' },
            },
          },
        },
      }).success,
    ).toBe(false);

    expect(
      PolicyEnvelopeV2.safeParse({
        schema_version: 2,
        policy: {
          preferences: {
            writes: { auto_apply: true },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown connector references unless they are registered in policy rules', () => {
    expect(
      PolicyEnvelopeV2.safeParse({
        schema_version: 2,
        policy: {
          preferences: {
            relay: {
              roles: {
                reviewer: {
                  prefer_connector: { kind: 'named', name: 'local-reviewer' },
                },
              },
            },
          },
        },
      }).success,
    ).toBe(false);

    const ok = PolicyEnvelopeV2.safeParse({
      schema_version: 2,
      policy: {
        rules: {
          connectors: {
            registry: { 'local-reviewer': customConnector },
          },
        },
        preferences: {
          relay: {
            roles: {
              reviewer: {
                prefer_connector: { kind: 'named', name: 'local-reviewer' },
              },
            },
          },
        },
      },
    });

    expect(ok.success).toBe(true);
  });

  it('rejects reserved connector registry names and connector-rule typos', () => {
    expect(
      PolicyEnvelopeV2.safeParse({
        schema_version: 2,
        policy: {
          rules: {
            connectors: {
              registry: {
                codex: { ...customConnector, name: 'codex' },
              },
            },
          },
        },
      }).success,
    ).toBe(false);

    expect(
      PolicyEnvelopeV2.safeParse({
        schema_version: 2,
        policy: {
          rules: {
            connectors: {
              allow: ['cdoex'],
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects invocation_options that smuggle old authority', () => {
    expect(
      PolicyEnvelopeV2.safeParse({
        schema_version: 2,
        policy: {
          defaults: {
            selection: {
              invocation_options: {
                nested: {
                  model: { provider: 'openai', model: 'gpt-5' },
                },
              },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('accepts invocation selection as an operator request, not a hard rule', () => {
    const ok = PolicyLayer.safeParse({
      source: 'invocation',
      envelope: {
        schema_version: 2,
        policy: {
          preferences: {
            invocation: {
              selection_request: {
                model: { provider: 'openai', model: 'gpt-5' },
                effort: 'medium',
                invocation_options: {
                  temperature: 0,
                  response_format: { type: 'json_object' },
                },
              },
            },
          },
        },
      },
    });

    expect(ok.success).toBe(true);
  });
});

describe('PolicyEnvelopeV2 hard-rule composition', () => {
  it('composes hard constraints restrictively', () => {
    const user = PolicyEnvelopeV2.parse({
      schema_version: 2,
      policy: {
        rules: {
          connectors: {
            allow: ['claude-code', 'codex'],
            deny: ['cursor-agent'],
          },
          writes: {
            auto_apply: true,
            require_checkpoint_globs: ['docs/**'],
          },
        },
        limits: {
          max_attempts_per_step: 3,
          max_wall_clock_ms: 900000,
          max_effort: 'high',
          max_tournament_n: 4,
        },
      },
    });
    const project = PolicyEnvelopeV2.parse({
      schema_version: 2,
      policy: {
        rules: {
          connectors: {
            allow: ['codex'],
            deny: ['claude-code'],
            deny_for_write: ['cursor-agent'],
          },
          models: {
            deny_providers: ['custom'],
            require_provider_for_connector: { codex: 'openai' },
          },
          writes: {
            auto_apply: false,
            require_checkpoint_globs: ['src/runtime/**'],
          },
          proof: {
            require_independent_review_for: ['generated-surfaces'],
          },
        },
        limits: {
          max_attempts_per_step: 2,
          max_effort: 'medium',
          max_tournament_n: 2,
        },
      },
    });

    const composed = composePolicyHardConstraints([user, project]);

    expect(composed.connectors.allow).toEqual(['codex']);
    expect(composed.connectors.deny).toEqual(['claude-code', 'cursor-agent']);
    expect(composed.connectors.deny_for_write).toEqual(['cursor-agent']);
    expect(composed.models.deny_providers).toEqual(['custom']);
    expect(composed.models.require_provider_for_connector).toEqual({ codex: 'openai' });
    expect(composed.writes.auto_apply).toBe(false);
    expect(composed.writes.require_checkpoint_globs).toEqual(['docs/**', 'src/runtime/**']);
    expect(composed.proof.require_independent_review_for).toEqual(['generated-surfaces']);
    expect(composed.limits.max_attempts_per_step).toBe(2);
    expect(composed.limits.max_wall_clock_ms).toBe(900000);
    expect(composed.limits.max_effort).toBe('medium');
    expect(composed.limits.max_tournament_n).toBe(2);
  });
});

describe('config v1 to PolicyEnvelopeV2 projection', () => {
  it('projects current config fields into rules, preferences, defaults, or rejected old authority', () => {
    const config = Config.parse({
      schema_version: 1,
      relay: {
        default: 'codex',
        roles: {
          reviewer: { kind: 'builtin', name: 'claude-code' },
        },
        circuits: {
          build: { kind: 'builtin', name: 'codex' },
        },
        connectors: {
          'local-reviewer': customConnector,
        },
      },
      skills: {
        bindings: {
          'review-assistant': 'tdd',
        },
      },
      defaults: {
        selection: {
          effort: 'medium',
        },
      },
      circuits: {
        build: {
          selection: {
            model: { provider: 'openai', model: 'gpt-5' },
            effort: 'high',
          },
          skill_bindings: {
            'test-discipline': 'tdd',
          },
          variant_models: [
            {
              id: 'codex-high',
              label: 'Codex high',
              connector: { kind: 'builtin', name: 'codex' },
              selection: {
                model: { provider: 'openai', model: 'gpt-5' },
                effort: 'high',
              },
            },
            {
              id: 'claude-max',
              label: 'Claude max',
              connector: { kind: 'builtin', name: 'claude-code' },
              selection: {
                model: { provider: 'anthropic', model: 'opus' },
                effort: 'max',
              },
            },
          ],
        },
      },
    });

    const projection = projectConfigV1ToPolicyEnvelopeV2({ config, source: 'project' });

    expect(projection.policy_envelope.policy.rules.connectors.registry).toEqual({
      'local-reviewer': customConnector,
    });
    expect(projection.policy_envelope.policy.defaults.connector).toEqual({
      kind: 'builtin',
      name: 'codex',
    });
    expect(projection.policy_envelope.policy.preferences.relay.roles.reviewer).toEqual({
      prefer_connector: { kind: 'builtin', name: 'claude-code' },
    });
    expect(projection.policy_envelope.policy.preferences.relay.flow_connector_hints).toEqual([
      {
        flow_id: 'build',
        prefer_connector: { kind: 'builtin', name: 'codex' },
      },
    ]);
    expect(projection.policy_envelope.policy.preferences.skills.slot_bindings).toEqual({
      'review-assistant': 'tdd',
    });
    expect(projection.policy_envelope.policy.preferences.skills.flow_slot_bindings).toEqual([
      {
        flow_id: 'build',
        bindings: { 'test-discipline': 'tdd' },
      },
    ]);
    expect(projection.policy_envelope.policy.preferences.selection.flow_hints).toHaveLength(1);
    expect(
      projection.policy_envelope.policy.preferences.prototype.variant_model_hints,
    ).toHaveLength(2);
    expect(projection.policy_envelope.policy.defaults.selection?.effort).toBe('medium');
    expect(projection.rejected_old_authority.map((item) => item.field)).toEqual(
      expect.arrayContaining(['relay.circuits', 'circuits.build.variant_models']),
    );
  });

  it('turns config layers into policy refs for guidance provenance', () => {
    const layer = LayeredConfig.parse({
      layer: 'project',
      source_path: '/repo/.circuit/config.yaml',
      config: {
        schema_version: 1,
        relay: {
          default: 'codex',
        },
      },
    });

    const refs = policyRefsForConfigLayers([layer]);

    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({
      kind: 'policy',
      ref: 'policy.runtime.config_v1',
    });
    expect(refs[1]).toMatchObject({
      kind: 'policy',
      ref: '/repo/.circuit/config.yaml',
    });
    expect(refs[1]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps policy refs best-effort for valid v1 config that cannot project cleanly to v2', () => {
    const layer = LayeredConfig.parse({
      layer: 'invocation',
      config: {
        schema_version: 1,
        defaults: {
          selection: {
            invocation_options: {
              connector_specific: {
                model: 'legacy connector option',
              },
            },
          },
        },
      },
    });

    expect(() =>
      projectConfigV1ToPolicyEnvelopeV2({ config: layer.config, source: 'invocation' }),
    ).toThrow();

    const refs = policyRefsForConfigLayers([layer]);

    expect(refs).toHaveLength(2);
    expect(refs[1]).toMatchObject({
      kind: 'policy',
      ref: 'policy.config_v1.invocation.0',
    });
    expect(refs[1]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
