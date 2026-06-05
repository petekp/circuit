import type {
  CircuitVariantModel,
  CircuitVariantModels,
  LayeredConfig as LayeredConfigValue,
} from '../schemas/config.js';
import type { RelayResolutionSource } from '../schemas/connector.js';
import type { ResolvedSelection } from '../schemas/selection-policy.js';

export interface PrototypeVariantConnectorPlan {
  readonly variantId: CircuitVariantModel['id'];
  readonly connectorName: string;
  readonly resolvedFrom: RelayResolutionSource;
}

export interface PrototypeVariantConnectorPlanner {
  planPrototypeVariantConnector(input: {
    readonly variant: CircuitVariantModel;
    readonly selectionConfigLayers?: readonly LayeredConfigValue[];
  }): PrototypeVariantConnectorPlan;
}

export function configuredPrototypeVariants(
  layers: readonly LayeredConfigValue[] | undefined,
): CircuitVariantModels | undefined {
  let variants: CircuitVariantModels | undefined;
  for (const layer of layers ?? []) {
    const circuits = layer.config.circuits as Record<
      string,
      { readonly variant_models?: CircuitVariantModels } | undefined
    >;
    const next = circuits.prototype?.variant_models;
    if (next !== undefined) variants = next;
  }
  return variants;
}

export function resolvedPrototypeVariantSelection(
  selection: CircuitVariantModel['selection'],
): ResolvedSelection {
  return {
    ...(selection.model === undefined ? {} : { model: selection.model }),
    ...(selection.effort === undefined ? {} : { effort: selection.effort }),
    skills: [],
    ...(selection.depth === undefined ? {} : { depth: selection.depth }),
    invocation_options: selection.invocation_options,
  };
}

export function planPrototypeVariantConnectorMatrix(input: {
  readonly variants: CircuitVariantModels;
  readonly expectedCount: number;
  readonly planner: PrototypeVariantConnectorPlanner;
  readonly selectionConfigLayers?: readonly LayeredConfigValue[];
}): readonly PrototypeVariantConnectorPlan[] {
  if (input.variants.length !== input.expectedCount) {
    throw new Error(
      `prototype.variant-options@v1 requires exactly axes.tournament_n (${input.expectedCount}) variant_models entries; found ${input.variants.length}`,
    );
  }

  return input.variants.map((variant) =>
    input.planner.planPrototypeVariantConnector({
      variant,
      ...(input.selectionConfigLayers === undefined
        ? {}
        : { selectionConfigLayers: input.selectionConfigLayers }),
    }),
  );
}
