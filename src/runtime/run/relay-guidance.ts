import {
  assertConnectorCanRunRole,
  assertConnectorSelectionCompatible,
  resolveConnectorForGuidanceInput,
} from '../../connectors/resolver.js';
import type {
  RuntimeIndexedFlow,
  RuntimeIndexedRelayStep,
} from '../../flows/registries/runtime-index.js';
import { composePolicyHardConstraints } from '../../policy/policy-envelope.js';
import type { ResolvedConnector } from '../../schemas/connector.js';
import type { RelayResolutionSource } from '../../schemas/connector.js';
import type { Depth } from '../../schemas/depth.js';
import type { HostKind } from '../../schemas/host.js';
import type { CompiledFlowId } from '../../schemas/ids.js';
import type {
  PolicyConnectorRef,
  PolicyLayer as PolicyLayerValue,
} from '../../schemas/policy-envelope.js';
import type { ResolvedSelection as ResolvedSelectionValue } from '../../schemas/selection-policy.js';
import type { SkillSlot } from '../../schemas/skill.js';
import { RelayRole } from '../../schemas/step.js';
import { deriveResolvedSelection } from '../../shared/relay-selection.js';
import { type LoadedRelaySkill, resolveLoadedRelaySkills } from '../../shared/skill-loading.js';
import type { RelayConnector } from '../executors/relay.js';
import type { RelayStep } from '../manifest/executable-flow.js';
import type { RunContext } from './run-context.js';

function builtinConnector(name: string): ResolvedConnector | undefined {
  if (name === 'claude-code' || name === 'codex' || name === 'cursor-agent') {
    return { kind: 'builtin', name };
  }
  return undefined;
}

function resolvedConnectorName(connector: ResolvedConnector | undefined): string | undefined {
  return connector?.name;
}

function configLayerConnector(
  name: string,
  configLayers: Parameters<typeof resolveConnectorForGuidanceInput>[0]['configLayers'],
): ResolvedConnector | undefined {
  let descriptor: ResolvedConnector | undefined;
  for (const layer of configLayers ?? []) {
    descriptor = layer.config.relay.connectors[name] ?? descriptor;
  }
  return descriptor;
}

function policyLayerConnector(
  name: string,
  policyLayers: readonly PolicyLayerValue[] | undefined,
): ResolvedConnector | undefined {
  let descriptor: ResolvedConnector | undefined;
  for (const layer of policyLayers ?? []) {
    descriptor = layer.envelope.policy.rules.connectors.registry[name] ?? descriptor;
  }
  return descriptor;
}

function connectorFromPolicyRef(
  ref: PolicyConnectorRef,
  policyLayers: readonly PolicyLayerValue[] | undefined,
): ResolvedConnector {
  if (ref.kind === 'builtin') return ref;
  const descriptor = policyLayerConnector(ref.name, policyLayers);
  if (descriptor !== undefined) return descriptor;
  throw new Error(`policy connector '${ref.name}' is referenced but not declared`);
}

function requestedConnectorForGuidanceInput(input: {
  readonly stepConnector?: string;
  readonly suppliedConnector?: RelayConnector;
  readonly configLayers?: Parameters<typeof resolveConnectorForGuidanceInput>[0]['configLayers'];
  readonly policyLayers?: readonly PolicyLayerValue[];
}): ResolvedConnector | undefined {
  const suppliedResolved = input.suppliedConnector?.connector;
  const suppliedResolvedName = resolvedConnectorName(suppliedResolved);
  const suppliedName = input.suppliedConnector?.connectorName ?? suppliedResolvedName;

  if (
    input.suppliedConnector?.connectorName !== undefined &&
    suppliedResolvedName !== undefined &&
    input.suppliedConnector.connectorName !== suppliedResolvedName
  ) {
    throw new Error(
      `relay connector identity mismatch: connectorName '${input.suppliedConnector.connectorName}' does not match resolved connector '${suppliedResolvedName}'`,
    );
  }

  if (
    input.stepConnector !== undefined &&
    suppliedName !== undefined &&
    input.stepConnector !== suppliedName
  ) {
    throw new Error(
      `relay connector identity mismatch: step requests '${input.stepConnector}' but supplied connector is '${suppliedName}'`,
    );
  }

  const requested = input.stepConnector ?? suppliedName;
  if (requested === undefined) return undefined;

  const builtin = builtinConnector(requested);
  if (builtin !== undefined) return builtin;

  if (suppliedResolved !== undefined && suppliedResolved.name === requested) {
    return suppliedResolved;
  }

  const policyConfigured = policyLayerConnector(requested, input.policyLayers);
  if (policyConfigured !== undefined) return policyConfigured;

  const configured = configLayerConnector(requested, input.configLayers);
  if (configured !== undefined) return configured;

  throw new Error(
    `relay connector '${requested}' requires resolved connector capabilities before execution`,
  );
}

