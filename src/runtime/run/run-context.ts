import type { RuntimePackageIndex } from '../../flows/registries/runtime-index.js';
import type { Axes } from '../../schemas/axes.js';
import type { RecoveryRouteBindingV0 } from '../../schemas/recovery-route-kind.js';
import type { Ref } from '../../schemas/ref.js';
import type { UserSkillRegistry } from '../../shared/user-skill-registry.js';
import type { SkillHookInjectionChannel } from '../../skill-hooks/injection.js';
import type { AcceptanceRetryFeedback } from '../acceptance-criteria.js';
import type { RunId } from '../domain/run.js';
import type { ExecutableFlow } from '../manifest/executable-flow.js';
import type { RunFileStore } from '../run-files/run-file-store.js';
import type { TraceStore } from '../trace/trace-store.js';
import type { RuntimeExecutionCapabilities } from './capabilities.js';
import type { ExternalFileReader } from './external-files.js';

export interface RunContext
  extends Omit<RuntimeExecutionCapabilities, 'executors' | 'progressSurface'> {
  readonly flow: ExecutableFlow;
  readonly packageIndex: RuntimePackageIndex;
  readonly runId: RunId;
  readonly runDir: string;
  readonly goal: string;
  readonly manifestHash: string;
  readonly workContractRef?: Ref;
  readonly recoveryRouteBindings?: readonly RecoveryRouteBindingV0[];
  readonly entryModeName?: string;
  readonly depth?: string;
  readonly axes?: Axes;
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
  // (deep-rigor Build): the 0-based index of the slice being executed and the
  // slice's metadata, so executors can tag trace entries and the relay prompt
  // can scope the worker to the current slice. Absent on single-pass runs.
  readonly activeSliceIndex?: number;
  readonly activeSlice?: unknown;
  // Run-scoped accumulator for skill-hook actuation: the post-step dispatcher
  // adds an `auto` hook event's resolved skills here, and planRelayGuidanceDecision
  // merges them into the next relay step's loaded skills. A mutable container on
  // the otherwise-readonly context, created once and shared by every stepContext
  // spread, so writes between steps are visible to later steps. See
  // src/skill-hooks/injection.ts.
  readonly skillHookInjections?: SkillHookInjectionChannel;
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
  };
}
