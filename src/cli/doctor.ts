// `circuit doctor` — a readiness report for the connectors your runs
// actually route through.
//
// A run that relays through a broken or signed-out connector CLI dies
// mid-flight, after real spend on the branches that were healthy. Doctor
// probes the same binaries a run would spawn (a version call for presence, a
// status call for sign-in where the CLI has one) and answers in plain English
// with a fix per connector. It grades readiness against the ROUTED connector
// set — the connectors at least one public flow's relay step would actually
// dispatch through, under the operator's config and host kind — so a fresh
// machine that only has claude-code installed reads Ready, not a false alarm
// about codex and cursor-agent it never routes to. Unrouted connectors still
// get probed and reported, but only informationally: their state never
// affects the exit code.
import { Command } from 'commander';

import {
  type ConnectorHealthCheck,
  probeBuiltinConnectors,
  probeCustomConnectorPresence,
} from '../connectors/health.js';
import { discoverRuntimeConfigLayers } from '../shared/config-loader.js';
import { commanderErrorMessage, configureCommanderProgram } from './commander-support.js';
import { hostKindFromEnv } from './preview.js';
import { resolveRoutedConnectors } from './routed-connectors.js';
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
  // connector under the operator's config and host kind. Only routed
  // connectors count toward readiness and the exit code.
  readonly routed: boolean;
  // Why it is routed: the distinct resolution sources that picked it, as
  // short phrases naming the config lever (`auto`, `default`,
  // `role: reviewer`, `flow: fix`, `step pin`). Empty for unrouted entries.
  readonly routed_via: readonly string[];
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
      cell(entry.connector, entry.routed ? palette.bold : undefined),
      entry.routed ? cell(entry.routed_via.join(', '), palette.accent) : cell('-', palette.dim),
      cell(STATE_LABELS[entry.state], statePaint(palette, entry.state)),
      cell(entry.detail, entry.routed ? undefined : palette.dim),
    ]);
    if (entry.remediation !== undefined) {
      rows.push([cell(''), cell(''), cell(''), cell(entry.remediation, palette.dim)]);
    }
  }
  return rows;
}

function brokenRoutedNames(entries: readonly DoctorConnectorEntry[]): readonly string[] {
  return entries
    .filter((entry) => entry.routed && entry.state === 'needs_attention')
    .map((entry) => entry.connector);
}

function verdictLine(palette: TerminalPalette, entries: readonly DoctorConnectorEntry[]): string {
  const broken = brokenRoutedNames(entries);
  if (broken.length === 0) return palette.bold(palette.accent('Ready.'));
  const noun = broken.length === 1 ? 'connector needs' : 'connectors need';
  return palette.bold(palette.warn(`Not ready: ${broken.join(', ')} ${noun} attention.`));
}

export function renderDoctorReport(
  palette: TerminalPalette,
  entries: readonly DoctorConnectorEntry[],
): string {
  // One table, routed connectors first (Array.prototype.sort is stable, so
  // the probe order survives within each group). The ROUTED VIA column is
  // both the routed/unrouted split and the teaching surface: it names the
  // exact resolution source behind every routing decision, and `-` marks a
  // connector no flow would dispatch through.
  const ordered = [...entries].sort((a, b) => Number(b.routed) - Number(a.routed));

  return [
    diamondHeaderLine(palette, 'circuit doctor'),
    '',
    verdictLine(palette, entries),
    '',
    renderStyledTable(palette, [
      columnHeader(palette, ['CONNECTOR', 'ROUTED VIA', 'STATE', 'DETAIL']),
      'rule',
      ...connectorRows(palette, ordered),
    ]),
    '',
    palette.dim('unrouted (-) connectors are optional and never fail this check. change routing:'),
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
  const routed = resolveRoutedConnectors({
    configLayers,
    ...(hostKind === undefined ? {} : { hostKind }),
  });

  const builtinChecks = await probeBuiltinConnectors();
  const customChecks = await Promise.all(
    [...routed.custom.values()].map((descriptor) =>
      probeCustomConnectorPresence(descriptor.name, descriptor.command[0] as string),
    ),
  );

  const entries: DoctorConnectorEntry[] = [
    ...builtinChecks.map((check) => ({
      ...check,
      routed: routed.names.has(check.connector),
      routed_via: routed.routes.get(check.connector) ?? [],
    })),
    ...customChecks.map((check) => ({
      ...check,
      routed: true,
      routed_via: routed.routes.get(check.connector) ?? [],
    })),
  ];

  const ready = brokenRoutedNames(entries).length === 0;

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 2,
          ready,
          routed_connectors: [...routed.names].sort(),
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
