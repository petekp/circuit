import { describe, expect, it } from 'vitest';

import { findComposeBuilder } from '../../src/flows/registries/compose-writers/registry.js';
import type {
  ComposeBuildContext,
  ComposeStep,
} from '../../src/flows/registries/compose-writers/types.js';
import type { RuntimeIndexedFlow } from '../../src/flows/registries/runtime-index.js';
import { runtimeConnectorPlanner } from '../../src/runtime/run/connector-planning.js';
import { CircuitVariantModels, LayeredConfig } from '../../src/schemas/config.js';

const PROTOTYPE_ROOT = '.circuit/runs/model-comparison/prototype-files';

const flow: RuntimeIndexedFlow = {
  id: 'prototype',
  version: '0.1.0',
  stages: [],
  steps: [],
};

const step: ComposeStep = {
  id: 'variant-options-step',
  title: 'Plan - resolve Prototype model variants',
  protocol: 'prototype-variant-options@v1',
  reads: [],
  routes: {},
  writes: {
    report: {
      path: 'reports/prototype/variant-options.json',
      schema: 'prototype.variant-options@v1',
    },
  },
  check: {},
  kind: 'compose',
};

const prototypeVariantOptionsComposeBuilder = findComposeBuilder('prototype.variant-options@v1');
if (prototypeVariantOptionsComposeBuilder === undefined) {
  throw new Error('prototype.variant-options@v1 compose builder must be registered');
}

function layerWithVariants(
  variantModels: CircuitVariantModels,
  connectors: Record<string, unknown> = {},
) {
  return LayeredConfig.parse({
    layer: 'project',
    config: {
      schema_version: 1,
      ...(Object.keys(connectors).length === 0 ? {} : { relay: { connectors } }),
      circuits: {
        prototype: {
          variant_models: variantModels,
        },
      },
    },
  });
}

function buildContext(
  variantModels: CircuitVariantModels,
  tournamentN = variantModels.length,
  connectors: Record<string, unknown> = {},
): ComposeBuildContext {
  return {
    runFolder: '/tmp/circuit-prototype-variant-options-test',
    flow,
    step,
    goal: 'prototype: compare model variants',
    axes: { depth: 'medium', tournament: true, tournament_n: tournamentN, autonomous: false },
    selectionConfigLayers: [layerWithVariants(variantModels, connectors)],
    connectorPlanner: runtimeConnectorPlanner,
    inputs: {
      brief: {
        objective: 'Sketch a connector-aware prototype tournament UI',
        prototype_scope: 'Create local disposable HTML variants.',
        out_of_scope: ['Production implementation'],
        target_user: 'Operator comparing local prototype variants',
        success_criteria: ['Each variant is isolated under its variant root.'],
        prototype_root: PROTOTYPE_ROOT,
        verification_command_candidates: [],
        claim_limits: ['not production', 'not deployed'],
      },
      plan: {
        objective: 'Sketch a connector-aware prototype tournament UI',
        prototype_root: PROTOTYPE_ROOT,
        files_to_create: [`${PROTOTYPE_ROOT}/variants/codex-55-xhigh/index.html`],
        entry_points: [`${PROTOTYPE_ROOT}/variants/codex-55-xhigh/index.html`],
        interaction_path: `${PROTOTYPE_ROOT}/variants/codex-55-xhigh/index.html`,
        preview_instructions: 'Open the variant HTML files locally.',
        verification: { commands: [] },
        build_followup_prompt: 'Build the chosen variant.',
        risks: ['Local prototype only.'],
        claim_limits: ['not production', 'not deployed'],
      },
    },
  };
}

describe('Prototype variant-options writer connector routing', () => {
  it('accepts the connector-aware three-model tournament matrix', () => {
    const variantModels = CircuitVariantModels.parse([
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
    ]);

    const report = prototypeVariantOptionsComposeBuilder.build(buildContext(variantModels));

    expect(report).toMatchObject({
      variant_count: 3,
      variants: [
        {
          variant_id: 'codex-55-xhigh',
          connector: { kind: 'builtin', name: 'codex' },
          connector_name: 'codex',
          connector_source: { source: 'explicit' },
          provider: 'openai',
          model: 'gpt-5.5',
          effort: 'xhigh',
        },
        {
          variant_id: 'opus-47-max',
          connector_name: 'claude-code',
          connector_source: { source: 'explicit' },
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          effort: 'max',
        },
        {
          variant_id: 'gemini-35-flash-cursor',
          connector_name: 'cursor-agent',
          connector_source: { source: 'explicit' },
          provider: 'gemini',
          model: 'gemini-3.5-flash',
          effort: 'none',
        },
      ],
    });
  });

  it('rejects read-only custom connectors for a tournament implementer variant', () => {
    const variantModels = CircuitVariantModels.parse([
      {
        id: 'custom-readonly',
        label: 'Custom read-only',
        connector: { kind: 'named', name: 'local-readonly' },
        selection: {
          model: { provider: 'anthropic', model: 'local-fixture-a' },
          effort: 'high',
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
    ]);

    expect(() =>
      prototypeVariantOptionsComposeBuilder.build(
        buildContext(variantModels, variantModels.length, {
          'local-readonly': {
            kind: 'custom',
            name: 'local-readonly',
            command: ['node', 'readonly.js'],
            prompt_transport: 'prompt-file',
            output: { kind: 'output-file' },
            capabilities: { filesystem: 'read-only', structured_output: 'json' },
          },
        }),
      ),
    ).toThrow(/connector 'local-readonly' is read-only/);
  });

  it('rejects codex with max effort', () => {
    const variantModels = CircuitVariantModels.parse([
      {
        id: 'codex-55-max',
        label: 'Codex 5.5 max',
        connector: { kind: 'builtin', name: 'codex' },
        selection: {
          model: { provider: 'openai', model: 'gpt-5.5' },
          effort: 'max',
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
    ]);

    expect(() => prototypeVariantOptionsComposeBuilder.build(buildContext(variantModels))).toThrow(
      /codex connector cannot honor effort 'max'/,
    );
  });
});
