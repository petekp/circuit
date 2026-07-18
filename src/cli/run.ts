import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';

import type { ExecutorRegistry } from '../runtime/executors/index.js';
import {
  type CheckpointResumeRejectedResult,
  isCheckpointResumeRejectedResult,
  isRuntimeRunFolder,
  resumeCompiledFlowResult,
} from '../runtime/run/checkpoint-resume.js';
import { runCompiledFlowWithWaiting } from '../runtime/run/compiled-flow-runner.js';
import {
  type GraphCheckpointWaitingResult,
  isGraphCheckpointWaitingResult,
} from '../runtime/run/graph-runner.js';
import { TraceStore } from '../runtime/trace/trace-store.js';
import { Axes, type Axes as AxesValue, TournamentN } from '../schemas/axes.js';
import type { CheckpointReviewResponse as CheckpointReviewResponseValue } from '../schemas/checkpoint-review-response.js';
import { type CompiledFlow, CompiledFlow as CompiledFlowSchema } from '../schemas/compiled-flow.js';
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
import type { RunStatusProjectionV1 } from '../schemas/run-status.js';
import type { CheckpointResolvedTraceEntry, RunClosedOutcome } from '../schemas/trace-entry.js';
import { type PowerDialResolution, resolvePowerDialSetting } from '../selection/power-tiers.js';

