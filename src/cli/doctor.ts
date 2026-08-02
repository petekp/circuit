// `circuit doctor` — a readiness report for the connectors your runs would
// actually use.
//
// A run that relays through a broken or signed-out connector CLI dies
// mid-flight, after real spend on the branches that were healthy. Doctor
// probes the same binaries a run would spawn (a version call for presence, a
// status call for sign-in where the CLI has one) and answers in plain English
// with a fix per connector. It grades readiness against the CHOSEN connector
// set — the connectors at least one public flow's relay step would actually
// dispatch through, under the operator's config and host kind — so a fresh
// machine that only has claude-code installed reads Ready, not a false alarm
// about codex and cursor-agent no flow would choose. Unchosen connectors
// still get probed and reported, but only informationally: their state never
// affects the exit code.
import { Command } from 'commander';

import {
  type ConnectorHealthCheck,
  probeBuiltinConnectors,
  probeCustomConnectorPresence,
} from '../connectors/health.js';
import {
  type StateDirProbe,
  codexStateDir,
  probeStateDirWritable,
  stateDirUnwritableSummary,
} from '../connectors/state-dir.js';
import { flowDefinitions } from '../flows/catalog.js';
import type { LayeredConfig as LayeredConfigValue } from '../schemas/config.js';
import type { HostKind as HostKindValue } from '../schemas/host.js';
import { discoverRuntimeConfigLayers } from '../shared/config-loader.js';
import { PROJECT_CONFIG_RELATIVE_SEGMENTS } from '../shared/control-plane-paths.js';
import { resolveVerificationCommands } from '../shared/verification-resolver.js';
import { resolveChosenConnectors } from './chosen-connectors.js';
import { commanderErrorMessage, configureCommanderProgram } from './commander-support.js';
import {
  type FlowSelectionPreview,
  resolveFlowSelectionPreview,
} from './flow-selection-preview.js';
import { hostKindFromEnv } from './preview.js';
import { cell, columnHeader, diamondHeaderLine, renderStyledTable } from './styled-table.js';
import { type TerminalPalette, colorEnabled, terminalPalette } from './terminal-style.js';
import { type WorkspaceHygieneFinding, workspaceHygieneFindings } from './workspace-hygiene.js';

interface ParsedDoctorArgs {
  readonly json: boolean;
}

function parseDoctorArgs(argv: readonly string[]): ParsedDoctorArgs | string {
  let options: { json?: boolean } | undefined;
  const program = configureCommanderProgram(new Command('circuit doctor'))
    .option('--json')
    .allowExcessArguments(false)
    .action(() => {
      options = program.opts<{ json?: boolean }>();
    });
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    return commanderErrorMessage(err);
  }
  if (options === undefined) return 'doctor could not parse its arguments';
  return { json: options.json === true };
}

export interface DoctorConnectorEntry extends ConnectorHealthCheck {
  // Whether at least one public flow's relay step would dispatch through this
  // connector under the operator's config and host kind. Only chosen
  // connectors count toward readiness and the exit code.
  readonly chosen: boolean;
  // Why it was chosen: the distinct resolution sources that picked it, as
  // short phrases naming the config lever (`auto`, `default`,
  // `role: reviewer`, `flow: fix`, `step pin`). Empty for unchosen entries.
  readonly chosen_by: readonly string[];
}

const STATE_LABELS: Record<ConnectorHealthCheck['state'], string> = {
  ok: 'ok',
  needs_attention: 'needs attention',
  unknown: 'could not check',
};

function statePaint(
  palette: TerminalPalette,
  state: ConnectorHealthCheck['state'],
): TerminalPalette['dim'] {
  if (state === 'ok') return palette.accent;
  if (state === 'needs_attention') return palette.warn;
  return palette.dim;
}

function connectorRows(
  palette: TerminalPalette,
  entries: readonly DoctorConnectorEntry[],
): readonly (readonly ReturnType<typeof cell>[])[] {
  const rows: (readonly ReturnType<typeof cell>[])[] = [];
  for (const entry of entries) {
    rows.push([
      cell(entry.connector, entry.chosen ? palette.bold : undefined),
      entry.chosen ? cell(entry.chosen_by.join(', '), palette.accent) : cell('-', palette.dim),
      cell(STATE_LABELS[entry.state], statePaint(palette, entry.state)),
      cell(entry.detail, entry.chosen ? undefined : palette.dim),
    ]);
    if (entry.remediation !== undefined) {
      rows.push([cell(''), cell(''), cell(''), cell(entry.remediation, palette.dim)]);
    }
  }
  return rows;
}

