import { Command } from 'commander';
import { flowDefinitions } from '../flows/catalog.js';
import type { LayeredConfig as LayeredConfigValue } from '../schemas/config.js';
import { HostKind, type HostKind as HostKindValue } from '../schemas/host.js';
import { discoverRuntimeConfigLayers } from '../shared/config-loader.js';
import { commanderErrorMessage, configureCommanderProgram } from './commander-support.js';
import {
  type FlowSelectionPreview,
  type RelayStepSelectionPreview,
  resolveFlowSelectionPreview,
} from './flow-selection-preview.js';

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

function hostKindFromEnv(): HostKindValue | undefined {
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

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function renderTable(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => pad(cell, widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function renderSinglePreview(preview: FlowSelectionPreview): string {
  const dialLine =
    preview.dial === preview.dialResolvesTo
      ? `dial: ${preview.dial}`
      : `dial: ${preview.dial} (resolves to ${preview.dialResolvesTo})`;
  const header = `flow: ${preview.flowId} (${preview.visibility})   ${dialLine}`;

  const rows: string[][] = [['STEP', 'ROLE', 'CONNECTOR', 'MODEL', 'EFFORT', 'SOURCE']];
  for (const step of preview.relaySteps) {
    rows.push([
      step.stepId,
      step.role,
      step.connector,
      modelCell(step),
      step.effort ?? '-',
      step.modelSource,
    ]);
  }
  const table = renderTable(rows);

  const problems = preview.relaySteps.filter((step) => step.problem !== undefined);
  const problemLines = problems.map((step) => `  ! ${step.stepId}: ${step.problem}`);

  const nonRelay =
    preview.nonRelaySteps.length === 0
      ? []
      : [
          '',
          `non-relay steps: ${preview.nonRelaySteps
            .map((step) => `${step.stepId} (${step.kind})`)
            .join(', ')}`,
        ];

  return [
    header,
    '',
    table,
    ...(problemLines.length === 0 ? [] : ['', 'problems:', ...problemLines]),
    ...nonRelay,
  ].join('\n');
}

function overviewDialLine(previews: readonly FlowSelectionPreview[]): string {
  const first = previews[0];
  if (first === undefined) return '';
  // `auto` may resolve differently per flow, so only claim a single resolution
  // when every flow landed on the same tier.
  const resolved = new Set(previews.map((p) => p.dialResolvesTo));
  if (resolved.size === 1 && first.dial !== first.dialResolvesTo) {
    return `dial: ${first.dial} (resolves to ${first.dialResolvesTo})`;
  }
  if (resolved.size > 1) return `dial: ${first.dial} (resolves per flow)`;
  return `dial: ${first.dial}`;
}

function renderOverview(previews: readonly FlowSelectionPreview[]): string {
  const header = `public flows   ${overviewDialLine(previews)}`;

  const rows: string[][] = [['FLOW', 'STEP', 'ROLE', 'CONNECTOR', 'MODEL', 'EFFORT', 'SOURCE']];
  const problemLines: string[] = [];
  for (const preview of previews) {
    preview.relaySteps.forEach((step, index) => {
      rows.push([
        index === 0 ? preview.flowId : '',
        step.stepId,
        step.role,
        step.connector,
        modelCell(step),
        step.effort ?? '-',
        step.modelSource,
      ]);
      if (step.problem !== undefined) {
        problemLines.push(`  ! ${preview.flowId} ${step.stepId}: ${step.problem}`);
      }
    });
  }

  return [
    header,
    '',
    renderTable(rows),
    ...(problemLines.length === 0 ? [] : ['', 'problems:', ...problemLines]),
    '',
    'one flow in depth: circuit preview <flow> [--matrix]',
  ].join('\n');
}

function renderMatrix(previews: readonly FlowSelectionPreview[]): string {
  const first = previews[0];
  if (first === undefined) return '';
  const header = `flow: ${first.flowId} (${first.visibility})   dial matrix: ${previews
    .map((p) => p.dial)
    .join(' / ')}`;

  // One row per relay step, one model+effort column per dial.
  const columnLabels = previews.map((p) => p.dial.toUpperCase());
  const rows: string[][] = [['STEP', 'ROLE', 'CONNECTOR', ...columnLabels]];
  for (const step of first.relaySteps) {
    const cells = previews.map((p) => {
      const match = p.relaySteps.find((candidate) => candidate.stepId === step.stepId);
      if (match === undefined) return '-';
      const model = modelCell(match);
      const effort = match.effort ?? '-';
      return `${model} / ${effort}`;
    });
    rows.push([step.stepId, step.role, step.connector, ...cells]);
  }
  return [header, '', renderTable(rows)].join('\n');
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

  const body = parsed.matrix
    ? renderMatrix(previews)
    : parsed.flowId === undefined
      ? renderOverview(previews)
      : renderSinglePreview(previews[0] as FlowSelectionPreview);
  process.stdout.write(`${body}\n`);
  return 0;
}
