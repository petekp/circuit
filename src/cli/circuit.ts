import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';

import type { ExecutorRegistry } from '../runtime/executors/index.js';
import { isRuntimeRunFolder, resumeCompiledFlow } from '../runtime/run/checkpoint-resume.js';
import type { ChildCompiledFlowResolver } from '../runtime/run/child-runner.js';
import { runCompiledFlowWithWaiting } from '../runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../runtime/run/graph-runner.js';
import { Axes, type Axes as AxesValue, TournamentN } from '../schemas/axes.js';
import { CompiledFlow } from '../schemas/compiled-flow.js';
import { HostKind, type HostKind as HostKindValue } from '../schemas/host.js';
import { CompiledFlowId, RunId } from '../schemas/ids.js';
import { computeManifestHash } from '../schemas/manifest.js';
import {
  ProgressEvent,
  type ProgressEvent as ProgressEventValue,
} from '../schemas/progress-event.js';
import { RunResult } from '../schemas/result.js';
import { Rigor, type Rigor as RigorValue } from '../schemas/rigor.js';

import {
  HISTORY_RECALL_REPORT_PATH,
  prepareRunStartHistoryRecall,
} from '../app/history/run-start-recall.js';
import {
  projectCheckpointWaitingProcessEvidence,
  projectClosedProcessEvidence,
} from '../app/process-evidence/projection.js';
import { runAutonomousContinuation } from '../app/run-envelope/autonomous-run.js';
import { findCompiledFlowPackageById, findFlowRuntimeSurfaceById } from '../flows/catalog.js';
import { validateCompiledFlowKindPolicy } from '../policy/flow-kind-policy.js';
import { discoverRuntimeConfigLayers } from '../shared/config-loader.js';
import { readPriorRoute, writeOperatorSummary } from '../shared/operator-summary-writer.js';
import { progressDisplay, progressPresentation } from '../shared/progress-output.js';
import type { ComposeWriterFn, RelayFn } from '../shared/relay-runtime-types.js';
import { CLI_COMMAND_NAMES, type CliCommandName } from './command-vocabulary.js';
import { parseCommanderOrThrow } from './commander-support.js';
import { runCreateCommand } from './create.js';
import { runHandoffCommand } from './handoff.js';
import { runHistoryCommand } from './history.js';
import { runMemoryCommand } from './memory.js';
import {
  type PostRunArtifactContext,
  type PostRunArtifactWarning,
  emitPostRunArtifacts,
  postRunArtifactWarningOutputFields,
} from './post-run-artifacts.js';
import {
  operatorSummaryOutputFields,
  routeOutputFields,
  runEnvelopeOutputFields,
  selectedProcessFields,
} from './run-output.js';
import { runRunsCommand } from './runs.js';
import {
  CLI_RUNTIME_ROUTING_POLICY,
  RUNTIME_POLICY_REASONS,
  type RuntimeSupportDecision,
  applyComposeWriterPolicy,
  applyFixturePolicy,
  runtimeOutputFields,
  showRuntimeDecision,
} from './runtime-routing-policy.js';

// Runtime CLI entry point — invoked through ./bin/circuit.
//
// Loads the named flow fixture at generated/flows/<flow-name>/circuit.json,
// parses it through the CompiledFlow schema, validates kind-canonical
// stage-set policy, composes the runtime boundary via the runner, and
// prints the <run-folder> path on success.
//
// Invocation-layer flags stay narrow (--goal, --rigor, --tournament,
// --tournament-n, --autonomous, --run-folder,
// --fixture, --flow-root). The product path discovers user-global and
// project config files and supplies them as LayeredConfigs to the
// selection resolver.
//
// `--dry-run` fails closed. An earlier version accepted the flag as a
// no-op while still spawning the real connector — a safety bug. The
// flag stays rejected until real dry-run support lands.

const DEFAULT_RUNS_BASE = '.circuit/runs';
const AUTONOMOUS_LOOP_RELATIVE_PATH = 'reports/autonomous-loop.json';
const DEFAULT_DEV_VERSION = '0.0.0-dev';

interface ParsedArgs {
  command: 'run' | 'resume';
  flowName?: string;
  goal?: string;
  axes: AxesValue;
  rigorProvided: boolean;
  tournamentProvided: boolean;
  tournamentNProvided: boolean;
  autonomousProvided: boolean;
  runFolder?: string;
  fixturePath?: string;
  flowRoot?: string;
  checkpointChoice?: string;
  progress?: 'jsonl';
  includeUntrackedContent: boolean;
}

// The TopLevelInvocation union is keyed off the shared CLI_COMMAND_NAMES
// tuple (src/cli/command-vocabulary.ts), so adding a command word there
// is a type error here until it is handled in main()'s dispatch.
type TopLevelInvocation = {
  readonly command: CliCommandName;
  readonly argv: readonly string[];
};

// Routing is model-only: the host (or operator) always supplies the flow.
// There is no deterministic classifier, so the route source is always the
// explicit positional flow argument.
interface ResolvedCompiledFlowRoute {
  flowName: string;
  source: 'explicit';
  reason: string;
}

interface ResolvedEntryModeSelection {
  entryModeName?: string;
  source?: 'explicit';
  reason?: string;
}

interface AxisSupport {
  allowedRigors: readonly RigorValue[];
  supportsTournament: boolean;
  supportsAutonomous: boolean;
}

export interface CliMainOptions {
  relayer?: RelayFn;
  composeWriter?: ComposeWriterFn;
  now?: () => Date;
  runId?: string;
  configHomeDir?: string;
  configCwd?: string;
  hostKind?: HostKindValue;
  runtimeExecutors?: Partial<ExecutorRegistry>;
  historyRecall?: 'auto' | 'enabled' | 'disabled';
}

export const CIRCUIT_HOST_KIND_ENV = 'CIRCUIT_HOST_KIND';

