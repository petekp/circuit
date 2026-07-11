// The routed connector set — every connector at least one public flow's relay
// step would actually dispatch through, under the effective config layers and
// host kind. `circuit doctor` grades only these connectors for readiness;
// everything else is reported informationally, since a broken connector no
// flow routes to cannot break a run.
//
// Reuses the exact connector-resolution seam `circuit preview` walks
// (explicitConnectorForStep + resolveConnectorForGuidanceInput) rather than
// duplicating it, but skips the model/effort machinery `circuit preview`
// needs and doctor does not — no codex default-model cache read.
import { resolveConnectorForGuidanceInput } from '../connectors/resolver.js';
import { flowDefinitions } from '../flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../flows/compile-schematic-to-flow.js';
import type { RuntimeIndexedStep } from '../flows/registries/runtime-index.js';
import { fromCompiledFlow } from '../runtime/manifest/from-compiled-flow.js';
import { buildRuntimePackageIndex } from '../runtime/manifest/runtime-package-index.js';
import type { LayeredConfig as LayeredConfigValue } from '../schemas/config.js';
import type { CustomConnectorDescriptor } from '../schemas/connector.js';
import type { HostKind } from '../schemas/host.js';
import { RelayRole as RelayRoleSchema } from '../schemas/step.js';
import { explicitConnectorForStep, firstCompiledFlow } from './flow-selection-preview.js';

export interface RoutedConnectorsInput {
  readonly configLayers?: readonly LayeredConfigValue[];
  readonly hostKind?: HostKind;
}

export interface RoutedConnectors {
  // Every connector name (builtin or custom) at least one public flow's relay
  // step resolves to under the given config layers and host kind.
  readonly names: ReadonlySet<string>;
  // Full descriptor for a routed custom connector, keyed by name — the health
  // probe needs `command[0]` to run a presence check.
  readonly custom: ReadonlyMap<string, CustomConnectorDescriptor>;
}

function routedConnectorsForFlow(
  flowId: string,
  layers: readonly LayeredConfigValue[],
  hostKind: HostKind | undefined,
): readonly {
  readonly connectorName: string;
  readonly descriptor: CustomConnectorDescriptor | undefined;
}[] {
  const definition = flowDefinitions.find((candidate) => candidate.id === flowId);
  if (definition === undefined) throw new Error(`unknown flow '${flowId}'`);
  const compiled = firstCompiledFlow(compileSchematicToCompiledFlow(definition.schematic));
  const index = buildRuntimePackageIndex(fromCompiledFlow(compiled));

  const resolved: { connectorName: string; descriptor: CustomConnectorDescriptor | undefined }[] =
    [];
  for (const step of index.flow.steps as readonly RuntimeIndexedStep[]) {
    if (step.kind !== 'relay') continue;
    const role = RelayRoleSchema.parse(step.role);
    const explicitConnector = explicitConnectorForStep(step, layers);
    const decision = resolveConnectorForGuidanceInput({
      flowId,
      role,
      configLayers: layers,
      ...(explicitConnector === undefined ? {} : { explicitConnector }),
      ...(hostKind === undefined ? {} : { hostKind }),
    });
    resolved.push({
      connectorName: decision.connectorName,
      descriptor: decision.connector.kind === 'custom' ? decision.connector : undefined,
    });
  }
  return resolved;
}

export function resolveRoutedConnectors(input: RoutedConnectorsInput = {}): RoutedConnectors {
  const layers = input.configLayers ?? [];
  const names = new Set<string>();
  const custom = new Map<string, CustomConnectorDescriptor>();
  for (const definition of flowDefinitions) {
    if (definition.visibility !== 'public') continue;
    for (const step of routedConnectorsForFlow(definition.id, layers, input.hostKind)) {
      names.add(step.connectorName);
      if (step.descriptor !== undefined) custom.set(step.connectorName, step.descriptor);
    }
  }
  return { names, custom };
}
