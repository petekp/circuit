// Runtime graph execution loop.
//
// Owns step advancement for one run folder: bootstrap trace, step attempts,
// recovery routes, checkpoint waiting, terminal closure, and result.json.
// Flow-specific behavior belongs in executors and flow registries; the runner
// only interprets the executable graph and appends durable trace entries.

import { randomUUID } from 'node:crypto';
import type { SliceLoopEngineFlag } from '../../flows/types.js';
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
import {
  type ContextDeliveryGuard,
  type DeliveredContextSlice,
  type RetryEvaluation,
  decideContextDeliveryOutcome,
} from './context-delivery.js';
import { type ContextPuller, type ContextRequest, extractContextRequest } from './context-pull.js';
import { resolveEngineFlags } from './engine-flags.js';
import { type EquipmentReshaper, extractEquipmentDiscovery } from './equipment-reshape.js';
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
  };
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
    const stepCountKey = sliceCorridor.countKey(step.id, stepSliceIndex);

    const isResumedCheckpoint = options.resumeCheckpoint?.stepId === currentStepId;
    const completedCount = completedStepCounts.get(stepCountKey) ?? 0;
    const incomingIsActiveRecovery = corridor.isActiveRoute(incomingRouteTaken);
    const maxAttempts = maxAttemptsForRoute(step, incomingIsActiveRecovery);
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
        ...(acceptanceRetryFeedback === undefined ? {} : { acceptanceRetryFeedback }),
        ...(isLoopBodyStep ? { activeSliceIndex: stepSliceIndex } : {}),
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
    // delivered back into the step here, so the run is never altered. When
    // delivery is ENABLED the early seam above already resolved, recorded, AND
    // delivered this step's request, so this seam is skipped (guarded on
    // `contextDelivery === undefined`) to avoid recording the same pull twice.
    // Inert unless the live path injected `contextPuller`; skipped on the terminal
    // step and inside a slice loop, mirroring the reshape seam. The slice-loop skip
    // is over-conservative here (context-pull never mutates, so the reshape reason
    // — slice-scoped completion keys — does not apply): a request surfaced inside a
    // corridor is dropped WITHOUT a finding, the one refusal path not made legible.
    // Lifting the skip (resolve + record inside corridors too) is a battle-test
    // item, gated on a deep-depth test; kept conservative and faithful for now.
    // Best-effort and fail-safe: any failure leaves the run untouched.
    if (
      options.contextPuller !== undefined &&
      options.contextDelivery === undefined &&
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
