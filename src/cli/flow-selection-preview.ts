// Flow selection preview.
//
// A pure, spawn-free projection of what each relay step in a flow would resolve
// to under a given Power dial and config: connector, model, effort, and where
// each value came from. It reuses the exact production selection seam
// (deriveResolvedSelection → materializePowerSelection → connector resolution)
// so the preview cannot drift from what a real run would dispatch. Nothing here
// spawns a connector subprocess; the one filesystem touch is a read-only lookup
// of the operator's codex default-model cache, injectable for tests.
//
// Lives at the CLI/application layer, not in src/selection: it composes the
// flow catalog, the runtime package index, and the connector resolver, none of
// which the flow-safe selection layer is allowed to import (see
// tests/contracts/architecture-boundaries.test.ts). The reused selection
// primitives themselves stay in src/selection.
import { resolveCodexDefaultModelUncached } from '../connectors/codex-default-model.js';
import {
  assertConnectorSelectionCompatible,
  customConnectorRegistryFromLayers,
  resolveConnectorForGuidanceInput,
} from '../connectors/resolver.js';
import { axisSelectionsForAxes } from '../flows/axis-selections.js';
import { flowDefinitions } from '../flows/catalog.js';
import {
  type CompileResult,
  compileSchematicToCompiledFlow,
} from '../flows/compile-schematic-to-flow.js';
import type {
  RuntimeIndexedFlow,
  RuntimeIndexedRelayStep,
  RuntimeIndexedStep,
  RuntimePackageIndex,
} from '../flows/registries/runtime-index.js';
import type { CompiledFlowVisibility } from '../flows/types.js';
import { fromCompiledFlow } from '../runtime/manifest/from-compiled-flow.js';
import { buildRuntimePackageIndex } from '../runtime/manifest/runtime-package-index.js';
import { LayeredConfig, type LayeredConfig as LayeredConfigValue } from '../schemas/config.js';
import type { ResolvedConnector } from '../schemas/connector.js';
import type { HostKind } from '../schemas/host.js';
import type { Power } from '../schemas/power.js';
import type { CompiledDepth, Process as ProcessValue } from '../schemas/process.js';
import type { RelayRole } from '../schemas/step.js';
import { RelayRole as RelayRoleSchema } from '../schemas/step.js';
import { resolveFlowProcessSetting } from '../selection/flow-process.js';
import {
  materializePowerSelection,
  resolvePowerDial,
  resolvePowerDialSetting,
} from '../selection/power-tiers.js';
import { deriveResolvedSelection } from '../selection/relay-selection.js';
import type { GuidanceSelectionFlow } from '../selection/selection-resolver.js';
import { clampDerivedDepthToFlow, deriveProcessFromPower } from './run.js';

// Where a relay step's model value came from. `pinned` = an explicit pin in
// the selection stack won — an operator config file OR a pin the flow itself
// authors (flow/stage/step selection), which is why the word promises a pin,
// not a file; `power-tier` = the Power dial's tier table filled it;
// `codex-default` = a codex connector's model was read from the operator's
// codex default-model cache; `codex-default-unresolved` = that cache was
// missing/unreadable, so the model is left blank rather than guessed;
// `unset` = no model resolved and the connector needs none named here.
export type PreviewModelSource =
  | 'pinned'
  | 'power-tier'
  | 'codex-default'
  | 'codex-default-unresolved'
  | 'unset';

// Where a relay step's effort came from. Same split as the model: `pinned` =
// an explicit pin in the selection stack won; `power-tier` = the dial's tier
// table filled it (including the fixed role allocation, e.g. researchers
// pinned to the top tier — a shipped default, not an operator choice);
// `unset` = the connector takes no effort here.
export type PreviewEffortSource = 'pinned' | 'power-tier' | 'unset';

export interface RelayStepSelectionPreview {
  readonly stepId: string;
  readonly kind: 'relay';
  readonly role: RelayRole;
  readonly connector: string;
  // The model's bare slug (e.g. `opus`, `gpt-5.5`) — what the readout shows.
  readonly model?: string;
  // The model's provider (e.g. `anthropic`, `openai`), kept as its own field so
  // the structured record stays complete while the readout omits it.
  readonly provider?: string;
  readonly modelSource: PreviewModelSource;
  readonly effort?: string;
  readonly effortSource: PreviewEffortSource;
  readonly power?: Power;
  readonly powerSource: 'fixed' | 'auto';
  readonly escalated: boolean;
  // Set only when the resolved connector cannot honor the resolved model or
  // effort (a misconfigured tier table or an incompatible pin). Preview reports
  // the mismatch instead of throwing, so one bad step never sinks the whole view.
  readonly problem?: string;
  // True when the flow's routing data excludes this step at the previewed
  // process (fix routes past review into fix-close-low at process low).
  // Absent means the step runs. Derived from the compiled per-mode graphs,
  // never from a per-flow special case, so the preview cannot advertise work
  // a run would skip.
  readonly skippedAtProcess?: boolean;
  // True when this row is a fan-out step: the relay below runs once per item the
  // step dispatches over, not once. How many items there are depends on the
  // target, so the readout says "per item" rather than inventing a count.
  readonly runsPerItem?: boolean;
}

