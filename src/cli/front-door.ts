import { colorEnabled, terminalPalette } from './terminal-style.js';
import { readSourceVersion } from './version-info.js';

// The static face of bare `circuit` for pipes, CI, and agents: a fast
// orientation page with zero config reads and zero failure modes. The
// interactive shell is the TTY face of the same front door; both surfaces
// point at the identical command vocabulary, so anything discovered here
// works everywhere.

export function renderFrontDoor(): string {
  const palette = terminalPalette(colorEnabled());
  const sep = palette.dim('·');
  const line = (command: string, blurb: string) => `  ${command.padEnd(46)} ${palette.dim(blurb)}`;

  return [
    `${palette.accent('◆')} ${palette.bold('circuit')} ${sep} v${readSourceVersion()} ${sep} configurable developer flows`,
    '',
    `${palette.bold('start here')}`,
    line('circuit demo', 'a real Fix run on a throwaway project built to be fixable'),
    '',
    `${palette.bold('run flows')}`,
    line('circuit run <flow> --goal "<goal>"', 'execute a flow with evidence and a report'),
    line('circuit checkpoints', 'pending checkpoints across active runs'),
    line('circuit resume --run-folder <path> ...', 'continue a paused run'),
    '',
    `${palette.bold('see what a run would do')}`,
    line('circuit preview [flow] [--matrix]', 'spawn-free model/effort readout per step'),
    line('circuit config [show|set|unset]', 'read and edit the layered selection config'),
    '',
    `${palette.bold('make new flows')}`,
    line('circuit create --description "<idea>"', 'instantiate a proven flow template'),
    line('circuit generate --description "<task>"', 'compose a custom flow block-by-block'),
    '',
    `${palette.bold('history and upkeep')}`,
    line('circuit runs / history / memory', 'list past runs and operator notes'),
    line('circuit doctor', 'connector health and run readiness'),
    line('circuit reclaim / uninstall / version', 'housekeeping'),
    '',
    palette.dim('interactive: run `circuit` in a terminal to browse, configure, and create flows'),
    palette.dim('full flag reference: circuit run --help (or any command with --help)'),
  ].join('\n');
}

export function runFrontDoorCommand(): number {
  process.stdout.write(`${renderFrontDoor()}\n`);
  return 0;
}
