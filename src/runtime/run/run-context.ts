import type { RuntimePackageIndex } from '../../flows/registries/runtime-index.js';
import type { Axes } from '../../schemas/axes.js';
import type { CheckpointReviewComment } from '../../schemas/checkpoint-review-response.js';
import type { RecoveryRouteBindingV0 } from '../../schemas/recovery-route-kind.js';
import type { Ref } from '../../schemas/ref.js';
import type { PowerInferenceChannel } from '../../selection/power-inference.js';
import type { UserSkillRegistry } from '../../shared/user-skill-registry.js';
import type { SkillHookInjectionChannel } from '../../skill-hooks/injection.js';
import type { AcceptanceRetryFeedback } from '../acceptance-criteria.js';
import type { RunId } from '../domain/run.js';
import type { ExecutableFlow } from '../manifest/executable-flow.js';
import type { RunFileStore } from '../run-files/run-file-store.js';
import type { TraceStore } from '../trace/trace-store.js';
import type { RuntimeExecutionCapabilities } from './capabilities.js';
import type { DeliveredContextSlice } from './context-delivery.js';
import type { ExternalFileReader } from './external-files.js';
import type { HonestyLedger } from './honesty-ledger.js';
import type { OracleCommandPinChannel } from './oracle-command-pin.js';

