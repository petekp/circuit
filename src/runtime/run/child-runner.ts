import type { LayeredConfig as LayeredConfigValue } from '../../schemas/config.js';
import type { HostKind } from '../../schemas/host.js';
import type { PolicyLayer as PolicyLayerValue } from '../../schemas/policy-envelope.js';
import type {
  ProgressReporter,
  RelayFn,
  RuntimeEvidencePolicy,
} from '../../shared/relay-runtime-types.js';
import type { ExecutorRegistry } from '../executors/index.js';
import type { RelayConnector } from '../executors/relay.js';
import type { ExternalFileReader } from './external-files.js';
import type { GraphRunResult } from './run-close.js';

export interface ChildFlowRef {
  readonly flowId: string;
  readonly entryMode: string;
  readonly version?: string;
}

export interface ResolvedChildFlow {
  readonly flowBytes: Uint8Array;
}

export type ChildCompiledFlowResolver = (
  ref: ChildFlowRef,
) => ResolvedChildFlow | Promise<ResolvedChildFlow>;

export interface WorktreeProvisionInput {
  readonly worktreePath: string;
  readonly baseRef: string;
  readonly branchName: string;
}

export interface WorktreeRunner {
  add(input: WorktreeProvisionInput): void | Promise<void>;
  remove(worktreePath: string): void | Promise<void>;
  changedFiles?(
    worktreePath: string,
    baseRef: string,
  ): readonly string[] | Promise<readonly string[]>;
}

export interface CompiledFlowRunOptions {
  readonly flowBytes: Uint8Array;
  readonly runDir: string;
  readonly runId?: string;
  readonly goal: string;
  readonly entryModeName?: string;
  readonly depth?: string;
  // Inherited from the parent run so a composed/nested child reaches a terminal
  // outcome instead of parking at a checkpoint with no operator to answer it.
  // Forwarded by the sub-run and fanout-branch executors; consumed in
  // resolveCheckpoint. Latent until a run invocation sets the parent unattended.
  readonly unattended?: boolean;
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
  readonly maxSteps?: number;
}

export type CompiledFlowRunner = (options: CompiledFlowRunOptions) => Promise<GraphRunResult>;
