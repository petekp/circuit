import { Command, CommanderError } from 'commander';
import type { BriefGitProbe } from '../app/continuity/brief.js';

import { CLI_COMMAND_NAMES, type CliCommandName } from './command-vocabulary.js';
import { parseCommanderOrThrow } from './commander-support.js';
import { runConfigCommand } from './config-command.js';
import { runCreateCommand } from './create.js';
import { runFrontDoorCommand } from './front-door.js';
import { runGenerateCommand } from './generate.js';
import { runHandoffCommand } from './handoff.js';
import { runHistoryCommand } from './history.js';
import { runInboxCommand } from './inbox.js';
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
import { CLI_RUNTIME_ROUTING_POLICY } from './runtime-routing-policy.js';
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

export function usage(): string {
  return [
    'usage: circuit run <flow-name> --goal "<goal>" [--why <why>] [--depth <low|medium|high>] [--power <auto|low|medium|high>] [--tournament [--tournament-n <2|3|4>]] [--autonomous] [--run-folder <path>] [--fixture <path>] [--flow-root <path>] [--progress jsonl]',
    '       circuit resume --run-folder <path> --checkpoint-choice <choice> [--progress jsonl]',
    '       circuit runs show --run-folder <path> --json',
    '       circuit inbox [--project-root <path>] [--runs-base <path>] [--json]',
    '       circuit history rebuild|query|pull|status|memory-merge|memory-effect --json [options]',
    '       circuit memory note --flow <id> [--applies-to <kind>] "<text>" | memory list | memory forget <id>',
    '       circuit handoff [save|resume|done|brief|hook|hooks|harvest] [options]',
    '       circuit create --description "<flow idea>" [--name <slug>] [--publish --yes]',
    '       circuit generate --description "<task to encode>" [--name <slug>] [--publish --yes]',
    '       circuit uninstall [--dir <path>] [--json]',
    '       circuit reclaim [--json]',
    '       circuit preview [flow-name] [--power <auto|low|medium|high>] [--matrix] [--json]',
    '       circuit config [show [--json] | set <key> <value> | unset <key>] [--project|--global]',
    '       circuit version [--json]',
    '',
    "Axes: `--depth` controls care level (`low`, `medium`, `high`); `--power` sets the model tier (`auto`, `low`, `medium`, `high`; default `medium`; `auto` lets the run's research read pick within configured bounds); `--tournament` turns on option fan-out; `--tournament-n` sets the option count in the v1 range [2, 4]; `--autonomous` auto-resolves supported checkpoints and runs a bounded continuation loop (recovery routed by unmet evidence kind; never completes by exhaustion). Unsupported tuples are rejected per flow with the flow allow-list.",
    '',
    'With an explicit flow name, loads generated/flows/<name>/circuit.json. The flow name is required: pass one of build|fix|review|explore|prototype|pursue. Routing is model-only; the host or operator names the flow, and the CLI never classifies the goal text.',
    '',
    'Config: if present, loads ~/.config/circuit/config.yaml and ./.circuit/config.yaml from the current working directory into the selection resolver before relay.',
    '',
    'Note: `--dry-run` is not implemented and is rejected. An earlier version silently invoked the real connector while reporting dry_run:true, which is a safety bug; the flag stays rejected until real dry-run support lands.',
    '',
    CLI_RUNTIME_ROUTING_POLICY,
    '',
    'Review evidence: untracked file contents are omitted by default. Add `--include-untracked-content` only when those files are safe to relay to the configured worker.',
  ].join('\n');
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

  parseCommanderOrThrow(program, argv);

  if (invocation === undefined) {
    throw new Error(
      'missing command: use run, resume, handoff, history, memory, create, generate, uninstall, runs, reclaim, inbox, preview, config, or version',
    );
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
  if (invocation.command === 'inbox') {
    return runInboxCommand(invocation.argv, {
      ...(options.briefGitProbe === undefined ? {} : { briefGitProbe: options.briefGitProbe }),
    });
  }
  if (invocation.command === 'preview') {
    return runPreviewCommand(invocation.argv);
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
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
