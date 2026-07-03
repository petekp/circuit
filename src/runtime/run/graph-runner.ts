// Runtime graph execution loop.
//
// Owns step advancement for one run folder: bootstrap trace, step attempts,
// recovery routes, checkpoint waiting, terminal closure, and result.json.
// Flow-specific behavior belongs in executors and flow registries; the runner
// only interprets the executable graph and appends durable trace entries.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SliceLoopEngineFlag, UntilLoopEngineFlag } from '../../flows/types.js';
import { composePolicyHardConstraints } from '../../policy/policy-envelope.js';
import type { Axes } from '../../schemas/axes.js';
import type { ChangeKindDeclaration, StandardChangeKind } from '../../schemas/change-kind.js';
import { computeManifestHash } from '../../schemas/manifest.js';
import type { RecoveryRouteBindingV0 } from '../../schemas/recovery-route-kind.js';
import type { Ref } from '../../schemas/ref.js';
import {
  clampPowerToBounds,
  createPowerInferenceChannel,
  extractPowerRecommendation,
  seedPowerInferenceFromTrace,
} from '../../selection/power-inference.js';
import { resolvePowerDialSetting } from '../../selection/power-tiers.js';
import { resolveDottedPath } from '../../shared/fanout-branch-template.js';
import { isProofPlanBlockedError } from '../../shared/proof-plan.js';
import { createUserSkillRegistry } from '../../shared/user-skill-registry.js';
import { dispatchSkillHooks } from '../../skill-hooks/dispatch.js';
import { createSkillHookInjectionChannel } from '../../skill-hooks/injection.js';
import { surfaceSourcesFromDeclarations } from '../../skill-hooks/surface-sources.js';
import { isAcceptanceRetryFeedback } from '../acceptance-criteria.js';
import type { RouteTarget } from '../domain/route.js';
import { isWaitingCheckpointStepOutcome } from '../domain/step.js';
import { type ExecutorRegistry, createDefaultExecutors } from '../executors/index.js';
import type { ExecutableFlow, ExecutableStep } from '../manifest/executable-flow.js';
import { buildRuntimePackageIndex } from '../manifest/runtime-package-index.js';
import { assertExecutableFlow } from '../manifest/validate-executable-flow.js';
import { resolveBindingLegibility } from './binding-legibility.js';
import type { RuntimeExecutionCapabilities } from './capabilities.js';
import { appendCarriedNote } from './carried-notes.js';
import type { CommitContainmentRunner } from './commit-containment.js';
import {
  type ContextDeliveryGuard,
  type DeliveredContextSlice,
  type RetryEvaluation,
  decideContextDeliveryOutcome,
} from './context-delivery.js';
import { type ContextPuller, type ContextRequest, extractContextRequest } from './context-pull.js';
import { resolveEngineFlags } from './engine-flags.js';
import { type EquipmentReshaper, extractEquipmentDiscovery } from './equipment-reshape.js';
import { FrozenEvalGuard } from './frozen-eval.js';
import { appendFlowSelectionGuidance, appendRecoveryRouteGuidance } from './guidance.js';
import { HonestyLedger } from './honesty-ledger.js';
import { writeRuntimeManifestSnapshot } from './manifest-snapshot.js';
import { recoveryBindingVerdict, recoveryCauseAllowed } from './recovery-binding-verdict.js';
import { RecoveryCorridor } from './recovery-corridor.js';
import { openRunBoundary } from './run-boundary.js';
import {
  type GraphClosedOutcome,
  type GraphRunResult,
  closeRun,
  completeCloseProofGap,
  outcomeForTerminal,
} from './run-close.js';
import type { RunContext } from './run-context.js';
import {
  classifyRouteDeclarationTransition,
  classifyRouteTargetTransition,
  isCompletedStepReentryAbort,
  isRouteTargetAbort,
} from './run-transition.js';
import { SliceCorridor } from './slice-corridor.js';
import {
  completedStepCountsFromTrace,
  latestRecoveryFailureEvidence,
  latestStepReportOrRelayRef,
  reportSelectedCheckpointBoundaryEvidence,
  seedSkillHookInjectionsFromTrace,
} from './trace-evidence.js';
import { evaluateUntilBudget } from './until-budget.js';
import { UntilCorridor, type UntilDisposition } from './until-corridor.js';

export interface GraphRunnerOptions extends RuntimeExecutionCapabilities {
  readonly runDir: string;
  readonly runId?: string;
  readonly goal?: string;
  readonly why?: string;
  readonly manifestHash?: string;
  readonly manifestBytes?: Uint8Array;
  // The live equipment reshaper. Present only on the live path
  // (compiled-flow-runner builds it once per run); when present, a confirmed
  // runtime equipment discovery re-equips the remaining relay steps and returns
  // a re-validated executable tail. Absent => reshape is inert and a discovery
  // downgrades to a finding. The compiled form and the per-run bound stay inside
  // this closure, so the runner only ever holds executable flows.
  readonly equipmentReshaper?: EquipmentReshaper;
  // The live context-pull channel — the typed-lookup sibling of the reshaper. A
  // FACTORY, not an instance: the seam builds a fresh puller for each step that
  // asks, so the query budget is per-step (one step's pulls never starve the
  // next). Present only on the live path (compiled-flow-runner passes
  // createContextPuller); when present, a relay that surfaces a typed
  // `context_request` has each named parent slice resolved and recorded in the
  // trace. Absent => the channel is inert and a request is ignored. Resolve-and-
  // record only: it never alters the run, so a run where no relay asks is
  // byte-identical with or without it.
  readonly contextPuller?: () => ContextPuller;
  // Pull-then-retry delivery — the value half of context-pull. Present only when
  // the live path opts in (`enableContextDelivery`). When present (and a puller
  // is too), a relay that surfaces a typed `context_request` has its answered
  // slices FOLDED into the envelope and the step RE-RUN ONCE on the enriched
  // context; the guard owns the per-run bound (one delivery per step, a global
  // cap). Absent => the resolve-and-record seam runs instead and a request is
  // recorded but not delivered (today's behavior). Requires `contextPuller`; on
  // its own it is inert.
  readonly contextDelivery?: ContextDeliveryGuard;
  readonly workContractRef?: Ref;
  readonly recoveryRouteBindings?: readonly RecoveryRouteBindingV0[];
  // Restart-cheapness pointer: a prior crashed run's folder whose finished
  // sub-run fanout branches a fresh run reuses instead of re-running. Threaded
  // onto RunContext; consumed by the fanout branch executor. Absent => inert.
  readonly reuseChildrenFrom?: string;
  readonly entryModeName?: string;
  readonly depth?: string;
  readonly axes?: Axes;
  // No operator present and no external resume driver — a checkpoint must reach
  // a terminal outcome rather than park. Threaded onto RunContext; see
  // RunContext.unattended and resolveCheckpoint.
  readonly unattended?: boolean;
  // Recursion bound. On a top-level run both are absent and the context seeds
  // depth 0 with the run's own flow id as the sole ancestor. On a child run the
  // sub-run executor forwards the parent's incremented depth and extended
  // ancestor chain, so the bound accumulates rather than resetting per run.
  readonly recursionDepth?: number;
  readonly recursionAncestors?: ReadonlySet<string>;
  readonly maxSteps?: number;
  // The until-loop stop-judge's evidence floor: returns true when the engine's
  // own evidence backs a goal-met claim. The dispose seam reads it ONLY when the
  // judge proposes done, to decide whether to honor a clean stop or block a
  // false-done. Absent => the default proof-gap floor (no open close-proof gap).
  // The seam injection keeps the loop policy offline-provable and is where the
  // honesty ledger's latch state composes in (slice 3).
  readonly untilEvidenceFloor?: (context: RunContext) => boolean;
  // The until-loop per-iteration commit-containment runner (slice 7, opt-in).
  // Present only when the host wires it in for a flow that declares
  // iterationCommitContainment. When BOTH are present, each completed iteration
  // is committed to a throwaway branch (the host constructs the runner over an
  // explicit project root, so the engine never reaches for ambient cwd). Absent
  // => the engine makes zero git calls and the loop runs uncontained as before.
  readonly commitContainmentRunner?: CommitContainmentRunner;
  readonly resumeCheckpoint?: {
    readonly stepId: string;
    readonly attempt: number;
    readonly selection: string;
  };
}

export interface GraphCheckpointWaitingResult {
  readonly kind: 'checkpoint_waiting';
  readonly outcome: 'checkpoint_waiting';
  readonly runFolder: string;
  readonly runId: string;
  readonly flowId: string;
  readonly traceEntriesObserved: number;
  readonly checkpoint: {
    readonly stepId: string;
    readonly attempt: number;
    readonly requestPath: string;
    readonly allowedChoices: readonly string[];
  };
}

export type GraphExecutionResult = GraphRunResult | GraphCheckpointWaitingResult;

export interface GraphRejectedOutcome {
  readonly kind: 'rejected';
  readonly outcome: 'rejected';
  readonly reason: string;
  readonly error: Error;
}

export type GraphExecutionOutcome =
  | GraphClosedOutcome
  | GraphCheckpointWaitingResult
  | GraphRejectedOutcome;

export function isGraphCheckpointWaitingResult(
  result: GraphExecutionResult | GraphExecutionOutcome,
): result is GraphCheckpointWaitingResult {
  return 'kind' in result && result.kind === 'checkpoint_waiting';
}

export function isGraphRejectedOutcome(
  result: GraphExecutionResult | GraphExecutionOutcome,
): result is GraphRejectedOutcome {
  return 'kind' in result && result.kind === 'rejected';
}

function defaultManifestHash(flow: ExecutableFlow): string {
  return `runtime:${flow.id}@${flow.version}`;
}

function routeTargetKey(target: RouteTarget): string {
  return target.kind === 'terminal' ? target.target : target.stepId;
}

function recoveryBindingForCompletedRoute(input: {
  readonly bindings: readonly RecoveryRouteBindingV0[] | undefined;
  readonly step: ExecutableStep;
  readonly route: string;
  readonly target: RouteTarget;
}): RecoveryRouteBindingV0 | undefined {
  return input.bindings?.find(
    (binding) =>
      binding.step_id === input.step.id &&
      binding.route_id === input.route &&
      binding.route_target === routeTargetKey(input.target),
  );
}

function hasRecoveryBindingForRoute(input: {
  readonly bindings: readonly RecoveryRouteBindingV0[] | undefined;
  readonly step: ExecutableStep;
  readonly route: string | undefined;
}): boolean {
  if (input.route === undefined) return false;
  const target = input.step.routes[input.route];
  if (target === undefined) return false;
  return (
    recoveryBindingForCompletedRoute({
      bindings: input.bindings,
      step: input.step,
      route: input.route,
      target,
    }) !== undefined
  );
}

function isRecoveryRouteForMechanics(input: {
  readonly bindings: readonly RecoveryRouteBindingV0[] | undefined;
  readonly step: ExecutableStep;
  readonly route: string | undefined;
}): boolean {
  if (input.bindings === undefined) return false;
  return hasRecoveryBindingForRoute(input);
}

function configuredMaxAttempts(step: ExecutableStep): number | undefined {
  const budgets = step.budgets;
  if (budgets === undefined || budgets === null || typeof budgets !== 'object') return undefined;
  const maxAttempts = (budgets as { readonly max_attempts?: unknown }).max_attempts;
  if (typeof maxAttempts !== 'number') return undefined;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return undefined;
  return maxAttempts;
}

