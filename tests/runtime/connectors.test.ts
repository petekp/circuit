import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertConnectorCanRunRole,
  assertConnectorSelectionCompatible,
  classifyConnectorFilesystem,
  classifyRelayWriteMode,
  resolveConnectorForGuidanceInput,
} from '../../src/connectors/resolver.js';
import type { RuntimeIndexedRelayStep } from '../../src/flows/registries/runtime-index.js';
import { projectConfigV1ToPolicyEnvelopeV2 } from '../../src/policy/policy-envelope.js';
import type { RelayConnector } from '../../src/runtime/executors/relay.js';
import type { ExecutableFlow, RelayStep } from '../../src/runtime/manifest/executable-flow.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import { planRelayGuidanceDecision } from '../../src/runtime/run/relay-guidance.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import {
  Config,
  LayeredConfig,
  type LayeredConfig as LayeredConfigValue,
} from '../../src/schemas/config.js';
import { CustomConnectorDescriptor } from '../../src/schemas/connector.js';
import { CompiledDepth } from '../../src/schemas/depth.js';
import {
  PolicyLayer,
  type PolicyLayer as PolicyLayerValue,
} from '../../src/schemas/policy-envelope.js';
import {
  SelectionOverride,
  type SelectionOverride as SelectionOverrideValue,
} from '../../src/schemas/selection-policy.js';

