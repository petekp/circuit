import type { Config, ConnectorReference } from '../schemas/config.js';
import type { LayeredConfig as LayeredConfigValue } from '../schemas/config.js';
import { type CustomConnectorDescriptor, EnabledConnector } from '../schemas/connector.js';
import { sha256OfJson } from '../schemas/hashing.js';
import {
  ComposedPolicyHardConstraints,
  type PolicyConnectorReference,
  PolicyEnvelopeProjectionV0,
  type PolicyEnvelopeProjectionV0 as PolicyEnvelopeProjectionValue,
  PolicyEnvelopeV2,
  type PolicyEnvelopeV2 as PolicyEnvelopeValue,
  type PolicyLayerSource,
  type PolicyLayer as PolicyLayerValue,
  type Provider,
  type RejectedPolicyAuthority,
} from '../schemas/policy-envelope.js';
import type { Ref } from '../schemas/ref.js';
import type { Effort } from '../schemas/selection-policy.js';

export { PolicyEnvelopeProjectionV0, PolicyEnvelopeV2 } from '../schemas/policy-envelope.js';

export class PolicyEnvelopeCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyEnvelopeCompositionError';
  }
}

interface ProjectConfigV1Input {
  readonly config: Config;
  readonly source: PolicyLayerSource;
}

export const RUNTIME_CONFIG_V1_POLICY_REF: Ref = {
  kind: 'policy',
  ref: 'policy.runtime.config_v1',
};

export const RUNTIME_POLICY_V2_REF: Ref = {
  kind: 'policy',
  ref: 'policy.runtime.policy_v2',
};

const EFFORT_ORDER: readonly Effort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function uniqueSorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function unionInto<T extends string>(target: Set<T>, values: readonly T[]): void {
  for (const value of values) target.add(value);
}

function intersectConnectorAllow(
  current: Set<string> | undefined,
  next: readonly string[] | undefined,
): Set<string> | undefined {
  if (next === undefined) return current;
  const nextSet = new Set(next);
  if (current === undefined) return nextSet;
  return new Set([...current].filter((value) => nextSet.has(value)));
}

function minNumber(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  return current === undefined ? next : Math.min(current, next);
}

function minEffort(current: Effort | undefined, next: Effort | undefined): Effort | undefined {
  if (next === undefined) return current;
  if (current === undefined) return next;
  return EFFORT_ORDER.indexOf(next) < EFFORT_ORDER.indexOf(current) ? next : current;
}

function composeAutoApply(
  current: boolean | undefined,
  next: boolean | undefined,
): boolean | undefined {
  if (next === undefined) return current;
  if (next === false || current === false) return false;
  return true;
}

function connectorRefFromDefault(
  value: Config['relay']['default'],
): PolicyConnectorReference | 'auto' {
  if (value === 'auto') return 'auto';
  if (EnabledConnector.options.includes(value as never)) {
    return { kind: 'builtin', name: value as (typeof EnabledConnector.options)[number] };
  }
  return { kind: 'named', name: value };
}

function connectorRefFromConfig(ref: ConnectorReference): PolicyConnectorReference {
  return ref;
}

function rejectOldAuthority(path: string, field: string, reason: string): RejectedPolicyAuthority {
  return { path, field, reason };
}

function sha256Json(value: unknown): string {
  return sha256OfJson(value);
}

function policyLayerSourceForConfigLayer(layer: LayeredConfigValue['layer']): PolicyLayerSource {
  if (layer === 'default') return 'built-in';
  return layer;
}

// SECURITY BOUNDARY (twin of C1 in src/connectors/resolver.ts). The
// PolicyEnvelope schema carries the same custom connector registry the legacy
// relay schema does, only reached through a different resolution path. Each
// `policy.rules.connectors.registry` entry is a custom descriptor whose
// arbitrary `command` the engine spawns with the full inherited environment. A
// project's committed `.circuit/config.yaml` is untrusted input — cloning a
// repository and running any flow (even a read-only review) must never let the
// repository author's config execute a command on the operator's machine. So a
// custom command connector is honored only from a policy layer the operator
// controls on their own machine (their user-global config) or supplies at
// invocation, never from a project-origin layer.
//
// Built-in connector names are reserved out of the registry by the schema, so
// this partition only ever governs arbitrary-command descriptors; built-ins
// resolve through their own path and stay selectable from any origin.
//
// This mirrors `customConnectorRegistryFromLayers` in the connectors module for
// policy layers. The two enforce the same rule but consume different layer
// shapes (`LayeredConfig` vs `PolicyLayer`), so the partition is expressed twice
// rather than behind one generic helper that would obscure both security-
// critical call sites. Later trusted layers override earlier ones, matching the
// config-layer merge order.
export function trustedPolicyConnectorRegistryFromLayers(
  layers: readonly PolicyLayerValue[] | undefined,
): {
  readonly registry: Record<string, CustomConnectorDescriptor>;
  readonly projectDeclaredNames: ReadonlySet<string>;
} {
  const registry: Record<string, CustomConnectorDescriptor> = {};
  const projectDeclaredNames = new Set<string>();
  for (const layer of layers ?? []) {
    const layerRegistry = layer.envelope.policy.rules.connectors.registry;
    if (layer.source === 'project') {
      // Record the names a project layer tried to register (so a selection that
      // points at one can raise a clear security refusal instead of a
      // misleading "not declared" error) but never adopt the command.
      for (const name of Object.keys(layerRegistry)) {
        projectDeclaredNames.add(name);
      }
      continue;
    }
    Object.assign(registry, layerRegistry);
  }
  return { registry, projectDeclaredNames };
}