function maxAttemptsForRoute(
  step: ExecutableStep,
  recoveryRoute: boolean,
  policyCap?: number,
): number {
  const routeMax = configuredMaxAttempts(step) ?? (recoveryRoute ? 2 : 1);
  // The per-repo policy max_attempts_per_step is an upper bound (a hard
  // constraint). Clamp the route's own ceiling down to it when present.
  return policyCap === undefined ? routeMax : Math.min(routeMax, policyCap);
}

function standardChangeKindDeclaration(
  changeKind: StandardChangeKind['change_kind'],
): ChangeKindDeclaration {
  return {
    change_kind: changeKind,
    failure_mode: 'runtime execution cannot produce required reports',
    acceptance_evidence: 'trace entries, reports, and result files satisfy their schemas',
    alternate_framing: 'start a fresh flow with a narrower goal',
  };
}

function bootstrapChangeKind(input: {
  readonly flow: ExecutableFlow;
  readonly entryModeName?: string;
}): ChangeKindDeclaration {
  const defaultKind =
    input.flow.entryModes?.find((mode) => mode.name === input.entryModeName)?.defaultChangeKind ??
    'ratchet-advance';
  if (
    defaultKind !== 'ratchet-advance' &&
    defaultKind !== 'equivalence-refactor' &&
    defaultKind !== 'discovery' &&
    defaultKind !== 'disposable'
  ) {
    return standardChangeKindDeclaration('ratchet-advance');
  }
  return standardChangeKindDeclaration(defaultKind);
}

// A slice loop re-enters its body once per slice. The resume path
// reconstructs slice progress from the trace, which only holds completed
// steps, so a checkpoint pausing mid-loop would lose the live slice index.
// Build's only checkpoint sits before the loop; this assertion keeps that
// true for any flow that opts into iteratesSliceLoop.
function assertNoCheckpointInSliceLoop(flow: ExecutableFlow, flag: SliceLoopEngineFlag): void {
  const steps = new Map(flow.steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  let cursor: string | undefined = flag.headStep;
  while (cursor !== undefined && !visited.has(cursor)) {
    visited.add(cursor);
    const step = steps.get(cursor);
    if (step === undefined) break;
    if (step.kind === 'checkpoint') {
      throw new Error(
        `slice loop body contains checkpoint step '${cursor}'; a checkpoint inside [${flag.headStep}..${flag.tailStep}] is not supported`,
      );
    }
    if (cursor === flag.tailStep) break;
    const forward = step.routes.continue ?? step.routes.pass;
    cursor = forward?.kind === 'step' ? forward.stepId : undefined;
  }
}

// Reject a malformed until-loop flag up front, before any step runs, so the
// operator sees a clear flag-config error rather than a misleading mid-loop
// abort. Two failure modes the engine cannot otherwise diagnose: a body step
// missing from bodySteps is not iteration-scoped, so it aborts as an illegal
// re-entry ("route cycle detected") on the second pass; and an undeclared
// reenterRoute surfaces as "selected undeclared route" only after a full body
// pass has already consumed worker budget. shouldReenter/advance key off
// headStep/tailStep directly while count-scoping keys off bodySteps membership,
// so this also asserts the two cannot disagree.
function assertUntilFlagCoherent(
  flow: ExecutableFlow,
  steps: ReadonlyMap<string, ExecutableFlow['steps'][number]>,
  flag: UntilLoopEngineFlag,
): void {
  const { headStep, tailStep, bodySteps, reenterRoute, maxIterations } = flag;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(
      `until loop on flow '${flow.id}' has maxIterations ${maxIterations}; it must be a positive integer`,
    );
  }
  const body = new Set(bodySteps);
  if (!body.has(headStep)) {
    throw new Error(
      `until loop on flow '${flow.id}' omits headStep '${headStep}' from bodySteps; the full [head..tail] span must be listed or the head aborts mid-loop as an illegal re-entry`,
    );
  }
  if (!body.has(tailStep)) {
    throw new Error(
      `until loop on flow '${flow.id}' omits tailStep '${tailStep}' from bodySteps; the full [head..tail] span must be listed or the tail aborts mid-loop as an illegal re-entry`,
    );
  }
  for (const id of bodySteps) {
    if (!steps.has(id)) {
      throw new Error(
        `until loop on flow '${flow.id}' lists bodyStep '${id}', which is not a declared step in the flow`,
      );
    }
  }
  const reenter = steps.get(tailStep)?.routes[reenterRoute];
  if (reenter === undefined) {
    throw new Error(
      `until loop on flow '${flow.id}' names reenterRoute '${reenterRoute}', but tail step '${tailStep}' declares no such route`,
    );
  }
  if (reenter.kind !== 'step' || reenter.stepId !== headStep) {
    throw new Error(
      `until loop on flow '${flow.id}' reenterRoute '${reenterRoute}' must target headStep '${headStep}' as a step route`,
    );
  }
  // Slice 2: a stop-judge loop disposes the tail's goal-met proposal, so it must
  // declare a separate exit for an exhausted run. Without it, the cap would have
  // nowhere honest to route and the loop could only exit through the clean-stop
  // forward route, which is the exact exhaustion-reads-as-success the loop
  // forbids. Require the route, that the tail declares it, and that it does not
  // resolve to @complete.
  if (flag.stopJudge !== undefined) {
    const { needsAttentionRoute } = flag;
    if (needsAttentionRoute === undefined) {
      throw new Error(
        `until loop on flow '${flow.id}' sets a stopJudge but no needsAttentionRoute; a judge-gated loop must declare where an exhausted run exits so the iteration cap cannot reach @complete`,
      );
    }
    const attention = steps.get(tailStep)?.routes[needsAttentionRoute];
    if (attention === undefined) {
      throw new Error(
        `until loop on flow '${flow.id}' names needsAttentionRoute '${needsAttentionRoute}', but tail step '${tailStep}' declares no such route`,
      );
    }
    if (attention.kind === 'terminal' && attention.target === '@complete') {
      throw new Error(
        `until loop on flow '${flow.id}' needsAttentionRoute '${needsAttentionRoute}' targets @complete; an exhausted judge-gated loop must exit to a non-complete terminal so exhaustion can never read as success`,
      );
    }
  }

  // Slices 4-6 (carried notes, the budget cap, the no-progress ceiling) are
  // evaluated only on the stop-judge tail seam; a count-driven loop never reads
  // them. Accepting one without a stopJudge would silently ignore a declared
  // spend cap (a fail-open of a safety bound), so reject the combination up front
  // the same way the needs-attention precondition above is gated.
  // frozenPaths joins this ladder: the guard is consulted only on the stop-judge
  // tail seam, and its latch lands in the honesty ledger, which exists only on a
  // judge-gated loop. A count-driven loop declaring frozenPaths would silently
  // ignore the freeze — a fail-open of a soundness bound — so reject it up front.
  if (flag.stopJudge === undefined) {
    const orphaned =
      flag.carriedNotes !== undefined
        ? 'carriedNotes'
        : flag.cumulativeUsdCap !== undefined
          ? 'cumulativeUsdCap'
          : flag.cumulativeTokenCap !== undefined
            ? 'cumulativeTokenCap'
            : flag.noProgressCeiling !== undefined
              ? 'noProgressCeiling'
              : flag.frozenPaths !== undefined
                ? 'frozenPaths'
                : undefined;
    if (orphaned !== undefined) {
      throw new Error(
        `until loop on flow '${flow.id}' sets ${orphaned} but no stopJudge; these bounds are read only on a judge-gated loop, so a count-driven loop would silently ignore them`,
      );
    }
  }
  // The no-progress ceiling counts unchanged progress markers, which only exist
  // when the judge writes one. Without stopJudge.progressPath the marker is never
  // recorded and the ceiling can never trip, so it would be silently unenforced.
  if (flag.noProgressCeiling !== undefined && flag.stopJudge?.progressPath === undefined) {
    throw new Error(
      `until loop on flow '${flow.id}' sets noProgressCeiling but no stopJudge.progressPath; without a progress marker to compare, the ceiling can never trip`,
    );
  }
}

// What the engine reads from the tail's judgment report each iteration. The
// goal-met boolean (slice 2) is disposed against the evidence floor; the lesson
// (slice 4) is carried verbatim into the next pass; the progress marker (slice
// 6) is compared for equality only. The engine never reads the goal text and
// never interprets the lesson or marker.
interface UntilJudgeReading {
  readonly goalProposed: boolean;
  readonly lesson: string | undefined;
  readonly progressMarker: unknown;
}

// Slice 2/4/6 stop-judge: read the tail relay's report once and pull the
// goal-met boolean, the carried lesson, and the opaque progress marker from it.
// A missing or unreadable judgment reads as "not done" with no lesson and no
// marker, so the loop re-enters or exhausts rather than stopping on an absent
// proposal. Reading once keeps the three reads on a single consistent snapshot.
async function readUntilJudgeReport(
  context: RunContext,
  stopJudge: NonNullable<UntilLoopEngineFlag['stopJudge']>,
): Promise<UntilJudgeReading> {
  try {
    const raw = await context.files.readJson(stopJudge.report);
    const goalProposed = resolveDottedPath(raw, stopJudge.goalMetPath) === true;
    const lessonValue =
      stopJudge.lessonPath === undefined ? undefined : resolveDottedPath(raw, stopJudge.lessonPath);
    const lesson = typeof lessonValue === 'string' ? lessonValue : undefined;
    const progressMarker =
      stopJudge.progressPath === undefined
        ? undefined
        : resolveDottedPath(raw, stopJudge.progressPath);
    return { goalProposed, lesson, progressMarker };
  } catch {
    return { goalProposed: false, lesson: undefined, progressMarker: undefined };
  }
}

// True when the most recent proof assessment on the run cannot back a clean
// close — its overall_status is not `proven` or it does not allow close. This is
// the until loop's "is the latest evidence red?" signal. The stop-judge consults
// it at the tail seam right after the iteration's verify step ran, so the latest
// proof.assessed is exactly this iteration's evidence. It catches the body-verify
// case that completeCloseProofGap misses: a run-verification body step routes to
// the judge (not @complete), so its proof_policy carries close_requires_proven:
// false and never opens a close gap — yet a red verify in the current iteration
// must still block the judge's goal-met claim. Absent any proof.assessed (a flow
// with no verification body, e.g. converge-proof) it returns false and the floor
// is unchanged.
function latestProofContradictsClose(context: RunContext): boolean {
  const entries = context.trace.getAll();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.kind !== 'proof.assessed') continue;
    return entry.overall_status !== 'proven' || entry.close_allowed !== true;
  }
  return false;
}

// The default evidence floor the stop-judge disposes a goal-met claim against:
// the engine honors the claim only when closing complete right now would have no
// proof gap, the latest proof assessment is not red, AND the honesty ledger holds
// no open overclaim latch. A flow that declares no close-proof requirement and
// runs no verification body has no proof gap and no proof assessment, so a
// met-claim stands on the judge alone there (converge-proof); the teeth come from
// flows that declare proof, run a real verification body, or leave an open latch.
// While a body step's overclaim is unresolved — or the current iteration's verify
// is red — the judge cannot clean-stop the loop, so it re-enters (or exhausts to
// needs-attention). The close path's finalize chokepoint is the matching backstop
// should a clean stop ever be reached with a latch still open.
function defaultUntilEvidenceFloor(context: RunContext): boolean {
  if (context.honestyLedger?.hasOpenLatches() === true) return false;
  if (latestProofContradictsClose(context)) return false;
  return completeCloseProofGap(context) === undefined;
}

