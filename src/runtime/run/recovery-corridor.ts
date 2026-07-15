// The recovery-corridor state machine.
//
// A run enters a "recovery corridor" when a step takes a recovery route: later
// steps may legitimately re-enter already-completed steps until the corridor
// returns to its origin. This object owns that lifecycle (the activeRecovery
// state) so the graph-runner loop no longer mutates it inline. Methods are
// intention-revealing: the loop asks the corridor questions (is this the active
// route? is this a return to origin? what evidence backs the corridor?) and
// tells it about transitions (enter on a recovery route, clear when the origin
// step completes without recovery mechanics).
//
// This is a pure relocation of already-pure helpers; it performs no IO. The two
// graph-mechanics dependencies it needs — the "does this route carry recovery
// mechanics" predicate and the "latest step report / relay ref" resolver — are
// injected so the corridor stays decoupled from the loop's other concerns.

import type {
  RecoveryFailureCause,
  RecoveryRouteBindingV0,
} from '../../schemas/recovery-route-kind.js';
import type { Ref } from '../../schemas/ref.js';
import type { TraceEntry } from '../domain/trace.js';
import type { ExecutableStep } from '../manifest/executable-flow.js';
import type { RecoveryFailureEvidence } from './recovery-binding-verdict.js';
import type { RelayRetryFeedback } from './relay-retry-feedback.js';

interface ActiveRecovery {
  readonly originStepId: string;
  readonly route: string;
  readonly reason?: string;
  readonly failure?: RecoveryFailureEvidence;
  readonly retryFeedback?: RelayRetryFeedback;
}

/** Decides whether a route on a step carries WorkContract recovery mechanics. */
export type RouteHasRecoveryMechanics = (input: {
  readonly step: ExecutableStep;
  readonly route: string | undefined;
}) => boolean;

/** Resolves the latest step.report_written / relay.result ref for an attempt. */
export type LatestStepReportOrRelayRef = (input: {
  readonly stepId: string;
  readonly attempt: number;
}) => Ref | undefined;

export interface RecoveryCorridorDeps {
  readonly steps: ReadonlyMap<string, ExecutableStep>;
  readonly bindings: readonly RecoveryRouteBindingV0[] | undefined;
  readonly routeHasRecoveryMechanics: RouteHasRecoveryMechanics;
  readonly latestStepReportOrRelayRef: LatestStepReportOrRelayRef;
}

export interface CorridorEnterInput {
  readonly originStepId: string;
  readonly route: string;
  readonly recoveryReason: unknown;
  readonly recoveryFailure: RecoveryFailureEvidence | undefined;
  readonly retryFeedback: RelayRetryFeedback | undefined;
}

export class RecoveryCorridor {
  private active: ActiveRecovery | undefined;

  constructor(private readonly deps: RecoveryCorridorDeps) {}

  /** True when `route` is the recovery route this corridor is currently traversing. */
  isActiveRoute(route: string | undefined): boolean {
    return route !== undefined && this.active?.route === route;
  }

  /**
   * True when stepping into `stepId` via `route` is a return toward the corridor
   * origin through non-recovery routes (so re-entering a completed step is legal).
   */
  isReturnToOrigin(input: {
    readonly stepId: string;
    readonly route: string | undefined;
  }): boolean {
    const active = this.active;
    if (active === undefined || this.isActiveRoute(input.route)) return false;
    return this.canReachStepViaNonRecoveryRoutes({
      fromStepId: input.stepId,
      targetStepId: active.originStepId,
    });
  }

  /** The "; last recovery reason: ..." suffix for cycle/budget abort messages. */
  lastReasonSuffix(): string {
    return this.active?.reason === undefined ? '' : `; last recovery reason: ${this.active.reason}`;
  }

  /**
   * Relay retry feedback to surface when `stepId` re-enters as the corridor
   * origin via the active recovery route.
   */
  retryFeedbackForReentry(input: {
    readonly stepId: string;
    readonly incomingRoute: string | undefined;
  }): RelayRetryFeedback | undefined {
    if (this.active?.originStepId !== input.stepId) return undefined;
    if (!this.isActiveRoute(input.incomingRoute)) return undefined;
    return this.active.retryFeedback;
  }

  /**
   * Failure evidence derived from the active corridor (when the completed route
   * has recovery mechanics but no direct failure evidence of its own).
   */
  evidenceFor(input: {
    readonly stepId: string;
    readonly attempt: number;
    readonly binding: RecoveryRouteBindingV0 | undefined;
  }): RecoveryFailureEvidence | undefined {
    const active = this.active;
    if (active?.failure === undefined) return undefined;
    const ref = this.deps.latestStepReportOrRelayRef({
      stepId: input.stepId,
      attempt: input.attempt,
    });
    if (ref === undefined) return undefined;
    return { ref, cause: corridorCause(active, input.binding) };
  }