function brokenChosenNames(entries: readonly DoctorConnectorEntry[]): readonly string[] {
  return entries
    .filter((entry) => entry.chosen && entry.state === 'needs_attention')
    .map((entry) => entry.connector);
}

function verdictLine(
  palette: TerminalPalette,
  entries: readonly DoctorConnectorEntry[],
  flows: readonly DoctorFlowBlocker[] = [],
): string {
  const broken = brokenChosenNames(entries);
  // A healthy connector set is not readiness if a flow refuses to start. Both
  // reasons are named in one line so the verdict never hides half the problem.
  const reasons: string[] = [];
  if (broken.length > 0) {
    reasons.push(`${broken.join(', ')} ${broken.length === 1 ? 'needs' : 'need'} attention`);
  }
  const blockedFlows = [...new Set(flows.map((blocker) => blocker.flowId))];
  if (blockedFlows.length > 0) {
    reasons.push(`${blockedFlows.join(', ')} cannot start`);
  }
  if (reasons.length === 0) return palette.bold(palette.accent('Ready.'));
  return palette.bold(palette.warn(`Not ready: ${reasons.join('; ')}.`));
}

// Workspace findings are advisory: they name repo-level friction (a format
// hook that would sweep `.circuit/`) with a paste-able fix, and never affect
// the readiness verdict or exit code.
function workspaceLines(
  palette: TerminalPalette,
  findings: readonly WorkspaceHygieneFinding[],
): readonly string[] {
  if (findings.length === 0) return [];
  return [
    '',
    palette.bold(palette.warn('Workspace')),
    ...findings.flatMap((finding) => [
      palette.warn(`  ${finding.detail}`),
      palette.dim(`  fix: ${finding.remediation}`),
    ]),
  ];
}

const PROJECT_CONFIG_DISPLAY_PATH = PROJECT_CONFIG_RELATIVE_SEGMENTS.join('/');

export interface DoctorVerificationProbe {
  readonly status: 'ready' | 'blocked';
  // Whether the project config carries a `verification` block at all. False
  // means every resolved command came from package.json scripts.
  readonly declared: boolean;
  readonly commands: readonly { readonly argv: readonly string[]; readonly cwd: string }[];
  readonly detail: string;
}

// Build and Fix both refuse to run without a proof command, and until the
// config hatch existed the only source was package.json — so a Python or Go
// project failed at the first step with a package.json complaint that read
// like a bug. Doctor answers the question before the run does.
//
// Advisory only, like the workspace findings: plenty of repos never run a
// flow that needs a proof, so a missing command never fails this check.
export function probeVerification(projectRoot: string, declared: boolean): DoctorVerificationProbe {
  const result = resolveVerificationCommands({
    projectRoot,
    goal: '',
    requestedNeeds: ['general'],
    commandIdPrefix: 'doctor',
  });
  if (result.status === 'blocked') {
    return { status: 'blocked', declared, commands: [], detail: result.reason };
  }
  return {
    status: 'ready',
    declared,
    commands: result.commands.map((command) => ({ argv: command.argv, cwd: command.cwd })),
    detail: declared
      ? `declared in ${PROJECT_CONFIG_DISPLAY_PATH}`
      : 'resolved from package.json scripts',
  };
}

function verificationLines(
  palette: TerminalPalette,
  probe: DoctorVerificationProbe,
): readonly string[] {
  if (probe.status === 'ready') {
    const first = probe.commands[0];
    if (first === undefined) return [];
    const where = first.cwd === '.' ? '' : ` in ${first.cwd}`;
    return [
      '',
      palette.bold('Verification'),
      `  Build and Fix would prove a change with: ${first.argv.join(' ')}${where}`,
      palette.dim(`  ${probe.detail}`),
    ];
  }
  return [
    '',
    palette.bold(palette.warn('Verification')),
    palette.warn('  Build and Fix have no way to prove a change in this project.'),
    palette.dim(`  ${probe.detail}`),
    palette.dim("  fix: circuit config set verification.general '{argv: [make, check]}'"),
  ];
}