export interface RunContext
  extends Omit<RuntimeExecutionCapabilities, 'executors' | 'progressSurface'> {
  readonly flow: ExecutableFlow;
  readonly packageIndex: RuntimePackageIndex;
  readonly runId: RunId;
  readonly runDir: string;
  readonly goal: string;
  // Operator-stated reason behind the goal (--why). Optional, unlike goal:
  // when absent, relay prompts are byte-identical to runs before the flag.
  readonly why?: string;
  readonly manifestHash: string;
  // A prior crashed run's folder to reuse finished children from (the
  // `--reuse-children-from` restart pointer). Run-state, not a capability:
  // present only on a fresh top-level run an operator explicitly pointed at a
  // dead folder, and deliberately NOT forwarded to child runs (children never
  // reuse-from). A sub-run fanout branch consults it before running its child;
  // when set, a prior finished isolating-worktree branch is admitted from disk
  // instead of re-run. Absent => reuse is inert and every child runs fresh.
  readonly reuseChildrenFrom?: string;
  readonly workContractRef?: Ref;
  readonly recoveryRouteBindings?: readonly RecoveryRouteBindingV0[];
  readonly entryModeName?: string;
  readonly depth?: string;
  readonly axes?: Axes;
  // Set by the run invocation (never by a flow) when no operator is present to
  // answer a checkpoint and no external resume driver can clear it — e.g. a
  // composed/nested flow running inside another run, or a batch/headless host.
  // The checkpoint executor honors this by reaching a terminal outcome instead
  // of parking at checkpoint_waiting forever (see resolveCheckpoint). Absent on
  // every interactive top-level run, so attended runs are unaffected.
  readonly unattended?: boolean;
  // Recursion bound, threaded parent-to-child like unattended (run-state, not a
  // capability). A top-level run seeds depth 0 and ancestors = { this flow id };
  // the sub-run executor descends one level and adds the child id before handing
  // off, so the depth cap and the cycle guard both have what they need. Absent on
  // a freshly constructed context defaults to depth 0 / a single-id ancestor set.
  // The ancestor set is forwarded in-process by reference and must never be
  // serialized to JSON or disk (a Set stringifies to `{}`); see the seed comment
  // in graph-runner for the invariants that keep this bound intact.
  readonly recursionDepth?: number;
  readonly recursionAncestors?: ReadonlySet<string>;
  readonly guidanceSelection?: {
    readonly bindsExecutionDepthToGuidanceSelection: boolean;
  };
  readonly now: () => Date;
  readonly files: RunFileStore;
  readonly trace: TraceStore;
  readonly externalFiles: ExternalFileReader;
  readonly activeStepAttempt?: number;
  readonly acceptanceRetryFeedback?: AcceptanceRetryFeedback;
  // Set by the graph-runner on a loop-body step during an active slice loop
  // (deep-depth Build): the 0-based index of the slice being executed and the
  // slice's metadata, so executors can tag trace entries and the relay prompt
  // can scope the worker to the current slice. Absent on single-pass runs.
  readonly activeSliceIndex?: number;
  readonly activeSlice?: unknown;
  // Pull-then-retry delivery: set by the graph-runner ONLY on the bounded re-run
  // of a step whose typed context_request was resolved. Carries the answered
  // slices the relay prompt folds in (deliveredContextSection). Absent on every
  // first-pass step and every run with delivery off, so those prompts are
  // byte-identical to before this channel. In-process only — never serialized.
  readonly deliveredContextSlices?: readonly DeliveredContextSlice[];
  // True when on-demand context-pull DELIVERY is active for this run's relays:
  // delivery is opted in (`enableContextDelivery`) AND this run is not a
  // delivery-blind slice corridor (deep depth, where delivery-in-corridor stays
  // deferred). Run-wide and stable. A compose writer reads it (via
  // ComposeBuildContext) to decide whether it may hand a downstream relay a thin
  // envelope and let the relay pull what it withheld. Absent => fat/full
  // provisioning, byte-identical to before this signal. Never serialized.
  readonly contextDeliveryActive?: boolean;
  // Run-scoped accumulator for skill-hook actuation: the post-step dispatcher
  // adds an `auto` hook event's resolved skills here, and planRelayGuidanceDecision
  // merges them into the next relay step's loaded skills. A mutable container on
  // the otherwise-readonly context, created once and shared by every stepContext
  // spread, so writes between steps are visible to later steps. See
  // src/skill-hooks/injection.ts.
  readonly skillHookInjections?: SkillHookInjectionChannel;
  // Run-scoped resolution of an `auto` power dial: the post-step seam writes
  // the first accepted researcher recommendation here (clamped to operator
  // bounds), and planRelayGuidanceDecision reads it when materializing the
  // dial. Same mutable-container-on-readonly-context pattern as
  // skillHookInjections; first write wins. See src/selection/power-inference.ts.
  readonly powerInference?: PowerInferenceChannel;
  // One skill registry per run, created at run start. Shared by the skill-hook
  // dispatcher (which resolves an event's triggered/unavailable skills) and the
  // relay skill loader (which loads selection, slot, and injected skills), so the
  // recorded run.skill-hook event cannot disagree with what the relay actually
  // loads, and the whole run reads one filesystem snapshot (deterministic; no
  // mid-run TOCTOU between dispatch and a later relay).
  readonly skillRegistry?: UserSkillRegistry;
  readonly resumeCheckpoint?: {
    readonly stepId: string;
    readonly attempt: number;
    readonly selection: string;
    readonly comments?: readonly CheckpointReviewComment[];
  };
  // The until-loop honesty ledger: open overclaim/exhaustion latches the body
  // loop accrued this run. Seeded by the graph-runner only when an until flag
  // with a stop-judge is active; absent on every other run. A mutable object on
  // the otherwise-readonly context (same pattern as skillHookInjections), so the
  // tail seam, the evidence floor, and the close path all read one shared ledger.
  // The close path's finalize chokepoint reads its open latches to keep a run
  // from closing complete while an overclaim is still unresolved.
  readonly honestyLedger?: HonestyLedger;
  // The until-loop oracle-command pin: snapshots each judge-gated verification
  // step's resolved command list at first resolution and serves it on every
  // later wave, so a worker cannot narrow the command in its plan or swap the
  // referenced package-script body between waves to fake a green. Seeded by the
  // graph-runner under the same gate as honestyLedger (a stop-judge until flag);
  // absent on every other run, so non-looped verification is byte-identical to
  // before this channel. A mutable container on the otherwise-readonly context
  // (same pattern as honestyLedger); keyed per step id.
  readonly oracleCommandPins?: OracleCommandPinChannel;
}
