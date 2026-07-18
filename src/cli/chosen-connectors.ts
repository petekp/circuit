// The chosen connector set — every connector at least one public flow's relay
// step would actually dispatch through, under the effective config layers and
// host kind. `circuit doctor` grades only these connectors for readiness;
// everything else is reported informationally, since a broken connector no
// flow ever chooses cannot break a run.
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
import type { CompiledFlow } from '../schemas/compiled-flow.js';
import type { LayeredConfig as LayeredConfigValue } from '../schemas/config.js';
import type { CustomConnectorDescriptor, RelayResolutionSource } from '../schemas/connector.js';
import type { HostKind } from '../schemas/host.js';
import { RelayRole as RelayRoleSchema } from '../schemas/step.js';
import { explicitConnectorForStep, firstCompiledFlow } from './flow-selection-preview.js';

export interface ChosenConnectorsInput {
  readonly configLayers?: readonly LayeredConfigValue[];
  readonly hostKind?: HostKind;
}

export interface ChosenConnectors {
  // Every connector name (builtin or custom) at least one public flow's relay
  // step resolves to under the given config layers and host kind.
  readonly names: ReadonlySet<string>;
  // Why each connector was chosen, keyed by name: the distinct resolution
  // sources that picked it, as short teachable phrases (`auto`, `default`,
  // `role: reviewer`, `flow: fix`, `step pin`), sorted. This is what
  // `circuit doctor` prints in its CHOSEN BY column, so the readout names
  // the exact config lever behind every decision.
  readonly sources: ReadonlyMap<string, readonly string[]>;
  // Full descriptor for a chosen custom connector, keyed by name — the health
  // probe needs `command[0]` to run a presence check.
  readonly custom: ReadonlyMap<string, CustomConnectorDescriptor>;
}

// The teachable phrase for one resolution source. `role:`/`flow:` name the
// config keys (`relay.roles.<role>`, `relay.flows.<flow>`) an operator would
// set to change the decision; `step pin` is authored by the flow itself.
function describeResolutionSource(source: RelayResolutionSource): string {
  switch (source.source) {
    case 'explicit':
      return 'step pin';
    case 'role':
      return `role: ${source.role}`;
    case 'flow':
      return `flow: ${source.flow_id}`;
    case 'default':
      return 'default';
    case 'auto':
      return 'auto';
  }
}

export interface ChosenStepConnector {
  readonly connectorName: string;
  readonly source: string;
  readonly descriptor: CustomConnectorDescriptor | undefined;
}

// The per-flow resolution walk, on an already-compiled flow. Run-intake
// preflight calls this directly with the loaded compiled flow so the probe
// set matches exactly what THIS run would dispatch through; the doctor path
// below compiles each catalog definition first.
export function connectorsForCompiledFlow(
  compiled: CompiledFlow,
  layers: readonly LayeredConfigValue[],
  hostKind: HostKind | undefined,
): readonly ChosenStepConnector[] {
  const index = buildRuntimePackageIndex(fromCompiledFlow(compiled));
  const flowId = index.flow.id as unknown as string;

  const resolved: ChosenStepConnector[] = [];
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
      source: describeResolutionSource(decision.resolvedFrom),
      descriptor: decision.connector.kind === 'custom' ? decision.connector : undefined,
    });
  }
  return resolved;
}

function chosenConnectorsForFlow(
  flowId: string,
  layers: readonly LayeredConfigValue[],
  hostKind: HostKind | undefined,
): readonly ChosenStepConnector[] {
  const definition = flowDefinitions.find((candidate) => candidate.id === flowId);
  if (definition === undefined) throw new Error(`unknown flow '${flowId}'`);
  const compiled = firstCompiledFlow(compileSchematicToCompiledFlow(definition.schematic));
  return connectorsForCompiledFlow(compiled, layers, hostKind);
}

export function resolveChosenConnectors(input: ChosenConnectorsInput = {}): ChosenConnectors {
  const layers = input.configLayers ?? [];
  const names = new Set<string>();
  const sourceSets = new Map<string, Set<string>>();
  const custom = new Map<string, CustomConnectorDescriptor>();
  for (const definition of flowDefinitions) {
    if (definition.visibility !== 'public') continue;
    for (const step of chosenConnectorsForFlow(definition.id, layers, input.hostKind)) {
      names.add(step.connectorName);
      const sourceSet = sourceSets.get(step.connectorName) ?? new Set<string>();
      sourceSet.add(step.source);
      sourceSets.set(step.connectorName, sourceSet);
      if (step.descriptor !== undefined) custom.set(step.connectorName, step.descriptor);
    }
  }
  const sources = new Map<string, readonly string[]>();
  for (const [name, sourceSet] of sourceSets) {
    sources.set(name, [...sourceSet].sort());
  }
  return { names, sources, custom };
}
