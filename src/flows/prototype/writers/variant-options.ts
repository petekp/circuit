import {
  configuredPrototypeVariants,
  planPrototypeVariantConnectorMatrix,
} from '../../../selection/connector-planning.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { PrototypeBrief, PrototypePlan, PrototypeVariantOptions } from '../reports.js';

export const prototypeVariantOptionsComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'prototype.variant-options@v1',
  reads: [
    { name: 'brief', schema: 'prototype.brief@v1', required: true },
    { name: 'plan', schema: 'prototype.plan@v1', required: true },
  ],
  build(context: ComposeBuildContext): unknown {
    const brief = PrototypeBrief.parse(context.inputs.brief);
    const plan = PrototypePlan.parse(context.inputs.plan);
    const variants = configuredPrototypeVariants(context.selectionConfigLayers);
    if (variants === undefined) {
      throw new Error(
        'prototype.variant-options@v1 requires circuits.prototype.variant_models in Circuit config',
      );
    }
    if (context.connectorPlanner === undefined) {
      throw new Error(
        'prototype.variant-options@v1 requires a connector planner in compose context',
      );
    }
    const expectedCount = context.axes?.tournament_n ?? 3;
    const connectorPlans = planPrototypeVariantConnectorMatrix({
      variants,
      expectedCount,
      planner: context.connectorPlanner,
      ...(context.selectionConfigLayers === undefined
        ? {}
        : { selectionConfigLayers: context.selectionConfigLayers }),
    });
    const connectorPlanByVariantId = new Map(
      connectorPlans.map((connectorPlan) => [connectorPlan.variantId, connectorPlan]),
    );
    return PrototypeVariantOptions.parse({
      schema_version: 1,
      objective: brief.objective,
      prototype_root: plan.prototype_root,
      variant_count: variants.length,
      claim_limits: brief.claim_limits,
      variants: variants.map((variant) => {
        const model = variant.selection.model;
        const effort = variant.selection.effort;
        if (model === undefined || effort === undefined) {
          throw new Error(
            `prototype.variant-options@v1 variant '${variant.id}' requires selection.model and selection.effort`,
          );
        }
        const artifactRoot = `${plan.prototype_root}/variants/${variant.id}`;
        const connectorPlan = connectorPlanByVariantId.get(variant.id);
        if (connectorPlan === undefined) {
          throw new Error(
            `prototype.variant-options@v1 missing connector plan for '${variant.id}'`,
          );
        }
        return {
          variant_id: variant.id,
          label: variant.label,
          provider: model.provider,
          model: model.model,
          effort,
          ...(variant.connector === undefined ? {} : { connector: variant.connector }),
          connector_name: connectorPlan.connectorName,
          connector_source: connectorPlan.resolvedFrom,
          prototype_root: plan.prototype_root,
          variant_root: artifactRoot,
          entry_point_hint: `${artifactRoot}/index.html`,
          selection: {
            model,
            effort,
          },
          selection_source: 'circuits.prototype.variant_models',
          goal: [
            `Create Prototype variant '${variant.label}' (${variant.id}) for: ${brief.objective}.`,
            `Write only disposable files under ${artifactRoot}.`,
            `The shared Prototype root is ${plan.prototype_root}.`,
            'Do not claim deployment, production readiness, branch previews, screenshots, provider behavior, or model behavior.',
          ].join(' '),
        };
      }),
    });
  },
};
