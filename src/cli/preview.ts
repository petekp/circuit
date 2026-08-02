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

// First versioned emission of the preview JSON surface. Bump on any change a
// consumer could not ignore (removals, renames, meaning changes) — additive
// fields do not require a bump.
const PREVIEW_JSON_SCHEMA_VERSION = 1;

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

function stepCells(
  palette: TerminalPalette,
  step: RelayStepSelectionPreview,
  process: string,
): readonly Cell[] {
  // A step routing excludes at this process must not read as work that will
  // run: the whole row dims and the SOURCE cell says so in plain characters
  // (pipes and NO_COLOR must see it too). Model and effort stay visible —
  // they are what the step would use at a process where it runs.
  if (step.skippedAtProcess === true) {
    return [
      cell(step.runsPerItem === true ? `${step.stepId} (per item)` : step.stepId, palette.dim),
      cell(step.role, palette.dim),
      cell(step.connector, palette.dim),
      cell(modelCell(step), palette.dim),
      cell(step.effort ?? '-', palette.dim),
      cell(`skipped at process: ${process}`, palette.dim),
    ];
  }
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
    // A fan-out row is one relay repeated per item, and a reader who is told
    // "one reviewer" when the run dispatches six has been misinformed.
    cell(step.runsPerItem === true ? `${step.stepId} (per item)` : step.stepId),
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
  // Name the lever when the config set it. Otherwise an operator who wrote
  // `flows.<id>.process` sees a number with no way to tell it took effect,
  // which is the exact confusion the old inert key created.
  // A flow that only runs one thoroughness clamps the setting away. Saying
  // "set by flows.review.process" there would name the config as the source
  // of a word the config never wrote, so the clamped case says what the
  // operator asked for and what this flow can actually do.
  const processLine = ((): string => {
    if (preview.processClampedFrom !== undefined) {
      return `process: ${preview.process} (flows.${preview.flowId}.process asks for ${preview.processClampedFrom}; ${preview.flowId} only runs ${preview.process})`;
    }
    if (preview.processSource === 'config') {
      return `process: ${preview.process} (set by flows.${preview.flowId}.process)`;
    }
    return `process: ${preview.process}`;
  })();
  const header = diamondHeaderLine(palette, 'circuit preview', [
    `${preview.flowId} (${preview.visibility})`,
    `${dialLine} · ${processLine}`,
  ]);

  const rows: TableRow[] = [
    columnHeader(palette, ['STEP', 'ARCHETYPE', 'CONNECTOR', 'MODEL', 'EFFORT', 'SOURCE']),
    'rule',
  ];
  for (const step of preview.relaySteps) {
    rows.push(stepCells(palette, step, preview.process));
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
              .map((step) =>
                step.skippedAtProcess === true
                  ? `${step.stepId} (${step.kind}, skipped at process: ${preview.process})`
                  : `${step.stepId} (${step.kind})`,
              )
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
        ...stepCells(palette, step, preview.process),
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

// The rows for one flow at every dial. `previews` must all be the same flow.
function matrixRows(
  palette: TerminalPalette,
  previews: readonly FlowSelectionPreview[],
): readonly TableRow[] {
  const first = previews[0];
  if (first === undefined) return [];

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
      // Routing excludes this step at this column's process (the process row
      // above names it): say so instead of advertising a selection.
      if (match.skippedAtProcess === true) return cell('(skipped)', palette.dim);
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
  return rows;
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
  return [header, '', renderStyledTable(palette, matrixRows(palette, previews))].join('\n');
}

// `--matrix` with no flow named. Bare `preview` lists every public flow, so
// asking for more detail must not narrow the subject to nothing: this is the
// same survey, one matrix per flow. Each flow keeps its own table rather than
// joining one wide one, because the step ids and archetypes differ per flow
// and a shared STEP column would line up rows that have nothing to do with
// each other.
function renderMatrixOverview(
  palette: TerminalPalette,
  previews: readonly FlowSelectionPreview[],
  dials: readonly DialChoice[],
): string {
  const byFlow = new Map<string, FlowSelectionPreview[]>();
  for (const preview of previews) {
    const group = byFlow.get(preview.flowId);
    if (group === undefined) byFlow.set(preview.flowId, [preview]);
    else group.push(preview);
  }

  return [
    diamondHeaderLine(palette, 'circuit preview', [
      'public flows',
      `dial matrix: ${dials.join(' / ')}`,
    ]),
    ...[...byFlow.entries()].flatMap(([flowId, group]) => [
      '',
      palette.bold(flowId),
      renderStyledTable(palette, matrixRows(palette, group)),
    ]),
    '',
    palette.dim('one flow in depth: circuit preview <flow> --matrix'),
  ].join('\n');
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
    // Machine surface versioning (matches doctor's top-level schema_version).
    // Array forms (--matrix, the bare overview) stamp each element instead of
    // wrapping in an envelope, so the shape stays additive for consumers.
    const stamped = previews.map((preview) => ({
      schema_version: PREVIEW_JSON_SCHEMA_VERSION,
      ...preview,
    }));
    writeJson(parsed.matrix || parsed.flowId === undefined ? stamped : stamped[0]);
    return 0;
  }

  const palette = terminalPalette(colorEnabled());
  const body = parsed.matrix
    ? parsed.flowId === undefined
      ? renderMatrixOverview(palette, previews, MATRIX_DIALS)
      : renderMatrix(palette, previews)
    : parsed.flowId === undefined
      ? renderOverview(palette, previews)
      : renderSinglePreview(palette, previews[0] as FlowSelectionPreview);
  process.stdout.write(`${body}\n`);
  return 0;
}
