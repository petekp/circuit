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
      cell(entry.connector),
      cell(STATE_LABELS[entry.state], statePaint(palette, entry.state)),
      cell(entry.detail),
    ]);
    if (entry.remediation !== undefined) {
      rows.push([cell(''), cell(''), cell(entry.remediation, palette.dim)]);
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
  const routed = entries.filter((entry) => entry.routed);
  const unrouted = entries.filter((entry) => !entry.routed);

  const lines: string[] = [
    diamondHeaderLine(palette, 'circuit doctor'),
    '',
    verdictLine(palette, entries),
  ];

  if (routed.length > 0) {
    lines.push(
      '',
      palette.dim('routed connectors (used by your flows):'),
      '',
      renderStyledTable(palette, [
        columnHeader(palette, ['CONNECTOR', 'STATE', 'DETAIL']),
        'rule',
        ...connectorRows(palette, routed),
      ]),
    );
  }

  if (unrouted.length > 0) {
    lines.push(
      '',
      palette.dim(
        'unrouted connectors (not used by your config; install only if you route work there):',
      ),
      '',
      renderStyledTable(palette, [
        columnHeader(palette, ['CONNECTOR', 'STATE', 'DETAIL']),
        'rule',
        ...connectorRows(palette, unrouted),
      ]),
    );
  }

  return lines.join('\n');
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
    ...builtinChecks.map((check) => ({ ...check, routed: routed.names.has(check.connector) })),
    ...customChecks.map((check) => ({ ...check, routed: true })),
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