function runtimeHostKind(options: CliMainOptions): HostKindValue | undefined {
  if (options.hostKind !== undefined) return options.hostKind;
  const raw = process.env[CIRCUIT_HOST_KIND_ENV];
  if (raw === undefined || raw.length === 0) return undefined;
  return HostKind.parse(raw);
}

export function usage(): string {
  return [
    'usage: circuit run [flow-name] --goal "<goal>" [--rigor <lite|standard|deep>] [--tournament [--tournament-n <2|3|4>]] [--autonomous] [--run-folder <path>] [--fixture <path>] [--flow-root <path>] [--progress jsonl]',
    '       circuit resume --run-folder <path> --checkpoint-choice <choice> [--progress jsonl]',
    '       circuit runs show --run-folder <path> --json',
    '       circuit history rebuild|query|status --json [options]',
    '       circuit memory note --flow <id> [--applies-to <kind>] "<text>" | memory list | memory forget <id>',
    '       circuit handoff [save|resume|done|brief|hook|hooks] [options]',
    '       circuit create --description "<flow idea>" [--name <slug>] [--publish --yes]',
    '       circuit version [--json]',
    '',
    'Axes: `--rigor` controls care level (`lite`, `standard`, `deep`); `--tournament` turns on option fan-out; `--tournament-n` sets the option count in the v1 range [2, 4]; `--autonomous` auto-resolves supported checkpoints and runs a bounded continuation loop (recovery routed by unmet evidence kind; never completes by exhaustion). Unsupported tuples are rejected per flow with the flow allow-list.',
    '',
    'With an explicit flow name, loads generated/flows/<name>/circuit.json. Without one, classifies the free-form goal across the registered explore/review/fix/build/pursue flows and then composes the runtime boundary using the configured relay connector.',
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

function readSourceVersion(): string {
  // Marketplace-safe by build-time replacement: build-plugin-runtime.ts
  // emits the bundled CLI with CIRCUIT_VERSION inlined as a literal,
  // so this function returns the build-time version in every marketplace
  // install and never reaches the path-resolution branches below. The
  // fileURLToPath candidate is only ever exercised in a source-tree
  // checkout where the env var is unset.
  if (process.env.CIRCUIT_VERSION !== undefined) return process.env.CIRCUIT_VERSION;
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), '../../plugins/version.json'),
    resolve(process.cwd(), 'plugins/version.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.length > 0) return raw.version;
    } catch {
      // Keep version reporting useful when the repo manifest is unavailable.
    }
  }
  return DEFAULT_DEV_VERSION;
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
      'missing command: use run, resume, handoff, history, memory, create, runs, or version',
    );
  }
  return invocation;
}

function addExecutionOptions(program: Command): Command {
  return program
    .option('--goal <goal>')
    .option('--rigor <lite|standard|deep>')
    .option('--tournament')
    .option('--tournament-n <2|3|4>')
    .option('--autonomous')
    .option('--run-folder <path>')
    .option('--fixture <path>')
    .option('--flow-root <path>')
    .option('--checkpoint-choice <choice>')
    .option('--progress <format>')
    .option('--dry-run')
    .option('--include-untracked-content');
}

function parseExecutionArgs(command: 'run' | 'resume', argv: readonly string[]): ParsedArgs {
  const program = addExecutionOptions(new Command(`circuit ${command}`).argument('[flow-name]'));
  parseCommanderOrThrow(program, argv);

  const opts = program.opts<{
    goal?: string;
    rigor?: string;
    tournament?: boolean;
    tournamentN?: string;
    autonomous?: boolean;
    runFolder?: string;
    fixture?: string;
    flowRoot?: string;
    checkpointChoice?: string;
    progress?: string;
    dryRun?: boolean;
    includeUntrackedContent?: boolean;
  }>();

  const flowName = program.args[0];

  if (opts.dryRun === true) {
    // Fail closed. An earlier version accepted the flag silently while
    // the real connector still ran. Re-enable once real dry-run support
    // lands (deterministic dry relayer + trace marker).
    throw new Error(
      '--dry-run is not currently implemented and is rejected. An earlier version silently invoked the real connector while reporting dry_run:true, which is a safety bug. The flag stays rejected until real dry-run support lands.',
    );
  }

  let rigor: RigorValue | undefined;
  const rigorProvided = opts.rigor !== undefined;
  if (opts.rigor !== undefined) rigor = Rigor.parse(opts.rigor);

  const tournamentProvided = opts.tournament === true;
  const tournament = opts.tournament === true;

  let tournamentN: number | undefined;
  const tournamentNProvided = opts.tournamentN !== undefined;
  if (opts.tournamentN !== undefined) {
    const parsed = Number(opts.tournamentN);
    if (!Number.isInteger(parsed) || !TournamentN.safeParse(parsed).success) {
      throw new Error('Tournament N must be between 2 and 4');
    }
    tournamentN = parsed;
  }

  const autonomousProvided = opts.autonomous === true;
  const autonomous = opts.autonomous === true;

  if (opts.flowRoot !== undefined && opts.flowRoot.length === 0) {
    throw new Error('--flow-root requires a non-empty value');
  }

  if (opts.progress !== undefined && opts.progress !== 'jsonl') {
    throw new Error("--progress only supports 'jsonl'");
  }

  const goal = opts.goal;
  const runFolder = opts.runFolder;
  const fixturePath = opts.fixture;
  const flowRoot = opts.flowRoot;
  const checkpointChoice = opts.checkpointChoice;
  const progress = opts.progress === 'jsonl' ? 'jsonl' : undefined;
  const includeUntrackedContent = opts.includeUntrackedContent === true;

  if (command === 'resume' || checkpointChoice !== undefined) {
    if (command !== 'resume') {
      throw new Error('checkpoint resume must use the `resume` subcommand');
    }
    if (runFolder === undefined) throw new Error('--run-folder is required for checkpoint resume');
    if (checkpointChoice === undefined || checkpointChoice.length === 0) {
      throw new Error('--checkpoint-choice is required for checkpoint resume');
    }
    if (flowName !== undefined) {
      throw new Error('checkpoint resume loads the saved flow manifest; omit flow-name');
    }
    if (goal !== undefined) {
      throw new Error('checkpoint resume reuses the saved run goal; omit --goal');
    }
    if (fixturePath !== undefined) {
      throw new Error('checkpoint resume loads the saved flow manifest; omit --fixture');
    }
    if (flowRoot !== undefined) {
      throw new Error('checkpoint resume loads the saved flow manifest; omit --flow-root');
    }
    if (rigorProvided || tournamentProvided || tournamentNProvided || autonomousProvided) {
      throw new Error(
        'checkpoint resume reuses the saved run axes; omit --rigor/--tournament/--tournament-n/--autonomous',
      );
    }
    if (includeUntrackedContent) {
      throw new Error(
        'checkpoint resume reuses the saved evidence policy; omit --include-untracked-content',
      );
    }
  } else if (goal === undefined || goal.length === 0) {
    throw new Error('--goal is required and must be non-empty');
  }

  if (tournamentNProvided && !tournamentProvided) {
    throw new Error('--tournament-n requires --tournament');
  }

  const axes = Axes.parse({
    ...(rigor === undefined ? {} : { rigor }),
    tournament,
    ...(tournamentN === undefined ? {} : { tournament_n: tournamentN }),
    autonomous,
  });

  const result: ParsedArgs = {
    command,
    axes,
    rigorProvided,
    tournamentProvided,
    tournamentNProvided,
    autonomousProvided,
    includeUntrackedContent,
  };
  if (goal !== undefined) result.goal = goal;
  if (flowName !== undefined) result.flowName = flowName;
  if (runFolder !== undefined) result.runFolder = runFolder;
  if (fixturePath !== undefined) result.fixturePath = fixturePath;
  if (flowRoot !== undefined) result.flowRoot = flowRoot;
  if (checkpointChoice !== undefined) result.checkpointChoice = checkpointChoice;
  if (progress !== undefined) result.progress = progress;
  return result;
}

