import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import type { BriefGitProbe } from '../app/continuity/brief.js';

import { runCheckpointsCommand } from './checkpoints.js';
import { CLI_COMMAND_NAMES, type CliCommandName } from './command-vocabulary.js';
import { parseCommanderOrThrow } from './commander-support.js';
import { runConfigCommand } from './config-command.js';
import { runCreateCommand } from './create.js';
import { runDoctorCommand } from './doctor.js';
import { runFrontDoorCommand } from './front-door.js';
import { runGenerateCommand } from './generate.js';
import { runHandoffCommand } from './handoff.js';
import {
  commandWordList,
  renderCommandHelp,
  renderRootHelp,
  resolveHelpInvocation,
} from './help.js';
import { runHistoryCommand } from './history.js';
import { runMemoryCommand } from './memory.js';
import { runPreviewCommand } from './preview.js';
import { runReclaimCommand } from './reclaim.js';
import {
  type ParsedArgs,
  type RunCommandOptions,
  parseExecutionArgs,
  runExecutionCommand,
  runResumeCommand,
} from './run.js';
import { runRunsCommand } from './runs.js';
import { runUninstallCommand } from './uninstall.js';
import { readSourceVersion } from './version-info.js';

// Runtime CLI entry point — invoked through ./bin/circuit.
//
// The root file owns top-level command dispatch and version output. Run/resume
// argument parsing and orchestration live in src/cli/run.ts so the CLI front
// door stays small.

// The TopLevelInvocation union is keyed off the shared CLI_COMMAND_NAMES
// tuple (src/cli/command-vocabulary.ts), so adding a command word there
// is a type error here until it is handled in main()'s dispatch.
type TopLevelInvocation = {
  readonly command: CliCommandName;
  readonly argv: readonly string[];
};

export interface CliMainOptions extends RunCommandOptions {
  briefGitProbe?: BriefGitProbe;
  // Test seam for the bare-invocation TTY branch: replaces the interactive
  // shell launcher (the TTY gate itself still applies).
  interactiveShell?: () => Promise<number>;
}

export { CIRCUIT_HOST_KIND_ENV } from './run.js';

const SEALED_MCP_REQUIRED_ENV = [
  'CIRCUIT_MCP_PROJECT_ROOT',
  'CIRCUIT_MCP_CODEX_EXECUTABLE',
  'CIRCUIT_MCP_PROOF_RUNNER',
  'CIRCUIT_MCP_GIT_STATE_HELPER',
  'CIRCUIT_MCP_CANCEL_FILE',
  'CODEX_HOME',
] as const;

/**
 * Internal adapter used only by the experimental MCP-owned plugin runtime.
 * There is intentionally no public CLI flag for this narrower execution mode.
 */
export function sealedMcpOptionsFromEnvironment(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Pick<CliMainOptions, 'sealedMcp'> {
  if (env.CIRCUIT_MCP_SEALED === undefined) return {};
  if (env.CIRCUIT_MCP_SEALED !== '1' || env.CIRCUIT_RUNTIME_SOURCE !== 'mcp-spike') {
    throw new Error('The sealed MCP runtime marker is invalid.');
  }
  if (argv[0] !== 'run' && argv[0] !== 'resume') {
    throw new Error('The sealed MCP runtime only permits run and resume.');
  }
  for (const key of SEALED_MCP_REQUIRED_ENV) {
    const value = env[key];
    if (typeof value !== 'string' || !isAbsolute(value)) {
      throw new Error(`${key} must be an absolute path in a sealed MCP run.`);
    }
  }
  if (
    env.CIRCUIT_MCP_WEB_SEARCH_MODE !== 'disabled' &&
    env.CIRCUIT_MCP_WEB_SEARCH_MODE !== 'cached'
  ) {
    throw new Error('CIRCUIT_MCP_WEB_SEARCH_MODE must be disabled or cached.');
  }
  const requestedRoot = env.CIRCUIT_MCP_PROJECT_ROOT as string;
  const rootStat = lstatSync(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('CIRCUIT_MCP_PROJECT_ROOT must be a real directory.');
  }
  const projectRoot = realpathSync(requestedRoot);
  const invocationCwd = realpathSync(resolve(cwd));
  if (projectRoot !== invocationCwd) {
    throw new Error('The sealed MCP project root must match the runtime working directory.');
  }
  return { sealedMcp: { projectRoot } };
}

function versionInfo(): Record<string, unknown> {
  return {
    schema_version: 1,
    name: 'circuit',
    version: readSourceVersion(),
    node_version: process.versions.node,
    runtime_source: process.env.CIRCUIT_RUNTIME_SOURCE ?? 'direct',
    ...(process.env.CIRCUIT_RUNTIME_PATH === undefined
      ? {}
      : { runtime_path: process.env.CIRCUIT_RUNTIME_PATH }),
    ...(process.env.CIRCUIT_PLUGIN_ROOT === undefined
      ? {}
      : { plugin_root: process.env.CIRCUIT_PLUGIN_ROOT }),
  };
}

function runVersionCommand(argv: readonly string[]): number {
  const program = new Command('circuit version')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .option('--json');
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError && err.code === 'commander.helpDisplayed') process.exit(0);
    const message =
      err instanceof CommanderError ? err.message.replace(/^error: /, '') : (err as Error).message;
    process.stderr.write(`error: ${message}\n`);
    return 2;
  }
  const unexpected = program.args[0];
  if (unexpected !== undefined) {
    process.stderr.write(
      `error: too many arguments. Expected 0 arguments but got ${program.args.length}.\n`,
    );
    return 2;
  }

  if (program.opts<{ json?: boolean }>().json === true) {
    process.stdout.write(`${JSON.stringify(versionInfo(), null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${readSourceVersion()}\n`);
  return 0;
}