function relayDecision(
  connector: ResolvedConnector,
  resolvedFrom: RelayResolutionSource,
  role: RelayRole,
): {
  readonly role: string;
  readonly connectorName: string;
  readonly connector: ResolvedConnector;
  readonly resolvedFrom: RelayResolutionSource;
} {
  assertConnectorCanRunRole(connector, role);
  return {
    role,
    connectorName: connector.name,
    connector,
    resolvedFrom,
  };
}

function policyConnectorChoice(input: {
  readonly flowId: string;
  readonly role: RelayRole;
  readonly policyLayers?: readonly PolicyLayerValue[];
}): ReturnType<typeof relayDecision> | undefined {
  if ((input.policyLayers?.length ?? 0) === 0) return undefined;

  let roleRef: PolicyConnectorRef | undefined;
  let flowRef: PolicyConnectorRef | undefined;
  let defaultRef: PolicyConnectorRef | 'auto' | undefined;
  const flowId = input.flowId as CompiledFlowId;

  for (const layer of input.policyLayers ?? []) {
    roleRef =
      layer.envelope.policy.preferences.relay.roles[input.role]?.prefer_connector ?? roleRef;
    for (const hint of layer.envelope.policy.preferences.relay.flow_connector_hints) {
      if (hint.flow_id === flowId) {
        flowRef = hint.prefer_connector;
      }
    }
    defaultRef = layer.envelope.policy.defaults.connector ?? defaultRef;
  }

  if (roleRef !== undefined) {
    return relayDecision(
      connectorFromPolicyRef(roleRef, input.policyLayers),
      { source: 'role', role: input.role },
      input.role,
    );
  }

  if (flowRef !== undefined) {
    return relayDecision(
      connectorFromPolicyRef(flowRef, input.policyLayers),
      { source: 'circuit', flow_id: flowId },
      input.role,
    );
  }

  if (defaultRef !== undefined && defaultRef !== 'auto') {
    return relayDecision(
      connectorFromPolicyRef(defaultRef, input.policyLayers),
      { source: 'default' },
      input.role,
    );
  }

  return undefined;
}

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function effortExceedsMax(effort: string | undefined, maxEffort: string | undefined): boolean {
  if (effort === undefined || maxEffort === undefined) return false;
  return EFFORT_ORDER.indexOf(effort as never) > EFFORT_ORDER.indexOf(maxEffort as never);
}

function assertPolicyAllowsRelayPlan(input: {
  readonly context: RunContext;
  readonly role: RelayRole;
  readonly connectorName: string;
  readonly resolvedSelection: ResolvedSelectionValue;
  readonly loadedSkills: readonly LoadedRelaySkill[];
}): void {
  const policyLayers = input.context.policyLayers ?? [];
  assertPolicyAllowsRelayExecutionInput({
    policyLayers,
    role: input.role,
    connectorName: input.connectorName,
    resolvedSelection: input.resolvedSelection,
  });
  if (policyLayers.length === 0) return;

  const constraints = composePolicyHardConstraints(policyLayers.map((layer) => layer.envelope));
  const deniedSkills = new Set(constraints.skills.deny);
  const deniedLoadedSkill = input.loadedSkills.find((skill) => deniedSkills.has(skill.id));
  if (deniedLoadedSkill !== undefined) {
    throw new Error(`PolicyEnvelope disallows skill '${deniedLoadedSkill.id}': skill is denied`);
  }
}