import { captureLocalCheckpointReviewAssets } from '../app/checkpoints/local-review-assets.js';
import {
  type CheckpointReviewSubmissionDecision,
  startLocalCheckpointReviewSession,
} from '../app/checkpoints/local-review-session.js';
import { prepareRunStartHistoryRecall } from '../app/history/run-start-recall.js';
import { operatorSummaryResumeCommandPrefix } from '../app/operator-summary/resume-command.js';
import {
  readPriorRoute,
  renderCheckpointReviewHtml,
  writeOperatorSummary,
} from '../app/operator-summary/writer.js';
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
import { verifyManifestSnapshotBytes } from '../shared/manifest-snapshot.js';
import { progressDisplay, progressPresentation } from '../shared/progress-output.js';
import type { ComposeWriterFn, RelayFn } from '../shared/relay-runtime-types.js';
import { checkpointAttemptResponsePath } from '../shared/run-file-paths.js';
import { resolveRunRelative } from '../shared/run-relative-path.js';
import {
  CheckpointResponseFileError,
  readCheckpointResponseFile,
} from './checkpoint-response-file.js';
import { openLocalCheckpointReview } from './checkpoint-review-open.js';
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
  checkpointResponse?: CheckpointReviewResponseValue;
  checkpointResponseFile?: string;
  checkpointReview?: boolean;
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
  /** Test or host seam; the default opens the explicit loopback review URL. */
  openCheckpointReview?: (url: string) => void;
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
    checkpointResponseFile?: string;
    checkpointReview?: boolean;
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
  const checkpointResponseFile = opts.checkpointResponseFile;
  const checkpointReview = opts.checkpointReview === true;
  const checkpointResponseInputs = [
    checkpointChoice !== undefined,
    checkpointResponseToken !== undefined,
    checkpointResponseFile !== undefined,
    checkpointReview,
  ].filter(Boolean).length;
  if (checkpointResponseInputs > 1) {
    throw new Error(
      'use only one of --checkpoint-review, --checkpoint-choice, --checkpoint-response, or --checkpoint-response-file',
    );
  }
  let checkpointResponse: CheckpointReviewResponseValue | undefined;
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
  if (checkpointResponseFile !== undefined && checkpointResponseFile.length === 0) {
    throw new Error('--checkpoint-response-file requires a non-empty path');
  }
  const progress = opts.progress === 'jsonl' ? 'jsonl' : undefined;
  const includeUntrackedContent = opts.includeUntrackedContent === true;
  const reuseChildrenFrom = opts.reuseChildrenFrom;
  if (reuseChildrenFrom !== undefined && reuseChildrenFrom.length === 0) {
    throw new Error('--reuse-children-from requires a non-empty path');
  }

  if (
    command === 'resume' ||
    checkpointChoice !== undefined ||
    checkpointResponse !== undefined ||
    checkpointResponseFile !== undefined ||
    checkpointReview
  ) {
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
      checkpointResponse === undefined &&
      checkpointResponseFile === undefined &&
      !checkpointReview
    ) {
      missingResumeFlags.push(
        '--checkpoint-review, --checkpoint-choice, --checkpoint-response, or --checkpoint-response-file',
      );
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
  if (checkpointResponseFile !== undefined) result.checkpointResponseFile = checkpointResponseFile;
  if (checkpointReview) result.checkpointReview = true;
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

type WaitingCheckpointRunStatus = Extract<
  RunStatusProjectionV1,
  { readonly engine_state: 'waiting_checkpoint' }
>;

function waitingCheckpointRunStatus(runFolder: string): WaitingCheckpointRunStatus | undefined {
  try {
    const status = projectRunStatusFromRunFolder(runFolder);
    return status.engine_state === 'waiting_checkpoint' ? status : undefined;
  } catch {
    return undefined;
  }
}

function checkpointResponseRejectionMessage(
  runFolder: string,
  rejection: CheckpointResumeRejectedResult,
): string | undefined {
  const retry = `Open the current checkpoint review page for ${runFolder} and export the review again.`;
  switch (rejection.code) {
    case 'checkpoint_response_wrong_run':
      return `error: This review belongs to a different run. ${retry}`;
    case 'checkpoint_response_wrong_step':
      return `error: This review belongs to a different checkpoint step in this run. ${retry}`;
    case 'checkpoint_response_stale_attempt':
      return `error: This review belongs to a stale checkpoint attempt. ${retry}`;
    case 'checkpoint_response_stale_request':
      return `error: This checkpoint request has changed since the review was exported. ${retry}`;
    case 'checkpoint_response_selection_mismatch':
      return `error: The selected choice in this review does not match the resume request. ${retry}`;
    case 'checkpoint_response_comment_choice_unavailable':
      return `error: A review comment refers to a choice that is no longer available. ${retry}`;
    default:
      return undefined;
  }
}

type ResumeRuntimeResult = Awaited<ReturnType<typeof resumeCompiledFlowResult>>;

function resumeRuntimeCheckpoint(input: {
  readonly runFolder: string;
  readonly selection: string;
  readonly checkpointResponse?: CheckpointReviewResponseValue;
  readonly options: RunCommandOptions;
  readonly hostKind: HostKindValue | undefined;
  readonly progress: ((event: ProgressEventValue) => void) | undefined;
}): Promise<ResumeRuntimeResult> {
  return resumeCompiledFlowResult({
    runDir: input.runFolder,
    selection: input.selection,
    ...(input.checkpointResponse === undefined
      ? {}
      : { checkpointResponse: input.checkpointResponse }),
    now: input.options.now ?? (() => new Date()),
    childCompiledFlowResolver: defaultChildCompiledFlowResolver(undefined),
    ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
    ...(input.options.runtimeExecutors === undefined
      ? {}
      : { executors: input.options.runtimeExecutors }),
    ...(input.options.relayer === undefined ? {} : { relayer: input.options.relayer }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    progressSurfaceForFlowId,
  });
}

function publicReviewRejection(
  runFolder: string,
  rejection: CheckpointResumeRejectedResult,
): CheckpointReviewSubmissionDecision {
  if (rejection.code === 'resume_in_progress') {
    return {
      status: 'rejected',
      terminal: false,
      code: 'resume_in_progress',
      publicMessage:
        'Another resume is already in progress. Wait for it to finish, then try again.',
    };
  }
  const detailed = checkpointResponseRejectionMessage(runFolder, rejection)?.replace(
    /^error:\s*/,
    '',
  );
  return {
    status: 'rejected',
    terminal: true,
    code: rejection.code ?? 'resume_rejected',
    publicMessage:
      detailed ??
      'Circuit could not continue this run. Inspect the current checkpoint, then try again.',
  };
}

function sameReviewComments(
  actual: unknown,
  expected: CheckpointReviewResponseValue['comments'],
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((value, index) => {
    const wanted = expected[index];
    if (
      wanted === undefined ||
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      return false;
    }
    const comment = value as Record<string, unknown>;
    const expectedKeys =
      wanted.scope === 'overall' ? ['body', 'scope'] : ['body', 'choice_id', 'scope'];
    return (
      Object.keys(comment).sort().join('\0') === expectedKeys.join('\0') &&
      comment.scope === wanted.scope &&
      comment.body === wanted.body &&
      (wanted.scope === 'overall' || comment.choice_id === wanted.choice_id)
    );
  });
}

function declaredCheckpointResponse(input: {
  readonly runFolder: string;
  readonly response: CheckpointReviewResponseValue;
  readonly manifestHash: string;
}):
  | {
      readonly canonicalPath: string;
      readonly attemptPath: string;
      readonly routeId: string;
    }
  | undefined {
  const snapshot = verifyManifestSnapshotBytes(input.runFolder);
  if (snapshot.hash !== input.manifestHash) return undefined;
  const bytes = Buffer.from(snapshot.bytes_base64, 'base64').toString('utf8');
  const flow = CompiledFlowSchema.parse(JSON.parse(bytes) as unknown);
  const step = flow.steps.find(
    (candidate) => candidate.id === input.response.step_id && candidate.kind === 'checkpoint',
  );
  if (step === undefined || step.kind !== 'checkpoint') return undefined;
  const responseRef = step.writes.response;
  if (responseRef === undefined) return undefined;
  const canonicalPath = responseRef;
  const policy = step.policy;
  const dynamicChoices = typeof policy === 'object' && policy !== null && 'choices_from' in policy;
  const routes = step.routes as Readonly<Record<string, unknown>>;
  const routeId = Object.hasOwn(routes, input.response.selection)
    ? input.response.selection
    : dynamicChoices && Object.hasOwn(routes, 'select')
      ? 'select'
      : dynamicChoices && Object.hasOwn(routes, 'pass')
        ? 'pass'
        : undefined;
  if (routeId === undefined) return undefined;
  return {
    canonicalPath,
    attemptPath: checkpointAttemptResponsePath(canonicalPath, input.response.attempt),
    routeId,
  };
}

function exactCheckpointResponseRecord(input: {
  readonly actual: unknown;
  readonly response: CheckpointReviewResponseValue;
  readonly routeId: string;
}): boolean {
  if (typeof input.actual !== 'object' || input.actual === null || Array.isArray(input.actual)) {
    return false;
  }
  const record = input.actual as Record<string, unknown>;
  const expectedKeys = [
    'resolution_source',
    'route_id',
    'schema_version',
    'selection',
    'step_id',
    ...(input.response.comments.length === 0 ? [] : ['comments']),
  ].sort();
  return (
    Object.keys(record).sort().join('\0') === expectedKeys.join('\0') &&
    record.schema_version === 1 &&
    record.step_id === input.response.step_id &&
    record.selection === input.response.selection &&
    record.route_id === input.routeId &&
    record.resolution_source === 'operator' &&
    (input.response.comments.length === 0
      ? record.comments === undefined
      : sameReviewComments(record.comments, input.response.comments))
  );
}

/**
 * Prove the normal checkpoint executor recorded exactly what the reviewer sent.
 * A fulfilled graph run is not enough: a later executor can close the run
 * without the checkpoint response ever reaching disk.
 */
export async function durableCheckpointReviewWasRecorded(
  runFolder: string,
  response: CheckpointReviewResponseValue,
): Promise<boolean> {
  try {
    const entries = await new TraceStore(runFolder).load();
    const bootstrap = entries[0];
    if (
      bootstrap?.kind !== 'run.bootstrapped' ||
      bootstrap.run_id !== response.run_id ||
      bootstrap.manifest_hash === undefined
    ) {
      return false;
    }
    const declared = declaredCheckpointResponse({
      runFolder,
      response,
      manifestHash: bootstrap.manifest_hash,
    });
    if (declared === undefined) return false;
    const resolved = entries.filter(
      (entry): entry is CheckpointResolvedTraceEntry =>
        entry.kind === 'checkpoint.resolved' &&
        entry.run_id === response.run_id &&
        entry.step_id === response.step_id &&
        entry.attempt === response.attempt,
    );
    if (resolved.length !== 1) return false;
    const [entry] = resolved;
    if (
      entry === undefined ||
      entry.selection !== response.selection ||
      entry.route_id !== declared.routeId ||
      entry.auto_resolved !== false ||
      entry.resolution_source !== 'operator' ||
      entry.response_path !== declared.canonicalPath ||
      entry.response_attempt_path !== declared.attemptPath ||
      entry.response_report_hash === undefined
    ) {
      return false;
    }

    const canonical = readFileSync(resolveRunRelative(runFolder, entry.response_path));
    const attempt = readFileSync(resolveRunRelative(runFolder, entry.response_attempt_path));
    if (!canonical.equals(attempt)) return false;
    const hash = createHash('sha256').update(attempt).digest('hex');
    if (hash !== entry.response_report_hash) return false;

    const canonicalBody = JSON.parse(canonical.toString('utf8')) as unknown;
    const attemptBody = JSON.parse(attempt.toString('utf8')) as unknown;
    return (
      exactCheckpointResponseRecord({
        actual: canonicalBody,
        response,
        routeId: declared.routeId,
      }) &&
      exactCheckpointResponseRecord({
        actual: attemptBody,
        response,
        routeId: declared.routeId,
      })
    );
  } catch {
    return false;
  }
}

async function checkpointReviewPersistenceDecision(
  runFolder: string,
  response: CheckpointReviewResponseValue,
): Promise<CheckpointReviewSubmissionDecision> {
  return (await durableCheckpointReviewWasRecorded(runFolder, response))
    ? { status: 'accepted' }
    : {
        status: 'rejected',
        terminal: true,
        code: 'checkpoint_review_not_persisted',
        publicMessage:
          'Circuit could not prove that this review reached the run record. Inspect the run before trying again.',
      };
}

function renderTrustedCheckpointReviewHtml(input: {
  readonly runFolder: string;
  readonly status: WaitingCheckpointRunStatus;
  readonly hostKind: HostKindValue | undefined;
}): ReturnType<typeof renderCheckpointReviewHtml> {
  const checkpoint = input.status.checkpoint;
  if (checkpoint.request_path === undefined || checkpoint.request_sha256 === undefined) {
    throw new Error('waiting checkpoint identity is incomplete');
  }
  const manifest = verifyManifestSnapshotBytes(input.runFolder);
  return renderCheckpointReviewHtml({
    runFolder: input.runFolder,
    runResult: {
      schema_version: 1,
      run_id: input.status.run_id,
      flow_id: input.status.flow_id,
      goal: input.status.goal,
      outcome: 'checkpoint_waiting',
      summary: `checkpoint '${checkpoint.step_id}' is waiting for an operator choice.`,
      trace_entries_observed: (input.status.last_event?.sequence ?? -1) + 1,
      manifest_hash: manifest.hash,
      checkpoint: {
        step_id: checkpoint.step_id,
        attempt: checkpoint.attempt,
        request_path: checkpoint.request_path,
        request_sha256: checkpoint.request_sha256,
        allowed_choices: checkpoint.choices.map((choice) => choice.id),
      },
    },
    resumeCommandPrefix: resumeCommandPrefix(input.hostKind),
  });
}

async function resumeThroughLocalReview(input: {
  readonly runFolder: string;
  readonly status: WaitingCheckpointRunStatus;
  readonly options: RunCommandOptions;
  readonly hostKind: HostKindValue | undefined;
  readonly progress: ((event: ProgressEventValue) => void) | undefined;
}): Promise<ResumeRuntimeResult | undefined> {
  const requestSha256 = input.status.checkpoint.request_sha256;
  if (requestSha256 === undefined) {
    process.stderr.write(
      'error: The waiting checkpoint is missing its request identity. Use `circuit checkpoints` to inspect the run.\n',
    );
    return undefined;
  }
  let rendered: ReturnType<typeof renderTrustedCheckpointReviewHtml>;
  try {
    rendered = renderTrustedCheckpointReviewHtml({
      runFolder: input.runFolder,
      status: input.status,
      hostKind: input.hostKind,
    });
  } catch {
    process.stderr.write(
      'error: Circuit could not regenerate the trusted checkpoint review page. Use an explicit --checkpoint-choice or --checkpoint-response-file fallback.\n',
    );
    return undefined;
  }

  let activeResume: Promise<ResumeRuntimeResult> | undefined;
  const checkpoint = input.status.checkpoint;
  let session: Awaited<ReturnType<typeof startLocalCheckpointReviewSession>>;
  try {
    const assets = captureLocalCheckpointReviewAssets({
      html: rendered.html,
      runFolder: input.runFolder,
      reviewAssets: rendered.reviewAssets,
      ...(rendered.projectRoot === undefined ? {} : { projectRoot: rendered.projectRoot }),
    });
    session = await startLocalCheckpointReviewSession({
      html: rendered.html,
      assets,
      identity: {
        runId: input.status.run_id,
        stepId: checkpoint.step_id,
        attempt: checkpoint.attempt,
        requestSha256,
      },
      allowedChoices: checkpoint.choices.map((choice) => choice.id),
      onSubmit: async (response) => {
        const expectedRoute = declaredCheckpointResponse({
          runFolder: input.runFolder,
          response,
          manifestHash: verifyManifestSnapshotBytes(input.runFolder).hash,
        })?.routeId;
        let markDurable: (() => void) | undefined;
        const durable = new Promise<void>((resolveDurable) => {
          markDurable = resolveDurable;
        });
        const resumeProgress = (event: ProgressEventValue): void => {
          if (
            event.type === 'step.completed' &&
            event.step_id === checkpoint.step_id &&
            event.attempt === checkpoint.attempt &&
            event.route_taken === expectedRoute &&
            event.failure_reason === undefined
          ) {
            markDurable?.();
          }
          input.progress?.(event);
        };
        const resumePromise = resumeRuntimeCheckpoint({
          runFolder: input.runFolder,
          selection: response.selection,
          checkpointResponse: response,
          options: input.options,
          hostKind: input.hostKind,
          progress: resumeProgress,
        });
        activeResume = resumePromise;

        try {
          return await Promise.race<CheckpointReviewSubmissionDecision>([
            durable.then(() => checkpointReviewPersistenceDecision(input.runFolder, response)),
            resumePromise.then(async (result) => {
              if (!isCheckpointResumeRejectedResult(result)) {
                return checkpointReviewPersistenceDecision(input.runFolder, response);
              }
              if (await durableCheckpointReviewWasRecorded(input.runFolder, response)) {
                return { status: 'accepted', continuation: 'failed' };
              }
              return publicReviewRejection(input.runFolder, result);
            }),
          ]);
        } catch {
          if (await durableCheckpointReviewWasRecorded(input.runFolder, response)) {
            return { status: 'accepted', continuation: 'failed' };
          }
          return {
            status: 'rejected',
            terminal: false,
            code: 'resume_failed',
            publicMessage:
              'Circuit could not continue this run. The review remains saved in this browser for manual recovery.',
          };
        }
      },
    });
  } catch {
    process.stderr.write(
      'error: Circuit could not start the local checkpoint review session. Use an explicit checkpoint response fallback.\n',
    );
    return undefined;
  }

  const reviewUrl = session.url;
  const now = input.options.now ?? (() => new Date());
  if (input.progress === undefined) {
    process.stderr.write(`Checkpoint review: ${reviewUrl}\n`);
  } else {
    input.progress(
      ProgressEvent.parse({
        schema_version: 1,
        type: 'checkpoint_review.ready',
        run_id: input.status.run_id,
        flow_id: input.status.flow_id,
        recorded_at: now().toISOString(),
        label: 'Checkpoint review is ready',
        display: {
          text: `Circuit: Review the checkpoint at ${reviewUrl}`,
          importance: 'major',
          tone: 'checkpoint',
        },
        presentation: {
          block_id: input.status.run_id,
          line_mode: 'append',
          status_text: `Review the checkpoint at ${reviewUrl}`,
        },
        step_id: checkpoint.step_id,
        attempt: checkpoint.attempt,
        review_url: reviewUrl,
      }),
    );
  }
  try {
    if (input.options.openCheckpointReview === undefined) {
      openLocalCheckpointReview(reviewUrl);
    } else {
      input.options.openCheckpointReview(reviewUrl);
    }
  } catch {
    // Opening is best effort. The exact URL was already surfaced above.
  }

  try {
    const settlement = await session.settled;
    const resumePromise = activeResume;
    if (resumePromise === undefined) {
      process.stderr.write('error: The review session finished without starting the saved run.\n');
      return undefined;
    }
    try {
      const result = await resumePromise;
      if (settlement.status === 'rejected') {
        process.stderr.write(
          'error: Circuit did not record this checkpoint review. Inspect the current run before trying again.\n',
        );
        return undefined;
      }
      if (isCheckpointResumeRejectedResult(result)) {
        process.stderr.write(
          'error: The checkpoint review was saved, but Circuit could not finish continuing the run. Inspect the run status before taking another action.\n',
        );
        return undefined;
      }
      return result;
    } catch {
      process.stderr.write(
        'error: The checkpoint review was saved, but Circuit could not finish continuing the run. Inspect the run status; the browser draft remains available for manual recovery.\n',
      );
      return undefined;
    }
  } finally {
    try {
      await session.waitForAcceptedReplay();
    } catch {
      // The bounded replay window is a delivery aid. Durable acceptance and
      // listener cleanup remain authoritative if reconciliation itself fails.
    }
    try {
      await session.close();
    } catch {
      // The review has already been handled. Listener cleanup must not hide
      // the durable run result from the operator.
    }
  }
}

function emitResumedCheckpointWaiting(input: {
  readonly runFolder: string;
  readonly priorStatus: WaitingCheckpointRunStatus | undefined;
  readonly runtimeResult: GraphCheckpointWaitingResult;
  readonly hostKind: HostKindValue | undefined;
  readonly progressJsonl: boolean;
  readonly now: () => Date;
}): number {
  const currentStatus = waitingCheckpointRunStatus(input.runFolder);
  const status = currentStatus ?? input.priorStatus;
  const manifestHash = verifyManifestSnapshotBytes(input.runFolder).hash;
  const waitingResult = {
    schema_version: 1 as const,
    run_id: RunId.parse(input.runtimeResult.runId),
    flow_id: CompiledFlowId.parse(input.runtimeResult.flowId),
    goal: status?.goal ?? 'Continue the saved run.',
    outcome: 'checkpoint_waiting' as const,
    summary: `checkpoint '${input.runtimeResult.checkpoint.stepId}' is waiting for an operator choice.`,
    trace_entries_observed: input.runtimeResult.traceEntriesObserved,
    manifest_hash: manifestHash,
    checkpoint: {
      step_id: input.runtimeResult.checkpoint.stepId,
      attempt: input.runtimeResult.checkpoint.attempt,
      request_path: input.runtimeResult.checkpoint.requestPath,
      request_sha256: input.runtimeResult.checkpoint.requestSha256,
      allowed_choices: input.runtimeResult.checkpoint.allowedChoices,
    },
  };
  const priorRoute = readPriorRoute(input.runFolder);
  const selectedProcess = selectedProcessFields({
    processId: waitingResult.flow_id,
    ...(priorRoute.routedBy === undefined ? {} : { routedBy: priorRoute.routedBy }),
    routerReason: priorRoute.routerReason ?? 'checkpoint resume',
  });
  const postRunArtifactWarnings: PostRunArtifactWarning[] = [];
  const postRunArtifactContext: PostRunArtifactContext = {
    progressJsonl: input.progressJsonl,
    warnings: postRunArtifactWarnings,
  };
  const { operatorSummary, runEnvelope } = emitPostRunArtifacts({
    context: postRunArtifactContext,
    runFolder: input.runFolder,
    operatorIntent: waitingResult.goal,
    recordedAt: input.now().toISOString(),
    selectedProcess,
    child: {
      kind: 'checkpoint_waiting',
      run_id: waitingResult.run_id,
      flow_id: waitingResult.flow_id,
      trace_entries_observed: waitingResult.trace_entries_observed,
      manifest_hash: waitingResult.manifest_hash,
      checkpoint: {
        step_id: waitingResult.checkpoint.step_id,
        request_path: waitingResult.checkpoint.request_path,
        allowed_choices: waitingResult.checkpoint.allowed_choices,
      },
    },
    writeOperatorSummary: () =>
      writeOperatorSummary({
        runFolder: input.runFolder,
        runResult: waitingResult,
        resumeCommandPrefix: resumeCommandPrefix(input.hostKind),
        route: {
          selectedFlow: waitingResult.flow_id,
          ...(priorRoute.routedBy === undefined ? {} : { routedBy: priorRoute.routedBy }),
          ...(priorRoute.routerReason === undefined
            ? {}
            : { routerReason: priorRoute.routerReason }),
        },
      }),
    buildProcessEvidenceProjection: () =>
      projectCheckpointWaitingProcessEvidence({
        runFolder: input.runFolder,
        runId: waitingResult.run_id,
        flowId: waitingResult.flow_id,
        traceEntriesObserved: waitingResult.trace_entries_observed,
        manifestHash: waitingResult.manifest_hash,
        checkpoint: {
          stepId: waitingResult.checkpoint.step_id,
          requestPath: waitingResult.checkpoint.request_path,
          allowedChoices: waitingResult.checkpoint.allowed_choices,
        },
      }),
    memoryContext: undefined,
  });
  const resumeRuntimeFields = showRuntimeDecision()
    ? { runtime_reason: RUNTIME_POLICY_REASONS.checkpointResume }
    : {};
  process.stdout.write(
    `${JSON.stringify(
      {
        schema_version: 1,
        run_id: waitingResult.run_id,
        flow_id: waitingResult.flow_id,
        run_folder: input.runFolder,
        outcome: waitingResult.outcome,
        trace_entries_observed: waitingResult.trace_entries_observed,
        ...resumeRuntimeFields,
        ...postRunArtifactWarningOutputFields(postRunArtifactWarnings),
        ...(operatorSummary === undefined ? {} : operatorSummaryOutputFields({ operatorSummary })),
        ...(runEnvelope === undefined ? {} : runEnvelopeOutputFields({ runEnvelope })),
        checkpoint: waitingResult.checkpoint,
      },
      null,
      2,
    )}\n`,
  );
  if (ttyNoticesEnabled({ stream: process.stderr, progressJsonl: input.progressJsonl })) {
    process.stderr.write(
      checkpointWaitingNotice({
        runFolder: input.runFolder,
        choices: waitingResult.checkpoint.allowed_choices,
        ...(operatorSummary?.htmlPath === undefined
          ? {}
          : { summaryHtmlPath: operatorSummary.htmlPath }),
      }),
    );
  }
  return 0;
}

export async function runResumeCommand(
  args: ParsedArgs,
  options: RunCommandOptions,
): Promise<number> {
  if (
    args.command === 'resume' &&
    args.runFolder !== undefined &&
    (args.checkpointChoice !== undefined ||
      args.checkpointResponse !== undefined ||
      args.checkpointResponseFile !== undefined ||
      args.checkpointReview === true)
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
      let checkpointResponse = args.checkpointResponse;
      if (checkpointResponse === undefined && args.checkpointResponseFile !== undefined) {
        try {
          checkpointResponse = readCheckpointResponseFile({
            argument: args.checkpointResponseFile,
            cwd: process.cwd(),
          });
        } catch (error) {
          const message =
            error instanceof CheckpointResponseFileError
              ? error.message
              : 'The checkpoint response file could not be read safely.';
          process.stderr.write(`error: ${message}\n`);
          return 2;
        }
      }
      const waitingRun = waitingCheckpointRunStatus(runFolder);
      let resumeResult: ResumeRuntimeResult;
      if (args.checkpointReview === true) {
        if (waitingRun === undefined) {
          process.stderr.write(`${nonResumableRunMessage(runFolder)}\n`);
          return 2;
        }
        const reviewed = await resumeThroughLocalReview({
          runFolder,
          status: waitingRun,
          options,
          hostKind,
          progress,
        });
        if (reviewed === undefined) return 2;
        resumeResult = reviewed;
      } else {
        // CLI-boundary forgiveness: when the run is provably waiting, map a
        // label, a different case, or stray whitespace onto the canonical
        // choice id. Typed responses stay exact.
        let selection = checkpointResponse?.selection ?? args.checkpointChoice;
        if (selection === undefined) return 2;
        const waiting = waitingRun?.checkpoint;
        if (waiting !== undefined) {
          const match = matchCheckpointChoice(selection, waiting.choices);
          const typedResponseIsNotExact =
            checkpointResponse !== undefined && match.kind !== 'exact';
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
          if (checkpointResponse === undefined) selection = match.id;
        }
        try {
          resumeResult = await resumeRuntimeCheckpoint({
            runFolder,
            selection,
            ...(checkpointResponse === undefined ? {} : { checkpointResponse }),
            options,
            hostKind,
            progress,
          });
        } catch {
          // Structured runtime rejections are handled below. An unexpected
          // throw still falls back to the public run-status projection.
          process.stderr.write(`${nonResumableRunMessage(runFolder)}\n`);
          return 2;
        }
      }
      if (isCheckpointResumeRejectedResult(resumeResult)) {
        const responseMessage = checkpointResponseRejectionMessage(runFolder, resumeResult);
        process.stderr.write(`${responseMessage ?? nonResumableRunMessage(runFolder)}\n`);
        return 2;
      }
      const runtimeResult = resumeResult.result;
      if (isGraphCheckpointWaitingResult(runtimeResult)) {
        return emitResumedCheckpointWaiting({
          runFolder,
          priorStatus: waitingRun,
          runtimeResult,
          hostKind,
          progressJsonl: args.progress === 'jsonl',
          now: options.now ?? (() => new Date()),
        });
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
