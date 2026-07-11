// `circuit checkpoints` — the read-only checkpoints list.
//
// Lists every run that parked at an operator checkpoint and is waiting on a
// decision. For each one it shows the fork (what it asks, the choices it
// offers), a best-effort staleness note, and the existing per-run resume
// command to answer it. This command never resumes anything: it is a read
// model over saved run folders plus a front door that links to `circuit
// resume`. The operator still answers one run at a time.

import { resolve } from 'node:path';
import { Command } from 'commander';
import { discoverCheckpointsList } from '../app/checkpoints/discover.js';
import { renderCheckpointsList } from '../app/checkpoints/render.js';
import type { BriefGitProbe } from '../app/continuity/brief.js';
import { runsRoot } from '../shared/control-plane-paths.js';
import { commanderErrorMessage, configureCommanderProgram } from './commander-support.js';

export interface CheckpointsCommandOptions {
  /** Brief-time git divergence probe; injectable for tests. */
  readonly briefGitProbe?: BriefGitProbe;
}

interface ParsedCheckpointsArgs {
  readonly projectRoot: string;
  readonly runsBase: string;
  readonly json: boolean;
}

function parseCheckpointsArgs(argv: readonly string[]): ParsedCheckpointsArgs | string {
  let options: { json?: boolean; projectRoot?: string; runsBase?: string } | undefined;
  const program = configureCommanderProgram(new Command('circuit checkpoints'))
    .option('--json')
    .option('--project-root <path>')
    .option('--runs-base <path>')
    .allowExcessArguments(false)
    .action(() => {
      options = program.opts<{ json?: boolean; projectRoot?: string; runsBase?: string }>();
    });
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    return commanderErrorMessage(err);
  }
  if (options === undefined) return 'checkpoints could not parse its arguments';

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  // The runs root defaults to the project's control plane; --runs-base lets a
  // caller point at a runs root that is not under the project root.
  const runsBase =
    options.runsBase === undefined ? runsRoot(projectRoot) : resolve(options.runsBase);
  return { projectRoot, runsBase, json: options.json === true };
}

export function runCheckpointsCommand(
  argv: readonly string[],
  options: CheckpointsCommandOptions = {},
): number {
  const parsed = parseCheckpointsArgs(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(`error: ${parsed}\n`);
    return 2;
  }

  const checkpoints = discoverCheckpointsList({
    runsRoot: parsed.runsBase,
    projectRoot: parsed.projectRoot,
    ...(options.briefGitProbe === undefined ? {} : { gitProbe: options.briefGitProbe }),
  });

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(checkpoints, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderCheckpointsList(checkpoints)}\n`);
  }
  return 0;
}