// Rewrite root parse errors so the message names its remedy. A far-miss
// unknown command gets the front-door pointer (near misses already carry
// Commander's did-you-mean suggestion); `--version` names the version
// command (the grammar is frozen, so the flag itself stays rejected).
function withRootRemedy(message: string): string {
  if (
    message.startsWith("unknown option '--version'") ||
    message.startsWith("unknown option '-V'")
  ) {
    return `${message}. The version is a command here: run 'circuit version'.`;
  }
  if (message.startsWith('unknown command') && !message.includes('Did you mean')) {
    return `${message}. Valid commands: ${commandWordList()}. See 'circuit --help'.`;
  }
  return message;
}

function parseTopLevelInvocation(argv: readonly string[]): TopLevelInvocation {
  let invocation: TopLevelInvocation | undefined;
  const program = new Command('circuit').exitOverride().configureOutput({ writeErr: () => {} });
  const addForwardingCommand = (name: CliCommandName) => {
    program
      .command(name)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .argument('[args...]')
      .action((args: string[]) => {
        invocation = { command: name, argv: args };
      });
  };
  for (const name of CLI_COMMAND_NAMES) addForwardingCommand(name);

  try {
    parseCommanderOrThrow(program, argv);
  } catch (err) {
    throw new Error(withRootRemedy(err instanceof Error ? err.message : String(err)));
  }

  if (invocation === undefined) {
    throw new Error(`missing command: use ${commandWordList()}`);
  }
  return invocation;
}

export async function main(argv: readonly string[], options: CliMainOptions = {}): Promise<number> {
  // Bare `circuit` is the front door, not an error. In a terminal it opens
  // the interactive shell; piped or in CI it prints the static orientation
  // page so agents get discovery instead of a failure.
  if (argv.length === 0) {
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      const launch =
        options.interactiveShell ??
        (async () => {
          // Lazy import: the Ink/React tree stays out of memory for every
          // ordinary subcommand invocation.
          const { runInteractiveShell } = await import('./interactive/index.js');
          return runInteractiveShell();
        });
      return launch();
    }
    return runFrontDoorCommand();
  }

  // Help never reaches the Commander forwarding parser below: its stubs
  // parse `<cmd> [args...]` and Commander's generated help for them is an
  // empty shell. Successful help prints to stdout and RETURNS 0 (no
  // process.exit, nothing on stderr); an unknown help topic is a usage
  // error (2) that names the valid commands.
  const help = resolveHelpInvocation(argv);
  if (help !== undefined) {
    if (help.kind === 'unknown-command') {
      process.stderr.write(
        `error: unknown command '${help.word}'. Valid commands: ${commandWordList()}. See 'circuit --help'.\n`,
      );
      return 2;
    }
    const page = help.kind === 'root' ? renderRootHelp() : renderCommandHelp(help.command);
    process.stdout.write(`${page}\n`);
    return 0;
  }

  let invocation: TopLevelInvocation;
  try {
    invocation = parseTopLevelInvocation(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  if (invocation.command === 'version') {
    return runVersionCommand(invocation.argv);
  }
  if (invocation.command === 'handoff') {
    return runHandoffCommand(invocation.argv, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.briefGitProbe === undefined ? {} : { briefGitProbe: options.briefGitProbe }),
    });
  }
  if (invocation.command === 'history') {
    return runHistoryCommand(invocation.argv);
  }
  if (invocation.command === 'memory') {
    return runMemoryCommand(invocation.argv, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  if (invocation.command === 'create') {
    return runCreateCommand(invocation.argv, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  if (invocation.command === 'generate') {
    // generate calls a model, so it needs the relay channel run/resume use (the
    // runtime builds the production relay when none is injected). create does not.
    return runGenerateCommand(invocation.argv, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.relayer === undefined ? {} : { relayer: options.relayer }),
    });
  }
  if (invocation.command === 'uninstall') {
    return runUninstallCommand(invocation.argv);
  }
  if (invocation.command === 'runs') {
    return runRunsCommand(invocation.argv);
  }
  if (invocation.command === 'reclaim') {
    return runReclaimCommand(invocation.argv);
  }
  if (invocation.command === 'checkpoints') {
    return runCheckpointsCommand(invocation.argv, {
      ...(options.briefGitProbe === undefined ? {} : { briefGitProbe: options.briefGitProbe }),
    });
  }
  if (invocation.command === 'preview') {
    return runPreviewCommand(invocation.argv);
  }
  if (invocation.command === 'doctor') {
    return runDoctorCommand(invocation.argv);
  }
  if (invocation.command === 'config') {
    return runConfigCommand(invocation.argv);
  }

  let args: ParsedArgs;
  try {
    args = parseExecutionArgs(invocation.command, invocation.argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }

  if (args.command === 'resume') {
    return runResumeCommand(args, options);
  }
  return runExecutionCommand(args, options);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  Promise.resolve()
    .then(() => main(argv, sealedMcpOptionsFromEnvironment(argv)))
    .then(
      (code) => process.exit(code),
      (err: unknown) => {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      },
    );
}