function assertPolicyAllowsRelayExecutionInput(input: {
  readonly policyLayers?: readonly PolicyLayerValue[];
  readonly role: RelayRole;
  readonly connectorName: string;
  readonly resolvedSelection?: ResolvedSelectionValue;
}): void {
  const policyLayers = input.policyLayers ?? [];
  if (policyLayers.length === 0) return;

  const constraints = composePolicyHardConstraints(policyLayers.map((layer) => layer.envelope));
  const allowedConnectors = constraints.connectors.allow;
  if (allowedConnectors !== undefined && !allowedConnectors.includes(input.connectorName)) {
    throw new Error(
      `PolicyEnvelope disallows connector '${input.connectorName}': not in allowed connectors`,
    );
  }
  if (constraints.connectors.deny.includes(input.connectorName)) {
    throw new Error(
      `PolicyEnvelope disallows connector '${input.connectorName}': connector is denied`,
    );
  }
  if (
    input.role === 'implementer' &&
    constraints.connectors.deny_for_write.includes(input.connectorName)
  ) {
    throw new Error(
      `PolicyEnvelope disallows connector '${input.connectorName}': connector is denied for write-capable relays`,
    );
  }

  const provider = input.resolvedSelection?.model?.provider;
  if (provider !== undefined && constraints.models.deny_providers.includes(provider)) {
    throw new Error(`PolicyEnvelope disallows provider '${provider}': provider is denied`);
  }
  const requiredProvider = constraints.models.require_provider_for_connector[input.connectorName];
  if (requiredProvider !== undefined && provider !== requiredProvider) {
    throw new Error(
      `PolicyEnvelope requires connector '${input.connectorName}' to use provider '${requiredProvider}'`,
    );
  }

  if (effortExceedsMax(input.resolvedSelection?.effort, constraints.limits.max_effort)) {
    throw new Error(
      `PolicyEnvelope disallows effort '${input.resolvedSelection?.effort}': max effort is '${constraints.limits.max_effort}'`,
    );
  }
}

function resolveRelayGuidanceExecution(input: {
  readonly flowId: string;
  readonly role: string;
  readonly stepConnector?: string;
  readonly suppliedConnector?: RelayConnector;
  readonly configLayers?: Parameters<typeof resolveConnectorForGuidanceInput>[0]['configLayers'];
  readonly policyLayers?: readonly PolicyLayerValue[];
  readonly hostKind?: HostKind;
}): {
  readonly role: string;
  readonly connectorName: string;
  readonly connector: ResolvedConnector;
  readonly resolvedFrom: RelayResolutionSource;
} {
  const role = RelayRole.parse(input.role);
  const explicitConnector = requestedConnectorForGuidanceInput({
    ...(input.stepConnector === undefined ? {} : { stepConnector: input.stepConnector }),
    ...(input.suppliedConnector === undefined
      ? {}
      : { suppliedConnector: input.suppliedConnector }),
    ...(input.configLayers === undefined ? {} : { configLayers: input.configLayers }),
    ...(input.policyLayers === undefined ? {} : { policyLayers: input.policyLayers }),
  });
  const resolved =
    explicitConnector === undefined
      ? (policyConnectorChoice({
          flowId: input.flowId,
          role,
          ...(input.policyLayers === undefined ? {} : { policyLayers: input.policyLayers }),
        }) ??
        resolveConnectorForGuidanceInput({
          flowId: input.flowId,
          role,
          ...(input.configLayers === undefined ? {} : { configLayers: input.configLayers }),
          ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
        }))
      : resolveConnectorForGuidanceInput({
          flowId: input.flowId,
          role,
          ...(input.configLayers === undefined ? {} : { configLayers: input.configLayers }),
          explicitConnector,
          ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
        });
  const resolvedConnector = resolved.connector;
  assertPolicyAllowsRelayExecutionInput({
    ...(input.policyLayers === undefined ? {} : { policyLayers: input.policyLayers }),
    role,
    connectorName: resolvedConnector.name,
  });
  return {
    role,
    connectorName: resolvedConnector.name,
    connector: resolvedConnector,
    resolvedFrom: resolved.resolvedFrom,
  };
}

