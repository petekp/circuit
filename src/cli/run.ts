import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';

import type { ExecutorRegistry } from '../runtime/executors/index.js';
import { isRuntimeRunFolder, resumeCompiledFlow } from '../runtime/run/checkpoint-resume.js';
import { runCompiledFlowWithWaiting } from '../runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../runtime/run/graph-runner.js';
import { Axes, type Axes as AxesValue, TournamentN } from '../schemas/axes.js';
import type { CompiledFlow } from '../schemas/compiled-flow.js';
import { Config, type LayeredConfig } from '../schemas/config.js';
import { Depth, type Depth as DepthValue } from '../schemas/depth.js';
import { HostKind, type HostKind as HostKindValue } from '../schemas/host.js';
import { CompiledFlowId, RunId } from '../schemas/ids.js';
import { computeManifestHash } from '../schemas/manifest.js';
import { Power, type Power as PowerValue } from '../schemas/power.js';
import {
  ProgressEvent,
  type ProgressEvent as ProgressEventValue,
} from '../schemas/progress-event.js';
import { RunResult } from '../schemas/result.js';

import { prepareRunStartHistoryRecall } from '../app/history/run-start-recall.js';
import { readPriorRoute, writeOperatorSummary } from '../app/operator-summary/writer.js';
import {
  projectCheckpointWaitingProcessEvidence,
  projectClosedProcessEvidence,
} from '../app/process-evidence/projection.js';
import { runAutonomousContinuation } from '../app/run-envelope/autonomous-run.js';
import { findCompiledFlowPackageById, findFlowRuntimeSurfaceById } from '../flows/catalog.js';
import { discoverRuntimeConfigLayers } from '../shared/config-loader.js';
import { runsRoot } from '../shared/control-plane-paths.js';
import { progressDisplay, progressPresentation } from '../shared/progress-output.js';
import type { ComposeWriterFn, RelayFn } from '../shared/relay-runtime-types.js';
import { parseCommanderOrThrow } from './commander-support.js';
import {
  type AxisSupport,
  axisSupportFromFlow,
  defaultChildCompiledFlowResolver,
  fixtureSelectionNameForAxes,
  loadFixture,
  resolveFixturePath,
} from './flow-fixtures.js';
import { codexInstallAssurance } from './handoff-codex-hooks.js';
import {
  type PostRunArtifactContext,
  type PostRunArtifactWarning,
  emitPostRunArtifacts,
  postRunArtifactWarningOutputFields,
} from './post-run-artifacts.js';
import { createRecoveryAttemptRunner } from './recovery-attempt-runner.js';
import {
  operatorSummaryOutputFields,
  routeOutputFields,
  runEnvelopeOutputFields,
  selectedProcessFields,
} from './run-output.js';
import { composeRunStdoutEnvelope, historyRecallOutputFields } from './run-stdout-envelope.js';
import {
  RUNTIME_POLICY_REASONS,
  type RuntimeSupportDecision,
  applyComposeWriterPolicy,
  applyFixturePolicy,
  runtimeOutputFields,
  showRuntimeDecision,
} from './runtime-routing-policy.js';

const AUTONOMOUS_LOOP_RELATIVE_PATH = 'reports/autonomous-loop.json';

