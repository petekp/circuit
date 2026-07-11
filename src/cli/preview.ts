import { Command } from 'commander';
import { flowDefinitions } from '../flows/catalog.js';
import type { LayeredConfig as LayeredConfigValue } from '../schemas/config.js';
import { HostKind, type HostKind as HostKindValue } from '../schemas/host.js';
import { discoverRuntimeConfigLayers } from '../shared/config-loader.js';
import { commanderErrorMessage, configureCommanderProgram } from './commander-support.js';
import {
  type FlowSelectionPreview,
  type PreviewEffortSource,
  type PreviewModelSource,
  type RelayStepSelectionPreview,
  resolveFlowSelectionPreview,
} from './flow-selection-preview.js';
import {
  type Cell,
  type TableRow,
  cell,
  columnHeader,
  diamondHeaderLine,
  renderStyledTable,
} from './styled-table.js';
import {
  type TerminalPalette,
  colorEnabled,
  composePaints,
  terminalPalette,
} from './terminal-style.js';

// `circuit preview [flow]` — a spawn-free look at what each relay step in a
// flow would resolve to (connector, model, effort, and where each came from)
// under a Power dial and the machine's config. It never runs a connector, so an
// operator can turn the dial and see the effect before paying for a run. With
// no flow named it surveys every public flow at the chosen dial, so the bare
// command answers "what would I get?" instead of demanding an argument.

const DIAL_CHOICES = ['auto', 'low', 'medium', 'high'] as const;
type DialChoice = (typeof DIAL_CHOICES)[number];
// Highest tier first, so the strongest configuration reads left-to-right.
const MATRIX_DIALS: readonly DialChoice[] = ['high', 'medium', 'low'];

interface PreviewInvocation {
  readonly flowId?: string;
  readonly power?: DialChoice;
  readonly matrix: boolean;
  readonly json: boolean;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function invalid(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 2;
}

function parsePreviewArgs(argv: readonly string[]): PreviewInvocation | string {
  let opts: { power?: string; matrix?: boolean; json?: boolean } | undefined;
  let positional: readonly string[] = [];
  const program = configureCommanderProgram(new Command('circuit preview'));
  program
    .argument('[flow]')
    .option('--power <auto|low|medium|high>')
    .option('--matrix')
    .option('--json')
    .action((_flow: string | undefined, options: typeof opts, command: Command) => {
      opts = options;
      positional = command.args;
    });
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    return commanderErrorMessage(err);
  }
  const flowId = positional[0];
  if (flowId === undefined && opts?.matrix === true)
    return 'the dial matrix needs a flow name: circuit preview <flow> --matrix';
  if (positional.length > 1) return `unexpected extra arguments: ${positional.slice(1).join(' ')}`;

  const power = opts?.power;
  if (power !== undefined && !(DIAL_CHOICES as readonly string[]).includes(power)) {
    return `--power must be one of ${DIAL_CHOICES.join(', ')}`;
  }

  return {
    ...(flowId === undefined ? {} : { flowId }),
    ...(power === undefined ? {} : { power: power as DialChoice }),
    matrix: opts?.matrix === true,
    json: opts?.json === true,
  };
}