function suppliedConnectorFromRelayer(context: RunContext): RelayConnector | undefined {
  if (context.relayer === undefined) return undefined;
  return {
    connectorName: context.relayer.connectorName,
    ...(context.relayer.connector === undefined ? {} : { connector: context.relayer.connector }),
    async relay() {
      throw new Error('relay identity placeholder should not be invoked');
    },
  };
}

interface RelayGuidancePlan {
  readonly relayExecution: ReturnType<typeof resolveRelayGuidanceExecution>;
  readonly resolvedSelection: ResolvedSelectionValue;
  readonly loadedSkills: readonly LoadedRelaySkill[];
}

export function planRelayGuidanceDecision(input: {
  readonly context: RunContext;
  readonly step: RelayStep;
  readonly compiledStep: RuntimeIndexedRelayStep;
  readonly depth: Depth;
  readonly suppliedConnector?: RelayConnector;
}): RelayGuidancePlan {
  const { context, step, compiledStep } = input;
  const flow = context.packageIndex.flow;
  const suppliedConnector = input.suppliedConnector ?? suppliedConnectorFromRelayer(context);
  const relayExecution = resolveRelayGuidanceExecution({
    flowId: context.flow.id,
    role: step.role,
    ...(suppliedConnector === undefined ? {} : { suppliedConnector }),
    ...(context.selectionConfigLayers === undefined
      ? {}
      : { configLayers: context.selectionConfigLayers }),
    ...(context.policyLayers === undefined ? {} : { policyLayers: context.policyLayers }),
    ...(context.hostKind === undefined ? {} : { hostKind: context.hostKind }),
    ...(step.connector === undefined ? {} : { stepConnector: step.connector }),
  });
  const resolvedSelection = deriveResolvedSelection(
    {
      ...(context.selectionConfigLayers === undefined
        ? {}
        : { selectionConfigLayers: context.selectionConfigLayers }),
    },
    flow as RuntimeIndexedFlow,
    compiledStep,
    input.depth,
  );
  assertConnectorSelectionCompatible(relayExecution.connectorName, resolvedSelection);
  // Skill-hook actuation: any skills an `auto` hook injected so far, applied
  // ONLY to write-capable (implementer) relays. Every injecting hook today
  // (before/after:edit-files, after:verification-failed) concerns a code edit, so
  // a researcher or reviewer relay must never receive these skills — a reviewer
  // judges the work independently and an implementer skill would contaminate that
  // role. (Without this gate the run-scoped channel would leak the skill into
  // every later relay, including review and close.) Read idempotently (the
  // channel never drains), so every planRelayGuidanceDecision call for this step —
  // production, injected-connector, and each fanout branch — sees the same set and
  // assertRelayGuidanceMatchesPlan + the request-payload hash stay consistent. The
  // channel is mutated only between steps.
  const injectedSkillIds =
    relayExecution.role === 'implementer' ? (context.skillHookInjections?.ids() ?? []) : [];
  const loadedSkills = resolveLoadedRelaySkills({
    flowId: flow.id as CompiledFlowId,
    stepId: step.id,
    skillSlots: (compiledStep.skill_slots ?? []) as readonly SkillSlot[],
    resolvedSelection,
    ...(context.selectionConfigLayers === undefined
      ? {}
      : { configLayers: context.selectionConfigLayers }),
    ...(injectedSkillIds.length === 0 ? {} : { injectedSkillIds }),
    // Share the run's single registry (the same one the skill-hook dispatcher
    // resolved against), so an injected skill recorded as triggered resolves here
    // identically — no dispatch-vs-relay divergence, one filesystem snapshot.
    ...(context.skillRegistry === undefined ? {} : { registry: context.skillRegistry }),
  });
  assertPolicyAllowsRelayPlan({
    context,
    role: RelayRole.parse(relayExecution.role),
    connectorName: relayExecution.connectorName,
    resolvedSelection,
    loadedSkills,
  });
  return { relayExecution, resolvedSelection, loadedSkills };
}