// A flow that cannot start. Connector health answers "can I reach a worker";
// this answers "would the flow I am about to run actually dispatch one".
export interface DoctorFlowBlocker {
  readonly flowId: string;
  // Every relay step the selection blocks, not just the first. A reader who
  // fixes one pin wants to know the whole flow was dead, not one step.
  readonly stepIds: readonly string[];
  readonly detail: string;
  // Where the offending value was written, when it came from a config layer.
  // Absent when the flow itself pins it, which is not the operator's to fix.
  readonly pinnedAt?: string;
  readonly pinnedKey?: string;
}

// Selection keys a config layer can set per flow. `power` is deliberately
// absent: the dial is global (`defaults.power`), and SelectionOverride is
// strict, so `flows.<id>.selection.power` fails to parse and can never appear
// in a layer.
const FLOW_SELECTION_KEYS = ['effort', 'model', 'depth'] as const;

interface FlowPin {
  readonly layerIndex: number;
  readonly pinnedAt: string;
  readonly pinnedKey: string;
  readonly key: (typeof FLOW_SELECTION_KEYS)[number];
}

// Every per-flow selection key any layer sets, highest-precedence layer first.
// All of them, not the first one found: which key is at fault is decided by
// measurement below, not by the order they are listed in.
function flowPins(layers: readonly LayeredConfigValue[], flowId: string): readonly FlowPin[] {
  const pins: FlowPin[] = [];
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer === undefined || layer.source_path === undefined) continue;
    // `flows` is keyed by a branded CompiledFlowId; read it as a plain record
    // rather than minting a brand just to look one up.
    const flowConfigs = layer.config.flows as Record<string, { selection?: unknown }> | undefined;
    const selection = flowConfigs?.[flowId]?.selection as Record<string, unknown> | undefined;
    if (selection === undefined) continue;
    for (const key of FLOW_SELECTION_KEYS) {
      if (selection[key] === undefined) continue;
      pins.push({
        layerIndex: index,
        pinnedAt: layer.source_path,
        pinnedKey: `flows.${flowId}.selection.${key}`,
        key,
      });
    }
  }
  return pins;
}

// The layer stack as it would be after `circuit config unset <key>` ran
// against the file this pin came from. Only the one layer is rewritten; the
// rest are passed through by reference.
function layersWithoutPin(
  layers: readonly LayeredConfigValue[],
  flowId: string,
  pin: FlowPin,
): readonly LayeredConfigValue[] {
  return layers.map((layer, index) => {
    if (index !== pin.layerIndex) return layer;
    const flows = layer.config.flows as Record<string, { selection?: Record<string, unknown> }>;
    const flow = flows[flowId];
    if (flow?.selection === undefined) return layer;
    const { [pin.key]: _removed, ...selection } = flow.selection;
    return {
      ...layer,
      config: { ...layer.config, flows: { ...flows, [flowId]: { ...flow, selection } } },
    } as LayeredConfigValue;
  });
}

function blockerDetails(input: {
  readonly layers: readonly LayeredConfigValue[];
  readonly flowId: string;
  readonly hostKind?: HostKindValue;
}): ReadonlyMap<string, string[]> {
  const byDetail = new Map<string, string[]>();
  let preview: FlowSelectionPreview;
  try {
    preview = resolveFlowSelectionPreview({
      flowId: input.flowId,
      configLayers: input.layers,
      ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
    });
  } catch {
    // A flow that will not even compile under this config is a bug in the
    // catalog, not an operator readiness problem. The catalog completeness
    // tests own that; doctor stays quiet rather than blaming the operator.
    return byDetail;
  }
  // Group by message: one pinned value usually blocks every step the same
  // way, and three copies of one sentence is not three problems.
  for (const step of preview.relaySteps) {
    if (step.problem === undefined) continue;
    const steps = byDetail.get(step.problem);
    if (steps === undefined) byDetail.set(step.problem, [step.stepId]);
    else steps.push(step.stepId);
  }
  return byDetail;
}

