import {
  assertConnectorSelectionCompatible,
  resolveConnectorForGuidanceInput,
  resolveConnectorReference,
} from '../../connectors/resolver.js';
import {
  type PrototypeVariantConnectorPlanner,
  resolvedPrototypeVariantSelection,
} from '../../selection/connector-planning.js';

export const runtimeConnectorPlanner: PrototypeVariantConnectorPlanner = {
  planPrototypeVariantConnector(input) {
    const explicitConnector =
      input.variant.connector === undefined
        ? undefined
        : resolveConnectorReference({
            ref: input.variant.connector,
            ...(input.selectionConfigLayers === undefined
              ? {}
              : { configLayers: input.selectionConfigLayers }),
          });
    const relay = resolveConnectorForGuidanceInput({
      flowId: 'prototype',
      role: 'implementer',
      ...(explicitConnector === undefined ? {} : { explicitConnector }),
      ...(input.selectionConfigLayers === undefined
        ? {}
        : { configLayers: input.selectionConfigLayers }),
    });
    assertConnectorSelectionCompatible(
      relay.connectorName,
      resolvedPrototypeVariantSelection(input.variant.selection),
    );
    return {
      variantId: input.variant.id,
      connectorName: relay.connectorName,
      resolvedFrom: relay.resolvedFrom,
    };
  },
};
