import { z } from 'zod';
import {
  ConnectorName,
  CustomConnectorDescriptor,
  EnabledConnector,
  RESERVED_CONNECTOR_NAMES,
} from './connector.js';
import { CompiledFlowId, SkillId, SkillSlotId } from './ids.js';
import { Effort, SelectionOverride } from './selection-policy.js';
import { RelayRole } from './step.js';

export const Provider = z.enum(['openai', 'anthropic', 'gemini', 'custom']);
export type Provider = z.infer<typeof Provider>;

export const PolicyConnectorReference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), name: EnabledConnector }).strict(),
  z.object({ kind: z.literal('named'), name: ConnectorName }).strict(),
]);
export type PolicyConnectorReference = z.infer<typeof PolicyConnectorReference>;

const forbiddenInvocationOptionKeys = new Set([
  'connector',
  'model',
  'effort',
  'skill',
  'skills',
  'write',
  'writes',
  'proof',
  'checkpoint',
  'recovery',
  'safe_apply',
  'safeApply',
  'auto_apply',
]);

function findForbiddenInvocationOptionKey(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenInvocationOptionKey(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenInvocationOptionKeys.has(key)) return key;
    const found = findForbiddenInvocationOptionKey(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

export const PolicySelectionRequest = SelectionOverride.superRefine((selection, ctx) => {
  const forbidden = findForbiddenInvocationOptionKey(selection.invocation_options);
  if (forbidden === undefined) return;
  ctx.addIssue({
    code: 'custom',
    path: ['invocation_options', forbidden],
    message: `invocation_options cannot carry authority key '${forbidden}'`,
  });
});
export type PolicySelectionRequest = z.infer<typeof PolicySelectionRequest>;

const ConnectorRules = z
  .object({
    allow: z.array(ConnectorName).min(1).optional(),
    deny: z.array(ConnectorName).default([]),
    deny_for_write: z.array(ConnectorName).default([]),
    registry: z.record(ConnectorName, CustomConnectorDescriptor).default({}),
  })
  .strict()
  .superRefine((rules, ctx) => {
    const reserved = new Set<string>(RESERVED_CONNECTOR_NAMES);
    for (const [name, descriptor] of Object.entries(rules.registry)) {
      if (reserved.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['registry', name],
          message: `connector name '${name}' is reserved and cannot be used as a custom connector key`,
        });
      }
      if (descriptor.name !== name) {
        ctx.addIssue({
          code: 'custom',
          path: ['registry', name, 'name'],
          message: `connector registry key '${name}' does not match descriptor name '${descriptor.name}'`,
        });
      }
    }
  });
export type ConnectorRules = z.infer<typeof ConnectorRules>;

const ModelRules = z
  .object({
    deny_providers: z.array(Provider).default([]),
    require_provider_for_connector: z.record(ConnectorName, Provider).default({}),
  })
  .strict();
export type ModelRules = z.infer<typeof ModelRules>;

