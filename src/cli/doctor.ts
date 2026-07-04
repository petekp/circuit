// `circuit doctor` — proactive connector health.
//
// A run that relays through a broken or signed-out connector CLI dies
// mid-flight, after real spend on the branches that were healthy. Doctor
// probes the same binaries a run would spawn (a version call for presence, a
// status call for sign-in where the CLI has one) and answers in plain
// English with a fix per connector. Informational by design: exit 1 means at
// least one connector needs attention, so scripts and CI can gate on it.

import { Command } from 'commander';

import { type ConnectorHealthCheck, probeBuiltinConnectors } from '../connectors/health.js';
import { commanderErrorMessage, configureCommanderProgram } from './commander-support.js';

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

const STATE_LABELS: Record<ConnectorHealthCheck['state'], string> = {
  ok: 'ok',
  needs_attention: 'needs attention',
  unknown: 'could not check',
};

export function renderDoctorReport(checks: readonly ConnectorHealthCheck[]): string {
  const lines = ['Connector health:', ''];
  const nameWidth = Math.max(...checks.map((check) => check.connector.length));
  for (const check of checks) {
    const name = check.connector.padEnd(nameWidth);
    lines.push(`  ${name}  ${STATE_LABELS[check.state]}  ${check.detail}`);
    if (check.remediation !== undefined) {
      lines.push(`  ${' '.repeat(nameWidth)}  ${check.remediation}`);
    }
  }
  lines.push('');
  const attention = checks.filter((check) => check.state === 'needs_attention').length;
  if (attention === 0) {
    lines.push('All connectors look healthy.');
  } else {
    const noun = attention === 1 ? 'connector needs' : 'connectors need';
    lines.push(
      `${attention} ${noun} attention. Runs that relay through ${attention === 1 ? 'it' : 'them'} will fail until fixed.`,
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
  const checks = await probeBuiltinConnectors();
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ schema_version: 1, connectors: checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderDoctorReport(checks)}\n`);
  }
  return checks.some((check) => check.state === 'needs_attention') ? 1 : 0;
}
