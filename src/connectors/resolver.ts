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

// SECURITY BOUNDARY (C1 — arbitrary command execution from a cloned repo).
// A custom connector descriptor carries an arbitrary `command` that the engine
// spawns with the full inherited environment. A project's committed
// `.circuit/config.yaml` is untrusted input: cloning a repository and running
// any flow (even a read-only review) must never let the repository author's
// config execute a command on the operator's machine. So custom connector
// definitions are honored only from layers the operator controls on their own
// machine — their user-global config or an explicit invocation override — and
// never from the project layer. Built-in connector names (claude-code / codex
// / cursor-agent) name a fixed, Circuit-shipped executable rather than an
// arbitrary command, so they stay selectable from any layer.
//
// This is the single place the project-vs-trusted partition of the custom
// connector registry lives. Every path that turns a connector name into a
// command-bearing descriptor resolves it through this registry (relay default
// / role / flow resolution here, and the step-pinned connector path in
// runtime/run/relay-guidance.ts), so the boundary cannot be forgotten by one
// caller while another honors it.
export function customConnectorRegistryFromLayers(
  layers: readonly LayeredConfigValue[] | undefined,
): {
  readonly registry: RelayConfigValue['connectors'];
  readonly projectDeclaredNames: ReadonlySet<string>;
} {
  const registry: RelayConfigValue['connectors'] = {};
  const projectDeclaredNames = new Set<string>();
  for (const layer of layers ?? []) {
    if (layer.layer === 'project') {
      // Record the names a project tried to register (to explain the refusal
      // clearly if a selection points at one) but never adopt the command.
      for (const name of Object.keys(layer.config.relay.connectors)) {
        projectDeclaredNames.add(name);
      }
      continue;
    }
    Object.assign(registry, layer.config.relay.connectors);
  }
  return { registry, projectDeclaredNames };
}

export function projectCustomConnectorRefusalMessage(name: string): string {
  return `This project config (.circuit/config.yaml) defines a custom connector '${name}' that runs its own command. Circuit does not run custom command connectors that come from a project config, because cloning or opening a repository could then run code on your machine. If you trust this connector, define '${name}' in your personal config at ~/.config/circuit/config.yaml instead.`;
}

interface MergedRelayConfig {
  readonly relay: RelayConfigValue;
  // Custom connector names a project layer tried to define. Consulted only when
  // a selection misses the trusted registry, to raise the security refusal
  // above instead of a misleading "not declared" error.
  readonly projectDeclaredCustomConnectors: ReadonlySet<string>;
}

function mergedRelayConfig(layers: readonly LayeredConfigValue[] | undefined): MergedRelayConfig {
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
  }
  const { registry, projectDeclaredNames } = customConnectorRegistryFromLayers(layers);
  merged.connectors = registry;
  return { relay: merged, projectDeclaredCustomConnectors: projectDeclaredNames };
}

function projectCustomRefusalOrNotDeclared(
  name: string,
  merged: MergedRelayConfig,
  notDeclaredMessage: string,
): Error {
  if (merged.projectDeclaredCustomConnectors.has(name)) {
    return new Error(projectCustomConnectorRefusalMessage(name));
  }
  return new Error(notDeclaredMessage);
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
  merged: MergedRelayConfig,
): ResolvedConnector {
  if (ref.kind === 'builtin') return ref;
  const descriptor = merged.relay.connectors[ref.name];
  if (descriptor === undefined) {
    throw projectCustomRefusalOrNotDeclared(
      ref.name,
      merged,
      `relay connector '${ref.name}' is referenced but not declared`,
    );
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
  merged: MergedRelayConfig,
): ResolvedConnector {
  if (isEnabledConnector(defaultRef)) {
    return { kind: 'builtin', name: defaultRef };
  }
  const descriptor = merged.relay.connectors[defaultRef];
  if (descriptor === undefined) {
    throw projectCustomRefusalOrNotDeclared(
      defaultRef,
      merged,
      `relay default connector '${defaultRef}' is referenced but not declared`,
    );
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

  const merged = mergedRelayConfig(input.configLayers);
  const roleRef = merged.relay.roles[input.role];
  if (roleRef !== undefined) {
    return decision(
      resolvedConnectorFromReference(roleRef, merged),
      {
        source: 'role',
        role: input.role,
      },
      input.role,
    );
  }

  const flowId = input.flowId as CompiledFlowId;
  const flowRef = merged.relay.flows[flowId];
  if (flowRef !== undefined) {
    return decision(
      resolvedConnectorFromReference(flowRef, merged),
      {
        source: 'flow',
        flow_id: flowId,
      },
      input.role,
    );
  }

  if (merged.relay.default !== 'auto') {
    return decision(
      resolvedConnectorFromDefault(merged.relay.default, merged),
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