  /** Enter / advance the corridor when a step takes a recovery route. */
  enter(input: CorridorEnterInput): void {
    const base: ActiveRecovery = {
      originStepId: input.originStepId,
      route: input.route,
      ...(input.recoveryFailure === undefined ? {} : { failure: input.recoveryFailure }),
      ...(input.retryFeedback === undefined ? {} : { retryFeedback: input.retryFeedback }),
    };
    this.active =
      typeof input.recoveryReason === 'string' ? { ...base, reason: input.recoveryReason } : base;
  }

  /**
   * Clear the corridor when its origin step completes without taking a recovery
   * route (the corridor has returned and exited).
   */
  clearIfExitingOrigin(input: {
    readonly stepId: string;
    readonly routeHasRecoveryMechanics: boolean;
  }): void {
    if (
      this.active !== undefined &&
      this.active.originStepId === input.stepId &&
      !input.routeHasRecoveryMechanics
    ) {
      this.active = undefined;
    }
  }

  /**
   * Checkpoint-resume reseed: replay the durable `step.completed` entries so a
   * resumed run lands on the same STRUCTURAL corridor identity (which recovery
   * route is active, with what origin step) the prior process held. Mirrors
   * seedSkillHookInjectionsFromTrace / seedPowerInferenceFromTrace: a fold over
   * existing trace entries into the in-memory channel, applying the exact
   * enter / clearIfExitingOrigin transitions the live loop applies after each
   * step completes (graph-runner: enter on a recovery-mechanics route, then
   * clearIfExitingOrigin when the origin re-completes without mechanics).
   *
   * Faithfulness boundary — read before relying on this. The durable
   * `step.completed` entry carries only `route_taken` (+ ids/attempt/slice).
   * The live `enter()` also took executor-outcome fields — `recoveryReason`
   * (details.reason), `recoveryFailure`, and `retryFeedback`
   * (details.retry_feedback) — that are NOT persisted to the trace. This
   * reseed therefore restores ONLY the structural fields (originStepId, route)
   * and deliberately leaves the payload fields undefined. The consequence is
   * exact: after reseed `lastReasonSuffix()` returns '' and
   * `retryFeedbackForReentry()` returns undefined even where the live run
   * carried a reason / feedback. `evidenceFor()` likewise has no seeded failure
   * to surface. That payload gap is the spec line for the full cursor
   * (docs/ideas/durability-tier2-cursor-spec.md); restoring it requires
   * persisting those fields, which is out of scope for this foundation slice.
   *
   * This is plumbing ahead of its consumer: no current code path resumes at an
   * arbitrary step.completed, so this is inert until a Tier-2 cursor calls it.
   */
  seedFromTrace(entries: readonly TraceEntry[]): void {
    for (const entry of entries) {
      if (entry.kind !== 'step.completed') continue;
      const step = this.deps.steps.get(entry.step_id);
      if (step === undefined) continue;
      const route = entry.route_taken;
      const routeHasRecoveryMechanics = this.deps.routeHasRecoveryMechanics({ step, route });
      // Same order as the live loop (graph-runner ~697-726): enter on a
      // recovery-mechanics route, then clear if the origin exits without
      // mechanics. Structural fields only — payload is honestly absent (see
      // the faithfulness note above).
      if (routeHasRecoveryMechanics) {
        this.enter({
          originStepId: entry.step_id,
          route,
          recoveryReason: undefined,
          recoveryFailure: undefined,
          retryFeedback: undefined,
        });
      }
      this.clearIfExitingOrigin({ stepId: entry.step_id, routeHasRecoveryMechanics });
    }
  }

  private canReachStepViaNonRecoveryRoutes(input: {
    readonly fromStepId: string;
    readonly targetStepId: string;
  }): boolean {
    if (input.fromStepId === input.targetStepId) return true;
    const seen = new Set<string>();
    const queue = [input.fromStepId];

    for (let index = 0; index < queue.length; index += 1) {
      const stepId = queue[index];
      if (stepId === undefined || seen.has(stepId)) continue;
      seen.add(stepId);
      const step = this.deps.steps.get(stepId);
      if (step === undefined) continue;
      for (const [route, target] of Object.entries(step.routes)) {
        if (this.deps.routeHasRecoveryMechanics({ step, route }) || target.kind !== 'step') {
          continue;
        }
        if (target.stepId === input.targetStepId) return true;
        queue.push(target.stepId);
      }
    }

    return false;
  }
}

function corridorCause(
  active: ActiveRecovery,
  binding: RecoveryRouteBindingV0 | undefined,
): RecoveryFailureCause {
  if (
    binding?.kind === 'checkpoint_authority' &&
    binding.allowed_failure_causes.includes('checkpoint_boundary')
  ) {
    return 'checkpoint_boundary';
  }
  return active.failure?.cause ?? 'unknown_failure';
}
