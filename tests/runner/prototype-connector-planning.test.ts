import { describe, expect, it } from 'vitest';

import { CircuitVariantModels, LayeredConfig } from '../../src/schemas/config.js';
import {
  type PrototypeVariantConnectorPlanner,
  configuredPrototypeVariants,
  planPrototypeVariantConnectorMatrix,
  resolvedPrototypeVariantSelection,
} from '../../src/selection/connector-planning.js';

function variantModels() {
  return CircuitVariantModels.parse([
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
  ]);
}

describe('Prototype connector planning seam', () => {
  it('reads Prototype variant models from the last selection config layer', () => {
    const lower = variantModels();
    const higher = CircuitVariantModels.parse([
      {
        id: 'cursor-flash',
        label: 'Cursor Flash',
        connector: { kind: 'builtin', name: 'cursor-agent' },
        selection: {
          model: { provider: 'gemini', model: 'gemini-3.5-flash' },
          effort: 'none',
        },
      },
      {
        id: 'opus-sonnet',
        label: 'Claude Sonnet',
        connector: { kind: 'builtin', name: 'claude-code' },
        selection: {
          model: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
          effort: 'high',
        },
      },
    ]);
    const layers = [
      LayeredConfig.parse({
        layer: 'user-global',
        config: {
          schema_version: 1,
          circuits: { prototype: { variant_models: lower } },
        },
      }),
      LayeredConfig.parse({
        layer: 'project',
        config: {
          schema_version: 1,
          circuits: { prototype: { variant_models: higher } },
        },
      }),
    ];

    expect(configuredPrototypeVariants(layers)).toEqual(higher);
  });

  it('validates tournament count and delegates connector decisions through a planner', () => {
    const variants = variantModels();
    const plannedVariantIds: string[] = [];
    const planner: PrototypeVariantConnectorPlanner = {
      planPrototypeVariantConnector(input) {
        plannedVariantIds.push(input.variant.id);
        return {
          variantId: input.variant.id,
          connectorName: input.variant.connector?.name ?? 'claude-code',
          resolvedFrom: { source: 'explicit' },
        };
      },
    };

    const plans = planPrototypeVariantConnectorMatrix({
      variants,
      expectedCount: 2,
      planner,
    });

    expect(plannedVariantIds).toEqual(['codex-55-xhigh', 'opus-47-max']);
    expect(plans).toEqual([
      {
        variantId: 'codex-55-xhigh',
        connectorName: 'codex',
        resolvedFrom: { source: 'explicit' },
      },
      {
        variantId: 'opus-47-max',
        connectorName: 'claude-code',
        resolvedFrom: { source: 'explicit' },
      },
    ]);
    expect(() =>
      planPrototypeVariantConnectorMatrix({
        variants,
        expectedCount: 3,
        planner,
      }),
    ).toThrow(
      /prototype.variant-options@v1 requires exactly axes.tournament_n \(3\) variant_models entries; found 2/,
    );
  });

  it('projects a variant selection into the connector compatibility shape', () => {
    const firstVariant = variantModels()[0];
    if (firstVariant === undefined) throw new Error('expected fixture variant');

    expect(resolvedPrototypeVariantSelection(firstVariant.selection)).toEqual({
      model: { provider: 'openai', model: 'gpt-5.5' },
      effort: 'xhigh',
      skills: [],
      invocation_options: {},
    });
  });
});