// Which pin, if any, is why this particular blocker is here.
//
// Doctor prints "fix: circuit config unset <key>", which is a promise about
// what happens next. Finding a pin on the flow and attaching it to every
// blocker only establishes that a pin exists somewhere, so the printed remedy
// could name a setting that has nothing to do with the problem — an operator
// edits a file, re-runs, and is still blocked.
//
// So measure it. Rebuild the layer stack as the unset would leave it, resolve
// again, and keep the pin only if this blocker is gone. Resolution is pure and
// spawn-free, so the counterfactual costs one in-memory pass per candidate.
//
// When no single unset clears it — two layers pinning the same impossible
// value, most likely — no pin is named. The blocker is still reported; doctor
// just does not claim to know the one-line remedy, which is the honest answer.
function pinCausingBlocker(input: {
  readonly layers: readonly LayeredConfigValue[];
  readonly flowId: string;
  readonly hostKind?: HostKindValue;
  readonly detail: string;
}): { readonly pinnedAt: string; readonly pinnedKey: string } | undefined {
  for (const pin of flowPins(input.layers, input.flowId)) {
    const without = blockerDetails({
      layers: layersWithoutPin(input.layers, input.flowId, pin),
      flowId: input.flowId,
      ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
    });
    if (!without.has(input.detail)) {
      return { pinnedAt: pin.pinnedAt, pinnedKey: pin.pinnedKey };
    }
  }
  return undefined;
}

// Ask every public flow whether its steps could dispatch under this config.
// This is the same compatibility assertion `circuit preview` surfaces and
// `circuit run` enforces at preflight, so doctor cannot drift from either: a
// blocker here is a run that would refuse to start.
//
// Spawn-free. It resolves selection and compares it against connector
// capability tables; nothing is executed.
export function probeFlowReadiness(input: {
  readonly layers: readonly LayeredConfigValue[];
  readonly hostKind?: HostKindValue;
}): readonly DoctorFlowBlocker[] {
  const blockers: DoctorFlowBlocker[] = [];
  for (const definition of flowDefinitions) {
    if (definition.visibility !== 'public') continue;
    const hostKind = input.hostKind === undefined ? {} : { hostKind: input.hostKind };
    const byDetail = blockerDetails({ layers: input.layers, flowId: definition.id, ...hostKind });
    for (const [detail, stepIds] of byDetail) {
      // Attributed per blocker, not per flow: two problems on one flow can
      // have two different causes, or one of them no config cause at all.
      const source = pinCausingBlocker({
        layers: input.layers,
        flowId: definition.id,
        detail,
        ...hostKind,
      });
      blockers.push({ flowId: definition.id, stepIds, detail, ...(source ?? {}) });
    }
  }
  return blockers;
}

function flowLines(
  palette: TerminalPalette,
  blockers: readonly DoctorFlowBlocker[],
): readonly string[] {
  if (blockers.length === 0) return [];
  return [
    '',
    palette.bold(palette.warn('Flows')),
    ...blockers.flatMap((blocker) => {
      const steps = blocker.stepIds.join(', ');
      const lines = [
        palette.warn(`  ${blocker.flowId} cannot start: ${blocker.detail}`),
        palette.dim(`  blocked steps: ${steps}`),
      ];
      if (blocker.pinnedKey !== undefined && blocker.pinnedAt !== undefined) {
        lines.push(
          palette.dim(`  set by ${blocker.pinnedKey} in ${blocker.pinnedAt}`),
          palette.dim(`  fix: circuit config unset ${blocker.pinnedKey} --project`),
        );
      }
      return lines;
    }),
  ];
}

