import type { RuntimePackageIndex } from '../../flows/registries/runtime-index.js';
import type { Axes } from '../../schemas/axes.js';
import type { RecoveryRouteBindingV0 } from '../../schemas/recovery-route-kind.js';
import type { Ref } from '../../schemas/ref.js';
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
  readonly resumeCheckpoint?: {
    readonly stepId: string;
    readonly attempt: number;
    readonly selection: string;
  };
}
