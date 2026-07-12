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
import { discoverRuntimeConfigLayers } from '../shared/config-loader.js';
import { resolveChosenConnectors } from './chosen-connectors.js';
import { commanderErrorMessage, configureCommanderProgram } from './commander-support.js';
import { hostKindFromEnv } from './preview.js';
import { cell, columnHeader, diamondHeaderLine, renderStyledTable } from './styled-table.js';
import { type TerminalPalette, colorEnabled, terminalPalette } from './terminal-style.js';

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

function verdictLine(palette: TerminalPalette, entries: readonly DoctorConnectorEntry[]): string {
  const broken = brokenChosenNames(entries);
  if (broken.length === 0) return palette.bold(palette.accent('Ready.'));
  const noun = broken.length === 1 ? 'connector needs' : 'connectors need';
  return palette.bold(palette.warn(`Not ready: ${broken.join(', ')} ${noun} attention.`));
}

export function renderDoctorReport(
  palette: TerminalPalette,
  entries: readonly DoctorConnectorEntry[],
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
    verdictLine(palette, entries),
    '',
    renderStyledTable(palette, [
      columnHeader(palette, ['CONNECTOR', 'CHOSEN BY', 'STATE', 'DETAIL']),
      'rule',
      ...connectorRows(palette, ordered),
    ]),
    '',
    palette.dim(
      'connectors marked - are optional (no flow step chooses them) and never fail this check. to change:',
    ),
    palette.dim(
      '  circuit config set relay.default codex   (also: relay.roles.reviewer, relay.flows.fix; then: circuit preview)',
    ),
  ].join('\n');
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

  const builtinChecks = await probeBuiltinConnectors();
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

  const ready = brokenChosenNames(entries).length === 0;

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 2,
          ready,
          chosen_connectors: [...chosen.names].sort(),
          connectors: entries,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const palette = terminalPalette(colorEnabled());
    process.stdout.write(`${renderDoctorReport(palette, entries)}\n`);
  }
  return ready ? 0 : 1;
}