function resolveFixturePath(
  flowName: string,
  modeName: string | undefined,
  override: string | undefined,
  flowRoot: string | undefined,
): string {
  if (override !== undefined) return resolve(override);
  const root = resolve(flowRoot ?? 'generated/flows');
  // When a mode is explicitly requested, prefer the per-mode file if the
  // schematic author emitted one. Schematics with route_overrides produce
  // <mode>.json siblings of circuit.json — see scripts/flows/emit.ts.
  // Falls back to circuit.json otherwise.
  if (modeName !== undefined) {
    const perMode = resolve(root, flowName, `${modeName}.json`);
    if (existsSync(perMode)) return perMode;
  }
  return resolve(root, flowName, 'circuit.json');
}

function progressReporter(enabled: boolean): ((event: ProgressEventValue) => void) | undefined {
  if (!enabled) return undefined;
  return (event) => {
    const parsed = ProgressEvent.parse(event);
    process.stderr.write(`${JSON.stringify(parsed)}\n`);
  };
}

function routeSelectedStatusText(flowId: string, entryModeName: string | undefined): string {
  return entryModeName === undefined
    ? `Chose ${flowId}.`
    : `Chose ${flowId} with ${entryModeName} thoroughness.`;
}

function resolveCompiledFlowRoute(args: ParsedArgs): ResolvedCompiledFlowRoute {
  if (args.flowName !== undefined) {
    return {
      flowName: args.flowName,
      source: 'explicit',
      reason: 'explicit flow positional argument',
    };
  }
  // Routing is model-only: the host or operator names the flow. There is no
  // deterministic classifier to guess one from the goal text.
  throw new Error(
    'a flow name is required: pass one of build|fix|review|explore|prototype|pursue as the first argument',
  );
}

function hasExplicitAxes(args: ParsedArgs): boolean {
  return args.rigorProvided || args.tournamentProvided || args.autonomousProvided;
}

function axisSelectionNameForAxes(axes: AxesValue): string {
  if (axes.autonomous) return 'autonomous';
  if (axes.tournament) return 'tournament';
  if (axes.rigor === 'lite' || axes.rigor === 'deep') return axes.rigor;
  return 'default';
}

function fixtureSelectionNameForAxes(axes: AxesValue): string {
  if (axes.tournament) return 'tournament';
  if (axes.autonomous) return 'autonomous';
  if (axes.rigor === 'lite' || axes.rigor === 'deep') return axes.rigor;
  return 'default';
}

function runtimeDepthForAxes(axes: AxesValue): string {
  if (axes.autonomous) return 'autonomous';
  if (axes.tournament) return 'tournament';
  return axes.rigor;
}

// Entry mode (thoroughness) is explicit-only: it comes from the axis flags
// (--rigor/--tournament/--autonomous), never inferred from goal text.
function resolveEntryModeSelection(args: ParsedArgs): ResolvedEntryModeSelection {
  if (hasExplicitAxes(args)) {
    return {
      entryModeName: axisSelectionNameForAxes(args.axes),
      source: 'explicit',
      reason: 'explicit axis flags',
    };
  }
  return {};
}

function progressSurfaceForFlowId(flowId: string) {
  return findFlowRuntimeSurfaceById(flowId)?.progress;
}

function axisSupportFromAxes(axes: CompiledFlow['axes']): AxisSupport {
  return {
    allowedRigors: axes.allowed_rigors,
    supportsTournament: axes.supports_tournament,
    supportsAutonomous: axes.supports_autonomous,
  };
}

function axisSupportFromFlow(input: {
  readonly flow: CompiledFlow;
}): AxisSupport {
  return axisSupportFromAxes(input.flow.axes);
}

