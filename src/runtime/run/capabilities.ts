import type { CompiledFlowProgressSurface } from '../../flows/types.js';
import type { LayeredConfig as LayeredConfigValue } from '../../schemas/config.js';
import type { HostKind } from '../../schemas/host.js';
import type {
  HistoryRecallPrecisionV1 as HistoryRecallPrecisionValue,
  HistoryRecallReportV1 as HistoryRecallReportValue,
  MemoryInputV0 as MemoryInputValue,
} from '../../schemas/index.js';
import type { PolicyLayer as PolicyLayerValue } from '../../schemas/policy-envelope.js';
import type { ProofPlanCommand, ProofPlanCommandObservation } from '../../shared/proof-plan.js';
import type {
  ProgressReporter,
  RelayFn,
  RuntimeEvidencePolicy,
} from '../../shared/relay-runtime-types.js';
import type { RuntimeGitReader } from '../../shared/runtime-git-reader.js';
import type { ExecutorRegistry } from '../executors/index.js';
import type { RelayConnector } from '../executors/relay.js';
import type {
  ChildCompiledFlowResolver,
  CompiledFlowRunner,
  WorktreeRunner,
} from './child-runner.js';
import type { ExternalFileReader } from './external-files.js';

export const RUNTIME_CAPABILITY_NAMES = [
  'now',
  'executors',
  'childExecutors',
  'childCompiledFlowResolver',
  'childRunner',
  'externalFiles',
  'projectRoot',
  'evidencePolicy',
  'worktreeRunner',
  'relayConnector',
  'relayer',
  'hostKind',
  'selectionConfigLayers',
  'policyLayers',
  'progress',
  'progressSurface',
  'memoryInputs',
  'historyRecallReport',
  'historyRecallPrecision',
  'proofCommandRunner',
  'gitReader',
] as const;

export type RuntimeCapabilityName = (typeof RUNTIME_CAPABILITY_NAMES)[number];

export interface RuntimeExecutionCapabilities {
  readonly now?: () => Date;
  readonly executors?: Partial<ExecutorRegistry>;
  readonly childExecutors?: Partial<ExecutorRegistry>;
  readonly childCompiledFlowResolver?: ChildCompiledFlowResolver;
  readonly childRunner?: CompiledFlowRunner;
  readonly externalFiles?: ExternalFileReader;
  readonly projectRoot?: string;
  readonly evidencePolicy?: RuntimeEvidencePolicy;
  readonly worktreeRunner?: WorktreeRunner;
  readonly relayConnector?: RelayConnector;
  readonly relayer?: RelayFn;
  readonly hostKind?: HostKind;
  readonly selectionConfigLayers?: readonly LayeredConfigValue[];
  readonly policyLayers?: readonly PolicyLayerValue[];
  readonly progress?: ProgressReporter;
  readonly progressSurface?: CompiledFlowProgressSurface;
  readonly memoryInputs?: readonly MemoryInputValue[];
  readonly historyRecallReport?: HistoryRecallReportValue;
  readonly historyRecallPrecision?: HistoryRecallPrecisionValue;
  readonly proofCommandRunner?: (
    command: ProofPlanCommand,
    projectRoot: string,
  ) => Promise<ProofPlanCommandObservation>;
  readonly gitReader?: RuntimeGitReader;
}
