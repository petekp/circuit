import type { LayeredConfig as LayeredConfigValue } from '../../schemas/config.js';
import type { HostKind } from '../../schemas/host.js';
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
  // Absolute path to the git repository the worktree belongs to. Used as the
  // working directory for `git worktree add` so it targets THIS repo instead of
  // the caller's process cwd. Optional: when omitted the runner falls back to
  // process.cwd() (the historical behavior). Callers that know the project root
  // (fan-out branches, reclaim) always pass it so a non-cwd `--project-root`
  // invocation provisions in the right repository.
  readonly repoRoot?: string;
}

export interface WorktreeRunner {
  add(input: WorktreeProvisionInput): void | Promise<void>;
  // `repoRoot` is the git repository the worktree belongs to; the runner uses it
  // as the working directory for `git worktree remove` so cleanup targets the
  // right repo regardless of process cwd. Optional for the same reason as on
  // add: absence preserves the process.cwd() fallback.
  remove(worktreePath: string, repoRoot?: string): void | Promise<void>;
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
  // Recursion bound carried from the parent's sub-run executor into this child
  // invocation: the child's run-context seeds itself from these instead of the
  // top-level defaults, so depth and the ancestor chain accumulate across the
  // real run boundary. Absent on a top-level invocation (seeds depth 0).
  readonly recursionDepth?: number;
  readonly recursionAncestors?: ReadonlySet<string>;
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
  readonly proofCommandRunner?: (
    command: ProofPlanCommand,
    projectRoot: string,
  ) => Promise<ProofPlanCommandObservation>;
  readonly gitReader?: RuntimeGitReader;
  readonly maxSteps?: number;
}

export type CompiledFlowRunner = (options: CompiledFlowRunOptions) => Promise<GraphRunResult>;