function resolveManifestHash(flow: ExecutableFlow, options: GraphRunnerOptions): string {
  if (options.manifestBytes === undefined) {
    return options.manifestHash ?? defaultManifestHash(flow);
  }
  const computed = computeManifestHash(options.manifestBytes);
  if (options.manifestHash !== undefined && options.manifestHash !== computed) {
    throw new Error('manifest bytes hash differs from run manifest_hash');
  }
  return computed;
}

async function executeExecutableFlowOutcomeUnsafe(
  flow: ExecutableFlow,
  options: GraphRunnerOptions,
): Promise<GraphExecutionOutcome> {
  assertExecutableFlow(flow);
  const isResume = options.resumeCheckpoint !== undefined;
  // Slice 1 does not support resuming an until-loop run. completedStepCountsFromTrace
  // rebuilds counts from the slice corridor only, and until-body steps persist no
  // per-iteration index in the trace, so a resumed until run would silently restart
  // from iteration 0 and re-spend a full iteration budget. Fence it loudly here,
  // before the run boundary opens; crash-durable until-loop resume lands with the
  // honesty-ledger slice. resolveEngineFlags(flow) returns flow.engineFlags, so
  // reading the flag directly here is equivalent to the later engineFlags binding.
  if (isResume && flow.engineFlags?.iteratesUntilCondition !== undefined) {
    throw new Error(
      `flow '${flow.id}' cannot resume an until-loop run: per-iteration counts are not yet persisted, so the loop would restart from iteration 0. Until-loop resume is deferred to the honesty-ledger slice.`,
    );
  }
  const runId = options.runId ?? randomUUID();
  const boundary = await openRunBoundary({
    runDir: options.runDir,
    isResume,
    runId,
    flow,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.progress === undefined ? {} : { progress: options.progress }),
    ...(options.progressSurface === undefined ? {} : { progressSurface: options.progressSurface }),
  });
  const runDir = boundary.runDirectory.path;
  const { existingTrace, files, trace } = boundary;
  const packageIndex = buildRuntimePackageIndex(flow);
  // First-class composition (M4): record which catalog-sourced bindings this run
  // got from its manifest. The by-id package is gone, so the manifest is the sole
  // source; `manifestBackedBindings` reports what the flow declares and the
  // reduced set stays empty until composed flows bring a needs model (M9).
  const bindingLegibility = resolveBindingLegibility(flow);
  // First-class composition (M4): engine-visible flags and the edit-file surface
  // table read off the runtime flow's manifest. A composed flow resolves both the
  // same way a built-in does, with no by-id package in the path.
  const engineFlags = resolveEngineFlags(flow);
  const editFileSurfaceSources = surfaceSourcesFromDeclarations(flow.reportFileSurfaces ?? {});
  // The honesty ledger backs the judge-gated until loop only. A stop-judge loop
  // can recover from a body-step overclaim by latching it and re-entering rather
  // than aborting; the ledger holds those open latches for the evidence floor
  // and the close-path finalize chokepoint. Created (and given a durable
  // run-folder mirror) only when an until flag with a stopJudge is present; the
  // slice-1 count-driven loop and every non-until run carry no ledger and are
  // unaffected. It stays empty until a body step actually overclaims, so a run
  // that never overclaims writes no ledger file.
  const honestyLedger =
    engineFlags?.iteratesUntilCondition?.stopJudge !== undefined
      ? new HonestyLedger({ path: join(runDir, 'honesty-ledger.json') })
      : undefined;
  const context: RunContext = {
    flow,
    packageIndex,
    runId,
    runDir,
    goal: options.goal ?? `Run ${flow.id}`,
    ...(options.why === undefined || options.why.length === 0 ? {} : { why: options.why }),
    manifestHash: resolveManifestHash(flow, options),
    ...(options.workContractRef === undefined ? {} : { workContractRef: options.workContractRef }),
    ...(options.recoveryRouteBindings === undefined
      ? {}
      : { recoveryRouteBindings: options.recoveryRouteBindings }),
    ...(options.reuseChildrenFrom === undefined
      ? {}
      : { reuseChildrenFrom: options.reuseChildrenFrom }),
    ...(options.entryModeName === undefined ? {} : { entryModeName: options.entryModeName }),
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.axes === undefined ? {} : { axes: options.axes }),
    ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
    // Seed the recursion bound. A top-level run starts at depth 0 with itself as
    // the only ancestor; a child run inherits the forwarded depth and chain. The
    // sub-run executor and the fanout sub-run branch read these to enforce the
    // cap and the cycle guard. Two invariants protect this bound:
    //   - The ancestor chain is a Set, forwarded in-process by reference. It must
    //     never cross a JSON or disk boundary (a Set stringifies to `{}` and the
    //     guard would go dark). It is intentionally absent from every report and
    //     trace schema; keep it that way.
    //   - Any path that spawns a child run must thread these through, or the
    //     child re-seeds to depth 0 and the bound stops accumulating. Recovery
    //     attempts and standalone resume deliberately do NOT thread them — each
    //     is a fresh top-level run whose own descent is capped independently.
    recursionDepth: options.recursionDepth ?? 0,
    recursionAncestors: options.recursionAncestors ?? new Set([flow.id]),
    now: boundary.clock.now,
    files,
    trace,
    externalFiles: options.externalFiles ?? boundary.externalFiles,
    // Created once for the whole run and shared by every per-step stepContext
    // spread below, so the post-step skill-hook actuator can record an `auto`
    // event's skills and the next relay step picks them up. Empty on runs with
    // no skill_hooks config, so it has no observable effect there.
    skillHookInjections: createSkillHookInjectionChannel(),
    // Run-scoped auto-power resolution, same lifecycle as the injection
    // channel: created once, written at most once by the post-step seam,
    // read by relay planning. Inert when the dial setting is not `auto`.
    powerInference: createPowerInferenceChannel(),
    // One filesystem snapshot of the user skill registry for the whole run,
    // shared by the skill-hook dispatcher and the relay skill loader so they
    // never disagree about which skills resolve (see RunContext.skillRegistry).
    skillRegistry: createUserSkillRegistry(),
    ...(options.childCompiledFlowResolver === undefined
      ? {}
      : { childCompiledFlowResolver: options.childCompiledFlowResolver }),
    ...(options.childRunner === undefined ? {} : { childRunner: options.childRunner }),
    ...(options.childExecutors === undefined ? {} : { childExecutors: options.childExecutors }),
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    ...(options.evidencePolicy === undefined ? {} : { evidencePolicy: options.evidencePolicy }),
    ...(options.worktreeRunner === undefined ? {} : { worktreeRunner: options.worktreeRunner }),
    ...(options.relayConnector === undefined ? {} : { relayConnector: options.relayConnector }),
    ...(options.relayer === undefined ? {} : { relayer: options.relayer }),
    ...(options.hostKind === undefined ? {} : { hostKind: options.hostKind }),
    ...(options.selectionConfigLayers === undefined
      ? {}
      : { selectionConfigLayers: options.selectionConfigLayers }),
    guidanceSelection: {
      bindsExecutionDepthToGuidanceSelection:
        engineFlags?.bindsExecutionDepthToRelaySelection === true,
    },
    ...(options.policyLayers === undefined ? {} : { policyLayers: options.policyLayers }),
    ...(options.progress === undefined ? {} : { progress: options.progress }),
    ...(options.memoryInputs === undefined ? {} : { memoryInputs: options.memoryInputs }),
    ...(options.historyRecallReport === undefined
      ? {}
      : { historyRecallReport: options.historyRecallReport }),
    ...(options.historyRecallPrecision === undefined
      ? {}
      : { historyRecallPrecision: options.historyRecallPrecision }),
    ...(options.resumeCheckpoint === undefined
      ? {}
      : { resumeCheckpoint: options.resumeCheckpoint }),
    ...(honestyLedger === undefined ? {} : { honestyLedger }),
  };
  // The composed per-repo policy caps how many attempts any one step may take
  // (max_attempts_per_step is a hard upper bound). Compose it once per run and
  // clamp every step's route ceiling to it below. No policy layers means no cap
  // and no behavior change.
  const policyLayersForAttemptCap = context.policyLayers ?? [];
  const policyMaxAttemptsCap =
    policyLayersForAttemptCap.length === 0
      ? undefined
      : composePolicyHardConstraints(policyLayersForAttemptCap.map((layer) => layer.envelope))
          .limits.max_attempts_per_step;
  const executors: ExecutorRegistry = {
    ...createDefaultExecutors({
      ...(options.relayConnector === undefined ? {} : { relayConnector: options.relayConnector }),
    }),
    ...options.executors,
  };
  const steps = new Map(flow.steps.map((step) => [step.id, step]));
  const sliceFlag = engineFlags?.iteratesSliceLoop;
  if (sliceFlag !== undefined) {
    assertNoCheckpointInSliceLoop(flow, sliceFlag);
  }
  const sliceCorridor = new SliceCorridor({
    flag: sliceFlag,
    depth: context.depth,
    readSlices: async () => {
      if (sliceFlag === undefined) return [];
      try {
        const raw = await files.readJson(sliceFlag.slicesFrom.report);
        const items = resolveDottedPath(raw, sliceFlag.slicesFrom.itemsPath);
        return Array.isArray(items) ? items : [];
      } catch {
        return [];
      }
    },
  });
  const untilFlag = engineFlags?.iteratesUntilCondition;
  if (untilFlag !== undefined && sliceFlag !== undefined) {
    // Both drive a single re-entry counter; a flow opts into at most one loop
    // shape. A nested slice+until loop would need two independent iteration
    // indices, which the completedStepCounts key model does not support.
    throw new Error(
      `flow '${flow.id}' sets both iteratesSliceLoop and iteratesUntilCondition; a flow may use at most one loop shape`,
    );
  }
  if (untilFlag !== undefined) {
    assertUntilFlagCoherent(flow, steps, untilFlag);
  }
  const untilCorridor = new UntilCorridor({ flag: untilFlag, depth: context.depth });
  // The frozen-eval guard (opt-in, default off). Constructed ONCE here — before
  // the body loop runs its first step — so the baseline fingerprints predate any
  // act edit. Built only when the flow declares a non-empty frozenPaths AND a
  // project root is threaded; absent either, the guard is undefined and the tail
  // seam makes zero fs reads (byte-identical default path). The guard is pure of
  // engine types and resolves every path against this explicit root, never cwd.
  const frozenEvalGuard =
    untilFlag?.frozenPaths !== undefined &&
    untilFlag.frozenPaths.length > 0 &&
    options.projectRoot !== undefined
      ? new FrozenEvalGuard(options.projectRoot, untilFlag.frozenPaths)
      : undefined;
  // On-demand context-pull delivery is "active" for this run's relays when
  // delivery is opted in AND this run is not a delivery-blind slice corridor.
  // Inside a corridor (deep depth) the delivery seam skips the head step
  // (delivery-in-corridor stays deferred), so a relay there could not recover a
  // withheld slice — a compose writer must NOT thin its envelope in that case.
  // Both operands are run-wide constants, so this is too: a stable signal a
  // compose writer keys its envelope thickness on. False on every run with
  // delivery off (the default), keeping those runs byte-identical.
  const contextDeliveryActive = options.contextDelivery !== undefined && !sliceCorridor.isActive();
  // completedStepCountsFromTrace rebuilds counts for the slice corridor only.
  // Until-body steps persist no per-iteration index in the trace, so their
  // counts cannot be rebuilt here; that is why an until-loop resume is fenced
  // off up front (see the isResume guard near the top of this function) and
  // lands properly with the honesty-ledger slice.
  const completedStepCounts = isResume
    ? completedStepCountsFromTrace(existingTrace, sliceCorridor)
    : new Map<string, number>();
  // Re-seed skill-hook injections that the prior process recorded, so a resumed
  // implementer step does not silently run without skills an earlier (and now
  // un-re-executed) step injected. No-op on a fresh run (empty existingTrace).
  if (isResume) {
    seedSkillHookInjectionsFromTrace(existingTrace, context.skillHookInjections);
    // Same for the auto-power resolution: a resumed run continues at the tier
    // the prior process recorded instead of re-inferring (or worse, falling
    // back to medium after the researcher step was checkpointed past).
    seedPowerInferenceFromTrace(existingTrace, context.powerInference);
    // A live equipment reshape (Step 2) honored before the checkpoint is the
    // third thing the prior process recorded that a resumed run must re-apply —
    // but unlike the two channels above, it lives in the FLOW, not a runtime
    // channel, so it is reseeded one level up where the flow is rebuilt:
    // checkpoint-resume.ts replays it via seedEquipmentReshapeFromTrace before
    // building the executable this runner walks. By the time we are here the flow
    // already carries the injected equipment, so there is nothing to reseed at
    // this seam. (The reshape is additive — no step id, route, or boundary
    // changes — which is why it can ride on the rebuilt flow without a structural
    // splice; that remains Step 3, out of scope.)
  }
  const defaultMaxSteps = Math.max(flow.steps.length * 4, 8);
  // A slice or until loop runs the body once per iteration, each step with its
  // own retry budget, so the flat step counter needs headroom the single-pass
  // default lacks. The two loop shapes are mutually exclusive, so at most one
  // term is non-zero; a default run adds nothing and keeps defaultMaxSteps.
  // maxSteps is only the runaway backstop here — the until loop's real bound is
  // maxIterations (enforced by the corridor), so generous headroom is harmless.
  const maxSteps =
    options.maxSteps ??
    defaultMaxSteps +
      (sliceFlag !== undefined && sliceCorridor.isActive() ? sliceFlag.maxSlices * 6 : 0) +
      (untilFlag !== undefined && untilCorridor.isActive()
        ? untilFlag.maxIterations * untilFlag.bodySteps.length * 4
        : 0);

  const bootstrapRecordedAt = context.now().toISOString();
  if (!isResume && options.manifestBytes !== undefined) {
    await writeRuntimeManifestSnapshot({
      runDir,
      runId,
      flowId: flow.id,
      capturedAt: bootstrapRecordedAt,
      bytes: options.manifestBytes,
    });
  }

  if (!isResume) {
    await trace.append({
      run_id: runId,
      kind: 'run.bootstrapped',
      recorded_at: bootstrapRecordedAt,
      flow_id: flow.id,
      goal: context.goal,
      manifest_hash: context.manifestHash,
      depth: context.depth ?? 'medium',
      change_kind: bootstrapChangeKind({
        flow,
        ...(context.entryModeName === undefined ? {} : { entryModeName: context.entryModeName }),
      }),
      // Empty for every built-in (the manifest is the sole authority post-M4);
      // omitted entirely when empty so a run that reduced nothing makes no claim.
      // A composed flow with a needs model (M9) can populate it again.
      ...(bindingLegibility.reducedBindings.length === 0
        ? {}
        : { reduced_bindings: bindingLegibility.reducedBindings }),
    });
    await appendFlowSelectionGuidance(context);
    if (options.historyRecallReport !== undefined) {
      await context.files.writeJson('reports/history/recall.json', options.historyRecallReport);
    }
    // Slice 3: the earned-precision audit sidecar mirrors the recall report on the
    // same runtime write path, so file ownership is not split between CLI and
    // runtime (circuit.ts only threads the data in; the runtime writes it).
    if (options.historyRecallPrecision !== undefined) {
      await context.files.writeJson(
        'reports/history/recall-precision.json',
        options.historyRecallPrecision,
      );
    }
  }

  let currentStepId = options.resumeCheckpoint?.stepId ?? flow.entry;
  let incomingRouteTaken: string | undefined;
  // Slice 7: tracks whether the throwaway containment branch has been created
  // yet. Lazily begun on the first iteration commit so the branch roots at the
  // pre-loop HEAD. Inert unless the flag and an injected runner are both present.
  let commitContainmentBegun = false;
  // Slice 7 helper: contain one completed iteration as a single commit on the
  // throwaway branch. Begun lazily on the first call so the branch roots at the
  // pre-loop HEAD. Inert (zero git calls) unless the flag AND an injected runner
  // are both present, so the default path stays byte-identical. Called from the
  // tail seam for iterations that converge or re-enter cleanly, AND from the
  // abort-intercept exits so an iteration that ends by retry-exhaustion is
  // contained too — the branch history stays one-to-one with iterations and a
  // stopped run still contains its final pass.
  const containIteration = async (iterationIndex: number, message: string): Promise<void> => {
    if (
      untilFlag?.iterationCommitContainment === undefined ||
      options.commitContainmentRunner === undefined
    ) {
      return;
    }
    if (!commitContainmentBegun) {
      await options.commitContainmentRunner.begin({
        branchName: `${untilFlag.iterationCommitContainment.branchPrefix}-${runId}`,
      });
      commitContainmentBegun = true;
    }
    await options.commitContainmentRunner.commitIteration({ iterationIndex, message });
  };
  const recoveryRouteBindings =
    options.recoveryRouteBindings ?? (options.workContractRef === undefined ? undefined : []);
  const corridor = new RecoveryCorridor({
    steps,
    bindings: recoveryRouteBindings,
    routeHasRecoveryMechanics: ({ step, route }) =>
      isRecoveryRouteForMechanics({ bindings: recoveryRouteBindings, step, route }),
    latestStepReportOrRelayRef: ({ stepId, attempt }) =>
      latestStepReportOrRelayRef({ context, stepId, attempt }),
  });
  // Reseed the recovery-corridor's structural identity from the durable trace,
  // mirroring the skill-hook / power-inference reseeds above. Inert today: the
  // only resume entrypoint is a checkpoint boundary, which is never inside an
  // open corridor, so `existingTrace` replays to no active corridor. This is
  // plumbing ahead of a Tier-2 cursor that resumes at an arbitrary
  // step.completed; see docs/ideas/durability-tier2-cursor-spec.md (the
  // executor-outcome payload — reason / acceptance feedback — is NOT in the
  // trace and is the spec line for that cursor). No-op on a fresh run.
  if (isResume) {
    corridor.seedFromTrace(existingTrace);
  }
  // Step 2 — the live equipment reshape. A confirmed runtime equipment discovery
  // can re-equip the remaining relay steps mid-run; when that happens the active
  // flow, its package index, and the steps map are swapped for the re-validated
  // executable tail the reshaper returns. These start as the loaded flow and only
  // change on an honored reshape, so a run that never reshapes is byte-identical
  // to before. The reshaper (when present) owns the compiled form and the per-run
  // bound; absent it, the whole reshape is inert.
  let activeFlow = flow;
  let activePackageIndex = packageIndex;

  // Shared resolve-and-record for the typed-lookup channel. Both context-pull
  // seams use it, so a recorded `run.context-pull` entry is identical whether the
  // run only records (delivery off) or goes on to deliver (delivery on). For each
  // query it materializes the named parent's typed report, resolves the one named
  // slice through a fresh per-step puller (which owns the budget and the
  // everything-refusal), records the answer-or-finding, and returns the answered
  // slices for the caller to fold in. A fresh puller per call keeps the budget
  // per-step. Returns [] when no puller is configured.
  const resolveAndRecordContextPull = async (input: {
    readonly stepId: string;
    readonly request: ContextRequest;
  }): Promise<DeliveredContextSlice[]> => {
    const factory = options.contextPuller;
    if (factory === undefined) return [];
    const contextPuller = factory();
    // Materialize the typed surface: parent step id -> that parent's report JSON,
    // read once each. A parent without a readable report is simply absent — the
    // channel parks the query as a finding. The query names a parent that already
    // RAN, so its report is settled; we never read the running step.
    const surface = new Map<string, unknown>();
    for (const query of input.request.queries) {
      if (surface.has(query.from_step)) continue;
      const reportPath = steps.get(query.from_step)?.writes?.report?.path;
      if (reportPath === undefined) continue;
      try {
        surface.set(query.from_step, await context.files.readJson(reportPath));
      } catch {
        // Unreadable report -> parent off the surface -> the query parks.
      }
    }
    const answered: DeliveredContextSlice[] = [];
    for (const query of input.request.queries) {
      const outcome = contextPuller({ fromStepId: input.stepId, query, surface });
      await trace.append({
        run_id: runId,
        kind: 'run.context-pull',
        step_id: input.stepId,
        from_step: query.from_step,
        field_path: query.field_path,
        answered: outcome.answered,
        ...(outcome.answered ? { bytes: outcome.bytes } : {}),
        reason: outcome.answered
          ? `pulled ${outcome.source} (${outcome.bytes} bytes)`
          : outcome.finding,
      });
      if (outcome.answered) {
        answered.push({ source: outcome.source, value: outcome.value, bytes: outcome.bytes });
      }
    }
    return answered;
  };

  for (let index = 0; index < maxSteps; index += 1) {
    const step = steps.get(currentStepId);
    if (step === undefined) {
      return await closeRun(
        context,
        'aborted',
        undefined,
        `route target '${currentStepId}' is not a known step id`,
      );
    }

    // Slice loop: load the slice list when first reaching the loop head, then
    // capture this step's slice index (the live index, pre-advance) so its
    // trace, attempt, and completion count are all keyed to the same slice.
    if (sliceCorridor.isActive() && sliceFlag !== undefined && step.id === sliceFlag.headStep) {
      await sliceCorridor.ensureInitialized();
    }
    const isLoopBodyStep = sliceCorridor.isLoopBodyStep(step.id);
    const stepSliceIndex = sliceCorridor.currentSliceIndex();
    // The until loop scopes its own body steps by iteration index, parallel to
    // the slice loop's slice-index scoping. The two are mutually exclusive, so
    // at most one corridor claims this step; whichever does owns its count key.
    const isUntilBodyStep = untilCorridor.isLoopBodyStep(step.id);
    const stepIterationIndex = untilCorridor.currentIterationIndex();
    const stepCountKey = isUntilBodyStep
      ? untilCorridor.countKey(step.id, stepIterationIndex)
      : sliceCorridor.countKey(step.id, stepSliceIndex);
    // The loop-body iteration scope shared by trace stamping (slice_index) and
    // recovery-evidence filtering (sliceIndex): the slice index under a slice
    // loop, the iteration index under an until loop. Both reset a step's attempt
    // counter per iteration, so (step_id, attempt) collides across iterations and
    // the recovery resolver would otherwise attribute an earlier iteration's
    // failed check to a later iteration's clean attempt. activeSlice METADATA
    // stays slice-only below (until loops have no precomputed slice objects), so
    // an until body step carries the index without a slice section in its prompt.
    const loopBodyIndex = isLoopBodyStep
      ? stepSliceIndex
      : isUntilBodyStep
        ? stepIterationIndex
        : undefined;

    const isResumedCheckpoint = options.resumeCheckpoint?.stepId === currentStepId;
    const completedCount = completedStepCounts.get(stepCountKey) ?? 0;
    const incomingIsActiveRecovery = corridor.isActiveRoute(incomingRouteTaken);
    const maxAttempts = maxAttemptsForRoute(step, incomingIsActiveRecovery, policyMaxAttemptsCap);
    const isRecoveryOriginReentry = corridor.isReturnToOrigin({
      stepId: step.id,
      route: incomingRouteTaken,
    });
    // `attempt` is the relay attempt number for this step+slice this iteration.
    // It is `let`, not `const`, because a kept pull-then-retry delivery (below)
    // advances it to the re-run's attempt so the post-step evidence lookups bind
    // to the kept attempt, not the discarded starved one.
    let attempt = isResumedCheckpoint ? options.resumeCheckpoint.attempt : completedCount + 1;
    // A delivery re-run consumes one extra attempt slot (it runs the step a second
    // time at attempt+1). When that happens this records the extra so the step's
    // completion count advances past BOTH attempts and a later recovery re-entry
    // never reuses the re-run's attempt number. Stays 0 on every run without a
    // delivery re-run, so the completion count is unchanged from today.
    let deliveryConsumedAttempts = 0;
    if (
      !isResumedCheckpoint &&
      isCompletedStepReentryAbort({
        completedCount,
        isRecoveryReturnToOrigin: isRecoveryOriginReentry,
        routeHasRecoveryMechanics: incomingIsActiveRecovery,
        maxAttempts,
      })
    ) {
      const recoverySuffix = corridor.lastReasonSuffix();
      const reason =
        incomingRouteTaken === undefined
          ? `route cycle detected at step '${step.id}'; aborting before re-entering an already completed step`
          : `route '${incomingRouteTaken}' for step '${step.id}' exhausted max_attempts=${maxAttempts}${recoverySuffix}`;

      // Until loop, in-step retry exhaustion (slice 3). A judge-gated body step
      // that used up its in-step retries does NOT abort the whole run. Instead
      // the engine latches the unresolved overclaim and either re-enters a fresh
      // iteration (the loop's own retry budget is maxIterations, not the step's
      // max_attempts) or, at the iteration cap, exits needs-attention. The open
      // latch keeps the run from ever closing complete while the overclaim is
      // unresolved (the evidence floor blocks a clean stop; the close-path
      // finalize chokepoint is the backstop). Only the max_attempts form is
      // intercepted: an unsanctioned cycle (incomingRouteTaken === undefined)
      // still aborts via the unchanged cycle guard. A slice-1 count loop has no
      // stopJudge and no ledger, so it is unaffected.
      if (
        untilCorridor.isActive() &&
        untilFlag?.stopJudge !== undefined &&
        isUntilBodyStep &&
        incomingRouteTaken !== undefined
      ) {
        context.honestyLedger?.latchOverclaim({
          stepId: step.id,
          iterationIndex: stepIterationIndex,
          reason,
        });
        // Slice 7: this iteration ended here (it exhausted its in-step retries and
        // never reaches the tail), so contain its partial work as a commit now,
        // before re-entering or stopping. Without this the next iteration's
        // `git add -A` would fold these edits into the wrong commit, and an
        // all-exhausting loop would never begin the branch at all. Inert unless
        // commit containment is configured.
        await containIteration(stepIterationIndex, 'exhausted in-step retries');
        if (untilCorridor.canReenter()) {
          // Clear the recovery corridor for this exhausted origin so the fresh
          // iteration starts clean rather than mid-recovery. The fresh
          // iteration's body steps carry count-0 iteration-scoped keys, so the
          // re-entry is not a cycle. The durable latch lives in the ledger file;
          // the carried-log correction note is slice 4 (carried notes).
          corridor.clearIfExitingOrigin({ stepId: step.id, routeHasRecoveryMechanics: false });
          untilCorridor.advance();
          currentStepId = untilFlag.headStep;
          incomingRouteTaken = untilFlag.reenterRoute;
          continue;
        }
        // Iteration cap reached with the overclaim still open: an honest
        // non-completion. Exit `stopped` (operator-visible "needs attention"),
        // never complete — exhaustion can never read as success.
        const exhaustedReason = `until loop exhausted with an unresolved overclaim on '${step.id}': ${reason}`;
        await trace.append({
          run_id: runId,
          kind: 'step.aborted',
          step_id: step.id,
          attempt,
          reason: exhaustedReason,
        });
        return await closeRun(context, 'stopped', undefined, exhaustedReason);
      }

      await trace.append({
        run_id: runId,
        kind: 'step.aborted',
        step_id: step.id,
        attempt,
        reason,
      });
      return await closeRun(context, 'aborted', undefined, reason);
    }

    if (!isResumedCheckpoint) {
      await trace.append({
        run_id: runId,
        kind: 'step.entered',
        step_id: step.id,
        attempt,
        ...(loopBodyIndex === undefined ? {} : { slice_index: loopBodyIndex }),
      });
    }

    // Mark where this step's trace begins, so skill-hook dispatch can scan only
    // the entries this step appends (its check.evaluated / proof.assessed signals).
    // A kept pull-then-retry delivery advances this past the discarded starved
    // attempt, so the post-step seams read the re-run's signals, not the first
    // attempt's (see the delivery seam below).
    let traceLengthBeforeStep = trace.getAll().length;
    let route: string;
    let details: Record<string, unknown>;
    try {
      const acceptanceRetryFeedback = corridor.acceptanceFeedbackForReentry({
        stepId: step.id,
        incomingRoute: incomingRouteTaken,
      });
      const activeSlice = isLoopBodyStep ? sliceCorridor.currentSlice() : undefined;
      const stepContext: RunContext = {
        ...context,
        // The active flow and its package index may have been swapped by a prior
        // step's honored equipment reshape; override the run-scoped defaults so a
        // re-equipped step's relay reads its injected skill slots.
        flow: activeFlow,
        packageIndex: activePackageIndex,
        activeStepAttempt: attempt,
        // Assign only when true, so a default run (and every run at deep depth)
        // leaves the key ABSENT on RunContext — keeping the "absent => fat / full
        // provisioning" contract that RunValue, ComposeBuildContext, and plan.ts
        // document literally true end to end, not present-but-false.
        ...(contextDeliveryActive ? { contextDeliveryActive } : {}),
        ...(acceptanceRetryFeedback === undefined ? {} : { acceptanceRetryFeedback }),
        // The iteration scope feeds executors that stamp slice_index on their
        // check.evaluated entries (relay, verification), so an until body step's
        // failure evidence is filed under its iteration and the recovery resolver
        // can tell iteration N's failed check from iteration N+1's clean attempt.
        ...(loopBodyIndex === undefined ? {} : { activeSliceIndex: loopBodyIndex }),
        ...(activeSlice === undefined ? {} : { activeSlice }),
        ...(isResumedCheckpoint && options.resumeCheckpoint !== undefined
          ? { resumeCheckpoint: options.resumeCheckpoint }
          : {}),
      };
      let outcome = await executors[step.kind](step, stepContext);
      if (isWaitingCheckpointStepOutcome(outcome)) {
        return {
          kind: 'checkpoint_waiting',
          outcome: 'checkpoint_waiting',
          runFolder: runDir,
          runId,
          flowId: flow.id,
          traceEntriesObserved: trace.getAll().length,
          checkpoint: outcome.checkpoint,
        };
      }

      // On-demand context-pull DELIVERY — pull-then-retry. The value half of the
      // typed-lookup channel: when delivery is enabled and this relay surfaced a
      // typed `context_request`, resolve the named slices (recording each as
      // run.context-pull — the same record the resolve-and-record seam writes),
      // fold the answered slices into the step's envelope, and RE-RUN the step
      // ONCE on the enriched context. Bounded: the per-step query budget caps the
      // slices, and the per-run guard caps a step to one delivery. Fail-safe: if
      // the re-run errors or its connector fails before producing a result, the
      // starved result is untouched and we keep the original outcome; otherwise we
      // keep the enriched re-run. Additive: it only adds context, never
      // restructures. It runs here, BEFORE route classification, so exactly one
      // chosen outcome flows through the rest of the pipeline. Inert unless the
      // live path injected `contextDelivery` (default off); when off, the
      // resolve-and-record seam further below runs instead, byte-identical to
      // today. Best-effort: any failure leaves the run on the starved outcome.
      const contextDelivery = options.contextDelivery;
      const deliveryRoute = outcome.route;
      if (
        contextDelivery !== undefined &&
        options.contextPuller !== undefined &&
        step.kind === 'relay' &&
        step.routes[deliveryRoute] !== undefined &&
        step.routes[deliveryRoute]?.kind !== 'terminal' &&
        !sliceCorridor.isActive()
      ) {
        try {
          const starvedEntries = trace.getAll().slice(traceLengthBeforeStep);
          const starvedCompleted = [...starvedEntries]
            .reverse()
            .find((entry) => entry.kind === 'relay.completed');
          if (starvedCompleted !== undefined) {
            const starvedBody = await context.files.readJson(starvedCompleted.result_path);
            const request = extractContextRequest(starvedBody);
            if (request !== undefined) {
              const delivered = await resolveAndRecordContextPull({
                stepId: step.id,
                request,
              });
              if (delivered.length > 0 && contextDelivery.claim(step.id)) {
                const traceLengthBeforeRetry = trace.getAll().length;
                // The re-run is a distinct attempt (attempt + 1), so its relay
                // entries — including a relay.failed if its connector fails — are
                // keyed to their own attempt and never contaminate the starved
                // attempt's recovery evidence on a fall-back. On keep we advance
                // `attempt` to this number so the post-step evidence lookups bind to
                // the kept re-run instead.
                const retryAttempt = attempt + 1;
                let retryEvaluation: RetryEvaluation;
                let retried = false;
                try {
                  const enrichedContext: RunContext = {
                    ...stepContext,
                    activeStepAttempt: retryAttempt,
                    deliveredContextSlices: delivered,
                  };
                  const retryOutcome = await executors[step.kind](step, enrichedContext);
                  retried = true;
                  if (isWaitingCheckpointStepOutcome(retryOutcome)) {
                    // A relay never parks; treat an impossible checkpoint here as a
                    // non-result and keep the starved outcome.
                    retryEvaluation = { kind: 'errored' };
                  } else {
                    // The re-run writes to the same fixed result path. If the worker
                    // connector failed it wrote nothing (the engine recorded a
                    // relay.failed), so the starved result is intact and we keep it;
                    // otherwise the enriched result is persisted and we keep it.
                    const retryEntries = trace.getAll().slice(traceLengthBeforeRetry);
                    const connectorFailed = retryEntries.some(
                      (entry) => entry.kind === 'relay.failed',
                    );
                    retryEvaluation = connectorFailed
                      ? { kind: 'connector_failed' }
                      : { kind: 'produced' };
                    if (retryEvaluation.kind === 'produced') {
                      outcome = retryOutcome;
                    }
                  }
                } catch {
                  retried = true;
                  retryEvaluation = { kind: 'errored' };
                }
                const decision = decideContextDeliveryOutcome(retryEvaluation);
                await trace.append({
                  run_id: runId,
                  kind: 'run.context-delivery',
                  step_id: step.id,
                  delivered_slices: delivered.length,
                  delivered_bytes: delivered.reduce((sum, slice) => sum + slice.bytes, 0),
                  retried,
                  kept: decision.keep,
                  reason: decision.reason,
                });
                if (retried) {
                  // The re-run consumed attempt `retryAttempt`. Record the extra so
                  // the step's completion count advances past it and no later
                  // recovery re-entry of this step reuses that attempt number,
                  // whether we kept the re-run or fell back.
                  deliveryConsumedAttempts = retryAttempt - attempt;
                }
                if (decision.keep === 'retry') {
                  // The kept outcome is the re-run: bind the rest of the pipeline to
                  // its attempt and its trace window. Advancing `attempt` makes the
                  // recovery-evidence lookups read the re-run's signals; advancing
                  // the trace boundary makes skill-hook dispatch, power inference,
                  // reshape, and the close pipeline scan the re-run's entries, not
                  // the discarded starved attempt's.
                  attempt = retryAttempt;
                  traceLengthBeforeStep = traceLengthBeforeRetry;
                }
                // Known bound: if the kept enriched body ITSELF surfaces a new
                // context_request (the worker, now richer, asks for yet more),
                // that second request is neither delivered (the per-step guard is
                // spent — one delivery per step) nor recorded. With delivery off
                // the late resolve-and-record seam would record it; with delivery
                // on that seam is skipped, so this is a minor legibility
                // asymmetry on an uncommon path (the design intent is that one
                // delivery satisfies the need). Honesty, correctness, and
                // durability are unaffected: the kept body is the real result. A
                // cheap fix exists (a record-only resolveAndRecordContextPull on
                // the kept body), deliberately deferred to keep this
                // safety-critical seam minimal.
              }
            }
          }
        } catch {
          // Fail-safe by design: any delivery failure leaves the run on the
          // starved outcome, exactly as if delivery were off.
        }
      }

      route = outcome.route;
      details = outcome.details ?? {};
    } catch (error) {
      const message = (error as Error).message;
      const reason = isProofPlanBlockedError(error)
        ? message
        : `step '${step.id}' handler threw: ${message}`;

      // Until loop, thrown body-step failure. The slice-3 abort-intercept above
      // only catches RE-ENTRY exhaustion (max_attempts on an already completed
      // step); a body step whose handler THROWS — the judge's own verdict check
      // failing is the live case (relay.ts throws when no recovery route is
      // bound for a failed_check) — lands here instead, and without this seam
      // the whole run aborts on iteration 1 of N. Same honest policy as the
      // slice-3 intercept: latch the unresolved overclaim (the floor blocks a
      // clean stop while it is open), contain the iteration's partial work, and
      // either re-enter a fresh iteration (the loop's retry budget is
      // maxIterations) or, at the cap, exit `stopped` — never complete, and
      // never an opaque mid-loop abort. The executor already traced the failed
      // check before throwing, so the failure stays legible per-iteration.
      if (
        untilCorridor.isActive() &&
        untilFlag?.stopJudge !== undefined &&
        untilCorridor.isLoopBodyStep(step.id)
      ) {
        context.honestyLedger?.latchOverclaim({
          stepId: step.id,
          iterationIndex: stepIterationIndex,
          reason,
        });
        await containIteration(stepIterationIndex, 'body step failed');
        if (untilCorridor.canReenter()) {
          corridor.clearIfExitingOrigin({ stepId: step.id, routeHasRecoveryMechanics: false });
          untilCorridor.advance();
          currentStepId = untilFlag.headStep;
          incomingRouteTaken = untilFlag.reenterRoute;
          continue;
        }
        const exhaustedReason = `until loop exhausted with an unresolved overclaim on '${step.id}': ${reason}`;
        await trace.append({
          run_id: runId,
          kind: 'step.aborted',
          step_id: step.id,
          attempt,
          reason: exhaustedReason,
        });
        return await closeRun(context, 'stopped', undefined, exhaustedReason);
      }

      await trace.append({
        run_id: runId,
        kind: 'step.aborted',
        step_id: step.id,
        attempt,
        reason: message,
      });
      return await closeRun(context, 'aborted', undefined, reason);
    }

    // Slice loop: when the tail step passes its forward route and more slices
    // remain, redirect to the loop head via the declared advance route instead
    // of proceeding past the loop. advance() bumps the live slice index so the
    // re-entered head step is keyed to (and budgeted for) the next slice, while
    // this completing step keeps its captured stepSliceIndex below.
    if (sliceCorridor.isActive() && sliceFlag !== undefined && step.id === sliceFlag.tailStep) {
      const forwardTarget = step.routes[route];
      const forwardStepId = forwardTarget?.kind === 'step' ? forwardTarget.stepId : undefined;
      if (sliceCorridor.shouldAdvance({ stepId: step.id, targetStepId: forwardStepId })) {
        route = sliceFlag.advanceRoute;
        sliceCorridor.advance();
      }
    }

    // Until loop: when the tail step takes its forward (non-re-enter) route and
    // the iteration cap has not been reached, redirect to the loop head via the
    // declared re-enter route instead of letting the forward route exit the
    // loop. advance() bumps the live iteration index so the re-entered head step
    // is keyed to (and budgeted for) the next iteration, while this completing
    // step keeps its captured stepIterationIndex. Unlike the slice loop the
    // forward route may be terminal (the body's natural end is to exit), so this
    // does not inspect the target — any non-re-enter route is a forward exit.
    if (untilCorridor.isActive() && untilFlag !== undefined && step.id === untilFlag.tailStep) {
      if (untilFlag.stopJudge !== undefined) {
        // Slice 2: the tail is a stop-judge. Read its goal-met boolean (plus the
        // slice-4 lesson and slice-6 progress marker, in one snapshot) and dispose
        // the boolean against the evidence floor; never read the goal text here.
        // The floor is consulted only on a met-claim (the sole case it can change
        // the outcome), so a not-done iteration costs no floor read.
        //
        // The frozen-eval guard runs first, BEFORE the floor disposes the claim.
        // If a body iteration changed one of the loop's declared read-only eval
        // paths, the act gamed the very surface the floor trusts — so we open the
        // dedicated `frozen-eval-guard` latch. defaultUntilEvidenceFloor returns
        // false while any latch is open, and nothing ever clears THIS key (the
        // body's latch-clear seam only clears real step ids), so a tampered run
        // can re-enter or exhaust but never close complete. Inert (no fs reads)
        // unless the flow declared frozenPaths and a project root was threaded.
        if (frozenEvalGuard !== undefined) {
          const changed = frozenEvalGuard.changedFrozenPaths();
          if (changed.length > 0) {
            context.honestyLedger?.latchOverclaim({
              stepId: 'frozen-eval-guard',
              iterationIndex: stepIterationIndex,
              reason: `eval surface modified during iteration ${stepIterationIndex}: ${changed.join(', ')}`,
            });
          }
        }
        const judgment = await readUntilJudgeReport(context, untilFlag.stopJudge);
        const evidenceConfirms =
          judgment.goalProposed &&
          (options.untilEvidenceFloor ?? defaultUntilEvidenceFloor)(context);
        let disposition = untilCorridor.disposeIteration({
          goalProposed: judgment.goalProposed,
          evidenceConfirms,
        });
        // Hoisted out of the re-enter/exhaust block so the experiment-ledger
        // entry below can read the consecutive no-progress count for EVERY
        // disposition — it defaults to 0 on a stop-clean pass, which never
        // touches the slices-4-6 block where the count is computed.
        let recordedNoProgress = 0;

        // Slices 4-6 compose only on a loop that is continuing or exhausting, not
        // on a confirmed clean stop: a goal the evidence backs completes honestly
        // regardless of budget or progress. A near-budget warning and a first
        // no-progress nudge are steers for the NEXT pass, so they attach only when
        // the loop actually re-enters.
        if (disposition !== 'stop-clean') {
          // Slice 5: cumulative budget, fail-closed. Evaluated over the whole run
          // trace (the loop dominates spend). Inert when no cap is set.
          const budget = evaluateUntilBudget(context.trace.getAll(), {
            ...(untilFlag.cumulativeUsdCap === undefined
              ? {}
              : { usdCap: untilFlag.cumulativeUsdCap }),
            ...(untilFlag.cumulativeTokenCap === undefined
              ? {}
              : { tokenCap: untilFlag.cumulativeTokenCap }),
          });
          // Slice 6: record the opaque progress marker and read the consecutive
          // no-progress count. Inert (count 0) when the flow declares no marker.
          const noProgressCount =
            untilFlag.stopJudge.progressPath === undefined
              ? 0
              : untilCorridor.recordProgressMarker(judgment.progressMarker);
          recordedNoProgress = noProgressCount;
          const ceilingHit =
            untilFlag.noProgressCeiling !== undefined &&
            noProgressCount >= untilFlag.noProgressCeiling;

          // A re-entering pass that is over budget or stalled out is forced to
          // exhaust instead: stop spending / stop spinning. This routes to the
          // same non-@complete needs-attention exit, so exhaustion stays honest.
          if (disposition === 'reenter' && (budget.overCap || ceilingHit)) {
            disposition = 'needs-attention';
          }

          // Slice 4: append this iteration's carried note for the next pass. Only
          // when still re-entering (an exhausting pass has no next reader). Carries
          // the judge's lesson plus any soft budget warning or first-stall nudge.
          if (disposition === 'reenter' && untilFlag.carriedNotes !== undefined) {
            const steers: string[] = [];
            if (budget.nearCap && budget.reason !== undefined) steers.push(budget.reason);
            if (noProgressCount === 1) {
              steers.push(
                'No measurable progress since the last pass. Try a materially different approach.',
              );
            }
            if (judgment.lesson !== undefined || steers.length > 0) {
              await appendCarriedNote({
                files: context.files,
                report: untilFlag.carriedNotes.report,
                note: {
                  iteration: stepIterationIndex,
                  lesson: judgment.lesson ?? '',
                  ...(steers.length === 0 ? {} : { steer: steers.join(' ') }),
                },
                ...(untilFlag.carriedNotes.maxEntries === undefined
                  ? {}
                  : { maxEntries: untilFlag.carriedNotes.maxEntries }),
              });
            }
          }
        }

        // The experiment-ledger entry: the durable per-iteration record of this
        // pass's judgment, stamped AFTER the disposition is final (the slices-4-6
        // block above may flip reenter -> needs-attention) and BEFORE the route
        // is reassigned below. Stamped only on a judge-gated loop — a count-driven
        // loop has no judgment and emits nothing, so today's count-loop traces
        // stay byte-identical. iterationLedgerFromTrace projects these back into
        // the operator's per-pass ledger. See src/runtime/run/iteration-ledger.ts.
        await trace.append({
          run_id: runId,
          kind: 'run.until-judgment',
          step_id: step.id,
          iteration: stepIterationIndex,
          goal_proposed: judgment.goalProposed,
          evidence_confirmed: evidenceConfirms,
          disposition,
          no_progress_count: recordedNoProgress,
          open_latch_count: context.honestyLedger?.openLatches().length ?? 0,
          ...(judgment.lesson === undefined ? {} : { lesson: judgment.lesson }),
        });

        if (disposition === 'reenter') {
          route = untilFlag.reenterRoute;
          untilCorridor.advance();
        } else if (disposition === 'needs-attention') {
          // assertUntilFlagCoherent guarantees a tail-declared needsAttentionRoute
          // whenever stopJudge is set, so this is defined. Fail loud rather than
          // silently fall through to the clean-stop forward route (a false-done).
          const attentionRoute = untilFlag.needsAttentionRoute;
          if (attentionRoute === undefined) {
            throw new Error(
              `until loop on flow '${flow.id}' reached needs-attention with no needsAttentionRoute`,
            );
          }
          route = attentionRoute;
        }
        // 'stop-clean' leaves the tail's forward route intact (the clean exit).
      } else if (untilCorridor.shouldReenter({ stepId: step.id, route })) {
        // Slice 1: count-driven advance, no stop-judge.
        route = untilFlag.reenterRoute;
        untilCorridor.advance();
      }

      // Slice 7 (opt-in, default off): contain this iteration's work as one
      // commit on the throwaway branch. Runs for every iteration that reaches the
      // tail after its route is settled, so the branch history maps one-to-one to
      // iterations and the operator's branch never moves. Inert unless the flow
      // declares the flag AND the host injected a runner. Iterations that exhaust
      // via the abort-intercept never reach here; they are contained at the
      // intercept instead (see the slice-3 block above).
      await containIteration(stepIterationIndex, `route ${route}`);
    }

    // The honest one-pass floor. Below the loop's activation depth the corridor
    // is inert (the body runs once, never re-enters) — but a stop-judge tail
    // still proposed a goal_met, and letting that proposal ride the forward
    // route to @complete undisposed is exactly the laundering the corridor
    // exists to prevent (the live surface test caught a bare rubber-stamp
    // closing @complete at medium depth this way; see
    // docs/release/proofs/live-runs/LEDGER.md, F13). So the disposition still
    // runs, once, with the loop's own moves removed: a met claim the evidence
    // floor confirms keeps the tail's forward route (the clean one-pass exit);
    // anything else — goal not proposed, or proposed but unconfirmed — exits via
    // the declared needs-attention route. There is no 'reenter' below the
    // floor: one pass is the whole budget. The same run.until-judgment entry is
    // stamped (iteration 0), so a one-pass judgment is as legible in the trace
    // as a looped one. Byte-identical for every flow without a stop-judge.
    if (
      !untilCorridor.isActive() &&
      untilFlag?.stopJudge !== undefined &&
      step.id === untilFlag.tailStep
    ) {
      // Same frozen-eval guard as the active seam: a one-pass body that edited a
      // declared read-only eval path must not complete on evidence it tampered
      // with. Inert (no fs reads) unless the flow declared frozenPaths and a
      // project root was threaded.
      if (frozenEvalGuard !== undefined) {
        const changed = frozenEvalGuard.changedFrozenPaths();
        if (changed.length > 0) {
          context.honestyLedger?.latchOverclaim({
            stepId: 'frozen-eval-guard',
            iterationIndex: stepIterationIndex,
            reason: `eval surface modified during iteration ${stepIterationIndex}: ${changed.join(', ')}`,
          });
        }
      }
      const judgment = await readUntilJudgeReport(context, untilFlag.stopJudge);
      const evidenceConfirms =
        judgment.goalProposed && (options.untilEvidenceFloor ?? defaultUntilEvidenceFloor)(context);
      const disposition: UntilDisposition = evidenceConfirms ? 'stop-clean' : 'needs-attention';
      await trace.append({
        run_id: runId,
        kind: 'run.until-judgment',
        step_id: step.id,
        iteration: stepIterationIndex,
        goal_proposed: judgment.goalProposed,
        evidence_confirmed: evidenceConfirms,
        disposition,
        no_progress_count: 0,
        open_latch_count: context.honestyLedger?.openLatches().length ?? 0,
        ...(judgment.lesson === undefined ? {} : { lesson: judgment.lesson }),
      });
      if (disposition === 'needs-attention') {
        // assertUntilFlagCoherent guarantees a tail-declared needsAttentionRoute
        // whenever stopJudge is set, so this is defined. Fail loud rather than
        // silently fall through to the clean-stop forward route (a false-done).
        const attentionRoute = untilFlag.needsAttentionRoute;
        if (attentionRoute === undefined) {
          throw new Error(
            `until loop on flow '${flow.id}' reached needs-attention with no needsAttentionRoute`,
          );
        }
        route = attentionRoute;
      }
      // 'stop-clean' leaves the tail's forward route intact (the clean exit).
    }

    const routeDeclaration = classifyRouteDeclarationTransition({
      stepId: step.id,
      route,
      target: step.routes[route],
    });
    if (routeDeclaration.kind === 'undeclared_route_abort') {
      await trace.append({
        run_id: runId,
        kind: 'step.aborted',
        step_id: step.id,
        attempt,
        reason: routeDeclaration.reason,
      });
      return await closeRun(context, 'aborted', undefined, routeDeclaration.reason);
    }
    const target = routeDeclaration.target;

    const recoveryBinding = recoveryBindingForCompletedRoute({
      bindings: recoveryRouteBindings,
      step,
      route,
      target,
    });
    const routeHasRecoveryMechanics = isRecoveryRouteForMechanics({
      bindings: recoveryRouteBindings,
      step,
      route,
    });
    const directRecoveryFailure =
      latestRecoveryFailureEvidence({
        context,
        stepId: step.id,
        attempt,
        details,
        ...(loopBodyIndex === undefined ? {} : { sliceIndex: loopBodyIndex }),
      }) ??
      reportSelectedCheckpointBoundaryEvidence({
        context,
        stepId: step.id,
        attempt,
        details,
        binding: recoveryBinding,
      });
    const recoveryFailure =
      directRecoveryFailure ??
      (routeHasRecoveryMechanics
        ? corridor.evidenceFor({
            stepId: step.id,
            attempt,
            binding: recoveryBinding,
          })
        : undefined);

    // Until loop, latch-clear (slice 3): a body step that re-runs and completes
    // its check clean (no recovery failure, no recovery route) clears any
    // overclaim latch it held from an earlier iteration. The ledger tracks the
    // step's LATEST state, so a clean pass resolves the latch; only then can the
    // close-path finalize chokepoint let the run reach complete. Inert on every
    // run with no judge-gated until ledger.
    if (
      untilCorridor.isActive() &&
      untilFlag?.stopJudge !== undefined &&
      isUntilBodyStep &&
      recoveryFailure === undefined &&
      !routeHasRecoveryMechanics
    ) {
      context.honestyLedger?.clearLatch(step.id);
    }

    const bindingVerdict = recoveryBindingVerdict({
      workContractRef: context.workContractRef,
      stepId: step.id,
      stepKind: step.kind,
      route,
      routeHasRecoveryMechanics,
      recoveryFailure,
      recoveryBinding,
    });
    if (bindingVerdict.kind === 'abort') {
      await trace.append({
        run_id: runId,
        kind: 'step.aborted',
        step_id: step.id,
        attempt,
        reason: bindingVerdict.reason,
      });
      return await closeRun(context, 'aborted', undefined, bindingVerdict.reason);
    }

    // The live loop index here is post-advance, so a re-enter/advance redirect
    // to the loop head reads the next iteration's (empty) count rather than the
    // just-completed one's, and is not flagged as a cycle. Whichever corridor
    // owns the target step supplies its key; the two are mutually exclusive.
    const targetCountKey =
      target.kind === 'step'
        ? untilCorridor.isLoopBodyStep(target.stepId)
          ? untilCorridor.countKey(target.stepId, untilCorridor.currentIterationIndex())
          : sliceCorridor.countKey(target.stepId, sliceCorridor.currentSliceIndex())
        : undefined;
    const targetCompletedCount =
      targetCountKey !== undefined ? (completedStepCounts.get(targetCountKey) ?? 0) : 0;
    const targetStep = target.kind === 'step' ? steps.get(target.stepId) : undefined;
    const isRecoveryReturnToOrigin =
      target.kind === 'step'
        ? corridor.isReturnToOrigin({
            stepId: target.stepId,
            route,
          })
        : false;
    const targetMaxAttempts =
      target.kind === 'step' && targetStep !== undefined
        ? maxAttemptsForRoute(targetStep, routeHasRecoveryMechanics, policyMaxAttemptsCap)
        : maxAttemptsForRoute(step, routeHasRecoveryMechanics, policyMaxAttemptsCap);
    const targetTransition = classifyRouteTargetTransition({
      stepId: step.id,
      route,
      target,
      targetCompletedCount,
      isRecoveryReturnToOrigin,
      routeHasRecoveryMechanics,
      targetMaxAttempts,
      recoveryReasonSuffix: corridor.lastReasonSuffix(),
    });
    if (isRouteTargetAbort(targetTransition)) {
      await trace.append({
        run_id: runId,
        kind: 'step.aborted',
        step_id: step.id,
        attempt,
        reason: targetTransition.reason,
      });
      return await closeRun(context, 'aborted', undefined, targetTransition.reason);
    }

    if (routeHasRecoveryMechanics) {
      corridor.enter({
        originStepId: step.id,
        route,
        recoveryReason: details.reason,
        recoveryFailure,
        acceptanceFeedback: isAcceptanceRetryFeedback(details.acceptance_feedback)
          ? details.acceptance_feedback
          : undefined,
      });
    }

    if (recoveryBinding !== undefined) {
      if (
        recoveryFailure !== undefined &&
        recoveryCauseAllowed(recoveryBinding, recoveryFailure.cause)
      ) {
        await appendRecoveryRouteGuidance(context, {
          stepId: step.id,
          attempt,
          routeId: route,
          recoveryKind: recoveryBinding.kind,
          failureCause: recoveryFailure.cause,
          failureRef: recoveryFailure.ref,
          bindingRef: recoveryBinding.source_ref,
        });
      }
    }

    corridor.clearIfExitingOrigin({ stepId: step.id, routeHasRecoveryMechanics });

    await trace.append({
      run_id: runId,
      kind: 'step.completed',
      step_id: step.id,
      attempt,
      route_taken: route,
      ...(loopBodyIndex === undefined ? {} : { slice_index: loopBodyIndex }),
    });
    // Keyed to this step's captured slice index (pre-advance), so a tail step
    // that just advanced still records its own slice's completion, not the
    // next slice's. `deliveryConsumedAttempts` (0 unless a pull-then-retry re-run
    // ran) advances the count past the re-run's attempt slot so a later recovery
    // re-entry never reuses it.
    completedStepCounts.set(stepCountKey, completedCount + 1 + deliveryConsumedAttempts);

    // Skill-hook dispatch: record any hook events this step's signals trigger
    // under the run's config, then actuate the `auto` ones. Best-effort and
    // fully isolated — a dispatch failure must never affect the run, and a run
    // with no skill_hooks config records nothing and injects nothing. File-edit
    // hooks read the step's reports via the run file store; check-outcome hooks
    // read the trace.
    try {
      const hookEvents = await dispatchSkillHooks({
        entries: trace.getAll().slice(traceLengthBeforeStep),
        ...(context.selectionConfigLayers === undefined
          ? {}
          : { configLayers: context.selectionConfigLayers }),
        scope: {
          flowId: flow.id,
          stepId: step.id,
          attemptId: String(attempt),
        },
        eventIdBase: `${runId}:${step.id}:${attempt}`,
        readJson: (ref) => context.files.readJson(ref),
        editFileSurfaceSources,
        // Share the run's single registry so the recorded triggered/unavailable
        // split matches what the relay loader will actually resolve.
        ...(context.skillRegistry === undefined ? {} : { registry: context.skillRegistry }),
      });
      for (const event of hookEvents) {
        await trace.append({ run_id: runId, kind: 'run.skill-hook', event });
        // Actuate: an `auto` policy injects its resolved skills into the next
        // implementer relay. Three guards, all required:
        //  - mode === 'auto': `mute`/`none` never inject (there is no `ask` mode).
        //  - decision_packet_id === undefined: a recorded decision packet blocks
        //    injection. A strict `auto` policy whose configured skill is
        //    unavailable carries a `strict-skill-unavailable` packet; when one is
        //    present we inject NOTHING — not even the skills that did resolve — and
        //    the run still proceeds (the conservative reading of strict mode). The
        //    packet is recorded onto the event for the trace; nothing interactive
        //    consumes it yet, so the run does NOT pause or await an operator choice
        //    (interactive resolution is a later slice).
        //  - triggered_skills non-empty: nothing to inject otherwise.
        if (
          event.policy.mode === 'auto' &&
          event.decision_packet_id === undefined &&
          event.triggered_skills.length > 0
        ) {
          context.skillHookInjections?.add(event.triggered_skills.map((skill) => skill.id));
        }
      }
    } catch (err) {
      // Skill-hook dispatch is non-critical: a failure must never break a run.
      // But it must not be silent either (the operator otherwise cannot tell
      // "no hook matched" from "dispatch crashed"). Record a marker the operator
      // summary surfaces as a `skill_hook_dispatch_failed` warning, mirroring how
      // an HTML render failure surfaces. If recording the marker itself fails,
      // stay silent rather than break the run.
      try {
        await trace.append({
          run_id: runId,
          kind: 'run.skill-hook-error',
          step_id: step.id,
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // Last-resort: never let observability break the run.
      }
    }

    // Auto-power inference: when the dial setting is `auto` and this step's
    // accepted relay was a researcher, read its result body for a
    // `recommended_power`, clamp it to the operator bounds, record the
    // resolution durably, and set the run-scoped channel so every later relay
    // materializes against it. First resolution wins; best-effort like
    // skill-hook dispatch — a failure here must never affect the run (the dial
    // just stays at the medium fallback).
    try {
      if (context.powerInference !== undefined && context.powerInference.get() === undefined) {
        const setting = resolvePowerDialSetting(context.selectionConfigLayers ?? []);
        if (setting.kind === 'auto') {
          const stepEntries = trace.getAll().slice(traceLengthBeforeStep);
          const researcherRelayed = stepEntries.some(
            (entry) => entry.kind === 'relay.started' && entry.role === 'researcher',
          );
          // The step completed, so the last relay.completed in the slice is the
          // accepted attempt; earlier ones were retried past.
          const completed = researcherRelayed
            ? [...stepEntries].reverse().find((entry) => entry.kind === 'relay.completed')
            : undefined;
          if (completed !== undefined) {
            const body = await context.files.readJson(completed.result_path);
            const recommendation = extractPowerRecommendation(body);
            if (recommendation !== undefined) {
              const resolved = clampPowerToBounds(recommendation.value, setting);
              await trace.append({
                run_id: runId,
                kind: 'run.power-inference',
                step_id: step.id,
                recommended: recommendation.value,
                rationale: recommendation.rationale,
                floor: setting.floor,
                ceiling: setting.ceiling,
                resolved,
                clamped: resolved !== recommendation.value,
              });
              context.powerInference.set({
                recommended: recommendation.value,
                rationale: recommendation.rationale,
                resolved,
                clamped: resolved !== recommendation.value,
              });
            }
          }
        }
      }
    } catch {
      // Non-critical by design: an unreadable result body or a trace-append
      // failure leaves the dial at the documented medium fallback.
    }

    // Step 2 — the live equipment reshape. The first time the engine adapts a
    // RUNNING flow. After a step completes, if its relay surfaced a CONFIRMED
    // equipment discovery (e.g. "this turned out to be a React app"), the
    // reshaper re-equips the remaining relay steps and returns a re-validated
    // executable tail to continue on. Additive only: equipment never changes the
    // step sequence, so there is NO splice seam (structural reshape is Step 3).
    // Inert unless the live path injected `equipmentReshaper`. Best-effort and
    // fail-safe — any failure leaves the run on its current, still-valid flow,
    // which is exactly the finding fallback. Skipped inside a slice loop
    // (completion-count keys are slice-scoped there) and on the terminal step
    // (nothing remains to equip). The reshaper owns the bound, the cycle guard,
    // and the confirmed-only default; this seam reads the signal and swaps the
    // executable flow — it never touches the compiled form.
    const equipmentReshaper = options.equipmentReshaper;
    if (
      equipmentReshaper !== undefined &&
      targetTransition.kind !== 'terminal_close' &&
      !sliceCorridor.isActive()
    ) {
      try {
        const stepEntries = trace.getAll().slice(traceLengthBeforeStep);
        const completed = [...stepEntries]
          .reverse()
          .find((entry) => entry.kind === 'relay.completed');
        if (completed !== undefined) {
          const body = await context.files.readJson(completed.result_path);
          const discovery = extractEquipmentDiscovery(body);
          if (discovery !== undefined) {
            // The remaining relay steps: relay steps other than the one that
            // surfaced the discovery, not yet run this pass. A completed step's
            // equipment is settled — re-equipping the past is meaningless.
            const remainingRelayStepIds = new Set(
              activeFlow.steps
                .filter(
                  (candidate) =>
                    candidate.kind === 'relay' &&
                    candidate.id !== step.id &&
                    (completedStepCounts.get(candidate.id) ?? 0) === 0,
                )
                .map((candidate) => candidate.id),
            );
            const outcome = equipmentReshaper({
              fromStepId: step.id,
              remainingRelayStepIds,
              discovery,
            });
            if (outcome.reshaped) {
              // Record the durable reason BEFORE committing the swap. The append
              // is the only operator-visible trace of why a later relay gained
              // skills; writing it first means a record failure aborts into the
              // catch with the flow still unchanged, rather than leaving skills
              // that appear mid-run with no recorded cause.
              await trace.append({
                run_id: runId,
                kind: 'run.equipment-reshape',
                step_id: step.id,
                confirmed: discovery.confirmed,
                reshaped: true,
                domain_tags: discovery.domain_tags,
                equipped_steps: [...outcome.equippedSteps],
                reason: outcome.rationale,
              });
              // Swap the running flow for the re-validated tail. The step
              // sequence is unchanged (additive equipment), so the cursor,
              // routes, and corridor — which read structure, not slots — keep
              // working; only the steps' skill slots and the package index move.
              // Build the index into a local FIRST, then assign the three pieces
              // of run state together: the swap is atomic by construction, so a
              // throw from buildRuntimePackageIndex can never leave activeFlow
              // ahead of its index (it cannot throw on an assertExecutableFlow-
              // validated flow, but we do not lean on that to stay consistent).
              const nextFlow = outcome.executableFlow;
              const nextPackageIndex = buildRuntimePackageIndex(nextFlow);
              activeFlow = nextFlow;
              activePackageIndex = nextPackageIndex;
              for (const updated of activeFlow.steps) {
                steps.set(updated.id, updated);
              }
            } else {
              await trace.append({
                run_id: runId,
                kind: 'run.equipment-reshape',
                step_id: step.id,
                confirmed: discovery.confirmed,
                reshaped: false,
                domain_tags: discovery.domain_tags,
                reason: outcome.finding,
              });
            }
          }
        }
      } catch {
        // Non-critical by design: a failed reshape attempt leaves the run on its
        // current, still-valid flow — exactly the finding fallback.
      }
    }

    // On-demand context-pull — the typed-lookup channel, RESOLVE-AND-RECORD seam.
    // After a relay completes, it may have surfaced a `context_request`: a typed
    // ask for one more named slice of a parent's report than its thin envelope
    // carried. The shared helper materializes each named parent's typed report,
    // resolves the slice through a fresh per-step channel, and records the
    // answer-or-finding in the trace. Resolve-and-record only: the value is not
    // delivered back into the step here, so the run is never altered.
    //
    // This seam runs when EITHER of two conditions holds:
    //   - delivery is off (`contextDelivery === undefined`): the resolve-and-record
    //     channel is the only one wired, so it handles every request.
    //   - we are inside a slice corridor (`sliceCorridor.isActive()`): the early
    //     delivery seam above is guarded on `!sliceCorridor.isActive()`, so it never
    //     fires for a corridor step. Delivery-in-corridor stays deferred (re-running
    //     a corridor head on enriched context would interact with slice-scoped
    //     completion keys — out of scope here), but the pull must still be made
    //     LEGIBLE: record it as a finding instead of dropping it silently. This is
    //     the lift of the formerly over-conservative slice-loop skip; context-pull
    //     never mutates, so recording inside a corridor is safe.
    // The combined guard avoids double-recording: with delivery on AND outside a
    // corridor, the early seam already resolved+recorded+delivered, so both
    // conditions are false and this seam is skipped.
    //
    // Inert unless the live path injected `contextPuller`; always skipped on the
    // terminal step. Best-effort and fail-safe: any failure leaves the run untouched.
    if (
      options.contextPuller !== undefined &&
      (options.contextDelivery === undefined || sliceCorridor.isActive()) &&
      targetTransition.kind !== 'terminal_close'
    ) {
      try {
        const stepEntries = trace.getAll().slice(traceLengthBeforeStep);
        const completed = [...stepEntries]
          .reverse()
          .find((entry) => entry.kind === 'relay.completed');
        if (completed !== undefined) {
          const body = await context.files.readJson(completed.result_path);
          const request = extractContextRequest(body);
          if (request !== undefined) {
            await resolveAndRecordContextPull({ stepId: step.id, request });
          }
        }
      } catch {
        // Non-critical by design: a failed context-pull leaves the run untouched.
      }
    }

    if (targetTransition.kind === 'terminal_close') {
      return await closeRun(
        context,
        outcomeForTerminal(targetTransition.terminalTarget),
        targetTransition.terminalTarget,
      );
    }

    currentStepId = targetTransition.targetStepId;
    incomingRouteTaken = route;
  }

  return await closeRun(context, 'aborted', undefined, `maxSteps exceeded: ${maxSteps}`);
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function executeExecutableFlowOutcome(
  flow: ExecutableFlow,
  options: GraphRunnerOptions,
): Promise<GraphExecutionOutcome> {
  try {
    return await executeExecutableFlowOutcomeUnsafe(flow, options);
  } catch (error) {
    const normalized = errorFromUnknown(error);
    return {
      kind: 'rejected',
      outcome: 'rejected',
      reason: normalized.message,
      error: normalized,
    };
  }
}

function graphOutcomeToCompatibilityResult(outcome: GraphExecutionOutcome): GraphExecutionResult {
  if (outcome.kind === 'closed') return outcome.result;
  if (outcome.kind === 'rejected') throw outcome.error;
  return outcome;
}

export async function executeExecutableFlowWithWaiting(
  flow: ExecutableFlow,
  options: GraphRunnerOptions,
): Promise<GraphExecutionResult> {
  return graphOutcomeToCompatibilityResult(await executeExecutableFlowOutcome(flow, options));
}

export async function executeExecutableFlow(
  flow: ExecutableFlow,
  options: GraphRunnerOptions,
): Promise<GraphRunResult> {
  const result = await executeExecutableFlowWithWaiting(flow, options);
  if (isGraphCheckpointWaitingResult(result)) {
    throw new Error(
      `runtime run '${result.runId}' paused at checkpoint '${result.checkpoint.stepId}', which requires checkpoint-aware resume routing`,
    );
  }
  return result;
}