function axisAllowListText(flowId: string, support: AxisSupport): string {
  const rigors = support.allowedRigors.join(', ');
  return `${flowId} allows rigors: ${rigors}; tournament: ${support.supportsTournament ? 'yes' : 'no'}; autonomous: ${support.supportsAutonomous ? 'yes' : 'no'}`;
}

function validateFlowAxes(input: {
  readonly flow: CompiledFlow;
  readonly args: ParsedArgs;
  readonly route: ResolvedCompiledFlowRoute;
  readonly fixturePath: string;
}): void {
  const axes = input.args.axes;
  const support = axisSupportFromFlow(input);
  const flowId = input.flow.id as unknown as string;
  const allowList = axisAllowListText(flowId, support);
  if (!support.allowedRigors.includes(axes.rigor)) {
    throw new Error(`--rigor ${axes.rigor} is not supported by flow '${flowId}'. ${allowList}`);
  }
  if (axes.tournament && !support.supportsTournament) {
    throw new Error(`--tournament is not supported by flow '${flowId}'. ${allowList}`);
  }
  if (axes.autonomous && !support.supportsAutonomous) {
    throw new Error(`--autonomous is not supported by flow '${flowId}'. ${allowList}`);
  }
}

function loadFixture(fixturePath: string): { flow: CompiledFlow; bytes: Buffer } {
  if (!existsSync(fixturePath)) {
    throw new Error(`flow fixture not found: ${fixturePath}`);
  }
  const bytes = readFileSync(fixturePath);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  const flow = CompiledFlow.parse(raw);
  // Enforce flow-kind canonical stage-set policy at fixture load.
  // Validator: src/shared/flow-kind-policy.ts.
  const policy = validateCompiledFlowKindPolicy(flow);
  if (!policy.ok) {
    throw new Error(`flow fixture policy violation (${fixturePath}):\n  ${policy.reason}`);
  }
  return { flow, bytes };
}

function defaultChildCompiledFlowResolver(flowRoot: string | undefined): ChildCompiledFlowResolver {
  return (ref) => {
    const fixturePath = resolveFixturePath(ref.flowId, ref.entryMode, undefined, flowRoot);
    const { bytes } = loadFixture(fixturePath);
    return { flowBytes: bytes };
  };
}

function assertFixtureMatchesRoute(flow: CompiledFlow, route: ResolvedCompiledFlowRoute): void {
  const flowId = flow.id as unknown as string;
  if (flowId !== route.flowName) {
    throw new Error(
      `flow fixture id mismatch: selected flow '${route.flowName}' but fixture declares '${flowId}'`,
    );
  }
}

function selectedEntryModeName(
  _flow: CompiledFlow,
  entryModeSelection: ResolvedEntryModeSelection,
): string {
  return entryModeSelection.entryModeName ?? 'default';
}

function selectedDepth(
  flow: CompiledFlow,
  args: ParsedArgs,
  _entryModeSelection: ResolvedEntryModeSelection,
): string {
  if (hasExplicitAxes(args)) return runtimeDepthForAxes(args.axes);
  return runtimeDepthForAxes(flow.axes.default);
}

function classifyRuntimeSupport(input: {
  readonly flow: CompiledFlow;
  readonly args: ParsedArgs;
  readonly route: ResolvedCompiledFlowRoute;
  readonly entryModeSelection: ResolvedEntryModeSelection;
  readonly fixturePath: string;
}): RuntimeSupportDecision {
  const flowId = input.flow.id as unknown as string;
  const entryModeName = selectedEntryModeName(input.flow, input.entryModeSelection);
  const depth = selectedDepth(input.flow, input.args, input.entryModeSelection);
  return {
    kind: 'supported',
    flowId,
    entryModeName,
    depth,
    reason: `runtime supports fresh ${flowId} axis selection '${entryModeName}' at depth '${depth}'`,
  };
}

function historyRecallOutputFields(input: {
  readonly runFolder: string;
  readonly report: ReturnType<typeof prepareRunStartHistoryRecall>['report'];
}) {
  return {
    history_recall: {
      status: input.report.status,
      memory_input_count: input.report.memory_input_count,
      report_path: join(input.runFolder, HISTORY_RECALL_REPORT_PATH),
      rebuilt: input.report.rebuilt,
      ...(input.report.index_state === undefined ? {} : { index_state: input.report.index_state }),
      warnings: input.report.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
      })),
    },
  };
}

function runEnvelopeMemoryContext(
  recall: ReturnType<typeof prepareRunStartHistoryRecall> | undefined,
): { readonly used: boolean; readonly memoryInputIds: readonly string[] } | undefined {
  if (recall === undefined) return undefined;
  const report = recall.report;
  return {
    used: report.status === 'used',
    memoryInputIds: report.memory_inputs.map((memory) => memory.memory_id),
  };
}

function shouldPrepareHistoryRecall(options: CliMainOptions): boolean {
  if (options.historyRecall === 'enabled') return true;
  if (options.historyRecall === 'disabled') return false;
  return (
    options.relayer === undefined &&
    options.runtimeExecutors === undefined &&
    options.composeWriter === undefined
  );
}