export interface NonRelayStepSelectionPreview {
  readonly stepId: string;
  readonly kind: string;
  // Same meaning as on relay steps: routing excludes this step at the
  // previewed process. Absent means the step runs.
  readonly skippedAtProcess?: boolean;
}

export interface FlowSelectionPreview {
  readonly flowId: string;
  readonly visibility: CompiledFlowVisibility;
  // The dial setting itself: a fixed tier or `auto`.
  readonly dial: Power | 'auto';
  // The single tier the dial resolves to for this preview. Equals `dial` when
  // fixed; `medium` for `auto` (the default-on tier, since a preview has no
  // researcher inference to clamp against).
  readonly dialResolvesTo: Power;
  // The process thoroughness the dial word derives (Path A), clamped to this
  // flow's allowed set — the same derivation `circuit run` applies when
  // `--process` is absent.
  readonly process: ProcessValue;
  // Which lever decided `process`: a standing `flows.<id>.process` in the
  // config, or the power dial. Surfaced so an operator reading the header can
  // tell a setting they wrote from a value the dial derived, and knows which
  // one to change.
  readonly processSource: 'config' | 'dial';
  // Set only when a standing `flows.<id>.process` asked for a thoroughness
  // this flow does not run, and the clamp moved it. Carries the word the
  // operator actually wrote. Without this the readout would name the config
  // as the source of a value the config never said, which reads as the
  // setting being ignored at best and as a lie at worst.
  readonly processClampedFrom?: ProcessValue;
  readonly relaySteps: readonly RelayStepSelectionPreview[];
  readonly nonRelaySteps: readonly NonRelayStepSelectionPreview[];
}

export interface FlowSelectionPreviewInput {
  readonly flowId: string;
  // The dial to preview. Omit to read whatever the passed config layers imply
  // (default-on medium when they say nothing).
  readonly power?: Power | 'auto';
  readonly configLayers?: readonly LayeredConfigValue[];
  readonly hostKind?: HostKind;
  // Read-only source of the operator's codex default model, injectable so tests
  // never touch ~/.codex. Defaults to the real cache reader (a file read, no
  // spawn), which throws when the cache is missing — caught and reported as
  // `codex-default-unresolved`.
  readonly codexDefaultModel?: () => string;
}

// Exported for `circuit doctor`'s chosen-connector-set computation (see
// chosen-connectors.ts), which reuses this compile step rather than
// duplicating it.
export function firstCompiledFlow(result: CompileResult) {
  if (result.kind === 'single') return result.flow;
  const first = [...result.flows.values()][0];
  if (first === undefined) throw new Error('per-mode compile produced no flows');
  return first;
}

function builtinConnector(name: string): ResolvedConnector | undefined {
  if (name === 'claude-code' || name === 'codex' || name === 'cursor-agent') {
    return { kind: 'builtin', name };
  }
  return undefined;
}

// A step's pinned connector, resolved to a concrete connector when it names a
// builtin or a config-declared custom connector. Returns undefined for an
// unpinned step (so connector resolution falls through to role/flow/auto) or a
// pinned name the config does not declare (best-effort: fall through too).
// Exported for `circuit doctor`'s chosen-connector-set computation (see
// chosen-connectors.ts), which resolves the same per-step pin without
// duplicating this security-sensitive lookup.
export function explicitConnectorForStep(
  step: RuntimeIndexedRelayStep,
  layers: readonly LayeredConfigValue[],
): ResolvedConnector | undefined {
  if (step.connector === undefined) return undefined;
  const builtin = builtinConnector(step.connector);
  if (builtin !== undefined) return builtin;
  // SECURITY: only surface custom connectors the operator's own layers declare.
  // A project config cannot supply a command-running connector (the production
  // resolver refuses it), so the preview must never show one as the resolved
  // connector. A pinned name the trusted config does not declare falls through
  // to role/flow/auto, matching the prior best-effort behavior.
  const { registry } = customConnectorRegistryFromLayers(layers);
  return registry[step.connector];
}

