// Relay connector resolution.
//
// Relay connector choice is layered: explicit invocation, role config, flow
// config, default config, then the auto fallback. Keep capability and provider
// checks here so executors can assume the selected connector can run the role.
import type { WorkRootKind } from '../schemas/change-packet.js';
import type { LayeredConfig as LayeredConfigValue } from '../schemas/config.js';
import type { ConnectorReference } from '../schemas/config.js';
import type {
  ConnectorCapabilities,
  EnabledConnector,
  RelayResolutionSource,
  ResolvedConnector,
} from '../schemas/connector.js';
import {
  BUILTIN_CONNECTOR_CAPABILITIES,
  BUILTIN_CONNECTOR_SPECS,
  type ConnectorProvider,
  EnabledConnector as EnabledConnectorSchema,
} from '../schemas/connector.js';
import type { HostKind } from '../schemas/host.js';
import type { CompiledFlowId } from '../schemas/ids.js';
import type { ResolvedSelection } from '../schemas/selection-policy.js';
import type { RelayRole } from '../schemas/step.js';
import type { ResolvedConnectorDecision } from './connector.js';

type RelayConfigValue = LayeredConfigValue['config']['relay'];

function mergedRelayConfig(layers: readonly LayeredConfigValue[] | undefined): RelayConfigValue {
  const merged: RelayConfigValue = {
    default: 'auto',
    roles: {},
    flows: {},
    connectors: {},
  };
  for (const layer of layers ?? []) {
    if (layer.config.relay.default !== 'auto' || merged.default === 'auto') {
      merged.default = layer.config.relay.default;
    }
    merged.roles = { ...merged.roles, ...layer.config.relay.roles };
    merged.flows = { ...merged.flows, ...layer.config.relay.flows };
    merged.connectors = { ...merged.connectors, ...layer.config.relay.connectors };
  }
  return merged;
}

function mergedHostKind(layers: readonly LayeredConfigValue[] | undefined): HostKind {
  let hostKind: HostKind | undefined;
  for (const layer of layers ?? []) {
    const configuredHostKind = layer.config.host?.kind;
    if (configuredHostKind !== undefined) {
      hostKind = configuredHostKind;
    }
  }
  return hostKind ?? 'generic-shell';
}

export function connectorCapabilities(connector: ResolvedConnector): ConnectorCapabilities {
  if (connector.kind === 'builtin') return BUILTIN_CONNECTOR_CAPABILITIES[connector.name];
  return connector.capabilities;
}

export type RelayWriteClassification =
  | {
      readonly filesystem: 'read-only';
      readonly write_capable: false;
      readonly may_unlock_higher_autonomy_after_safe_apply: false;
      readonly reason: string;
    }
  | {
      readonly filesystem: 'trusted-write' | 'isolated-write';
      readonly write_capable: true;
      readonly work_root_kind: WorkRootKind;
      readonly may_unlock_higher_autonomy_after_safe_apply: boolean;
      readonly reason: string;
    };

export function classifyConnectorFilesystem(
  capabilities: ConnectorCapabilities,
): RelayWriteClassification {
  if (capabilities.filesystem === 'read-only') {
    return {
      filesystem: 'read-only',
      write_capable: false,
      may_unlock_higher_autonomy_after_safe_apply: false,
      reason: 'connector is read-only',
    };
  }

  if (capabilities.filesystem === 'isolated-write') {
    return {
      filesystem: 'isolated-write',
      write_capable: true,
      work_root_kind: 'isolated_worktree',
      may_unlock_higher_autonomy_after_safe_apply: true,
      reason: 'connector writes outside the parent checkout',
    };
  }

  return {
    filesystem: 'trusted-write',
    write_capable: true,
    work_root_kind: 'pre_safe_apply_trusted_write',
    may_unlock_higher_autonomy_after_safe_apply: false,
    reason: 'connector can mutate the parent checkout before SafeApply',
  };
}

export function classifyRelayWriteMode(connector: ResolvedConnector): RelayWriteClassification {
  return classifyConnectorFilesystem(connectorCapabilities(connector));
}

export function assertConnectorCanRunRole(connector: ResolvedConnector, role: RelayRole): void {
  const capabilities = connectorCapabilities(connector);
  if (role === 'implementer' && capabilities.filesystem === 'read-only') {
    throw new Error(
      `relay connector '${connector.name}' is read-only and cannot run implementer step role '${role}'`,
    );
  }
}