const WriteRules = z
  .object({
    auto_apply: z.boolean().optional(),
    require_checkpoint_globs: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type WriteRules = z.infer<typeof WriteRules>;

const SkillRules = z
  .object({
    deny: z.array(SkillId).default([]),
  })
  .strict();
export type SkillRules = z.infer<typeof SkillRules>;

const ProofRules = z
  .object({
    require_independent_review_for: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ProofRules = z.infer<typeof ProofRules>;

export const PolicyRules = z
  .object({
    connectors: ConnectorRules.default({ deny: [], deny_for_write: [], registry: {} }),
    models: ModelRules.default({ deny_providers: [], require_provider_for_connector: {} }),
    writes: WriteRules.default({ require_checkpoint_globs: [] }),
    skills: SkillRules.default({ deny: [] }),
    proof: ProofRules.default({ require_independent_review_for: [] }),
  })
  .strict();
export type PolicyRules = z.infer<typeof PolicyRules>;

const DEFAULT_POLICY_RULES: PolicyRules = {
  connectors: { deny: [], deny_for_write: [], registry: {} },
  models: { deny_providers: [], require_provider_for_connector: {} },
  writes: { require_checkpoint_globs: [] },
  skills: { deny: [] },
  proof: { require_independent_review_for: [] },
};

export const PolicyLimits = z
  .object({
    max_attempts_per_step: z.number().int().positive().optional(),
    max_wall_clock_ms: z.number().int().positive().optional(),
    max_effort: Effort.optional(),
    max_tournament_n: z.number().int().positive().optional(),
  })
  .strict();
export type PolicyLimits = z.infer<typeof PolicyLimits>;

const RelayRolePreference = z
  .object({
    prefer_connector: PolicyConnectorReference,
  })
  .strict();
export type RelayRolePreference = z.infer<typeof RelayRolePreference>;

const FlowConnectorHint = z
  .object({
    flow_id: CompiledFlowId,
    prefer_connector: PolicyConnectorReference,
  })
  .strict();
export type FlowConnectorHint = z.infer<typeof FlowConnectorHint>;

const RelayPreferences = z
  .object({
    roles: z.partialRecord(RelayRole, RelayRolePreference).default({}),
    flow_connector_hints: z.array(FlowConnectorHint).default([]),
  })
  .strict();
export type RelayPreferences = z.infer<typeof RelayPreferences>;

const FlowSelectionHint = z
  .object({
    flow_id: CompiledFlowId,
    selection: PolicySelectionRequest,
  })
  .strict();
export type FlowSelectionHint = z.infer<typeof FlowSelectionHint>;

const SkillPreferences = z
  .object({
    slot_bindings: z.record(SkillSlotId, SkillId).default({}),
    flow_slot_bindings: z
      .array(
        z
          .object({
            flow_id: CompiledFlowId,
            bindings: z.record(SkillSlotId, SkillId),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type SkillPreferences = z.infer<typeof SkillPreferences>;

const PrototypeVariantModelHint = z
  .object({
    flow_id: CompiledFlowId,
    id: z.string().min(1),
    label: z.string().min(1),
    connector: PolicyConnectorReference.optional(),
    selection: PolicySelectionRequest,
  })
  .strict();
export type PrototypeVariantModelHint = z.infer<typeof PrototypeVariantModelHint>;

export const PolicyPreferences = z
  .object({
    relay: RelayPreferences.default({ roles: {}, flow_connector_hints: [] }),
    selection: z
      .object({
        flow_hints: z.array(FlowSelectionHint).default([]),
      })
      .strict()
      .default({ flow_hints: [] }),
    skills: SkillPreferences.default({ slot_bindings: {}, flow_slot_bindings: [] }),
    invocation: z
      .object({
        selection_request: PolicySelectionRequest.optional(),
      })
      .strict()
      .default({}),
    prototype: z
      .object({
        variant_model_hints: z.array(PrototypeVariantModelHint).default([]),
      })
      .strict()
      .default({ variant_model_hints: [] }),
  })
  .strict();
export type PolicyPreferences = z.infer<typeof PolicyPreferences>;

const DEFAULT_POLICY_PREFERENCES: PolicyPreferences = {
  relay: { roles: {}, flow_connector_hints: [] },
  selection: { flow_hints: [] },
  skills: { slot_bindings: {}, flow_slot_bindings: [] },
  invocation: {},
  prototype: { variant_model_hints: [] },
};

export const PolicyDefaults = z
  .object({
    connector: z.union([PolicyConnectorReference, z.literal('auto')]).optional(),
    selection: PolicySelectionRequest.optional(),
    proof_profile: z.enum(['standard', 'strict']).optional(),
  })
  .strict();
export type PolicyDefaults = z.infer<typeof PolicyDefaults>;

export const PolicyEnvelopeV2 = z
  .object({
    schema_version: z.literal(2),
    policy: z
      .object({
        rules: PolicyRules.default(DEFAULT_POLICY_RULES),
        limits: PolicyLimits.default({}),
        preferences: PolicyPreferences.default(DEFAULT_POLICY_PREFERENCES),
        defaults: PolicyDefaults.default({}),
      })
      .strict(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    const builtinConnectors = new Set<string>(EnabledConnector.options);
    const registeredConnectors = new Set<string>(
      Object.keys(envelope.policy.rules.connectors.registry),
    );

    const checkConnectorName = (path: (string | number)[], name: string) => {
      if (builtinConnectors.has(name) || registeredConnectors.has(name)) return;
      ctx.addIssue({
        code: 'custom',
        path,
        message: `connector '${name}' is not registered`,
      });
    };

    const checkRef = (path: (string | number)[], ref: PolicyConnectorReference | undefined) => {
      if (ref === undefined || ref.kind !== 'named') return;
      if (!registeredConnectors.has(ref.name)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `connector '${ref.name}' is not registered`,
        });
      }
    };

    for (const [index, name] of envelope.policy.rules.connectors.allow?.entries() ?? []) {
      checkConnectorName(['policy', 'rules', 'connectors', 'allow', index], name);
    }
    for (const [index, name] of envelope.policy.rules.connectors.deny.entries()) {
      checkConnectorName(['policy', 'rules', 'connectors', 'deny', index], name);
    }
    for (const [index, name] of envelope.policy.rules.connectors.deny_for_write.entries()) {
      checkConnectorName(['policy', 'rules', 'connectors', 'deny_for_write', index], name);
    }
    for (const name of Object.keys(envelope.policy.rules.models.require_provider_for_connector)) {
      checkConnectorName(
        ['policy', 'rules', 'models', 'require_provider_for_connector', name],
        name,
      );
    }
    for (const [role, preference] of Object.entries(envelope.policy.preferences.relay.roles)) {
      checkRef(
        ['policy', 'preferences', 'relay', 'roles', role, 'prefer_connector'],
        preference?.prefer_connector,
      );
    }
    for (const [index, hint] of envelope.policy.preferences.relay.flow_connector_hints.entries()) {
      checkRef(
        ['policy', 'preferences', 'relay', 'flow_connector_hints', index, 'prefer_connector'],
        hint.prefer_connector,
      );
    }
    for (const [
      index,
      hint,
    ] of envelope.policy.preferences.prototype.variant_model_hints.entries()) {
      checkRef(
        ['policy', 'preferences', 'prototype', 'variant_model_hints', index, 'connector'],
        hint.connector,
      );
    }
    if (envelope.policy.defaults.connector !== 'auto') {
      checkRef(['policy', 'defaults', 'connector'], envelope.policy.defaults.connector);
    }
  });
export type PolicyEnvelopeV2 = z.infer<typeof PolicyEnvelopeV2>;

export const PolicyLayerSource = z.enum(['built-in', 'user-global', 'project', 'invocation']);
export type PolicyLayerSource = z.infer<typeof PolicyLayerSource>;

export const PolicyLayer = z
  .object({
    source: PolicyLayerSource,
    source_path: z.string().optional(),
    envelope: PolicyEnvelopeV2,
  })
  .strict();
export type PolicyLayer = z.infer<typeof PolicyLayer>;

export const RejectedPolicyAuthority = z
  .object({
    path: z.string().min(1),
    field: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type RejectedPolicyAuthority = z.infer<typeof RejectedPolicyAuthority>;

export const PolicyEnvelopeProjectionV0 = z
  .object({
    schema_version: z.literal(0),
    source: PolicyLayerSource,
    policy_envelope: PolicyEnvelopeV2,
    rejected_old_authority: z.array(RejectedPolicyAuthority),
  })
  .strict();
export type PolicyEnvelopeProjectionV0 = z.infer<typeof PolicyEnvelopeProjectionV0>;

export const ComposedPolicyHardConstraints = z
  .object({
    connectors: z
      .object({
        allow: z.array(ConnectorName).optional(),
        deny: z.array(ConnectorName),
        deny_for_write: z.array(ConnectorName),
      })
      .strict(),
    models: z
      .object({
        deny_providers: z.array(Provider),
        require_provider_for_connector: z.record(ConnectorName, Provider),
      })
      .strict(),
    writes: z
      .object({
        auto_apply: z.boolean().optional(),
        require_checkpoint_globs: z.array(z.string().min(1)),
      })
      .strict(),
    skills: z
      .object({
        deny: z.array(SkillId),
      })
      .strict(),
    proof: z
      .object({
        require_independent_review_for: z.array(z.string().min(1)),
      })
      .strict(),
    limits: PolicyLimits,
  })
  .strict();
export type ComposedPolicyHardConstraints = z.infer<typeof ComposedPolicyHardConstraints>;

export type PolicyConnectorRef = z.infer<typeof PolicyConnectorReference>;