export function composePolicyHardConstraints(
  envelopes: readonly PolicyEnvelopeValue[],
): ComposedPolicyHardConstraints {
  let allow: Set<string> | undefined;
  const deny = new Set<string>();
  const denyForWrite = new Set<string>();
  const denyProviders = new Set<Provider>();
  const requireProviderForConnector: Record<string, Provider> = {};
  let autoApply: boolean | undefined;
  const checkpointGlobs = new Set<string>();
  const deniedSkills = new Set<string>();
  const independentReviewFor = new Set<string>();
  let maxAttempts: number | undefined;
  let maxWallClockMs: number | undefined;
  let maxEffortCap: Effort | undefined;
  let maxTournamentN: number | undefined;

  for (const envelope of envelopes) {
    const parsed = PolicyEnvelopeV2.parse(envelope);
    const { rules, limits } = parsed.policy;

    allow = intersectConnectorAllow(allow, rules.connectors.allow);
    unionInto(deny, rules.connectors.deny);
    unionInto(denyForWrite, rules.connectors.deny_for_write);
    unionInto(denyProviders, rules.models.deny_providers);
    for (const [connector, provider] of Object.entries(
      rules.models.require_provider_for_connector,
    )) {
      const previous = requireProviderForConnector[connector];
      if (previous !== undefined && previous !== provider) {
        throw new PolicyEnvelopeCompositionError(
          `conflicting provider requirements for connector '${connector}': '${previous}' and '${provider}'`,
        );
      }
      requireProviderForConnector[connector] = provider;
    }
    autoApply = composeAutoApply(autoApply, rules.writes.auto_apply);
    unionInto(checkpointGlobs, rules.writes.require_checkpoint_globs);
    unionInto(deniedSkills, rules.skills.deny);
    unionInto(independentReviewFor, rules.proof.require_independent_review_for);

    maxAttempts = minNumber(maxAttempts, limits.max_attempts_per_step);
    maxWallClockMs = minNumber(maxWallClockMs, limits.max_wall_clock_ms);
    maxEffortCap = minEffort(maxEffortCap, limits.max_effort);
    maxTournamentN = minNumber(maxTournamentN, limits.max_tournament_n);
  }

  return ComposedPolicyHardConstraints.parse({
    connectors: {
      ...(allow !== undefined ? { allow: uniqueSorted(allow) } : {}),
      deny: uniqueSorted(deny),
      deny_for_write: uniqueSorted(denyForWrite),
    },
    models: {
      deny_providers: uniqueSorted(denyProviders),
      require_provider_for_connector: Object.fromEntries(
        Object.entries(requireProviderForConnector).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    writes: {
      ...(autoApply !== undefined ? { auto_apply: autoApply } : {}),
      require_checkpoint_globs: uniqueSorted(checkpointGlobs),
    },
    skills: {
      deny: uniqueSorted(deniedSkills),
    },
    proof: {
      require_independent_review_for: uniqueSorted(independentReviewFor),
    },
    limits: {
      ...(maxAttempts !== undefined ? { max_attempts_per_step: maxAttempts } : {}),
      ...(maxWallClockMs !== undefined ? { max_wall_clock_ms: maxWallClockMs } : {}),
      ...(maxEffortCap !== undefined ? { max_effort: maxEffortCap } : {}),
      ...(maxTournamentN !== undefined ? { max_tournament_n: maxTournamentN } : {}),
    },
  });
}

export function projectConfigV1ToPolicyEnvelopeV2(
  input: ProjectConfigV1Input,
): PolicyEnvelopeProjectionValue {
  const { config, source } = input;
  const rejectedOldAuthority: RejectedPolicyAuthority[] = [];
  const flowConnectorHints = Object.entries(config.relay.flows).map(([flowId, ref]) => {
    rejectedOldAuthority.push(
      rejectOldAuthority(
        `relay.flows.${flowId}`,
        'relay.flows',
        'flow-id connector routing is old authority; migrate it only as a guidance preference',
      ),
    );
    return {
      flow_id: flowId,
      prefer_connector: connectorRefFromConfig(ref),
    };
  });

  const flowSelectionHints = [];
  const flowSlotBindings = [];
  const variantModelHints = [];
  for (const [flowId, override] of Object.entries(config.flows)) {
    if (override.selection !== undefined) {
      flowSelectionHints.push({
        flow_id: flowId,
        selection: override.selection,
      });
    }
    if (Object.keys(override.skill_bindings).length > 0) {
      flowSlotBindings.push({
        flow_id: flowId,
        bindings: override.skill_bindings,
      });
    }
    if (override.variant_models !== undefined) {
      rejectedOldAuthority.push(
        rejectOldAuthority(
          `flows.${flowId}.variant_models`,
          `flows.${flowId}.variant_models`,
          'variant model matrices are branch-choice inputs only; they cannot directly choose relay execution',
        ),
      );
      for (const variant of override.variant_models) {
        variantModelHints.push({
          flow_id: flowId,
          id: variant.id,
          label: variant.label,
          ...(variant.connector !== undefined
            ? { connector: connectorRefFromConfig(variant.connector) }
            : {}),
          selection: variant.selection,
        });
      }
    }
  }

  return PolicyEnvelopeProjectionV0.parse({
    schema_version: 0,
    source,
    policy_envelope: {
      schema_version: 2,
      policy: {
        rules: {
          connectors: {
            registry: config.relay.connectors,
          },
        },
        preferences: {
          relay: {
            roles: Object.fromEntries(
              Object.entries(config.relay.roles)
                .filter((entry): entry is [string, ConnectorReference] => entry[1] !== undefined)
                .map(([role, ref]) => [role, { prefer_connector: connectorRefFromConfig(ref) }]),
            ),
            flow_connector_hints: flowConnectorHints,
          },
          selection: {
            flow_hints: flowSelectionHints,
          },
          skills: {
            slot_bindings: config.skills.bindings,
            flow_slot_bindings: flowSlotBindings,
          },
          prototype: {
            variant_model_hints: variantModelHints,
          },
        },
        defaults: {
          connector: connectorRefFromDefault(config.relay.default),
          ...(config.defaults.selection !== undefined
            ? { selection: config.defaults.selection }
            : {}),
        },
      },
    },
    rejected_old_authority: rejectedOldAuthority,
  });
}

export function policyRefsForConfigLayers(
  layers: readonly LayeredConfigValue[] | undefined,
): readonly Ref[] {
  const refs: Ref[] = [RUNTIME_CONFIG_V1_POLICY_REF];
  for (const [index, layer] of (layers ?? []).entries()) {
    const ref = layer.source_path ?? `policy.config_v1.${layer.layer}.${index}`;
    let sha256: string;
    try {
      const projection = projectConfigV1ToPolicyEnvelopeV2({
        config: layer.config,
        source: policyLayerSourceForConfigLayer(layer.layer),
      });
      sha256 = sha256Json(projection.policy_envelope);
    } catch {
      // Runtime guidance is provenance-only in the v1 transition. A valid v1
      // config must not start failing just because its migration projection is
      // stricter than current runtime behavior.
      sha256 = sha256Json({ schema_version: 1, config: layer.config });
    }
    refs.push({
      kind: 'policy',
      ref,
      sha256,
    });
  }
  return refs;
}

export function policyRefsForPolicyLayers(
  layers: readonly PolicyLayerValue[] | undefined,
): readonly Ref[] {
  const refs: Ref[] = [];
  for (const [index, layer] of (layers ?? []).entries()) {
    refs.push({
      kind: 'policy',
      ref: layer.source_path ?? `policy.policy_v2.${layer.source}.${index}`,
      sha256: sha256Json(layer.envelope),
    });
  }
  return refs;
}

export function policyRefsForRuntimeInputs(input: {
  readonly configLayers?: readonly LayeredConfigValue[];
  readonly policyLayers?: readonly PolicyLayerValue[];
}): readonly Ref[] {
  const refs: Ref[] = [];
  if ((input.configLayers?.length ?? 0) > 0 || (input.policyLayers?.length ?? 0) === 0) {
    refs.push(...policyRefsForConfigLayers(input.configLayers));
  }
  if ((input.policyLayers?.length ?? 0) > 0) {
    refs.push(RUNTIME_POLICY_V2_REF, ...policyRefsForPolicyLayers(input.policyLayers));
  }
  return refs;
}
