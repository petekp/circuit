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
import type { RelayConnector } from '../../src/runtime/executors/relay.js';
import type { ExecutableFlow, RelayStep } from '../../src/runtime/manifest/executable-flow.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import { planRelayGuidanceDecision } from '../../src/runtime/run/relay-guidance.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import {
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
      depth: CompiledDepth.parse('standard'),
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
          circuits: {},
          connectors: {},
        },
        circuits: {},
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
          circuits: {},
          connectors: {},
        },
        circuits: {},
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
          circuits: {},
          connectors: {},
        },
        circuits: {},
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
          circuits: {},
          connectors: {},
        },
        circuits: {},
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
      classifyConnectorFilesystem({ filesystem: 'read-only', structured_output: 'json' }),
    ).toEqual({
      filesystem: 'read-only',
      write_capable: false,
      may_unlock_higher_autonomy_after_safe_apply: false,
      reason: 'connector is read-only',
    });

    expect(
      classifyConnectorFilesystem({ filesystem: 'isolated-write', structured_output: 'json' }),
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
      layer: 'project',
      config: {
        schema_version: 1,
        host: { kind: 'generic-shell' },
        relay: {
          default: 'auto',
          roles: { reviewer: { kind: 'named', name: 'local-reviewer' } },
          circuits: {},
          connectors: { 'local-reviewer': custom },
        },
        circuits: {},
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
          circuits: {},
          connectors: {},
        },
        circuits: {},
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
          circuits: {
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
    expect(decision.resolvedFrom).toEqual({ source: 'circuit', flow_id: 'review' });
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
    const policyLayer = PolicyLayer.parse({
      source: 'project',
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
      layer: 'project',
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
      layer: 'project',
      config: {
        schema_version: 1,
        host: { kind: 'generic-shell' },
        relay: {
          default: 'auto',
          roles: {},
          circuits: {},
          connectors: { 'local-reviewer': custom },
        },
        circuits: {},
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

  it('uses merged config precedence for custom step connector descriptors', () => {
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
      command: ['node', 'project-reviewer.js'],
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
          circuits: {},
          connectors: { 'local-reviewer': lowerPrecedence },
        },
        circuits: {},
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
          circuits: {},
          connectors: { 'local-reviewer': higherPrecedence },
        },
        circuits: {},
        defaults: {},
      },
    });

    const decision = relayGuidanceExecution({
      flowId: 'review',
      role: 'reviewer',
      stepConnector: 'local-reviewer',
      configLayers: [userLayer, projectLayer],
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
});
