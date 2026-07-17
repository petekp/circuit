import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';

import type { ExecutorRegistry } from '../runtime/executors/index.js';
import { isRuntimeRunFolder, resumeCompiledFlow } from '../runtime/run/checkpoint-resume.js';
import { runCompiledFlowWithWaiting } from '../runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../runtime/run/graph-runner.js';
import { Axes, type Axes as AxesValue, TournamentN } from '../schemas/axes.js';
import type { CheckpointReviewResponse } from '../schemas/checkpoint-review-response.js';
import type { CompiledFlow } from '../schemas/compiled-flow.js';
import { Config, type LayeredConfig } from '../schemas/config.js';
import { HostKind, type HostKind as HostKindValue } from '../schemas/host.js';
import { CompiledFlowId, RunId } from '../schemas/ids.js';
import { computeManifestHash } from '../schemas/manifest.js';
import { PowerDialSetting, type PowerDialSetting as PowerDialValue } from '../schemas/power.js';
import { Process, type Process as ProcessValue } from '../schemas/process.js';
import {
  ProgressEvent,
  type ProgressEvent as ProgressEventValue,
} from '../schemas/progress-event.js';
import { RunResult } from '../schemas/result.js';
import type { RunEnvelopeOutcome } from '../schemas/run-envelope.js';
import type { WaitingCheckpointStatus } from '../schemas/run-status.js';
import type { RunClosedOutcome } from '../schemas/trace-entry.js';
import { type PowerDialResolution, resolvePowerDialSetting } from '../selection/power-tiers.js';

import { prepareRunStartHistoryRecall } from '../app/history/run-start-recall.js';
import { operatorSummaryResumeCommandPrefix } from '../app/operator-summary/resume-command.js';
import { readPriorRoute, writeOperatorSummary } from '../app/operator-summary/writer.js';
import {
  projectCheckpointWaitingProcessEvidence,
  projectClosedProcessEvidence,
} from '../app/process-evidence/projection.js';
import { runAutonomousContinuation } from '../app/run-envelope/autonomous-run.js';
import {
  RunStatusFolderError,
  projectRunStatusFromRunFolder,
} from '../app/run-status/run-folder-projector.js';
import { INTERNAL_FLOW_IDS, catalogFlowIds, findFlowRuntimeSurfaceById } from '../flows/catalog.js';
import { decodeCheckpointReviewResponse } from '../shared/checkpoint-review-token.js';
import { discoverRuntimeConfigLayers } from '../shared/config-loader.js';
import { runsRoot } from '../shared/control-plane-paths.js';
import { progressDisplay, progressPresentation } from '../shared/progress-output.js';
import type { ComposeWriterFn, RelayFn } from '../shared/relay-runtime-types.js';
import { parseCommanderOrThrow } from './commander-support.js';
import {
  type AxisSupport,
  axisSupportFromFlow,
  compiledFlowSelectionNameForAxes,
  defaultChildCompiledFlowResolver,
  defaultFlowRoot,
  loadCompiledFlow,
  resolveCompiledFlowPath,
} from './compiled-flow-loading.js';
import { codexInstallAssurance } from './handoff-codex-hooks.js';
import {
  type PostRunArtifactContext,
  type PostRunArtifactWarning,
  emitPostRunArtifacts,
  postRunArtifactWarningOutputFields,
} from './post-run-artifacts.js';
import { createRecoveryAttemptRunner } from './recovery-attempt-runner.js';
import {
  invalidCheckpointChoiceMessage,
  matchCheckpointChoice,
  missingRunFolderMessage,
  runFolderCandidates,
} from './resume-input.js';
import { RUN_EXECUTION_FLAGS } from './run-flag-vocabulary.js';
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
import {
  checkpointWaitingNotice,
  runFinishedNotice,
  runStartedNotice,
  ttyNoticesEnabled,
} from './tty-notice.js';

const AUTONOMOUS_LOOP_RELATIVE_PATH = 'reports/autonomous-loop.json';