// Inject the requested dial as an invocation-layer `defaults.power` opinion, so
// the production dial reader (resolvePowerDialSetting) sees it exactly as it
// would in a real run started with `--power`.
function withPowerLayer(
  layers: readonly LayeredConfigValue[],
  power: Power | 'auto' | undefined,
): readonly LayeredConfigValue[] {
  if (power === undefined) return layers;
  const layer = LayeredConfig.parse({
    layer: 'invocation',
    config: { schema_version: 1, defaults: { power } },
  });
  return [...layers, layer];
}

function previewRelayStep(input: {
  readonly step: RuntimeIndexedRelayStep;
  readonly flow: RuntimeIndexedFlow;
  readonly flowId: string;
  readonly layers: readonly LayeredConfigValue[];
  readonly depth: CompiledDepth;
  readonly hostKind: HostKind | undefined;
  readonly codexDefaultModel: () => string;
  readonly skipped: boolean;
  readonly runsPerItem?: boolean;
}): RelayStepSelectionPreview {
  const { step, flow, layers } = input;
  const role = RelayRoleSchema.parse(step.role);
  const explicitConnector = explicitConnectorForStep(step, layers);
  const connector = resolveConnectorForGuidanceInput({
    flowId: input.flowId,
    role,
    configLayers: layers,
    ...(explicitConnector === undefined ? {} : { explicitConnector }),
    ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
  });
  const connectorName = connector.connectorName;

  // Mirror the production plan seam: resolve the layered selection stack, then
  // let the Power dial fill any model/effort the stack left unset.
  const stackSelection = deriveResolvedSelection(
    { selectionConfigLayers: layers },
    flow as GuidanceSelectionFlow,
    step,
    input.depth,
  );
  const modelFromStack = stackSelection.model !== undefined;
  const effortFromStack = stackSelection.effort !== undefined;
  let resolved = materializePowerSelection({
    resolved: stackSelection,
    role,
    connectorName,
    attempt: 1,
    configLayers: layers,
  });

  // The codex tier table sets effort only (never a model id, which would rot),
  // so a codex relay's model is the operator's codex default — read read-only
  // here, the same value dispatch would resolve. A failed read is reported, not
  // fatal: the step shows as unresolved and the rest of the preview stands.
  let modelSource: PreviewModelSource;
  if (resolved.model !== undefined) {
    modelSource = modelFromStack ? 'pinned' : 'power-tier';
  } else if (connectorName === 'codex') {
    try {
      const slug = input.codexDefaultModel();
      resolved = { ...resolved, model: { provider: 'openai', model: slug } };
      modelSource = 'codex-default';
    } catch {
      modelSource = 'codex-default-unresolved';
    }
  } else {
    modelSource = 'unset';
  }

  let effortSource: PreviewEffortSource;
  if (resolved.effort !== undefined) {
    effortSource = effortFromStack ? 'pinned' : 'power-tier';
  } else {
    effortSource = 'unset';
  }

  let problem: string | undefined;
  try {
    assertConnectorSelectionCompatible(connectorName, resolved);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }

  const modelSlug = resolved.model?.model;
  const provider = resolved.model?.provider;
  return {
    stepId: step.id,
    kind: 'relay',
    role,
    connector: connectorName,
    ...(modelSlug === undefined ? {} : { model: modelSlug }),
    ...(provider === undefined ? {} : { provider }),
    modelSource,
    ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
    effortSource,
    ...(resolved.power === undefined ? {} : { power: resolved.power }),
    powerSource: resolved.power_source ?? 'fixed',
    escalated: resolved.power_escalated === true,
    ...(problem === undefined ? {} : { problem }),
    ...(input.skipped ? { skippedAtProcess: true } : {}),
    ...(input.runsPerItem === true ? { runsPerItem: true } : {}),
  };
}

// Route-aware step enumeration. A schematic with route_overrides compiles to
// one graph per mode, so which steps actually run depends on the previewed
// process. Honesty rule: enumerate the union of steps across every process
// the operator could dial to (schematic order), and mark any step the current
// process's graph excludes as skipped — the row stays visible, but the
// preview must not advertise it as work that will run. Tournament- and
// autonomous-only steps stay out: no process setting reaches them, so listing
// them would be the same lie in the other direction.
interface PreviewStepEnumeration {
  readonly step: RuntimeIndexedStep;
  // The graph this step was found in — skipped steps do not exist in the
  // current process's graph, so their selection resolves against a graph
  // that carries them.
  readonly flow: RuntimeIndexedFlow;
  readonly skipped: boolean;
}