export function renderDoctorReport(
  palette: TerminalPalette,
  entries: readonly DoctorConnectorEntry[],
  workspace: readonly WorkspaceHygieneFinding[] = [],
  verification?: DoctorVerificationProbe,
  flows: readonly DoctorFlowBlocker[] = [],
): string {
  // One table, chosen connectors first (Array.prototype.sort is stable, so
  // the probe order survives within each group). The CHOSEN BY column is
  // both the chosen/unchosen split and the teaching surface: it names the
  // exact resolution source behind every decision, and `-` marks a connector
  // no flow would dispatch through.
  const ordered = [...entries].sort((a, b) => Number(b.chosen) - Number(a.chosen));

  return [
    diamondHeaderLine(palette, 'circuit doctor'),
    '',
    verdictLine(palette, entries, flows),
    '',
    renderStyledTable(palette, [
      columnHeader(palette, ['CONNECTOR', 'CHOSEN BY', 'STATE', 'DETAIL']),
      'rule',
      ...connectorRows(palette, ordered),
    ]),
    ...workspaceLines(palette, workspace),
    ...(verification === undefined ? [] : verificationLines(palette, verification)),
    ...flowLines(palette, flows),
    '',
    // Doctor cannot see other environments: a sandboxed agent session spawns
    // workers under restrictions this terminal may not have. Run intake runs
    // its own preflight in the run's environment for exactly that reason.
    palette.dim(
      'these checks reflect the environment doctor ran in; a sandboxed agent session can fail where this terminal passes.',
    ),
    palette.dim(
      'connectors marked - are optional (no flow step chooses them) and never fail this check. to change:',
    ),
    // Remedies must work when pasted: relay.roles.* and relay.flows.* take
    // connector reference objects, so the role/flow lever shows the
    // inline-YAML object form a bare name would fail.
    palette.dim('  circuit config set relay.default codex'),
    palette.dim(
      "  circuit config set relay.roles.reviewer '{kind: builtin, name: codex}'   (also: relay.flows.<flow>; check with: circuit preview)",
    ),
  ].join('\n');
}

// The sandboxed-session failure class: codex can be installed and signed in,
// yet unable to write its state directory (~/.codex) from THIS environment,
// which kills every codex relay seconds after spawn. Annotated only when the
// base probes passed — a missing or signed-out binary is already the headline
// — and the failing line reuses the shared diagnosis sentence, so doctor, run
// intake, and the mid-run failure interpreter describe this identically.
export function annotateCodexStateDir(
  check: ConnectorHealthCheck,
  probe: StateDirProbe,
): ConnectorHealthCheck {
  if (check.connector !== 'codex' || check.state !== 'ok') return check;
  if (probe.writable) {
    return { ...check, detail: `${check.detail}; state directory is writable (${probe.dir})` };
  }
  return {
    ...check,
    state: 'needs_attention',
    detail: `${check.detail}; could not write state directory (${probe.dir})`,
    remediation: stateDirUnwritableSummary('codex', probe.dir),
  };
}

export async function runDoctorCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseDoctorArgs(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(`error: ${parsed}\n`);
    return 2;
  }

  const configLayers = discoverRuntimeConfigLayers({}).selectionConfigLayers;
  const hostKind = hostKindFromEnv();
  const chosen = resolveChosenConnectors({
    configLayers,
    ...(hostKind === undefined ? {} : { hostKind }),
  });

  const builtinChecks = (await probeBuiltinConnectors()).map((check) =>
    check.connector === 'codex' && check.state === 'ok'
      ? annotateCodexStateDir(check, probeStateDirWritable(codexStateDir()))
      : check,
  );
  const customChecks = await Promise.all(
    [...chosen.custom.values()].map((descriptor) =>
      probeCustomConnectorPresence(descriptor.name, descriptor.command[0] as string),
    ),
  );

  const entries: DoctorConnectorEntry[] = [
    ...builtinChecks.map((check) => ({
      ...check,
      chosen: chosen.names.has(check.connector),
      chosen_by: chosen.sources.get(check.connector) ?? [],
    })),
    ...customChecks.map((check) => ({
      ...check,
      chosen: true,
      chosen_by: chosen.sources.get(check.connector) ?? [],
    })),
  ];

  const flows = probeFlowReadiness({
    layers: configLayers,
    ...(hostKind === undefined ? {} : { hostKind }),
  });
  const ready = brokenChosenNames(entries).length === 0 && flows.length === 0;
  const workspace = workspaceHygieneFindings(process.cwd());
  const verification = probeVerification(
    process.cwd(),
    configLayers.some(
      (layer) => layer.layer === 'project' && layer.config.verification !== undefined,
    ),
  );

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 2,
          ready,
          chosen_connectors: [...chosen.names].sort(),
          connectors: entries,
          workspace,
          verification,
          flows,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const palette = terminalPalette(colorEnabled());
    process.stdout.write(
      `${renderDoctorReport(palette, entries, workspace, verification, flows)}\n`,
    );
  }
  return ready ? 0 : 1;
}