export async function main(argv: readonly string[], options: CliMainOptions = {}): Promise<number> {
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
  if (invocation.command === 'runs') {
    return runRunsCommand(invocation.argv);
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

async function runResumeCommand(args: ParsedArgs, options: CliMainOptions): Promise<number> {
  if (
    args.command === 'resume' &&
    args.runFolder !== undefined &&
    args.checkpointChoice !== undefined
  ) {
    const runFolder = resolve(args.runFolder);
    const progress = progressReporter(args.progress === 'jsonl');
    const hostKind = runtimeHostKind(options);
    if (await isRuntimeRunFolder(runFolder)) {
      const runtimeResult = await resumeCompiledFlow({
        runDir: runFolder,
        selection: args.checkpointChoice,
        now: options.now ?? (() => new Date()),
        childCompiledFlowResolver: defaultChildCompiledFlowResolver(undefined),
        ...(hostKind === undefined ? {} : { hostKind }),
        ...(options.runtimeExecutors === undefined ? {} : { executors: options.runtimeExecutors }),
        ...(options.relayer === undefined ? {} : { relayer: options.relayer }),
        ...(progress === undefined ? {} : { progress }),
        progressSurfaceForFlowId,
      });
      const runResult = RunResult.parse(JSON.parse(readFileSync(runtimeResult.resultPath, 'utf8')));
      const priorRoute = readPriorRoute(runFolder);
      const postRunArtifactWarnings: PostRunArtifactWarning[] = [];
      const postRunArtifactContext: PostRunArtifactContext = {
        progressJsonl: args.progress === 'jsonl',
        warnings: postRunArtifactWarnings,
      };
      const recordedAt = (options.now ?? (() => new Date()))().toISOString();
      const selectedProcess = selectedProcessFields({
        processId: runResult.flow_id as unknown as string,
        ...(priorRoute.routedBy === undefined ? {} : { routedBy: priorRoute.routedBy }),
        routerReason: priorRoute.routerReason ?? 'checkpoint resume',
      });
      const { operatorSummary, runEnvelope } = emitPostRunArtifacts({
        context: postRunArtifactContext,
        runFolder,
        operatorIntent: runResult.goal,
        recordedAt,
        selectedProcess,
        child: {
          kind: 'closed',
          runResult,
          resultPath: runtimeResult.resultPath,
        },
        writeOperatorSummary: () =>
          writeOperatorSummary({
            runFolder,
            runResult,
            route: {
              selectedFlow: runResult.flow_id as unknown as string,
              ...(priorRoute.routedBy === undefined ? {} : { routedBy: priorRoute.routedBy }),
              ...(priorRoute.routerReason === undefined
                ? {}
                : { routerReason: priorRoute.routerReason }),
            },
          }),
        buildProcessEvidenceProjection: () =>
          projectClosedProcessEvidence({
            runFolder,
            runResult,
            resultPath: runtimeResult.resultPath,
          }),
        // Resume reuses the saved run; it records no fresh memory context.
        memoryContext: undefined,
      });
      const resumeRuntimeFields = showRuntimeDecision()
        ? {
            runtime_reason: RUNTIME_POLICY_REASONS.checkpointResume,
          }
        : {};
      process.stdout.write(
        `${JSON.stringify(
          {
            schema_version: 1,
            run_id: runResult.run_id,
            flow_id: runResult.flow_id,
            run_folder: runFolder,
            outcome: runResult.outcome,
            // A resumed run can also abort; surface its reason the same way (F-H-2).
            ...(runResult.reason === undefined ? {} : { reason: runResult.reason }),
            trace_entries_observed: runResult.trace_entries_observed,
            result_path: runtimeResult.resultPath,
            ...resumeRuntimeFields,
            ...postRunArtifactWarningOutputFields(postRunArtifactWarnings),
            ...(operatorSummary === undefined
              ? {}
              : operatorSummaryOutputFields({ operatorSummary })),
            ...(runEnvelope === undefined ? {} : runEnvelopeOutputFields({ runEnvelope })),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    process.stderr.write('error: run folder is not a resumable Circuit run folder\n');
    return 2;
  }
  // Defensive fallback: parseExecutionArgs guarantees a resume command carries a
  // run folder and checkpoint choice, so this delegation is unreachable in
  // practice. It preserves the original control flow, where a malformed resume
  // fell through to the execution path's goal-undefined guard.
  return runExecutionCommand(args, options);
}

async function runExecutionCommand(args: ParsedArgs, options: CliMainOptions): Promise<number> {
  if (args.goal === undefined) {
    throw new Error('internal error: --goal missing outside checkpoint resume mode');
  }
  const operatorGoal = args.goal;

  let route: ResolvedCompiledFlowRoute;
  try {
    route = resolveCompiledFlowRoute(args);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  const entryModeSelection = resolveEntryModeSelection(args);
  const fixtureSelectionName = fixtureSelectionNameForAxes(args.axes);
  const fixturePath = resolveFixturePath(
    route.flowName,
    fixtureSelectionName,
    args.fixturePath,
    args.flowRoot,
  );
  // An internal flow (e.g. the frozen `goal`) ships no host surface, so its
  // fixture is absent from a host package's flow root. Reject with a clear
  // message naming it as internal rather than leaking the generic
  // fixture-not-found path (F-L-3). A source/dev checkout that DOES carry the
  // fixture still runs the flow explicitly — the guard only fires when the
  // fixture is missing here.
  if (!existsSync(fixturePath)) {
    const pkg = findCompiledFlowPackageById(route.flowName);
    if (pkg?.visibility === 'internal') {
      process.stderr.write(
        `error: ${route.flowName} is an internal flow and is not available through the host run surface.\n`,
      );
      return 2;
    }
  }
  const { flow, bytes } = loadFixture(fixturePath);
  assertFixtureMatchesRoute(flow, route);
  try {
    validateFlowAxes({ flow, args, route, fixturePath });
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  const runId = RunId.parse(options.runId ?? randomUUID());
  const now = options.now ?? (() => new Date());
  const progress = progressReporter(args.progress === 'jsonl');
  const selectedStatusText = routeSelectedStatusText(flow.id, entryModeSelection.entryModeName);
  progress?.({
    schema_version: 1,
    type: 'route.selected',
    run_id: runId,
    flow_id: flow.id,
    recorded_at: now().toISOString(),
    label: `Selected ${route.flowName}`,
    display: progressDisplay(`Circuit: ${selectedStatusText}`, 'major', 'info'),
    presentation: progressPresentation({ blockId: runId, statusText: selectedStatusText }),
    // These route facets mirror routeOutputFields, but the route.selected event
    // is a typed discriminated-union member (ProgressEvent), not the loosely
    // typed stdout JSON. Spreading a Record<string, unknown> builder here erases
    // the literal property types and breaks the union parse, so the fields stay
    // inline. The shared shape is the selectedProcessFields builder used by the
    // three selected_process literals below.
    selected_flow: flow.id,
    routed_by: route.source,
    router_reason: route.reason,
    ...(entryModeSelection.entryModeName === undefined
      ? {}
      : { entry_mode: entryModeSelection.entryModeName }),
    ...(entryModeSelection.source === undefined
      ? {}
      : { entry_mode_source: entryModeSelection.source }),
  });
  const runFolder = resolve(args.runFolder ?? `${DEFAULT_RUNS_BASE}/${runId as unknown as string}`);
  const runtimeConfigLayers = discoverRuntimeConfigLayers({
    ...(options.configHomeDir !== undefined ? { homeDir: options.configHomeDir } : {}),
    ...(options.configCwd !== undefined ? { cwd: options.configCwd } : {}),
  });
  const { policyLayers, selectionConfigLayers } = runtimeConfigLayers;
  const hostKind = runtimeHostKind(options);

  const projectRoot = resolve(options.configCwd ?? process.cwd());

  const runtimeSupport = classifyRuntimeSupport({
    flow,
    args,
    route,
    entryModeSelection,
    fixturePath,
  });
  const runtimeDecisionDiagnostics = showRuntimeDecision();
  const defaultRuntimeSupport = applyComposeWriterPolicy(
    applyFixturePolicy(runtimeSupport, {
      args,
      fixturePath,
    }),
    { hasComposeWriter: options.composeWriter !== undefined },
  );
  const routeToRuntime = defaultRuntimeSupport.kind === 'supported';

  if (routeToRuntime) {
    const progressSurface = progressSurfaceForFlowId(flow.id);
    const historyRecall = shouldPrepareHistoryRecall(options)
      ? prepareRunStartHistoryRecall({
          repoRoot: projectRoot,
          query: operatorGoal,
          flowId: flow.id as unknown as string,
          now,
        })
      : undefined;
    const runtimeResult = await runCompiledFlowWithWaiting({
      flowBytes: bytes,
      compiledFlowPath: fixturePath,
      runDir: runFolder,
      runId,
      goal: operatorGoal,
      now,
      projectRoot,
      childCompiledFlowResolver: defaultChildCompiledFlowResolver(args.flowRoot),
      depth: selectedDepth(flow, args, entryModeSelection),
      axes: args.axes,
      ...(entryModeSelection.entryModeName === undefined
        ? {}
        : { entryModeName: entryModeSelection.entryModeName }),
      ...(options.relayer === undefined ? {} : { relayer: options.relayer }),
      ...(options.runtimeExecutors === undefined ? {} : { executors: options.runtimeExecutors }),
      ...(hostKind === undefined ? {} : { hostKind }),
      ...(selectionConfigLayers.length === 0 ? {} : { selectionConfigLayers }),
      ...(policyLayers.length === 0 ? {} : { policyLayers }),
      ...(progress === undefined ? {} : { progress }),
      ...(progressSurface === undefined ? {} : { progressSurface }),
      ...(historyRecall === undefined ? {} : { memoryInputs: historyRecall.report.memory_inputs }),
      ...(historyRecall === undefined ? {} : { historyRecallReport: historyRecall.report }),
      ...(historyRecall === undefined ? {} : { historyRecallPrecision: historyRecall.precision }),
      ...(args.includeUntrackedContent
        ? { evidencePolicy: { includeUntrackedFileContent: true } }
        : {}),
    });
    if (isGraphCheckpointWaitingResult(runtimeResult)) {
      const waitingResult = {
        schema_version: 1 as const,
        run_id: RunId.parse(runtimeResult.runId),
        flow_id: CompiledFlowId.parse(runtimeResult.flowId),
        goal: operatorGoal,
        outcome: 'checkpoint_waiting' as const,
        summary: `checkpoint '${runtimeResult.checkpoint.stepId}' is waiting for an operator choice.`,
        trace_entries_observed: runtimeResult.traceEntriesObserved,
        manifest_hash: computeManifestHash(bytes),
        checkpoint: {
          step_id: runtimeResult.checkpoint.stepId,
          request_path: runtimeResult.checkpoint.requestPath,
          allowed_choices: runtimeResult.checkpoint.allowedChoices,
        },
      };
      const selectedProcess = selectedProcessFields({
        processId: flow.id,
        routedBy: route.source,
        routerReason: route.reason,
        ...(entryModeSelection.entryModeName === undefined
          ? {}
          : { entryMode: entryModeSelection.entryModeName }),
      });
      const postRunArtifactWarnings: PostRunArtifactWarning[] = [];
      const postRunArtifactContext: PostRunArtifactContext = {
        progressJsonl: args.progress === 'jsonl',
        warnings: postRunArtifactWarnings,
      };
      const recordedAt = now().toISOString();
      const { operatorSummary, runEnvelope } = emitPostRunArtifacts({
        context: postRunArtifactContext,
        runFolder,
        operatorIntent: operatorGoal,
        recordedAt,
        selectedProcess,
        child: {
          kind: 'checkpoint_waiting',
          run_id: waitingResult.run_id,
          flow_id: waitingResult.flow_id,
          trace_entries_observed: waitingResult.trace_entries_observed,
          manifest_hash: waitingResult.manifest_hash,
          checkpoint: {
            step_id: waitingResult.checkpoint.step_id,
            request_path: runtimeResult.checkpoint.requestPath,
            allowed_choices: waitingResult.checkpoint.allowed_choices,
          },
        },
        writeOperatorSummary: () =>
          writeOperatorSummary({
            runFolder,
            runResult: waitingResult,
            route: {
              selectedFlow: route.flowName,
              routedBy: route.source,
              routerReason: route.reason,
            },
          }),
        buildProcessEvidenceProjection: () =>
          projectCheckpointWaitingProcessEvidence({
            runFolder,
            runId: waitingResult.run_id,
            flowId: waitingResult.flow_id,
            traceEntriesObserved: waitingResult.trace_entries_observed,
            manifestHash: waitingResult.manifest_hash,
            checkpoint: {
              stepId: waitingResult.checkpoint.step_id,
              requestPath: runtimeResult.checkpoint.requestPath,
              allowedChoices: waitingResult.checkpoint.allowed_choices,
            },
          }),
        memoryContext: runEnvelopeMemoryContext(historyRecall),
        recallMemoryIndicator: historyRecall?.precision.indicator,
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            schema_version: 1,
            run_id: waitingResult.run_id,
            flow_id: waitingResult.flow_id,
            ...routeOutputFields({
              selectedFlow: route.flowName,
              routedBy: route.source,
              routerReason: route.reason,
              ...(entryModeSelection.entryModeName === undefined
                ? {}
                : { entryMode: entryModeSelection.entryModeName }),
              ...(entryModeSelection.source === undefined
                ? {}
                : { entryModeSource: entryModeSelection.source }),
            }),
            run_folder: runFolder,
            outcome: waitingResult.outcome,
            trace_entries_observed: waitingResult.trace_entries_observed,
            ...runtimeOutputFields({
              include: runtimeDecisionDiagnostics,
              decision: defaultRuntimeSupport,
            }),
            ...(historyRecall === undefined
              ? {}
              : historyRecallOutputFields({ runFolder, report: historyRecall.report })),
            ...postRunArtifactWarningOutputFields(postRunArtifactWarnings),
            ...(operatorSummary === undefined
              ? {}
              : operatorSummaryOutputFields({ operatorSummary })),
            ...(runEnvelope === undefined ? {} : runEnvelopeOutputFields({ runEnvelope })),
            checkpoint: waitingResult.checkpoint,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    const runResult = RunResult.parse(JSON.parse(readFileSync(runtimeResult.resultPath, 'utf8')));
    const selectedProcess = selectedProcessFields({
      processId: flow.id,
      routedBy: route.source,
      routerReason: route.reason,
      ...(entryModeSelection.entryModeName === undefined
        ? {}
        : { entryMode: entryModeSelection.entryModeName }),
    });
    const postRunArtifactWarnings: PostRunArtifactWarning[] = [];
    const postRunArtifactContext: PostRunArtifactContext = {
      progressJsonl: args.progress === 'jsonl',
      warnings: postRunArtifactWarnings,
    };
    const recordedAt = now().toISOString();
    const { operatorSummary, processEvidence, runEnvelope } = emitPostRunArtifacts({
      context: postRunArtifactContext,
      runFolder,
      operatorIntent: operatorGoal,
      recordedAt,
      selectedProcess,
      child: {
        kind: 'closed',
        runResult,
        resultPath: runtimeResult.resultPath,
      },
      writeOperatorSummary: () =>
        writeOperatorSummary({
          runFolder,
          runResult,
          route: {
            selectedFlow: route.flowName,
            routedBy: route.source,
            routerReason: route.reason,
          },
        }),
      buildProcessEvidenceProjection: () =>
        projectClosedProcessEvidence({
          runFolder,
          runResult,
          resultPath: runtimeResult.resultPath,
        }),
      memoryContext: runEnvelopeMemoryContext(historyRecall),
      recallMemoryIndicator: historyRecall?.precision.indicator,
    });
    // S10: in autonomous mode, drive the continuation loop. Attempt 1 reuses the
    // primary run above; follow-up attempts run the routed recovery flow for real
    // in a sub-folder. The loop owns the completion decision and never closes
    // complete by exhaustion. Failures degrade to the normal single-shot result.
    let autonomousLoop: Awaited<ReturnType<typeof runAutonomousContinuation>> | undefined;
    if (
      args.axes.autonomous === true &&
      processEvidence !== undefined &&
      runEnvelope !== undefined
    ) {
      const primaryProjection = processEvidence.projection;
      const contract = runEnvelope.record.goal_contract;
      const parentAxes = args.axes;
      // Cache each routed recovery flow so a repeated route does not re-read and
      // re-parse the same compiled flow from disk on every attempt.
      const recoveryFlowCache = new Map<
        string,
        { flow: CompiledFlow; bytes: Buffer; path: string }
      >();
      try {
        autonomousLoop = await runAutonomousContinuation({
          contract,
          primaryProcessId: flow.id,
          runFlow: async ({ processId, attemptNumber }) => {
            if (attemptNumber === 1) {
              return { projection: primaryProjection };
            }
            let recoveryFlow = recoveryFlowCache.get(processId);
            if (recoveryFlow === undefined) {
              const path = resolveFixturePath(
                processId,
                fixtureSelectionName,
                undefined,
                args.flowRoot,
              );
              const loaded = loadFixture(path);
              // Guard the routed recovery flow the same way the primary run is
              // guarded: the loaded fixture's declared id must match the routed
              // process, so the loop can never silently run a different flow than
              // it routed to. A mismatch degrades the loop to the single-shot
              // result via the surrounding catch.
              const loadedFlowId = loaded.flow.id as unknown as string;
              if (loadedFlowId !== processId) {
                throw new Error(
                  `recovery flow fixture id mismatch: routed to '${processId}' but fixture declares '${loadedFlowId}'`,
                );
              }
              recoveryFlow = { flow: loaded.flow, bytes: loaded.bytes, path };
              recoveryFlowCache.set(processId, recoveryFlow);
            }
            // A recovery attempt is a single bounded child run inside the parent
            // loop, not itself an autonomous loop. Run it with axes the recovery
            // flow actually supports: a routed recovery flow may differ from the
            // parent (for example review does not support --autonomous), and the
            // parent's up-front validateFlowAxes does not cover it. Never pass an
            // axis the flow does not declare.
            const support = axisSupportFromFlow({ flow: recoveryFlow.flow });
            const recoveryAxes = Axes.parse({
              // Keep the parent's rigor only if the recovery flow allows it;
              // otherwise fall back to the recovery flow's own default rigor,
              // which the axes schema guarantees is in its allowed set (never a
              // hardcoded value the flow might not declare).
              rigor: support.allowedRigors.includes(parentAxes.rigor)
                ? parentAxes.rigor
                : recoveryFlow.flow.axes.default.rigor,
              tournament: false,
              autonomous: parentAxes.autonomous && support.supportsAutonomous,
            });
            const attemptFolder = join(
              runFolder,
              'attempts',
              `attempt-${attemptNumber}-${processId}`,
            );
            const recoveryResult = await runCompiledFlowWithWaiting({
              flowBytes: recoveryFlow.bytes,
              compiledFlowPath: recoveryFlow.path,
              runDir: attemptFolder,
              runId: RunId.parse(randomUUID()),
              goal: operatorGoal,
              now,
              projectRoot,
              childCompiledFlowResolver: defaultChildCompiledFlowResolver(args.flowRoot),
              axes: recoveryAxes,
              ...(options.relayer === undefined ? {} : { relayer: options.relayer }),
              ...(options.runtimeExecutors === undefined
                ? {}
                : { executors: options.runtimeExecutors }),
              ...(hostKind === undefined ? {} : { hostKind }),
              ...(selectionConfigLayers.length === 0 ? {} : { selectionConfigLayers }),
              ...(policyLayers.length === 0 ? {} : { policyLayers }),
            });
            if (isGraphCheckpointWaitingResult(recoveryResult)) {
              return {
                projection: projectCheckpointWaitingProcessEvidence({
                  runFolder: attemptFolder,
                  runId: RunId.parse(recoveryResult.runId),
                  flowId: recoveryResult.flowId,
                  traceEntriesObserved: recoveryResult.traceEntriesObserved,
                  manifestHash: computeManifestHash(recoveryFlow.bytes),
                  checkpoint: {
                    stepId: recoveryResult.checkpoint.stepId,
                    requestPath: recoveryResult.checkpoint.requestPath,
                    allowedChoices: recoveryResult.checkpoint.allowedChoices,
                  },
                }),
              };
            }
            const recoveryRunResult = RunResult.parse(
              JSON.parse(readFileSync(recoveryResult.resultPath, 'utf8')),
            );
            return {
              projection: projectClosedProcessEvidence({
                runFolder: attemptFolder,
                runResult: recoveryRunResult,
                resultPath: recoveryResult.resultPath,
              }),
            };
          },
        });
        const autonomousLoopPath = join(runFolder, AUTONOMOUS_LOOP_RELATIVE_PATH);
        mkdirSync(dirname(autonomousLoopPath), { recursive: true });
        writeFileSync(autonomousLoopPath, `${JSON.stringify(autonomousLoop, null, 2)}\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        postRunArtifactWarnings.push({ label: 'autonomous-loop', message });
        if (args.progress !== 'jsonl') {
          process.stderr.write(`warning: autonomous loop failed: ${message}\n`);
        }
        autonomousLoop = undefined;
      }
    }
    // Record the resolved axes on the envelope so a reader can audit which
    // rigor/tournament/autonomous selection actually ran (F-M-1). entry_mode
    // collapses the three axes into one name; resolved_axes keeps them explicit.
    const resolvedAxes = args.axes;
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 1,
          run_id: runResult.run_id,
          flow_id: runResult.flow_id,
          resolved_axes: {
            rigor: resolvedAxes.rigor,
            tournament: resolvedAxes.tournament,
            autonomous: resolvedAxes.autonomous,
          },
          ...routeOutputFields({
            selectedFlow: route.flowName,
            routedBy: route.source,
            routerReason: route.reason,
            ...(entryModeSelection.entryModeName === undefined
              ? {}
              : { entryMode: entryModeSelection.entryModeName }),
            ...(entryModeSelection.source === undefined
              ? {}
              : { entryModeSource: entryModeSelection.source }),
          }),
          run_folder: runFolder,
          outcome: runResult.outcome,
          // Copy the abort reason onto the final envelope so a non-streaming
          // host (and the present no-blocks branch) renders the specific reason
          // rather than a generic fallback (F-H-2). result.json carries it too.
          ...(runResult.reason === undefined ? {} : { reason: runResult.reason }),
          trace_entries_observed: runResult.trace_entries_observed,
          result_path: runtimeResult.resultPath,
          ...runtimeOutputFields({
            include: runtimeDecisionDiagnostics,
            decision: defaultRuntimeSupport,
          }),
          ...(historyRecall === undefined
            ? {}
            : historyRecallOutputFields({ runFolder, report: historyRecall.report })),
          ...postRunArtifactWarningOutputFields(postRunArtifactWarnings),
          ...(operatorSummary === undefined
            ? {}
            : operatorSummaryOutputFields({ operatorSummary })),
          ...(runEnvelope === undefined ? {} : runEnvelopeOutputFields({ runEnvelope })),
          ...(autonomousLoop === undefined
            ? {}
            : {
                autonomous_loop: {
                  outcome: autonomousLoop.outcome,
                  attempts: autonomousLoop.attempts.length,
                  stop_reason: autonomousLoop.stopReason,
                  path: join(runFolder, AUTONOMOUS_LOOP_RELATIVE_PATH),
                },
              }),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stderr.write(`error: unsupported runtime invocation: ${defaultRuntimeSupport.reason}\n`);
  return 2;
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