describe('runtime connector safety', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'circuit-runtime-connectors-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function relaySafetyFlow(overrides: Partial<RelayStep> = {}): ExecutableFlow {
    const step: RelayStep = {
      id: 'relay-step',
      kind: 'relay',
      role: 'implementer',
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['accept'],
      },
      routes: { pass: { kind: 'terminal', target: '@complete' } },
      writes: { report: { path: 'reports/relay-report.json' } },
      ...overrides,
    };

    return {
      id: 'connector-safety',
      version: '0.1.0',
      entry: step.id,
      stages: [{ id: 'act', stepIds: [step.id] }],
      steps: [step],
    };
  }

  function relayGuidanceExecution(input: {
    readonly flowId?: string;
    readonly role: string;
    readonly selection?: unknown;
    readonly stepConnector?: string;
    readonly suppliedConnector?: RelayConnector;
    readonly hostKind?: RunContext['hostKind'];
    readonly configLayers?: readonly LayeredConfigValue[];
    readonly policyLayers?: readonly PolicyLayerValue[];
  }) {
    const flowId = input.flowId ?? 'review';
    const rawSelection = input.selection as Partial<SelectionOverrideValue> | undefined;
    const selectionOverride =
      input.selection === undefined
        ? undefined
        : SelectionOverride.parse({
            ...rawSelection,
            skills: rawSelection?.skills ?? { mode: 'inherit' },
            invocation_options: rawSelection?.invocation_options ?? {},
          });
    const runtimeSelection: RelayStep['selection'] | undefined =
      selectionOverride === undefined
        ? undefined
        : {
            ...(selectionOverride.model === undefined ? {} : { model: selectionOverride.model }),
            ...(selectionOverride.effort === undefined ? {} : { effort: selectionOverride.effort }),
            ...(selectionOverride.skills === undefined ? {} : { skills: selectionOverride.skills }),
            ...(selectionOverride.depth === undefined ? {} : { depth: selectionOverride.depth }),
            ...(selectionOverride.invocation_options === undefined
              ? {}
              : { invocation_options: selectionOverride.invocation_options }),
          };
    const step: RelayStep = {
      id: 'relay-step',
      kind: 'relay',
      role: input.role,
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['accept'],
      },
      routes: { pass: { kind: 'terminal', target: '@complete' } },
      writes: {
        request: { path: 'request.txt' },
        receipt: { path: 'receipt.txt' },
        result: { path: 'result.json' },
      },
      ...(runtimeSelection === undefined ? {} : { selection: runtimeSelection }),
      ...(input.stepConnector === undefined ? {} : { connector: input.stepConnector }),
    };
    const compiledStep: RuntimeIndexedRelayStep = {
      id: step.id,
      title: step.id,
      protocol: step.id,
      reads: [],
      routes: { pass: '@complete' },
      writes: {
        request: 'request.txt',
        receipt: 'receipt.txt',
        result: 'result.json',
      },
      check: { pass: ['ok'] },
      skill_slots: [],
      kind: 'relay',
      role: step.role as RuntimeIndexedRelayStep['role'],
      ...(selectionOverride === undefined ? {} : { selection: selectionOverride }),
      ...(input.stepConnector === undefined ? {} : { connector: input.stepConnector }),
    };
    const context = {
      flow: {
        id: flowId,
        version: '0.1.0',
        entry: step.id,
        stages: [{ id: 'main', stepIds: [step.id] }],
        steps: [step],
      },
      packageIndex: {
        flow: {
          id: flowId,
          version: '0.1.0',
          stages: [{ id: 'main', steps: [step.id] }],
          steps: [compiledStep],
        },
        stepsById: new Map([[step.id, compiledStep]]),
        reportPathBySchema: new Map(),
      },
      hostKind: input.hostKind,
      selectionConfigLayers: input.configLayers,
      policyLayers: input.policyLayers,
    } as unknown as RunContext;
    return planRelayGuidanceDecision({
      context,
      step,
      compiledStep,
      depth: CompiledDepth.parse('medium'),
      ...(input.suppliedConnector === undefined
        ? {}
        : { suppliedConnector: input.suppliedConnector }),
    }).relayExecution;
  }

  it('defaults auto relay resolution to claude-code for generic shell', () => {
    const decision = resolveConnectorForGuidanceInput({ flowId: 'review', role: 'reviewer' });
    expect(decision.connector).toEqual({ kind: 'builtin', name: 'claude-code' });
    expect(decision.resolvedFrom).toEqual({ source: 'auto' });
  });

  it('defaults auto relay resolution to the current host connector', () => {
    const codexDecision = relayGuidanceExecution({
      flowId: 'build',
      role: 'implementer',
      hostKind: 'codex',
      configLayers: [],
    });
    expect(codexDecision.connectorName).toBe('codex');
    expect(codexDecision.resolvedFrom).toEqual({ source: 'auto' });

    const claudeDecision = relayGuidanceExecution({
      flowId: 'build',
      role: 'implementer',
      hostKind: 'claude-code',
      configLayers: [],
    });
    expect(claudeDecision.connectorName).toBe('claude-code');
    expect(claudeDecision.resolvedFrom).toEqual({ source: 'auto' });
  });

  it('lets a higher-precedence generic-shell host reset lower host config for auto routing', () => {
    const userLayer = LayeredConfig.parse({
      layer: 'user-global',
      config: {
        schema_version: 1,
        host: { kind: 'codex' },
        relay: {
          default: 'auto',
          roles: {},
          flows: {},
          connectors: {},
        },
        flows: {},
        defaults: {},
      },
    });
    const projectLayer = LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        host: { kind: 'generic-shell' },
        relay: {
          default: 'auto',
          roles: {},
          flows: {},
          connectors: {},
        },
        flows: {},
        defaults: {},
      },
    });

    const decision = resolveConnectorForGuidanceInput({
      flowId: 'build',
      role: 'implementer',
      configLayers: [userLayer, projectLayer],
    });

    expect(decision.connectorName).toBe('claude-code');
    expect(decision.resolvedFrom).toEqual({ source: 'auto' });
  });

  it('does not let an omitted higher-precedence host reset lower host config', () => {
    const userLayer = LayeredConfig.parse({
      layer: 'user-global',
      config: {
        schema_version: 1,
        host: { kind: 'codex' },
        relay: {
          default: 'auto',
          roles: {},
          flows: {},
          connectors: {},
        },
        flows: {},
        defaults: {},
      },
    });
    const projectLayer = LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        relay: {
          default: 'auto',
          roles: {},
          flows: {},
          connectors: {},
        },
        flows: {},
        defaults: {},
      },
    });

    const decision = resolveConnectorForGuidanceInput({
      flowId: 'build',
      role: 'implementer',
      configLayers: [userLayer, projectLayer],
    });

    expect(decision.connectorName).toBe('codex');
    expect(decision.resolvedFrom).toEqual({ source: 'auto' });
  });

  it('rejects read-only connectors for implementer roles', () => {
    expect(() =>
      assertConnectorCanRunRole(
        CustomConnectorDescriptor.parse({
          kind: 'custom',
          name: 'local-readonly',
          command: ['node', 'readonly.js'],
          prompt_transport: 'prompt-file',
          output: { kind: 'output-file' },
          capabilities: { filesystem: 'read-only', structured_output: 'json' },
        }),
        'implementer',
      ),
    ).toThrow(/read-only/);
  });

  it('accepts write-capable built-ins for implementer roles', () => {
    expect(() =>
      assertConnectorCanRunRole({ kind: 'builtin', name: 'codex' }, 'implementer'),
    ).not.toThrow();
    expect(() =>
      assertConnectorCanRunRole({ kind: 'builtin', name: 'cursor-agent' }, 'implementer'),
    ).not.toThrow();
  });

  it('classifies current built-in write-capable connectors as pre-SafeApply trusted writes', () => {
    for (const name of ['claude-code', 'codex', 'cursor-agent'] as const) {
      expect(classifyRelayWriteMode({ kind: 'builtin', name })).toEqual({
        filesystem: 'trusted-write',
        write_capable: true,
        work_root_kind: 'pre_safe_apply_trusted_write',
        may_unlock_higher_autonomy_after_safe_apply: false,
        reason: 'connector can mutate the parent checkout before SafeApply',
      });
    }
  });

  it('keeps read-only and isolated connector write classifications distinct', () => {
    expect(
      classifyConnectorFilesystem({
        filesystem: 'read-only',
        structured_output: 'json',
        tool_scope: 'none',
      }),
    ).toEqual({
      filesystem: 'read-only',
      write_capable: false,
      may_unlock_higher_autonomy_after_safe_apply: false,
      reason: 'connector is read-only',
    });

    expect(
      classifyConnectorFilesystem({
        filesystem: 'isolated-write',
        structured_output: 'json',
        tool_scope: 'none',
      }),
    ).toEqual({
      filesystem: 'isolated-write',
      write_capable: true,
      work_root_kind: 'isolated_worktree',
      may_unlock_higher_autonomy_after_safe_apply: true,
      reason: 'connector writes outside the parent checkout',
    });
  });

  it('resolves declared custom connectors by role without losing identity', () => {
    const custom = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'local-reviewer',
      command: ['node', 'reviewer.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });
    const layer = LayeredConfig.parse({
      // A custom connector's command is honored only from the operator's own
      // config, so the trusted user-global layer is where role routing to a
      // custom connector is declared (a project layer would be refused).
      layer: 'user-global',
      config: {
        schema_version: 1,
        host: { kind: 'generic-shell' },
        relay: {
          default: 'auto',
          roles: { reviewer: { kind: 'named', name: 'local-reviewer' } },
          flows: {},
          connectors: { 'local-reviewer': custom },
        },
        flows: {},
        defaults: {},
      },
    });

    const decision = resolveConnectorForGuidanceInput({
      flowId: 'review',
      role: 'reviewer',
      configLayers: [layer],
    });
    expect(decision.connectorName).toBe('local-reviewer');
    expect(decision.resolvedFrom).toEqual({ source: 'role', role: 'reviewer' });
  });

  it('threads config layers through relay guidance planning', () => {
    const layer = LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        host: { kind: 'generic-shell' },
        relay: {
          default: 'codex',
          roles: {},
          flows: {},
          connectors: {},
        },
        flows: {},
        defaults: {},
      },
    });

    const decision = relayGuidanceExecution({
      flowId: 'review',
      role: 'reviewer',
      configLayers: [layer],
    });

    expect(decision.connectorName).toBe('codex');
    expect(decision.resolvedFrom).toEqual({ source: 'default' });
  });

  it('uses PolicyEnvelope flow connector hints before legacy v1 flow routing', () => {
    const legacyLayer = LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        relay: {
          default: 'codex',
          roles: {},
          flows: {
            review: { kind: 'builtin', name: 'codex' },
          },
          connectors: {},
        },
      },
    });
    const policyLayer = PolicyLayer.parse({
      source: 'project',
      envelope: {
        schema_version: 2,
        policy: {
          preferences: {
            relay: {
              flow_connector_hints: [
                {
                  flow_id: 'review',
                  prefer_connector: { kind: 'builtin', name: 'claude-code' },
                },
              ],
            },
          },
        },
      },
    });

    const decision = relayGuidanceExecution({
      flowId: 'review',
      role: 'reviewer',
      configLayers: [legacyLayer],
      policyLayers: [policyLayer],
    });

    expect(decision.connectorName).toBe('claude-code');
    expect(decision.resolvedFrom).toEqual({ source: 'flow', flow_id: 'review' });
  });

  it('uses PolicyEnvelope connector defaults before legacy v1 relay defaults', () => {
    const legacyLayer = LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        relay: {
          default: 'codex',
        },
      },
    });
    const policyLayer = PolicyLayer.parse({
      source: 'project',
      envelope: {
        schema_version: 2,
        policy: {
          defaults: {
            connector: { kind: 'builtin', name: 'claude-code' },
          },
        },
      },
    });

    const decision = relayGuidanceExecution({
      flowId: 'review',
      role: 'reviewer',
      configLayers: [legacyLayer],
      policyLayers: [policyLayer],
    });

    expect(decision.connectorName).toBe('claude-code');
    expect(decision.resolvedFrom).toEqual({ source: 'default' });
  });

  it('resolves custom step connector capabilities from PolicyEnvelope before legacy config', () => {
    const legacyCustom = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'local-reviewer',
      command: ['node', 'legacy-reviewer.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });
    const policyCustom = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'local-reviewer',
      command: ['node', 'policy-reviewer.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });
    const legacyLayer = LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        relay: {
          connectors: { 'local-reviewer': legacyCustom },
        },
      },
    });
    // A custom connector's command is honored only from a policy layer the
    // operator controls, so the trusted user-global layer is where this
    // policy-schema custom connector lives (a project-origin policy layer would
    // be refused — see the policy trust-boundary tests below). This still proves
    // the policy registry resolves the step-pinned custom connector ahead of the
    // legacy v1 config registry.
    const policyLayer = PolicyLayer.parse({
      source: 'user-global',
      envelope: {
        schema_version: 2,
        policy: {
          rules: {
            connectors: {
              registry: { 'local-reviewer': policyCustom },
            },
          },
        },
      },
    });

    const decision = relayGuidanceExecution({
      flowId: 'review',
      role: 'reviewer',
      stepConnector: 'local-reviewer',
      configLayers: [legacyLayer],
      policyLayers: [policyLayer],
    });

    expect(decision.connectorName).toBe('local-reviewer');
    expect(decision.connector).toEqual(policyCustom);
    expect(decision.resolvedFrom).toEqual({ source: 'explicit' });
  });

  it('applies PolicyEnvelope connector rules to explicit relay connectors', () => {
    const policyLayer = PolicyLayer.parse({
      source: 'project',
      envelope: {
        schema_version: 2,
        policy: {
          rules: {
            connectors: {
              allow: ['codex'],
            },
          },
        },
      },
    });

    expect(() =>
      relayGuidanceExecution({
        flowId: 'review',
        role: 'reviewer',
        stepConnector: 'claude-code',
        policyLayers: [policyLayer],
      }),
    ).toThrow("PolicyEnvelope disallows connector 'claude-code'");
  });

  it('applies PolicyEnvelope provider rules to explicit relay selection', () => {
    const policyLayer = PolicyLayer.parse({
      source: 'project',
      envelope: {
        schema_version: 2,
        policy: {
          rules: {
            models: {
              deny_providers: ['openai'],
            },
          },
        },
      },
    });

    expect(() =>
      relayGuidanceExecution({
        flowId: 'review',
        role: 'reviewer',
        stepConnector: 'codex',
        selection: { model: { provider: 'openai', model: 'gpt-5' }, effort: 'medium' },
        policyLayers: [policyLayer],
      }),
    ).toThrow("PolicyEnvelope disallows provider 'openai'");
  });

  it('applies PolicyEnvelope effort limits to explicit relay selection', () => {
    const policyLayer = PolicyLayer.parse({
      source: 'project',
      envelope: {
        schema_version: 2,
        policy: {
          limits: {
            max_effort: 'medium',
          },
        },
      },
    });

    expect(() =>
      relayGuidanceExecution({
        flowId: 'review',
        role: 'reviewer',
        stepConnector: 'claude-code',
        selection: {
          model: { provider: 'anthropic', model: 'claude-opus-4-7' },
          effort: 'high',
        },
        policyLayers: [policyLayer],
      }),
    ).toThrow("PolicyEnvelope disallows effort 'high'");
  });

  it('honors a builtin step connector without a supplied relay connector', () => {
    const decision = relayGuidanceExecution({
      flowId: 'review',
      role: 'reviewer',
      stepConnector: 'claude-code',
    });

    expect(decision.connectorName).toBe('claude-code');
    expect(decision.connector).toEqual({ kind: 'builtin', name: 'claude-code' });
    expect(decision.resolvedFrom).toEqual({ source: 'explicit' });
  });

  it('honors the codex step connector for implementer roles', () => {
    const decision = relayGuidanceExecution({
      flowId: 'prototype',
      role: 'implementer',
      stepConnector: 'codex',
      selection: { model: { provider: 'openai', model: 'gpt-5.5' }, effort: 'xhigh' },
    });

    expect(decision.connectorName).toBe('codex');
    expect(decision.connector).toEqual({ kind: 'builtin', name: 'codex' });
    expect(decision.resolvedFrom).toEqual({ source: 'explicit' });
  });

  it('honors the cursor-agent step connector for Gemini implementer roles', () => {
    const decision = relayGuidanceExecution({
      flowId: 'prototype',
      role: 'implementer',
      stepConnector: 'cursor-agent',
      selection: { model: { provider: 'gemini', model: 'gemini-3.5-flash' }, effort: 'none' },
    });

    expect(decision.connectorName).toBe('cursor-agent');
    expect(decision.connector).toEqual({ kind: 'builtin', name: 'cursor-agent' });
    expect(decision.resolvedFrom).toEqual({ source: 'explicit' });
  });

  it('rejects read-only custom step connectors without a supplied relay connector', () => {
    const custom = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'local-readonly',
      command: ['node', 'readonly.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });
    const layer = LayeredConfig.parse({
      // Declared in the trusted user-global layer so the read-only role check is
      // what rejects it here, not the project-layer trust boundary.
      layer: 'user-global',
      config: {
        schema_version: 1,
        relay: {
          connectors: { 'local-readonly': custom },
        },
      },
    });

    expect(() =>
      relayGuidanceExecution({
        flowId: 'build',
        role: 'implementer',
        stepConnector: 'local-readonly',
        configLayers: [layer],
      }),
    ).toThrow(/connector 'local-readonly' is read-only/);
  });

  it('resolves a custom step connector from config layers without a supplied relay connector', () => {
    const custom = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'local-reviewer',
      command: ['node', 'reviewer.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });
    const layer = LayeredConfig.parse({
      // A step-pinned custom connector resolves its command only from a trusted
      // layer; the operator's user-global config is that trusted source.
      layer: 'user-global',
      config: {
        schema_version: 1,
        host: { kind: 'generic-shell' },
        relay: {
          default: 'auto',
          roles: {},
          flows: {},
          connectors: { 'local-reviewer': custom },
        },
        flows: {},
        defaults: {},
      },
    });

    const decision = relayGuidanceExecution({
      flowId: 'review',
      role: 'reviewer',
      stepConnector: 'local-reviewer',
      configLayers: [layer],
    });

    expect(decision.connectorName).toBe('local-reviewer');
    expect(decision.connector).toEqual(custom);
    expect(decision.resolvedFrom).toEqual({ source: 'explicit' });
  });

  it('honors trusted-layer precedence for custom step connector descriptors', () => {
    const lowerPrecedence = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'local-reviewer',
      command: ['node', 'user-reviewer.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });
    const higherPrecedence = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'local-reviewer',
      command: ['node', 'invocation-reviewer.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });
    const userLayer = LayeredConfig.parse({
      layer: 'user-global',
      config: {
        schema_version: 1,
        host: { kind: 'generic-shell' },
        relay: {
          default: 'auto',
          roles: {},
          flows: {},
          connectors: { 'local-reviewer': lowerPrecedence },
        },
        flows: {},
        defaults: {},
      },
    });
    // Precedence still applies among trusted layers: an invocation-time
    // override outranks the user-global config. (A project layer, by contrast,
    // cannot contribute a custom command connector at all — see the trust
    // boundary tests below.)
    const invocationLayer = LayeredConfig.parse({
      layer: 'invocation',
      config: {
        schema_version: 1,
        host: { kind: 'generic-shell' },
        relay: {
          default: 'auto',
          roles: {},
          flows: {},
          connectors: { 'local-reviewer': higherPrecedence },
        },
        flows: {},
        defaults: {},
      },
    });

    const decision = relayGuidanceExecution({
      flowId: 'review',
      role: 'reviewer',
      stepConnector: 'local-reviewer',
      configLayers: [userLayer, invocationLayer],
    });

    expect(decision.connectorName).toBe('local-reviewer');
    expect(decision.connector).toEqual(higherPrecedence);
    expect(decision.resolvedFrom).toEqual({ source: 'explicit' });
  });

  it('rejects a custom step connector that has no resolved capabilities', () => {
    expect(() =>
      relayGuidanceExecution({
        flowId: 'review',
        role: 'reviewer',
        stepConnector: 'local-reviewer',
      }),
    ).toThrow(
      "relay connector 'local-reviewer' requires resolved connector capabilities before execution",
    );
  });

  it('keeps custom connectors read-only and rejects empty argv elements', () => {
    expect(() =>
      CustomConnectorDescriptor.parse({
        kind: 'custom',
        name: 'writer',
        command: ['node', 'writer.js'],
        prompt_transport: 'prompt-file',
        output: { kind: 'output-file' },
        capabilities: { filesystem: 'trusted-write', structured_output: 'json' },
      }),
    ).toThrow(/custom connectors are read-only/);

    expect(() =>
      CustomConnectorDescriptor.parse({
        kind: 'custom',
        name: 'bad-argv',
        command: ['node', ''],
        prompt_transport: 'prompt-file',
        output: { kind: 'output-file' },
        capabilities: { filesystem: 'read-only', structured_output: 'json' },
      }),
    ).toThrow();
  });

  it('rejects connector/model provider and effort incompatibility', () => {
    expect(() =>
      assertConnectorSelectionCompatible('claude-code', {
        model: { provider: 'openai', model: 'gpt-5.4' },
        skills: [],
        invocation_options: {},
      }),
    ).toThrow(/expected provider 'anthropic'/);

    expect(() =>
      assertConnectorSelectionCompatible('codex', {
        effort: 'minimal',
        skills: [],
        invocation_options: {},
      }),
    ).toThrow(/cannot honor effort 'minimal'/);

    expect(() =>
      assertConnectorSelectionCompatible('codex', {
        effort: 'max',
        skills: [],
        invocation_options: {},
      }),
    ).toThrow(/cannot honor effort 'max'/);

    expect(() =>
      assertConnectorSelectionCompatible('cursor-agent', {
        model: { provider: 'openai', model: 'gpt-5.5' },
        effort: 'none',
        skills: [],
        invocation_options: {},
      }),
    ).toThrow(/expected provider 'gemini'/);

    expect(() =>
      assertConnectorSelectionCompatible('cursor-agent', {
        model: { provider: 'gemini', model: 'gemini-3.5-flash' },
        effort: 'low',
        skills: [],
        invocation_options: {},
      }),
    ).toThrow(/cannot honor effort 'low'/);

    expect(() =>
      assertConnectorSelectionCompatible('claude-code', {
        model: { provider: 'anthropic', model: 'claude-opus-4-7' },
        effort: 'max',
        skills: [],
        invocation_options: {},
      }),
    ).not.toThrow();
  });

  it('enforces connector write capability before runtime relay invocation', async () => {
    let relayCalls = 0;
    const readOnlyConnector = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'local-readonly',
      command: ['node', 'readonly.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });

    const result = await executeExecutableFlow(relaySafetyFlow(), {
      runDir: join(tempDir, 'read-only-implementer'),
      runId: '11111111-1111-4111-8111-111111111111',
      goal: 'prove runtime connector safety',
      relayConnector: {
        connectorName: 'local-readonly',
        connector: readOnlyConnector,
        async relay() {
          relayCalls += 1;
          return { ok: true };
        },
      },
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("connector 'local-readonly' is read-only");
    expect(relayCalls).toBe(0);
  });

  it('does not let a supplied resolved connector override the step connector', async () => {
    let relayCalls = 0;

    const result = await executeExecutableFlow(
      relaySafetyFlow({
        connector: 'codex',
      }),
      {
        runDir: join(tempDir, 'step-connector-mismatch'),
        runId: '33333333-3333-4333-8333-333333333333',
        goal: 'prove manifest connector identity wins',
        relayConnector: {
          connector: { kind: 'builtin', name: 'claude-code' },
          async relay() {
            relayCalls += 1;
            return { ok: true };
          },
        },
      },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(
      "relay connector identity mismatch: step requests 'codex' but supplied connector is 'claude-code'",
    );
    expect(relayCalls).toBe(0);
  });

  it('rejects mismatched supplied connectorName and resolved connector', async () => {
    let relayCalls = 0;

    const result = await executeExecutableFlow(
      relaySafetyFlow({
        role: 'reviewer',
      }),
      {
        runDir: join(tempDir, 'supplied-connector-mismatch'),
        runId: '44444444-4444-4444-8444-444444444444',
        goal: 'prove callback connector identity is coherent',
        relayConnector: {
          connectorName: 'codex',
          connector: { kind: 'builtin', name: 'claude-code' },
          async relay() {
            relayCalls += 1;
            return { ok: true };
          },
        },
      },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(
      "relay connector identity mismatch: connectorName 'codex' does not match resolved connector 'claude-code'",
    );
    expect(relayCalls).toBe(0);
  });

  it('rejects custom step connectors with non-matching supplied capabilities', async () => {
    let relayCalls = 0;
    const otherReviewer = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'other-reviewer',
      command: ['node', 'other-reviewer.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });

    const result = await executeExecutableFlow(
      relaySafetyFlow({
        role: 'reviewer',
        connector: 'local-reviewer',
      }),
      {
        runDir: join(tempDir, 'custom-connector-mismatch'),
        runId: '55555555-5555-4555-8555-555555555555',
        goal: 'prove custom connector capabilities match requested identity',
        relayConnector: {
          connector: otherReviewer,
          async relay() {
            relayCalls += 1;
            return { ok: true };
          },
        },
      },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(
      "relay connector identity mismatch: step requests 'local-reviewer' but supplied connector is 'other-reviewer'",
    );
    expect(relayCalls).toBe(0);
  });

  it('enforces connector model compatibility before runtime relay invocation', async () => {
    let relayCalls = 0;

    const result = await executeExecutableFlow(
      relaySafetyFlow({
        role: 'reviewer',
        selection: { model: { provider: 'openai', model: 'gpt-5.4' } },
      }),
      {
        runDir: join(tempDir, 'provider-mismatch'),
        runId: '22222222-2222-4222-8222-222222222222',
        goal: 'prove runtime connector compatibility',
        relayConnector: {
          connectorName: 'claude-code',
          async relay() {
            relayCalls += 1;
            return { ok: true };
          },
        },
      },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("expected provider 'anthropic'");
    expect(relayCalls).toBe(0);
  });

  // SECURITY (C1): a custom connector carries an arbitrary `command` the engine
  // spawns. A project's committed `.circuit/config.yaml` is untrusted input —
  // cloning a repo and running any flow (even read-only review) must never let
  // the repo author's config execute a command. Custom connector definitions
  // are honored only from the operator's own layers (user-global, invocation);
  // built-in connector names stay selectable from any layer.
  describe('project-layer custom connector trust boundary', () => {
    const evilCustom = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'evil',
      command: ['node', 'evil.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });

    function projectLayer(relay: unknown): LayeredConfigValue {
      return LayeredConfig.parse({ layer: 'project', config: { schema_version: 1, relay } });
    }
    function userGlobalLayer(relay: unknown): LayeredConfigValue {
      return LayeredConfig.parse({ layer: 'user-global', config: { schema_version: 1, relay } });
    }

    it('refuses a project-layer custom connector selected via relay.default', () => {
      expect(() =>
        resolveConnectorForGuidanceInput({
          flowId: 'review',
          role: 'reviewer',
          configLayers: [projectLayer({ default: 'evil', connectors: { evil: evilCustom } })],
        }),
      ).toThrow(/does not run custom command connectors that come from a project config/);
    });

    it('refuses a project-layer custom connector selected via a relay role', () => {
      expect(() =>
        resolveConnectorForGuidanceInput({
          flowId: 'review',
          role: 'reviewer',
          configLayers: [
            projectLayer({
              roles: { reviewer: { kind: 'named', name: 'evil' } },
              connectors: { evil: evilCustom },
            }),
          ],
        }),
      ).toThrow(/custom connector 'evil'/);
    });

    it('refuses a project-layer custom connector pinned as an explicit step connector', () => {
      expect(() =>
        relayGuidanceExecution({
          flowId: 'review',
          role: 'reviewer',
          stepConnector: 'evil',
          configLayers: [projectLayer({ connectors: { evil: evilCustom } })],
        }),
      ).toThrow(/does not run custom command connectors that come from a project config/);
    });

    it('leaves a built-in connector chosen by project relay.default unaffected', () => {
      const decision = resolveConnectorForGuidanceInput({
        flowId: 'review',
        role: 'reviewer',
        configLayers: [projectLayer({ default: 'codex' })],
      });
      expect(decision.connector).toEqual({ kind: 'builtin', name: 'codex' });
      expect(decision.resolvedFrom).toEqual({ source: 'default' });
    });

    it('honors a custom connector defined in the user-global layer', () => {
      const decision = resolveConnectorForGuidanceInput({
        flowId: 'review',
        role: 'reviewer',
        configLayers: [userGlobalLayer({ default: 'evil', connectors: { evil: evilCustom } })],
      });
      expect(decision.connector).toEqual(evilCustom);
      expect(decision.resolvedFrom).toEqual({ source: 'default' });
    });

    it('honors a user-global custom connector pinned as an explicit step connector', () => {
      const decision = relayGuidanceExecution({
        flowId: 'review',
        role: 'reviewer',
        stepConnector: 'evil',
        configLayers: [userGlobalLayer({ connectors: { evil: evilCustom } })],
      });
      expect(decision.connectorName).toBe('evil');
      expect(decision.connector).toEqual(evilCustom);
    });

    it('ignores a project override that tries to replace a user-global custom command', () => {
      const trusted = CustomConnectorDescriptor.parse({
        kind: 'custom',
        name: 'worker',
        command: ['node', 'trusted-worker.js'],
        prompt_transport: 'prompt-file',
        output: { kind: 'output-file' },
        capabilities: { filesystem: 'read-only', structured_output: 'json' },
      });
      const attackerOverride = CustomConnectorDescriptor.parse({
        kind: 'custom',
        name: 'worker',
        command: ['node', 'attacker-worker.js'],
        prompt_transport: 'prompt-file',
        output: { kind: 'output-file' },
        capabilities: { filesystem: 'read-only', structured_output: 'json' },
      });

      const decision = relayGuidanceExecution({
        flowId: 'review',
        role: 'reviewer',
        stepConnector: 'worker',
        configLayers: [
          userGlobalLayer({ connectors: { worker: trusted } }),
          projectLayer({ connectors: { worker: attackerOverride } }),
        ],
      });
      expect(decision.connector).toEqual(trusted);
    });
  });

  // SECURITY (twin of C1): the PolicyEnvelope schema carries the same custom
  // connector registry the legacy relay schema does, reached through a different
  // resolution path (`policyLayerConnector`). A project `.circuit/config.yaml`
  // can place a custom arbitrary-command connector into that policy registry —
  // either as a `schema_version: 2` policy config directly, or as a v1
  // `relay.connectors` map lowered by `projectConfigV1ToPolicyEnvelopeV2`. The
  // policy path must draw the identical origin boundary: a project-origin custom
  // command connector is refused; built-ins stay selectable from any origin; a
  // custom connector defined in the operator's own (user-global / invocation)
  // policy layer is honored.
  describe('project policy custom connector trust boundary', () => {
    const evilPolicyCustom = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'evil',
      command: ['node', 'evil-policy.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });

    function policyLayerFromEnvelope(
      source: 'project' | 'user-global' | 'invocation',
      policy: unknown,
    ): PolicyLayerValue {
      return PolicyLayer.parse({ source, envelope: { schema_version: 2, policy } });
    }

    it('refuses a project v1 relay.connectors custom connector lowered into a policy envelope', () => {
      // The v1 twin: a committed project config's `relay.connectors` map, lowered
      // through the documented v1 -> v2 bridge, keeps the custom command in the
      // policy registry with its project origin.
      const projection = projectConfigV1ToPolicyEnvelopeV2({
        config: Config.parse({
          schema_version: 1,
          relay: { connectors: { evil: evilPolicyCustom } },
        }),
        source: 'project',
      });
      const policyLayer = PolicyLayer.parse({
        source: projection.source,
        envelope: projection.policy_envelope,
      });

      expect(() =>
        relayGuidanceExecution({
          flowId: 'review',
          role: 'reviewer',
          stepConnector: 'evil',
          policyLayers: [policyLayer],
        }),
      ).toThrow(/does not run custom command connectors that come from a project config/);
    });

    it('refuses a schema_version 2 project policy custom connector pinned as a step connector', () => {
      const policyLayer = policyLayerFromEnvelope('project', {
        rules: { connectors: { registry: { evil: evilPolicyCustom } } },
      });

      expect(() =>
        relayGuidanceExecution({
          flowId: 'review',
          role: 'reviewer',
          stepConnector: 'evil',
          policyLayers: [policyLayer],
        }),
      ).toThrow(/does not run custom command connectors that come from a project config/);
    });

    it('refuses a schema_version 2 project policy custom connector selected via a policy default', () => {
      // The second entry route into `policyLayerConnector`: a policy default that
      // names the custom connector (no step pin, no supplied connector).
      const policyLayer = policyLayerFromEnvelope('project', {
        rules: { connectors: { registry: { evil: evilPolicyCustom } } },
        defaults: { connector: { kind: 'named', name: 'evil' } },
      });

      expect(() =>
        relayGuidanceExecution({
          flowId: 'review',
          role: 'reviewer',
          policyLayers: [policyLayer],
        }),
      ).toThrow(/does not run custom command connectors that come from a project config/);
    });

    it('honors a custom connector declared in a user-global policy layer', () => {
      const trustedCustom = CustomConnectorDescriptor.parse({
        kind: 'custom',
        name: 'worker',
        command: ['node', 'trusted-policy-worker.js'],
        prompt_transport: 'prompt-file',
        output: { kind: 'output-file' },
        capabilities: { filesystem: 'read-only', structured_output: 'json' },
      });
      const policyLayer = policyLayerFromEnvelope('user-global', {
        rules: { connectors: { registry: { worker: trustedCustom } } },
      });

      const decision = relayGuidanceExecution({
        flowId: 'review',
        role: 'reviewer',
        stepConnector: 'worker',
        policyLayers: [policyLayer],
      });
      expect(decision.connectorName).toBe('worker');
      expect(decision.connector).toEqual(trustedCustom);
    });

    it('leaves a built-in connector selected by a project policy default unaffected', () => {
      const policyLayer = policyLayerFromEnvelope('project', {
        defaults: { connector: { kind: 'builtin', name: 'codex' } },
      });

      const decision = relayGuidanceExecution({
        flowId: 'review',
        role: 'reviewer',
        policyLayers: [policyLayer],
      });
      expect(decision.connector).toEqual({ kind: 'builtin', name: 'codex' });
      expect(decision.resolvedFrom).toEqual({ source: 'default' });
    });

    it('ignores a project policy override that tries to replace a user-global policy custom command', () => {
      const trusted = CustomConnectorDescriptor.parse({
        kind: 'custom',
        name: 'worker',
        command: ['node', 'trusted-policy-worker.js'],
        prompt_transport: 'prompt-file',
        output: { kind: 'output-file' },
        capabilities: { filesystem: 'read-only', structured_output: 'json' },
      });
      const attacker = CustomConnectorDescriptor.parse({
        kind: 'custom',
        name: 'worker',
        command: ['node', 'attacker-policy-worker.js'],
        prompt_transport: 'prompt-file',
        output: { kind: 'output-file' },
        capabilities: { filesystem: 'read-only', structured_output: 'json' },
      });
      const userLayer = policyLayerFromEnvelope('user-global', {
        rules: { connectors: { registry: { worker: trusted } } },
      });
      const projectOverride = policyLayerFromEnvelope('project', {
        rules: { connectors: { registry: { worker: attacker } } },
      });

      const decision = relayGuidanceExecution({
        flowId: 'review',
        role: 'reviewer',
        stepConnector: 'worker',
        policyLayers: [userLayer, projectOverride],
      });
      expect(decision.connector).toEqual(trusted);
    });
  });
});