function enumeratePreviewSteps(
  result: CompileResult,
  definition: (typeof flowDefinitions)[number],
  process: ProcessValue,
): readonly PreviewStepEnumeration[] {
  if (result.kind === 'single') {
    // One graph for every mode: every step runs at every process.
    const index = buildRuntimePackageIndex(fromCompiledFlow(result.flow));
    return index.flow.steps.map((step) => ({ step, flow: index.flow, skipped: false }));
  }

  const axes = firstCompiledFlow(result).axes;
  const selections = axisSelectionsForAxes(definition.id, axes);
  const processDepths = axes.allowed_depths.filter(
    (depth): depth is ProcessValue => depth === 'low' || depth === 'medium' || depth === 'high',
  );
  const indexByProcess = new Map<ProcessValue, RuntimePackageIndex>();
  for (const depth of processDepths) {
    const modeName = selections.find((selection) => selection.depth === depth)?.name;
    const modeFlow = modeName === undefined ? undefined : result.flows.get(modeName);
    if (modeFlow !== undefined) {
      indexByProcess.set(depth, buildRuntimePackageIndex(fromCompiledFlow(modeFlow)));
    }
  }
  // The clamp guarantees the previewed process is an allowed depth, so the
  // fallback only guards a malformed compile result.
  const current =
    indexByProcess.get(process) ??
    buildRuntimePackageIndex(fromCompiledFlow(firstCompiledFlow(result)));

  const enumerated: PreviewStepEnumeration[] = [];
  for (const item of definition.schematic.items) {
    const stepId = item.id as unknown as string;
    const inCurrent = current.stepsById.get(stepId);
    if (inCurrent !== undefined) {
      enumerated.push({ step: inCurrent, flow: current.flow, skipped: false });
      continue;
    }
    for (const index of indexByProcess.values()) {
      const step = index.stepsById.get(stepId);
      if (step !== undefined) {
        enumerated.push({ step, flow: index.flow, skipped: true });
        break;
      }
    }
  }
  return enumerated;
}

export function resolveFlowSelectionPreview(
  input: FlowSelectionPreviewInput,
): FlowSelectionPreview {
  const definition = flowDefinitions.find((candidate) => candidate.id === input.flowId);
  if (definition === undefined) {
    throw new Error(`unknown flow '${input.flowId}'`);
  }
  const compileResult = compileSchematicToCompiledFlow(definition.schematic);
  // Axes are identical across per-mode graphs, so any mode's flow serves the
  // process clamp below.
  const compiled = firstCompiledFlow(compileResult);

  const layers = withPowerLayer(input.configLayers ?? [], input.power);
  const setting = resolvePowerDialSetting(layers);
  const dial: Power | 'auto' = setting.kind === 'fixed' ? setting.value : 'auto';
  const dialResolvesTo = resolvePowerDial(layers);
  const codexDefaultModel = input.codexDefaultModel ?? resolveCodexDefaultModelUncached;
  // Path A: a standing `flows.<id>.process` if the config sets one, else the
  // dial word derives process thoroughness (auto derives medium). Clamped to
  // this flow's allowed set — the same precedence and the same clamp
  // `circuit run` applies when `--process` is absent, so the preview cannot
  // drift from what a real run would resolve.
  const configuredProcess = resolveFlowProcessSetting(layers, input.flowId);
  const process = clampDerivedDepthToFlow(
    configuredProcess ?? deriveProcessFromPower(setting),
    compiled.axes.allowed_depths,
  );
  const depth: CompiledDepth = process;

  const relaySteps: RelayStepSelectionPreview[] = [];
  const nonRelaySteps: NonRelayStepSelectionPreview[] = [];
  for (const { step, flow, skipped } of enumeratePreviewSteps(compileResult, definition, process)) {
    // A fan-out whose branches are relays IS relay work: it dispatches one
    // worker per item. Reading it as a non-relay step would tell an operator
    // that a flow whose only workers live in a fan-out relays nothing.
    const branchRelay = step.kind === 'fanout' ? step.branch_relay : undefined;
    if (step.kind === 'relay' || branchRelay !== undefined) {
      const relayShaped = (
        branchRelay === undefined ? step : { ...step, ...branchRelay, kind: 'relay' }
      ) as RuntimeIndexedRelayStep;
      relaySteps.push(
        previewRelayStep({
          step: relayShaped,
          flow,
          flowId: input.flowId,
          layers,
          depth,
          hostKind: input.hostKind,
          codexDefaultModel,
          skipped,
          ...(branchRelay === undefined ? {} : { runsPerItem: true }),
        }),
      );
    } else {
      nonRelaySteps.push({
        stepId: step.id,
        kind: step.kind,
        ...(skipped ? { skippedAtProcess: true } : {}),
      });
    }
  }

  return {
    flowId: input.flowId,
    visibility: definition.visibility,
    dial,
    dialResolvesTo,
    process,
    processSource: configuredProcess === undefined ? 'dial' : 'config',
    ...(configuredProcess !== undefined && configuredProcess !== process
      ? { processClampedFrom: configuredProcess }
      : {}),
    relaySteps,
    nonRelaySteps,
  };
}