function resolvedConnectorFromReference(
  ref: ConnectorReference,
  relay: RelayConfigValue,
): ResolvedConnector {
  if (ref.kind === 'builtin') return ref;
  const descriptor = relay.connectors[ref.name];
  if (descriptor === undefined) {
    throw new Error(`relay connector '${ref.name}' is referenced but not declared`);
  }
  return descriptor;
}

export function resolveConnectorReference(input: {
  readonly ref: ConnectorReference;
  readonly configLayers?: readonly LayeredConfigValue[];
}): ResolvedConnector {
  return resolvedConnectorFromReference(input.ref, mergedRelayConfig(input.configLayers));
}

function isEnabledConnector(value: string): value is EnabledConnector {
  return (EnabledConnectorSchema.options as readonly string[]).includes(value);
}

function resolvedConnectorFromDefault(
  defaultRef: RelayConfigValue['default'],
  relay: RelayConfigValue,
): ResolvedConnector {
  if (isEnabledConnector(defaultRef)) {
    return { kind: 'builtin', name: defaultRef };
  }
  const descriptor = relay.connectors[defaultRef];
  if (descriptor === undefined) {
    throw new Error(`relay default connector '${defaultRef}' is referenced but not declared`);
  }
  return descriptor;
}

function decision(
  connector: ResolvedConnector,
  resolvedFrom: RelayResolutionSource,
  role: RelayRole,
): ResolvedConnectorDecision {
  assertConnectorCanRunRole(connector, role);
  return {
    connectorName: connector.name,
    connector,
    resolvedFrom,
  };
}

function autoConnectorForHost(hostKind: HostKind | undefined): ResolvedConnector {
  if (hostKind === 'codex') return { kind: 'builtin', name: 'codex' };
  return { kind: 'builtin', name: 'claude-code' };
}

export function resolveConnectorForGuidanceInput(input: {
  readonly flowId: string;
  readonly role: RelayRole;
  readonly configLayers?: readonly LayeredConfigValue[];
  readonly explicitConnector?: ResolvedConnector;
  readonly hostKind?: HostKind;
}): ResolvedConnectorDecision {
  if (input.explicitConnector !== undefined) {
    return decision(input.explicitConnector, { source: 'explicit' }, input.role);
  }

  const relay = mergedRelayConfig(input.configLayers);
  const roleRef = relay.roles[input.role];
  if (roleRef !== undefined) {
    return decision(
      resolvedConnectorFromReference(roleRef, relay),
      {
        source: 'role',
        role: input.role,
      },
      input.role,
    );
  }

  const flowId = input.flowId as CompiledFlowId;
  const flowRef = relay.flows[flowId];
  if (flowRef !== undefined) {
    return decision(
      resolvedConnectorFromReference(flowRef, relay),
      {
        source: 'flow',
        flow_id: flowId,
      },
      input.role,
    );
  }

  if (relay.default !== 'auto') {
    return decision(
      resolvedConnectorFromDefault(relay.default, relay),
      { source: 'default' },
      input.role,
    );
  }

  return decision(
    autoConnectorForHost(input.hostKind ?? mergedHostKind(input.configLayers)),
    { source: 'auto' },
    input.role,
  );
}

// Provider / supported-effort lookups are now registry-driven. A custom
// connector name is not in the built-in registry and resolves to `undefined`,
// which the callers treat as "no built-in compatibility constraint to assert"
// — identical to the prior if-chain fall-through.
function expectedProvider(connectorName: string): ConnectorProvider | undefined {
  if (!isEnabledConnector(connectorName)) return undefined;
  return BUILTIN_CONNECTOR_SPECS[connectorName].provider;
}

function supportedEfforts(connectorName: string): readonly string[] | undefined {
  if (!isEnabledConnector(connectorName)) return undefined;
  return BUILTIN_CONNECTOR_SPECS[connectorName].supportedEfforts;
}

export function assertConnectorSelectionCompatible(
  connectorName: string,
  selection: ResolvedSelection | undefined,
): void {
  const expected = expectedProvider(connectorName);
  const model = selection?.model;
  if (expected !== undefined && model !== undefined && model.provider !== expected) {
    throw new Error(
      `${connectorName} connector cannot honor model provider '${model.provider}' for model '${model.model}'; expected provider '${expected}'`,
    );
  }
  const effort = selection?.effort;
  if (effort === undefined) return;
  const supported = supportedEfforts(connectorName);
  if (supported !== undefined && !supported.includes(effort)) {
    throw new Error(
      `${connectorName} connector cannot honor effort '${effort}'; supported efforts: ${supported.join(', ')}`,
    );
  }
}