export interface ParsedArgs {
  command: 'run' | 'resume';
  flowName?: string;
  goal?: string;
  why?: string;
  axes: AxesValue;
  power?: PowerValue;
  powerProvided: boolean;
  depthProvided: boolean;
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

export interface RunCommandOptions {
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

function runtimeHostKind(options: RunCommandOptions): HostKindValue | undefined {
  if (options.hostKind !== undefined) return options.hostKind;
  const raw = process.env[CIRCUIT_HOST_KIND_ENV];
  if (raw === undefined || raw.length === 0) return undefined;
  return HostKind.parse(raw);
}

function addExecutionOptions(program: Command): Command {
  return program
    .option('--goal <goal>')
    .option('--why <why>')
    .option('--depth <low|medium|high>')
    .option('--power <low|medium|high>')
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

export function parseExecutionArgs(command: 'run' | 'resume', argv: readonly string[]): ParsedArgs {
  const program = addExecutionOptions(new Command(`circuit ${command}`).argument('[flow-name]'));
  parseCommanderOrThrow(program, argv);

  const opts = program.opts<{
    goal?: string;
    why?: string;
    depth?: string;
    power?: string;
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

  let depth: DepthValue | undefined;
  const depthProvided = opts.depth !== undefined;
  if (opts.depth !== undefined) depth = Depth.parse(opts.depth);

  let power: PowerValue | undefined;
  const powerProvided = opts.power !== undefined;
  if (opts.power !== undefined) {
    const parsed = Power.safeParse(opts.power);
    if (!parsed.success) {
      throw new Error('--power must be one of low, medium, high');
    }
    power = parsed.data;
  }

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
  const why = opts.why;
  if (why !== undefined && why.length === 0) {
    throw new Error('--why must be non-empty when provided');
  }
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
    if (why !== undefined) {
      throw new Error('checkpoint resume reuses the saved run goal; omit --why');
    }
    if (fixturePath !== undefined) {
      throw new Error('checkpoint resume loads the saved flow manifest; omit --fixture');
    }
    if (flowRoot !== undefined) {
      throw new Error('checkpoint resume loads the saved flow manifest; omit --flow-root');
    }
    if (depthProvided || tournamentProvided || tournamentNProvided || autonomousProvided) {
      throw new Error(
        'checkpoint resume reuses the saved run axes; omit --depth/--tournament/--tournament-n/--autonomous',
      );
    }
    if (powerProvided) {
      // The dial is config, not a saved axis: a resumed run re-discovers its
      // config layers from disk, so changing the dial mid-run goes through
      // config, not a flag the manifest never recorded.
      throw new Error('checkpoint resume re-reads power from config; omit --power');
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
    ...(depth === undefined ? {} : { depth }),
    tournament,
    ...(tournamentN === undefined ? {} : { tournament_n: tournamentN }),
    autonomous,
  });

  const result: ParsedArgs = {
    command,
    axes,
    powerProvided,
    depthProvided,
    tournamentProvided,
    tournamentNProvided,
    autonomousProvided,
    includeUntrackedContent,
  };
  if (goal !== undefined) result.goal = goal;
  if (why !== undefined) result.why = why;
  if (power !== undefined) result.power = power;
  if (flowName !== undefined) result.flowName = flowName;
  if (runFolder !== undefined) result.runFolder = runFolder;
  if (fixturePath !== undefined) result.fixturePath = fixturePath;
  if (flowRoot !== undefined) result.flowRoot = flowRoot;
  if (checkpointChoice !== undefined) result.checkpointChoice = checkpointChoice;
  if (progress !== undefined) result.progress = progress;
  return result;
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
  return args.depthProvided || args.tournamentProvided || args.autonomousProvided;
}

function axisSelectionNameForAxes(axes: AxesValue): string {
  if (axes.autonomous) return 'autonomous';
  if (axes.tournament) return 'tournament';
  if (axes.depth === 'low' || axes.depth === 'high') return axes.depth;
  return 'default';
}

function runtimeDepthForAxes(axes: AxesValue): string {
  if (axes.autonomous) return 'autonomous';
  if (axes.tournament) return 'tournament';
  return axes.depth;
}

// Entry mode (thoroughness) is explicit-only: it comes from the axis flags
// (--depth/--tournament/--autonomous), never inferred from goal text.
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

function axisAllowListText(flowId: string, support: AxisSupport): string {
  const depths = support.allowedDepths.join(', ');
  return `${flowId} allows depths: ${depths}; tournament: ${support.supportsTournament ? 'yes' : 'no'}; autonomous: ${support.supportsAutonomous ? 'yes' : 'no'}`;
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
  if (!support.allowedDepths.includes(axes.depth)) {
    throw new Error(`--depth ${axes.depth} is not supported by flow '${flowId}'. ${allowList}`);
  }
  if (axes.tournament && !support.supportsTournament) {
    throw new Error(`--tournament is not supported by flow '${flowId}'. ${allowList}`);
  }
  if (axes.autonomous && !support.supportsAutonomous) {
    throw new Error(`--autonomous is not supported by flow '${flowId}'. ${allowList}`);
  }
}

// Resolve a dot path (e.g. 'circuits.prototype.variant_models') across the
// layered selection config. The last layer that defines it wins, matching how
// flow writers read config. Returns undefined when no layer defines the path.
function readConfigPathFromLayers(layers: readonly LayeredConfig[], dotPath: string): unknown {
  const segments = dotPath.split('.');
  let resolved: unknown;
  for (const layer of layers) {
    let cursor: unknown = layer.config;
    for (const segment of segments) {
      if (cursor === null || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (cursor !== undefined) resolved = cursor;
  }
  return resolved;
}

// Reject up-front when an active axis needs config the operator has not
// supplied. This runs before any worker, so a missing prerequisite fails like
// an unsupported axis (exit 2, no run folder) instead of aborting mid-run.
function validateFlowConfigRequirements(input: {
  readonly flow: CompiledFlow;
  readonly axes: AxesValue;
  readonly selectionConfigLayers: readonly LayeredConfig[];
}): void {
  const requirements = findCompiledFlowPackageById(
    input.flow.id as unknown as string,
  )?.requiredConfig;
  if (requirements === undefined) return;
  for (const requirement of requirements) {
    const axisActive =
      requirement.axis === 'tournament' ? input.axes.tournament : input.axes.autonomous;
    if (!axisActive) continue;
    if (readConfigPathFromLayers(input.selectionConfigLayers, requirement.path) === undefined) {
      throw new Error(requirement.message);
    }
  }
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

function shouldPrepareHistoryRecall(options: RunCommandOptions): boolean {
  if (options.historyRecall === 'enabled') return true;
  if (options.historyRecall === 'disabled') return false;
  return (
    options.relayer === undefined &&
    options.runtimeExecutors === undefined &&
    options.composeWriter === undefined
  );
}

export async function runResumeCommand(
  args: ParsedArgs,
  options: RunCommandOptions,
): Promise<number> {
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
          composeRunStdoutEnvelope({
            runId: runResult.run_id,
            flowId: runResult.flow_id,
            // Resume reuses the saved run's route and axes, so the envelope
            // carries no resolved_axes or route facets.
            resolvedAxes: undefined,
            route: undefined,
            runFolder,
            outcome: runResult.outcome,
            reason: runResult.reason,
            traceEntriesObserved: runResult.trace_entries_observed,
            resultPath: runtimeResult.resultPath,
            runtimeFields: resumeRuntimeFields,
            historyRecallReport: undefined,
            postRunArtifactWarnings,
            operatorSummary,
            runEnvelope,
            autonomousLoop: undefined,
          }),
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

export async function runExecutionCommand(
  args: ParsedArgs,
  options: RunCommandOptions,
): Promise<number> {
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
  const runFolder =
    args.runFolder === undefined
      ? join(runsRoot(process.cwd()), runId as unknown as string)
      : resolve(args.runFolder);
  const runtimeConfigLayers = discoverRuntimeConfigLayers({
    ...(options.configHomeDir !== undefined ? { homeDir: options.configHomeDir } : {}),
    ...(options.configCwd !== undefined ? { cwd: options.configCwd } : {}),
    // --power rides the existing invocation config layer, so it composes with
    // (and outranks) a user-global or project `defaults.power` exactly like
    // any other layered config opinion.
    ...(args.power === undefined
      ? {}
      : {
          invocationConfig: Config.parse({
            schema_version: 1,
            defaults: { power: args.power },
          }),
        }),
  });
  const { policyLayers, selectionConfigLayers } = runtimeConfigLayers;
  try {
    validateFlowConfigRequirements({ flow, axes: args.axes, selectionConfigLayers });
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  const hostKind = runtimeHostKind(options);

  const projectRoot = resolve(options.configCwd ?? process.cwd());

  // A3: on Codex, restore needs a one-time hook install (Claude is zero-setup).
  // The front-door run is the only path a not-yet-installed Codex user reliably
  // triggers, so nudge once per repo here. Best-effort: never block a run.
  if (hostKind === 'codex') {
    try {
      const assurance = codexInstallAssurance({ projectRoot, now });
      if (assurance.notice !== undefined) process.stderr.write(`${assurance.notice}\n`);
    } catch {
      // Assurance is advisory; a failure to detect or persist must not abort.
    }
  }

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
          // Opt-in: rank project facts by query relevance before the gate's
          // budget. Default off keeps the prior store-order behavior.
          rankProjectFacts: process.env.CIRCUIT_RANK_PROJECT_FACTS === '1',
          now,
        })
      : undefined;
    const runtimeResult = await runCompiledFlowWithWaiting({
      flowBytes: bytes,
      compiledFlowPath: fixturePath,
      runDir: runFolder,
      runId,
      goal: operatorGoal,
      ...(args.why === undefined ? {} : { why: args.why }),
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
      try {
        autonomousLoop = await runAutonomousContinuation({
          contract,
          primaryProcessId: flow.id,
          runFlow: createRecoveryAttemptRunner({
            primaryProjection,
            fixtureSelectionName,
            flowRoot: args.flowRoot,
            parentAxes,
            runFolder,
            operatorGoal,
            now,
            projectRoot,
            relayer: options.relayer,
            runtimeExecutors: options.runtimeExecutors,
            hostKind,
            selectionConfigLayers,
            policyLayers,
          }),
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
    // depth/tournament/autonomous selection actually ran (F-M-1). entry_mode
    // collapses the three axes into one name; resolved_axes keeps them explicit.
    const resolvedAxes = args.axes;
    process.stdout.write(
      `${JSON.stringify(
        composeRunStdoutEnvelope({
          runId: runResult.run_id,
          flowId: runResult.flow_id,
          resolvedAxes,
          route: {
            selectedFlow: route.flowName,
            routedBy: route.source,
            routerReason: route.reason,
            ...(entryModeSelection.entryModeName === undefined
              ? {}
              : { entryMode: entryModeSelection.entryModeName }),
            ...(entryModeSelection.source === undefined
              ? {}
              : { entryModeSource: entryModeSelection.source }),
          },
          runFolder,
          outcome: runResult.outcome,
          reason: runResult.reason,
          traceEntriesObserved: runResult.trace_entries_observed,
          resultPath: runtimeResult.resultPath,
          runtimeFields: runtimeOutputFields({
            include: runtimeDecisionDiagnostics,
            decision: defaultRuntimeSupport,
          }),
          historyRecallReport: historyRecall?.report,
          postRunArtifactWarnings,
          operatorSummary,
          runEnvelope,
          autonomousLoop:
            autonomousLoop === undefined
              ? undefined
              : { ...autonomousLoop, path: join(runFolder, AUTONOMOUS_LOOP_RELATIVE_PATH) },
        }),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stderr.write(`error: unsupported runtime invocation: ${defaultRuntimeSupport.reason}\n`);
  return 2;
}