// Exported for the interactive shell: both surfaces must resolve previews
// under the same host context or the shell would show different selections
// than `circuit preview` for the same machine.
export function hostKindFromEnv(): HostKindValue | undefined {
  const raw = process.env.CIRCUIT_HOST_KIND;
  if (raw === undefined) return undefined;
  const parsed = HostKind.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function selectionLayers(): readonly LayeredConfigValue[] {
  // Discover only the selection layers; the preview applies the dial itself, so
  // the discovered layers carry no `--power` opinion (user-global/project only).
  return discoverRuntimeConfigLayers({}).selectionConfigLayers;
}

function modelCell(step: RelayStepSelectionPreview): string {
  if (step.model !== undefined) return step.model;
  if (step.modelSource === 'codex-default-unresolved') return '(codex default: unavailable)';
  return '(none)';
}

// `pinned` is an explicit decision (operator config or a pin the flow itself
// carries); everything else is a default the engine filled in. Weight carries
// that split: pinned values are bold, dial defaults plain, absent values dim —
// so a fully-default table reads uniformly calm, and any pin stands out.
function isExplicit(source: PreviewModelSource | PreviewEffortSource): boolean {
  return source === 'pinned';
}

// The plain-characters form of the provenance split (styling is presentation
// only, so pipes and NO_COLOR must still see it). The effort note appears only
// when effort's explicit/default kind differs from the model's: unannotated
// means "same kind as the model", and out of the box every row is a default.
export function sourceCellText(
  modelSource: PreviewModelSource,
  effortSource: PreviewEffortSource,
): string {
  if (effortSource === 'unset' || isExplicit(effortSource) === isExplicit(modelSource)) {
    return modelSource;
  }
  return `${modelSource} · effort:${effortSource}`;
}

function stepCells(palette: TerminalPalette, step: RelayStepSelectionPreview): readonly Cell[] {
  const modelPaint =
    step.model === undefined
      ? palette.dim
      : isExplicit(step.modelSource)
        ? composePaints(palette.bold, palette.provider(step.provider))
        : palette.provider(step.provider);
  const effortPaint =
    step.effort === undefined
      ? palette.dim
      : isExplicit(step.effortSource)
        ? palette.bold
        : undefined;
  return [
    cell(step.stepId),
    cell(step.role, palette.role(step.role)),
    cell(step.connector),
    cell(modelCell(step), modelPaint),
    cell(step.effort ?? '-', effortPaint),
    cell(sourceCellText(step.modelSource, step.effortSource), palette.dim),
  ];
}

function problemBlock(palette: TerminalPalette, lines: readonly string[]): readonly string[] {
  if (lines.length === 0) return [];
  return ['', palette.warn('problems:'), ...lines.map((line) => palette.warn(line))];
}

// Exported for the interactive shell: the browse screen renders the same
// preview strings inside its live region, so the two surfaces cannot drift.
export function renderSinglePreview(
  palette: TerminalPalette,
  preview: FlowSelectionPreview,
): string {
  const dialLine =
    preview.dial === preview.dialResolvesTo
      ? `dial: ${preview.dial}`
      : `dial: ${preview.dial} (resolves to ${preview.dialResolvesTo})`;
  const header = diamondHeaderLine(palette, 'circuit preview', [
    `${preview.flowId} (${preview.visibility})`,
    `${dialLine} · process: ${preview.process}`,
  ]);

  const rows: TableRow[] = [
    columnHeader(palette, ['STEP', 'ARCHETYPE', 'CONNECTOR', 'MODEL', 'EFFORT', 'SOURCE']),
    'rule',
  ];
  for (const step of preview.relaySteps) {
    rows.push(stepCells(palette, step));
  }

  const problemLines = preview.relaySteps
    .filter((step) => step.problem !== undefined)
    .map((step) => `  ! ${step.stepId}: ${step.problem}`);

  const nonRelay =
    preview.nonRelaySteps.length === 0
      ? []
      : [
          '',
          palette.dim(
            `non-relay steps: ${preview.nonRelaySteps
              .map((step) => `${step.stepId} (${step.kind})`)
              .join(', ')}`,
          ),
        ];

  return [
    header,
    '',
    renderStyledTable(palette, rows),
    ...problemBlock(palette, problemLines),
    ...nonRelay,
  ].join('\n');
}

function overviewDialLine(previews: readonly FlowSelectionPreview[]): string {
  const first = previews[0];
  if (first === undefined) return '';
  // `auto` may resolve differently per flow, so only claim a single resolution
  // when every flow landed on the same tier.
  const resolved = new Set(previews.map((p) => p.dialResolvesTo));
  const dialText =
    resolved.size === 1 && first.dial !== first.dialResolvesTo
      ? `dial: ${first.dial} (resolves to ${first.dialResolvesTo})`
      : resolved.size > 1
        ? `dial: ${first.dial} (resolves per flow)`
        : `dial: ${first.dial}`;
  // The per-flow clamp (Review/Pursue pin to medium, Prototype floors at
  // medium) means the derived process can differ across flows even under one
  // dial, so only claim a single process when every flow landed on the same
  // tier.
  const processes = new Set(previews.map((p) => p.process));
  const processText =
    processes.size === 1 ? `process: ${first.process}` : 'process: (resolves per flow)';
  return `${dialText} · ${processText}`;
}

function renderOverview(
  palette: TerminalPalette,
  previews: readonly FlowSelectionPreview[],
): string {
  const header = diamondHeaderLine(palette, 'circuit preview', [
    'public flows',
    overviewDialLine(previews),
  ]);

  const rows: TableRow[] = [
    columnHeader(palette, ['FLOW', 'STEP', 'ARCHETYPE', 'CONNECTOR', 'MODEL', 'EFFORT', 'SOURCE']),
    'rule',
  ];
  const problemLines: string[] = [];
  previews.forEach((preview, flowIndex) => {
    if (flowIndex > 0) rows.push('gap');
    preview.relaySteps.forEach((step, index) => {
      rows.push([
        cell(index === 0 ? preview.flowId : '', palette.bold),
        ...stepCells(palette, step),
      ]);
      if (step.problem !== undefined) {
        problemLines.push(`  ! ${preview.flowId} ${step.stepId}: ${step.problem}`);
      }
    });
  });

  return [
    header,
    '',
    renderStyledTable(palette, rows),
    ...problemBlock(palette, problemLines),
    '',
    palette.dim('one flow in depth: circuit preview <flow> [--matrix]'),
  ].join('\n');
}

// Exported for the interactive shell (see renderSinglePreview).
export function renderMatrix(
  palette: TerminalPalette,
  previews: readonly FlowSelectionPreview[],
): string {
  const first = previews[0];
  if (first === undefined) return '';
  const header = diamondHeaderLine(palette, 'circuit preview', [
    `${first.flowId} (${first.visibility})`,
    `dial matrix: ${previews.map((p) => p.dial).join(' / ')}`,
  ]);

  // One row per relay step, one model+effort column per dial.
  const columnLabels = previews.map((p) => p.dial.toUpperCase());
  const processRow: TableRow = [
    cell('process', palette.dim),
    cell('', palette.dim),
    cell('', palette.dim),
    ...previews.map((p) => cell(p.process, palette.dim)),
  ];
  const rows: TableRow[] = [
    columnHeader(palette, ['STEP', 'ARCHETYPE', 'CONNECTOR', ...columnLabels]),
    'rule',
    processRow,
    'rule',
  ];
  for (const step of first.relaySteps) {
    const dialCells = previews.map((p) => {
      const match = p.relaySteps.find((candidate) => candidate.stepId === step.stepId);
      if (match === undefined) return cell('-', palette.dim);
      const model = modelCell(match);
      const effort = match.effort ?? '-';
      // Same encoding as the step tables: weight is provenance, hue is
      // provider. A bold cell is (at least partly) pinned, so it will not
      // fully follow the dial across the row.
      const pinned = isExplicit(match.modelSource) || isExplicit(match.effortSource);
      return cell(
        `${model} / ${effort}`,
        pinned
          ? composePaints(palette.bold, palette.provider(match.provider))
          : palette.provider(match.provider),
      );
    });
    rows.push([
      cell(step.stepId),
      cell(step.role, palette.role(step.role)),
      cell(step.connector),
      ...dialCells,
    ]);
  }
  return [header, '', renderStyledTable(palette, rows)].join('\n');
}

export function runPreviewCommand(argv: readonly string[]): number {
  const parsed = parsePreviewArgs(argv);
  if (typeof parsed === 'string') return invalid(parsed);

  const layers = selectionLayers();
  const hostKind = hostKindFromEnv();

  // No flow named: survey every public flow at the one chosen dial.
  const flowIds =
    parsed.flowId === undefined
      ? flowDefinitions.filter((d) => d.visibility === 'public').map((d) => d.id)
      : [parsed.flowId];
  const dials: readonly (DialChoice | undefined)[] = parsed.matrix ? MATRIX_DIALS : [parsed.power];

  let previews: FlowSelectionPreview[];
  try {
    previews = flowIds.flatMap((flowId) =>
      dials.map((power) =>
        resolveFlowSelectionPreview({
          flowId,
          ...(power === undefined ? {} : { power }),
          configLayers: layers,
          ...(hostKind === undefined ? {} : { hostKind }),
        }),
      ),
    );
  } catch (err) {
    return invalid(err instanceof Error ? err.message : String(err));
  }

  if (parsed.json) {
    writeJson(parsed.matrix || parsed.flowId === undefined ? previews : previews[0]);
    return 0;
  }

  const palette = terminalPalette(colorEnabled());
  const body = parsed.matrix
    ? renderMatrix(palette, previews)
    : parsed.flowId === undefined
      ? renderOverview(palette, previews)
      : renderSinglePreview(palette, previews[0] as FlowSelectionPreview);
  process.stdout.write(`${body}\n`);
  return 0;
}