export interface ParsedArgs {
  command: 'run' | 'resume';
  flowName?: string;
  goal?: string;
  why?: string;
  axes: AxesValue;
  power?: PowerDialValue;
  powerProvided: boolean;
  processProvided: boolean;
  tournamentProvided: boolean;
  autonomousProvided: boolean;
  runFolder?: string;
  fixturePath?: string;
  flowRoot?: string;
  checkpointChoice?: string;
  checkpointResponse?: CheckpointReviewResponse;
  progress?: 'jsonl';
  includeUntrackedContent: boolean;
  // A prior crashed run's folder to reuse finished sub-run children from
  // (`--reuse-children-from`). Fresh-run only; resolved to an absolute path at
  // the run call site, like runFolder.
  reuseChildrenFrom?: string;
}

interface ResolvedCompiledFlowRoute {
  flowName: string;
  source: 'explicit';
  reason: string;
}

interface ResolvedEntryModeSelection {
  entryModeName?: string;
  source?: 'explicit' | 'derived';
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

function resumeCommandPrefix(hostKind: HostKindValue | undefined): string {
  return operatorSummaryResumeCommandPrefix({
    ...(hostKind === undefined ? {} : { hostKind }),
    pluginRoot: process.env.CIRCUIT_PLUGIN_ROOT,
    execPath: process.execPath,
    cliEntryPath: process.argv[1],
  });
}

// The flow names a misuse error may offer, derived from the catalog's
// visibility (the same source of truth as INTERNAL_FLOW_IDS) so an internal
// flow such as pursue is never advertised. Sorted to match the order the
// unknown-flow listing uses.
function publicFlowNameOffer(): string {
  return catalogFlowIds
    .filter((id) => !INTERNAL_FLOW_IDS.has(id))
    .sort()
    .join('|');
}

function runtimeHostKind(options: RunCommandOptions): HostKindValue | undefined {
  if (options.hostKind !== undefined) return options.hostKind;
  const raw = process.env[CIRCUIT_HOST_KIND_ENV];
  if (raw === undefined || raw.length === 0) return undefined;
  return HostKind.parse(raw);
}

// The option surface derives from RUN_EXECUTION_FLAGS so the parser, the
// help text, and the doc lint (tests/contracts/doc-command-claims.test.ts)
// can never disagree. Add new flags to the vocabulary, not here.
function addExecutionOptions(program: Command): Command {
  for (const row of RUN_EXECUTION_FLAGS) {
    program.option(row.valueHint === undefined ? row.flag : `${row.flag} ${row.valueHint}`);
  }
  return program;
}

export function parseExecutionArgs(command: 'run' | 'resume', argv: readonly string[]): ParsedArgs {
  const program = addExecutionOptions(new Command(`circuit ${command}`).argument('[flow-name]'));
  parseCommanderOrThrow(program, argv);

  const opts = program.opts<{
    goal?: string;
    why?: string;
    process?: string;
    power?: string;
    tournament?: boolean | string;
    autonomous?: boolean;
    runFolder?: string;
    fixture?: string;
    flowRoot?: string;
    checkpointChoice?: string;
    checkpointResponse?: string;
    progress?: string;
    dryRun?: boolean;
    includeUntrackedContent?: boolean;
    reuseChildrenFrom?: string;
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

  let depth: ProcessValue | undefined;
  const processProvided = opts.process !== undefined;
  if (opts.process !== undefined) {
    // Mirror the --power rejection below: a bad value gets one line naming
    // the valid values, never a raw schema-error dump.
    const parsedProcess = Process.safeParse(opts.process);
    if (!parsedProcess.success) {
      throw new Error(`--process must be one of ${Process.options.join(', ')}`);
    }
    depth = parsedProcess.data;
  }

  let power: PowerDialValue | undefined;
  const powerProvided = opts.power !== undefined;
  if (opts.power !== undefined) {
    const parsed = PowerDialSetting.safeParse(opts.power);
    if (!parsed.success) {
      throw new Error('--power must be one of auto, low, medium, high');
    }
    power = parsed.data;
  }

  const tournamentProvided = opts.tournament !== undefined;
  const tournament = tournamentProvided;

  let tournamentN: number | undefined;
  if (typeof opts.tournament === 'string') {
    const parsed = Number(opts.tournament);
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
  const checkpointResponseToken = opts.checkpointResponse;
  if (checkpointChoice !== undefined && checkpointResponseToken !== undefined) {
    throw new Error('use either --checkpoint-choice or --checkpoint-response, not both');
  }
  let checkpointResponse: CheckpointReviewResponse | undefined;
  if (checkpointResponseToken !== undefined) {
    if (checkpointResponseToken.length === 0) {
      throw new Error('--checkpoint-response requires a non-empty value');
    }
    try {
      checkpointResponse = decodeCheckpointReviewResponse(checkpointResponseToken);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : '';
      throw new Error(`--checkpoint-response is invalid${detail}`);
    }
  }
  const progress = opts.progress === 'jsonl' ? 'jsonl' : undefined;
  const includeUntrackedContent = opts.includeUntrackedContent === true;
  const reuseChildrenFrom = opts.reuseChildrenFrom;
  if (reuseChildrenFrom !== undefined && reuseChildrenFrom.length === 0) {
    throw new Error('--reuse-children-from requires a non-empty path');
  }

  if (command === 'resume' || checkpointChoice !== undefined || checkpointResponse !== undefined) {
    if (command !== 'resume') {
      throw new Error('checkpoint resume must use the `resume` subcommand');
    }
    // Collect every missing required flag so the operator can supply them all at
    // once. Throwing on the first missing flag forced a supply-one, rerun,
    // supply-the-next loop; both flags are listed together on the run's
    // checkpoints entry, so name both together here too.
    const missingResumeFlags: string[] = [];
    if (runFolder === undefined) missingResumeFlags.push('--run-folder');
    if (
      (checkpointChoice === undefined || checkpointChoice.length === 0) &&
      checkpointResponse === undefined
    ) {
      missingResumeFlags.push('--checkpoint-choice or --checkpoint-response');
    }
    if (missingResumeFlags.length > 0) {
      throw new Error(
        `checkpoint resume requires ${missingResumeFlags.join(' and ')}. Run \`circuit checkpoints\` to see the run folder and its checkpoint choices.`,
      );
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
    if (processProvided || tournamentProvided || autonomousProvided) {
      throw new Error(
        'checkpoint resume reuses the saved run axes; omit --process/--tournament/--autonomous',
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
    if (reuseChildrenFrom !== undefined) {
      throw new Error(
        'checkpoint resume continues this run in place; --reuse-children-from starts a fresh run that reuses children from a dead run folder, so omit it on resume',
      );
    }
  } else {
    // Launch-path mirror of the resume branch above: collect every missing
    // requirement into one message, so a bare `circuit run` does not reveal
    // the flow-name requirement only after --goal is supplied.
    const missingRunInputs: string[] = [];
    const runRemedies: string[] = [];
    if (flowName === undefined) {
      missingRunInputs.push('a flow name');
      runRemedies.push(`pass one of ${publicFlowNameOffer()} as the first argument`);
    }
    if (goal === undefined || goal.length === 0) {
      missingRunInputs.push('--goal');
      runRemedies.push('state the goal with a non-empty --goal');
    }
    if (missingRunInputs.length > 0) {
      throw new Error(
        `${missingRunInputs.join(' and ')} ${
          missingRunInputs.length > 1 ? 'are' : 'is'
        } required: ${runRemedies.join(' and ')}`,
      );
    }
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
    processProvided,
    tournamentProvided,
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
  if (checkpointResponse !== undefined) result.checkpointResponse = checkpointResponse;
  if (progress !== undefined) result.progress = progress;
  if (reuseChildrenFrom !== undefined) result.reuseChildrenFrom = reuseChildrenFrom;
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
  // deterministic classifier to guess one from the goal text. Defensive:
  // parseExecutionArgs already rejects a missing flow name on the CLI path,
  // and both messages derive the offer from the catalog's visibility.
  throw new Error(
    `a flow name is required: pass one of ${publicFlowNameOffer()} as the first argument`,
  );
}

function hasExplicitAxes(args: ParsedArgs): boolean {
  return args.processProvided || args.tournamentProvided || args.autonomousProvided;
}

// Path A: the power dial word derives process thoroughness when --process is
// absent. auto has no fixed tier of its own, so it derives medium — the same
// default-on tier the dial resolves to elsewhere when auto has no inference.
// Exported for characterization (cli-process-derivation.test.ts), same
// pattern as exitCodeForClosedOutcome below.
export function deriveProcessFromPower(setting: PowerDialResolution): ProcessValue {
  return setting.kind === 'fixed' ? setting.value : 'medium';
}

// A derived process is never a usage error: it clamps to the flow's allowed
// set (floor below the lowest allowed value, ceiling above the highest).
// Every flow allows medium, so a pinned single-value set (Review, Pursue)
// clamps any derived tier to that one value. Exported for characterization
// (cli-process-derivation.test.ts).
export function clampDerivedDepthToFlow(
  derived: ProcessValue,
  allowedDepths: readonly ProcessValue[],
): ProcessValue {
  if (allowedDepths.includes(derived)) return derived;
  const order = Process.options;
  const derivedIndex = order.indexOf(derived);
  const allowedIndices = allowedDepths.map((candidate) => order.indexOf(candidate));
  const minAllowed = Math.min(...allowedIndices);
  const maxAllowed = Math.max(...allowedIndices);
  const clampedIndex = Math.min(Math.max(derivedIndex, minAllowed), maxAllowed);
  const clamped = order[clampedIndex];
  if (clamped === undefined) {
    throw new Error(`internal error: unable to clamp process '${derived}' to allowed set`);
  }
  return clamped;
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

// Entry mode (thoroughness) names the run's tier on the operator surface. It
// comes from the axis flags (--process/--tournament/--autonomous) or — when
// only --power was given — from the tier the dial derived, never from goal
// text. A derived tier is named only when it lands off the flow default, so
// a bare run keeps the plain "Chose <flow>." line. finalAxes must be the
// post-derivation, post-clamp axes. Exported for characterization
// (cli-process-derivation.test.ts).
export function resolveEntryModeSelection(
  args: ParsedArgs,
  finalAxes: AxesValue,
): ResolvedEntryModeSelection {
  if (hasExplicitAxes(args)) {
    return {
      entryModeName: axisSelectionNameForAxes(args.axes),
      source: 'explicit',
      reason: 'explicit axis flags',
    };
  }
  if (args.power !== undefined) {
    const entryModeName = axisSelectionNameForAxes(finalAxes);
    if (entryModeName !== 'default') {
      return { entryModeName, source: 'derived', reason: 'derived from the power dial' };
    }
  }
  return {};
}

function progressSurfaceForFlowId(flowId: string) {
  return findFlowRuntimeSurfaceById(flowId)?.progress;
}

function axisAllowListText(flowId: string, support: AxisSupport): string {
  // Operator prose says "process" (the --process dial); "depth" is a retired
  // name (UBIQUITOUS_LANGUAGE.md) that stays internal-only.
  const allowedProcesses = support.allowedDepths.join(', ');
  return `${flowId} allows process: ${allowedProcesses}; tournament: ${support.supportsTournament ? 'yes' : 'no'}; autonomous: ${support.supportsAutonomous ? 'yes' : 'no'}`;
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
    throw new Error(`--process ${axes.depth} is not supported by flow '${flowId}'. ${allowList}`);
  }
  if (axes.tournament && !support.supportsTournament) {
    throw new Error(`--tournament is not supported by flow '${flowId}'. ${allowList}`);
  }
  if (axes.autonomous && !support.supportsAutonomous) {
    throw new Error(`--autonomous is not supported by flow '${flowId}'. ${allowList}`);
  }
}

// Resolve a dot path (e.g. 'flows.prototype.variant_models') across the
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
  const requirements = input.flow.required_config;
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

// args.axes.depth always carries the run's final process word by the time
// this runs, whether from an explicit --process or the power-derived,
// flow-clamped value resolved earlier in runExecutionCommand — so this reads
// it directly rather than falling back to the flow's own default.
function selectedDepth(
  _flow: CompiledFlow,
  args: ParsedArgs,
  _entryModeSelection: ResolvedEntryModeSelection,
): string {
  return runtimeDepthForAxes(args.axes);
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

// When resume is pointed at a runtime run folder that cannot be resumed, the
// internal rejection is project-internal jargon ("runtime checkpoint resume
// rejected: run has no unresolved checkpoint request"). Answer the operator in
// plain language keyed on the public run-status projection, and always point at
// the inspection front door so they have a next step.
function nonResumableRunMessage(runFolder: string): string {
  const inspect = `Inspect it with: circuit runs show --run-folder ${runFolder} --json`;
  let lead: string;
  try {
    const status = projectRunStatusFromRunFolder(runFolder);
    switch (status.engine_state) {
      case 'open':
        // Bootstrapped and stepping, but never reached a checkpoint. From a run
        // folder alone we cannot tell "still running elsewhere" from "crashed
        // mid-run", so name both honestly rather than guess.
        lead = `The run at ${runFolder} has no checkpoint to resume: it was interrupted before it reached one, or it is still running elsewhere.`;
        break;
      case 'waiting_checkpoint':
        // Defensive: a genuine checkpoint-waiting folder should have resumed, so
        // reaching here means resume rejected it for another reason. Stay honest.
        lead = `The run at ${runFolder} could not be resumed even though it is waiting at a checkpoint. Something about the saved checkpoint prevented it.`;
        break;
      case 'completed':
      case 'aborted':
        lead = `The run at ${runFolder} already finished (${status.terminal_outcome}), so there is no checkpoint to resume.`;
        break;
      default:
        lead = `The run folder at ${runFolder} is damaged (${status.reason}), so it cannot be resumed.`;
        break;
    }
  } catch (err) {
    // Projection itself can throw on a missing or unreadable folder. Keep the
    // operator message honest and still actionable.
    const detail = err instanceof RunStatusFolderError ? `: ${err.message}` : '';
    lead = `The run at ${runFolder} cannot be resumed and its status could not be read${detail}.`;
  }
  return `error: ${lead}\n${inspect}`;
}

// The projection is the public answer to "is this run genuinely waiting, and
// on what choices". Anything that stops it from answering (missing folder,
// damaged trace) returns undefined here and falls through to the existing
// honest rejection paths, so forgiveness never masks a real problem.
function waitingCheckpointStatus(runFolder: string): WaitingCheckpointStatus | undefined {
  try {
    const status = projectRunStatusFromRunFolder(runFolder);
    return status.engine_state === 'waiting_checkpoint' ? status.checkpoint : undefined;
  } catch {
    return undefined;
  }
}

export async function runResumeCommand(
  args: ParsedArgs,
  options: RunCommandOptions,
): Promise<number> {
  if (
    args.command === 'resume' &&
    args.runFolder !== undefined &&
    (args.checkpointChoice !== undefined || args.checkpointResponse !== undefined)
  ) {
    const candidates = runFolderCandidates(args.runFolder, process.cwd());
    let runFolder = candidates[0] ?? resolve(args.runFolder);
    for (const candidate of candidates) {
      if (await isRuntimeRunFolder(candidate)) {
        runFolder = candidate;
        break;
      }
    }
    const progress = progressReporter(args.progress === 'jsonl');
    const hostKind = runtimeHostKind(options);
    if (await isRuntimeRunFolder(runFolder)) {
      // CLI-boundary forgiveness: when the run is provably waiting, map a
      // label, a different case, or stray whitespace onto the canonical choice
      // id, and answer a real miss with the actual choices. The engine's
      // allow-list stays strict and unchanged.
      let selection = args.checkpointResponse?.selection ?? args.checkpointChoice;
      if (selection === undefined) return 2;
      const waiting = waitingCheckpointStatus(runFolder);
      if (waiting !== undefined) {
        const match = matchCheckpointChoice(selection, waiting.choices);
        const typedResponseIsNotExact =
          args.checkpointResponse !== undefined && match.kind !== 'exact';
        if (match.kind === 'no_match' || typedResponseIsNotExact) {
          process.stderr.write(
            `${invalidCheckpointChoiceMessage({
              attempted: selection,
              runFolder,
              checkpoint: waiting,
            })}\n`,
          );
          return 2;
        }
        if (args.checkpointResponse === undefined) selection = match.id;
      }
      let runtimeResult: Awaited<ReturnType<typeof resumeCompiledFlow>>;
      try {
        runtimeResult = await resumeCompiledFlow({
          runDir: runFolder,
          selection,
          ...(args.checkpointResponse === undefined
            ? {}
            : { checkpointResponse: args.checkpointResponse }),
          now: options.now ?? (() => new Date()),
          childCompiledFlowResolver: defaultChildCompiledFlowResolver(undefined),
          ...(hostKind === undefined ? {} : { hostKind }),
          ...(options.runtimeExecutors === undefined
            ? {}
            : { executors: options.runtimeExecutors }),
          ...(options.relayer === undefined ? {} : { relayer: options.relayer }),
          ...(progress === undefined ? {} : { progress }),
          progressSurfaceForFlowId,
        });
      } catch {
        // The folder is a runtime run folder but resume could not proceed: it
        // was interrupted before reaching a checkpoint, already finished, or the
        // saved checkpoint is damaged. The internal rejection is project-internal
        // jargon; answer the operator honestly from the public run-status
        // projection and point at the inspection front door instead.
        process.stderr.write(`${nonResumableRunMessage(runFolder)}\n`);
        return 2;
      }
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
            resumeCommandPrefix: resumeCommandPrefix(hostKind),
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
      if (ttyNoticesEnabled({ stream: process.stderr, progressJsonl: args.progress === 'jsonl' })) {
        process.stderr.write(runFinishedNotice({ outcome: runResult.outcome, runFolder }));
      }
      // Resume never runs the autonomous loop, but the resumed run's envelope can
      // still re-derive needs_attention (missing declared evidence), so honor it.
      return exitCodeForRun({
        outcome: runResult.outcome,
        envelopeOutcome: runEnvelope?.record.outcome,
      });
    }
    process.stderr.write(
      `${missingRunFolderMessage({ resolved: runFolder, exists: existsSync(runFolder) })}\n`,
    );
    return 2;
  }
  // Defensive fallback: parseExecutionArgs guarantees a resume command carries a
  // run folder and checkpoint choice, so this delegation is unreachable in
  // practice. It preserves the original control flow, where a malformed resume
  // fell through to the execution path's goal-undefined guard.
  return runExecutionCommand(args, options);
}

// The process exit code mirrors the closed outcome so scripts and agents
// wrapping the CLI can read the ending without parsing the envelope. The
// contract is grep-shaped: 0 means "you got the completed goal" (or the run
// is parked at a checkpoint waiting for you — reaching the decision point is
// the command succeeding), 1 means "the run closed short of complete"
// (aborted, stopped, escalated, handoff — a `&&` chain must never proceed on
// any of them), 2 stays usage errors. Deliberate closes share exit 1 with
// aborts on purpose: the exit code answers "did the work complete", and the
// envelope's outcome field carries the distinction for callers who need it.
// The Claude launcher renders deliberate closes without the failure line
// while propagating the exit (plugins/claude/scripts/circuit.ts).
// Exported for characterization (run-exit-codes.test.ts): the switch is
// exhaustive over RunClosedOutcome, so a new close outcome fails compile
// here and forces a deliberate exit-code decision instead of inheriting one.
export function exitCodeForClosedOutcome(outcome: RunClosedOutcome): number {
  switch (outcome) {
    case 'complete':
      return 0;
    case 'aborted':
    case 'stopped':
    case 'escalated':
    case 'handoff':
      return 1;
  }
}

// The exit code answers "did the work end in a good state?", which is richer
// than the closed outcome alone. Two independent signals can contradict a
// `complete` close, and the CLI must not report success over the run's own
// honest verdict:
//   1. The run envelope re-derives `needs_attention` when a `complete` run is
//      missing a declared evidence path (missingRunEvidence). So a run can close
//      `complete` (exit 0 by outcome) while its own envelope says otherwise.
//   2. When an autonomous continuation loop ran, the loop — not the primary
//      attempt — owns the completion decision (it may have recovered a primary
//      that closed needing attention, or exhausted one that closed complete).
// H1 fixes the specific Fix-degrades-to-`partial` case at the outcome level via
// the terminal-outcome bind; this is the general envelope-level floor for it.
export function exitCodeForRun(input: {
  readonly outcome: RunClosedOutcome;
  readonly envelopeOutcome?: RunEnvelopeOutcome | undefined;
  readonly autonomousLoopOutcome?: RunEnvelopeOutcome | undefined;
}): number {
  // A loop that ran is authoritative: its final verdict supersedes the primary
  // attempt's closed outcome.
  if (input.autonomousLoopOutcome !== undefined) {
    return input.autonomousLoopOutcome === 'complete' ? 0 : 1;
  }
  const base = exitCodeForClosedOutcome(input.outcome);
  if (base !== 0) return base;
  // The run closed `complete`. Honor the envelope's independently re-derived
  // outcome: anything short of `complete` must not report success.
  if (input.envelopeOutcome !== undefined && input.envelopeOutcome !== 'complete') {
    return 1;
  }
  return 0;
}

// Lists the flows an operator can actually name, from the same root the run
// path loads them from. Internal flows ship no host surface, so they stay out
// of the offer. Best-effort: an unreadable root just drops the listing.
// A root with no flows at all means the operator is running from a directory
// that is not a circuit checkout, so the message names where the CLI looked
// and how to point it somewhere real instead of offering an empty list.
function unknownFlowMessage(flowName: string, flowRoot: string | undefined): string {
  // Mirror resolveCompiledFlowPath's default so the message names the
  // directory the loader actually searched (package fallback included).
  const root = flowRoot !== undefined ? resolve(flowRoot) : defaultFlowRoot();
  let available: string[] = [];
  try {
    available = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'circuit.json')))
      .map((entry) => entry.name)
      .filter((name) => !INTERNAL_FLOW_IDS.has(name))
      .sort();
  } catch {
    available = [];
  }
  if (available.length === 0) {
    return [
      `error: no flow named '${flowName}' is installed.`,
      `No flows were found under ${root}.`,
      'Run circuit from the circuit checkout, or pass --flow-root <circuit checkout>/generated/flows.',
    ].join('\n');
  }
  return `error: no flow named '${flowName}' is installed.\nAvailable flows: ${available.join(', ')}`;
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
  // Path A: config discovery moves ahead of fixture/axis resolution because an
  // absent --process derives its value from the resolved power dial (config
  // layers + --power), and that derived value must be known before the
  // fixture/mode is selected below.
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

  // An explicit --process always wins. Absent one, the power dial word derives
  // process thoroughness (auto derives medium); the flow's allowed set clamps
  // it below once the flow itself is loaded.
  let axes = args.axes;
  if (!args.processProvided) {
    axes = Axes.parse({
      ...axes,
      depth: deriveProcessFromPower(resolvePowerDialSetting(selectionConfigLayers)),
    });
  }

  const fixtureSelectionName = compiledFlowSelectionNameForAxes(axes);
  const fixturePath = resolveCompiledFlowPath(
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
    if (INTERNAL_FLOW_IDS.has(route.flowName)) {
      process.stderr.write(
        `error: ${route.flowName} is an internal flow and is not available through the host run surface.\n`,
      );
      return 2;
    }
    // The operator asked for a flow by name, so the answer names flows: an
    // unknown name lists what this install actually has instead of leaking
    // the compiled-flow path on disk (audit finding 5). An explicit
    // --fixture-path override keeps the path-based error below.
    if (args.fixturePath === undefined) {
      process.stderr.write(`${unknownFlowMessage(route.flowName, args.flowRoot)}\n`);
      return 2;
    }
  }
  const { flow, bytes } = loadCompiledFlow(fixturePath);
  assertFixtureMatchesRoute(flow, route);
  // A derived (non-explicit) process clamps silently to the flow's supported
  // set (floor Prototype to medium, pin Review/Pursue to medium, no-op for
  // the full ladder); an explicit --process outside the set stays a usage
  // error, checked by validateFlowAxes below unchanged.
  if (!args.processProvided) {
    axes = Axes.parse({
      ...axes,
      depth: clampDerivedDepthToFlow(axes.depth, flow.axes.allowed_depths),
    });
  }
  // runArgs carries the run's final axes (explicit or power-derived and
  // flow-clamped) through the rest of the run: every downstream read of the
  // axes/depth must see this resolved value, not the pre-derivation args.
  const runArgs: ParsedArgs = axes === args.axes ? args : { ...args, axes };
  // Resolved after derivation+clamp so a power-derived tier is named on the
  // operator surface (status text, entry_mode fields) like an explicit one.
  const entryModeSelection = resolveEntryModeSelection(args, runArgs.axes);
  try {
    validateFlowAxes({ flow, args: runArgs, route, fixturePath });
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  const runId = RunId.parse(options.runId ?? randomUUID());
  const now = options.now ?? (() => new Date());
  const progress = progressReporter(runArgs.progress === 'jsonl');
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
    runArgs.runFolder === undefined
      ? join(runsRoot(process.cwd()), runId as unknown as string)
      : resolve(runArgs.runFolder);
  try {
    validateFlowConfigRequirements({ flow, axes: runArgs.axes, selectionConfigLayers });
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
    args: runArgs,
    route,
    entryModeSelection,
    fixturePath,
  });
  const runtimeDecisionDiagnostics = showRuntimeDecision();
  const defaultRuntimeSupport = applyComposeWriterPolicy(
    applyFixturePolicy(runtimeSupport, {
      args: runArgs,
      fixturePath,
    }),
    { hasComposeWriter: options.composeWriter !== undefined },
  );
  const routeToRuntime = defaultRuntimeSupport.kind === 'supported';

  const ttyNotices = ttyNoticesEnabled({
    stream: process.stderr,
    progressJsonl: runArgs.progress === 'jsonl',
  });

  if (routeToRuntime) {
    if (ttyNotices) {
      process.stderr.write(
        runStartedNotice({
          flowName: route.flowName,
          ...(entryModeSelection.entryModeName === undefined
            ? {}
            : { entryModeName: entryModeSelection.entryModeName }),
          runFolder,
        }),
      );
    }
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
      ...(runArgs.why === undefined ? {} : { why: runArgs.why }),
      now,
      projectRoot,
      childCompiledFlowResolver: defaultChildCompiledFlowResolver(runArgs.flowRoot),
      depth: selectedDepth(flow, runArgs, entryModeSelection),
      axes: runArgs.axes,
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
      ...(runArgs.includeUntrackedContent
        ? { evidencePolicy: { includeUntrackedFileContent: true } }
        : {}),
      ...(runArgs.reuseChildrenFrom === undefined
        ? {}
        : { reuseChildrenFrom: resolve(runArgs.reuseChildrenFrom) }),
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
          attempt: runtimeResult.checkpoint.attempt,
          request_path: runtimeResult.checkpoint.requestPath,
          request_sha256: runtimeResult.checkpoint.requestSha256,
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
        progressJsonl: runArgs.progress === 'jsonl',
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
            resumeCommandPrefix: resumeCommandPrefix(hostKind),
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
      if (ttyNotices) {
        process.stderr.write(
          checkpointWaitingNotice({
            runFolder,
            choices: waitingResult.checkpoint.allowed_choices,
            ...(operatorSummary?.htmlPath === undefined
              ? {}
              : { summaryHtmlPath: operatorSummary.htmlPath }),
          }),
        );
      }
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
      progressJsonl: runArgs.progress === 'jsonl',
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
          resumeCommandPrefix: resumeCommandPrefix(hostKind),
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
      runArgs.axes.autonomous === true &&
      processEvidence !== undefined &&
      runEnvelope !== undefined
    ) {
      const primaryProjection = processEvidence.projection;
      const contract = runEnvelope.record.goal_contract;
      const parentAxes = runArgs.axes;
      try {
        autonomousLoop = await runAutonomousContinuation({
          contract,
          primaryProcessId: flow.id,
          runFlow: createRecoveryAttemptRunner({
            primaryProjection,
            fixtureSelectionName,
            flowRoot: runArgs.flowRoot,
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
        if (runArgs.progress !== 'jsonl') {
          process.stderr.write(`warning: autonomous loop failed: ${message}\n`);
        }
        autonomousLoop = undefined;
      }
    }
    // Record the resolved axes on the envelope so a reader can audit which
    // depth/tournament/autonomous selection actually ran (F-M-1). entry_mode
    // collapses the three axes into one name; resolved_axes keeps them explicit.
    const resolvedAxes = runArgs.axes;
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
    if (ttyNotices) {
      process.stderr.write(runFinishedNotice({ outcome: runResult.outcome, runFolder }));
    }
    return exitCodeForRun({
      outcome: runResult.outcome,
      envelopeOutcome: runEnvelope?.record.outcome,
      autonomousLoopOutcome: autonomousLoop?.outcome,
    });
  }

  process.stderr.write(`error: unsupported runtime invocation: ${defaultRuntimeSupport.reason}\n`);
  return 2;
}
