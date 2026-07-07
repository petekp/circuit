import type {
  FlowVariantModel,
  FlowVariantModels,
  LayeredConfig as LayeredConfigValue,
} from '../schemas/config.js';
import type { RelayResolutionSource } from '../schemas/connector.js';
import type { ResolvedSelection } from '../schemas/selection-policy.js';

export interface PrototypeVariantConnectorPlan {
  readonly variantId: FlowVariantModel['id'];
  readonly connectorName: string;
  readonly resolvedFrom: RelayResolutionSource;
}

export interface PrototypeVariantConnectorPlanner {
  planPrototypeVariantConnector(input: {
    readonly variant: FlowVariantModel;
    readonly selectionConfigLayers?: readonly LayeredConfigValue[];
  }): PrototypeVariantConnectorPlan;
}

export function configuredPrototypeVariants(
  layers: readonly LayeredConfigValue[] | undefined,
): FlowVariantModels | undefined {
  let variants: FlowVariantModels | undefined;
  for (const layer of layers ?? []) {
    const flows = layer.config.flows as Record<
      string,
      { readonly variant_models?: FlowVariantModels } | undefined
    >;
    const next = flows.prototype?.variant_models;
    if (next !== undefined) variants = next;
  }
  return variants;
}

export function resolvedPrototypeVariantSelection(
  selection: FlowVariantModel['selection'],
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
  readonly variants: FlowVariantModels;
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
