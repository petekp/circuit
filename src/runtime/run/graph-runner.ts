// Runtime graph execution loop.
//
// Owns step advancement for one run folder: bootstrap trace, step attempts,
// recovery routes, checkpoint waiting, terminal closure, and result.json.
// Flow-specific behavior belongs in executors and flow registries; the runner
// only interprets the executable graph and appends durable trace entries.

import { randomUUID } from 'node:crypto';
import { findCompiledFlowPackageById } from '../../flows/catalog.js';
import type { SliceLoopEngineFlag } from '../../flows/types.js';
import type { Axes } from '../../schemas/axes.js';
import type { ChangeKindDeclaration, StandardChangeKind } from '../../schemas/change-kind.js';
import { computeManifestHash } from '../../schemas/manifest.js';
import type { RecoveryRouteBindingV0 } from '../../schemas/recovery-route-kind.js';
import type { Ref } from '../../schemas/ref.js';
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
import type { RuntimeExecutionCapabilities } from './capabilities.js';
import { appendFlowSelectionGuidance, appendRecoveryRouteGuidance } from './guidance.js';
import { writeRuntimeManifestSnapshot } from './manifest-snapshot.js';
import { recoveryBindingVerdict, recoveryCauseAllowed } from './recovery-binding-verdict.js';
import { RecoveryCorridor } from './recovery-corridor.js';
import { openRunBoundary } from './run-boundary.js';
import {
  type GraphClosedOutcome,
  type GraphRunResult,
  closeRun,
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

export interface GraphRunnerOptions extends RuntimeExecutionCapabilities {
  readonly runDir: string;
  readonly runId?: string;
  readonly goal?: string;
  readonly why?: string;
  readonly manifestHash?: string;
  readonly manifestBytes?: Uint8Array;
  readonly workContractRef?: Ref;
  readonly recoveryRouteBindings?: readonly RecoveryRouteBindingV0[];
  readonly entryModeName?: string;
  readonly depth?: string;
  readonly axes?: Axes;
  readonly maxSteps?: number;
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

function maxAttemptsForRoute(step: ExecutableStep, recoveryRoute: boolean): number {
  return configuredMaxAttempts(step) ?? (recoveryRoute ? 2 : 1);
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
  const compiledPackage = findCompiledFlowPackageById(flow.id);
  const editFileSurfaceSources = surfaceSourcesFromDeclarations(
    compiledPackage?.reportFileSurfaces ?? {},
  );
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
    ...(options.entryModeName === undefined ? {} : { entryModeName: options.entryModeName }),
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.axes === undefined ? {} : { axes: options.axes }),
    now: boundary.clock.now,
    files,
    trace,
    externalFiles: options.externalFiles ?? boundary.externalFiles,
    // Created once for the whole run and shared by every per-step stepContext
    // spread below, so the post-step skill-hook actuator can record an `auto`
    // event's skills and the next relay step picks them up. Empty on runs with
    // no skill_hooks config, so it has no observable effect there.
    skillHookInjections: createSkillHookInjectionChannel(),
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
        compiledPackage?.engineFlags?.bindsExecutionDepthToRelaySelection === true,
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
  };
  const executors: ExecutorRegistry = {
    ...createDefaultExecutors({
      ...(options.relayConnector === undefined ? {} : { relayConnector: options.relayConnector }),
    }),
    ...options.executors,
  };
  const steps = new Map(flow.steps.map((step) => [step.id, step]));
  const sliceFlag = compiledPackage?.engineFlags?.iteratesSliceLoop;
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
  const completedStepCounts = isResume
    ? completedStepCountsFromTrace(existingTrace, sliceCorridor)
    : new Map<string, number>();
  // Re-seed skill-hook injections that the prior process recorded, so a resumed
  // implementer step does not silently run without skills an earlier (and now
  // un-re-executed) step injected. No-op on a fresh run (empty existingTrace).
  if (isResume) {
    seedSkillHookInjectionsFromTrace(existingTrace, context.skillHookInjections);
  }
  const defaultMaxSteps = Math.max(flow.steps.length * 4, 8);
  // A slice loop runs the body once per slice, each with its own retry budget,
  // so the flat step counter needs headroom the single-pass default lacks.
  const maxSteps =
    options.maxSteps ??
    (sliceFlag !== undefined && sliceCorridor.isActive()
      ? defaultMaxSteps + sliceFlag.maxSlices * 6
      : defaultMaxSteps);

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
      depth: context.depth ?? 'standard',
      change_kind: bootstrapChangeKind({
        flow,
        ...(context.entryModeName === undefined ? {} : { entryModeName: context.entryModeName }),
      }),
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
    const stepCountKey = sliceCorridor.countKey(step.id, stepSliceIndex);

    const isResumedCheckpoint = options.resumeCheckpoint?.stepId === currentStepId;
    const completedCount = completedStepCounts.get(stepCountKey) ?? 0;
    const incomingIsActiveRecovery = corridor.isActiveRoute(incomingRouteTaken);
    const maxAttempts = maxAttemptsForRoute(step, incomingIsActiveRecovery);
    const isRecoveryOriginReentry = corridor.isReturnToOrigin({
      stepId: step.id,
      route: incomingRouteTaken,
    });
    const attempt = isResumedCheckpoint ? options.resumeCheckpoint.attempt : completedCount + 1;
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
        ...(isLoopBodyStep ? { slice_index: stepSliceIndex } : {}),
      });
    }

    // Mark where this step's trace begins, so skill-hook dispatch can scan only
    // the entries this step appends (its check.evaluated / proof.assessed signals).
    const traceLengthBeforeStep = trace.getAll().length;
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
        activeStepAttempt: attempt,
        ...(acceptanceRetryFeedback === undefined ? {} : { acceptanceRetryFeedback }),
        ...(isLoopBodyStep ? { activeSliceIndex: stepSliceIndex } : {}),
        ...(activeSlice === undefined ? {} : { activeSlice }),
        ...(isResumedCheckpoint && options.resumeCheckpoint !== undefined
          ? { resumeCheckpoint: options.resumeCheckpoint }
          : {}),
      };
      const outcome = await executors[step.kind](step, stepContext);
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
      route = outcome.route;
      details = outcome.details ?? {};
    } catch (error) {
      const message = (error as Error).message;
      const reason = isProofPlanBlockedError(error)
        ? message
        : `step '${step.id}' handler threw: ${message}`;
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
        ...(isLoopBodyStep ? { sliceIndex: stepSliceIndex } : {}),
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

    // The live slice index here is post-advance, so a slice-advance redirect
    // to the loop head reads the next slice's (empty) count rather than the
    // just-completed slice's, and is not flagged as a cycle.
    const targetCompletedCount =
      target.kind === 'step'
        ? (completedStepCounts.get(
            sliceCorridor.countKey(target.stepId, sliceCorridor.currentSliceIndex()),
          ) ?? 0)
        : 0;
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
        ? maxAttemptsForRoute(targetStep, routeHasRecoveryMechanics)
        : maxAttemptsForRoute(step, routeHasRecoveryMechanics);
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
      ...(isLoopBodyStep ? { slice_index: stepSliceIndex } : {}),
    });
    // Keyed to this step's captured slice index (pre-advance), so a tail step
    // that just advanced still records its own slice's completion, not the
    // next slice's.
    completedStepCounts.set(stepCountKey, completedCount + 1);

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
