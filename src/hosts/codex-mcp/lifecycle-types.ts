import type { McpRuntimeAssetPins } from './asset-pins.js';
import type { CircuitStartInputV1, McpRunStateV1 } from './contracts.js';

export type Awaitable<T> = T | Promise<T>;

export interface LifecycleWorkspaceIdentity {
  readonly key: string;
  readonly canonical_path: string;
  readonly device: string;
  readonly inode: string;
  readonly identity_source?: 'codex/sandbox-state-meta' | 'mcp/roots';
}

export interface LifecycleExecutableIdentity {
  readonly real_path: string;
  readonly device: string;
  readonly inode: string;
  readonly sha256: string;
}

export interface LifecycleProcessIdentity {
  readonly pid: number;
  readonly process_group_id: number;
  readonly birth_token: string;
  readonly started_at: string;
  readonly executable: LifecycleExecutableIdentity;
}

export interface LifecycleProcessOwnerIdentity extends LifecycleProcessIdentity {
  readonly instance_id: string;
}

export interface LifecycleLaunch {
  readonly generation: number;
  readonly allocation_owner: LifecycleProcessOwnerIdentity;
  readonly phase:
    | 'reserved'
    | 'supervisor_recorded'
    | 'launch_authorized'
    | 'runtime_recorded'
    | 'exited';
  readonly supervisor?: LifecycleProcessIdentity;
  readonly runtime?: LifecycleProcessIdentity;
  readonly authorization_sha256?: string;
  readonly authorized_at?: string;
  readonly exit?: {
    readonly observed_at: string;
    readonly exit_code?: number;
    readonly signal?: string;
    readonly process_group_cleanup: 'confirmed' | 'unconfirmed';
  };
}

export interface LifecycleProgressEvent {
  readonly cursor: number;
  readonly kind: string;
  readonly recorded_at: string;
  readonly summary: string;
}

export interface LifecycleCheckpointLocator {
  readonly generation: number;
  readonly step_id: string;
  readonly attempt: number;
  readonly request_path: string;
  readonly request_sha256: string;
  readonly allowed_choices: readonly string[];
  readonly choices_sha256: string;
}

export interface LifecycleFinalReportLocator {
  readonly schema: string;
  readonly path: string;
  readonly sha256: string;
  readonly byte_length: number;
  readonly summary: string;
  // Digest binding for the human-facing receipt Markdown, when the worker
  // wrote one. The reader returns its content for the host to render verbatim.
  readonly operator_summary?: {
    readonly path: string;
    readonly sha256: string;
    readonly byte_length: number;
  };
}

export interface LifecycleRecoveryEvidence {
  readonly reason: string;
  readonly detected_at: string;
  readonly last_checked_at: string;
  readonly owner_status?: 'alive' | 'absent' | 'unknown';
  readonly supervisor_status?: 'alive' | 'absent' | 'unknown';
  readonly runtime_status?: 'alive' | 'absent' | 'unknown';
  readonly process_group_status?: 'alive' | 'absent' | 'unknown';
  readonly cancellation_requested: boolean;
}

export interface LifecycleRunRecord {
  readonly revision: number;
  readonly run_id: string;
  readonly workspace: LifecycleWorkspaceIdentity;
  readonly request: CircuitStartInputV1;
  readonly state: McpRunStateV1;
  readonly summary: string;
  readonly runtime_assets_sha256: string;
  readonly updated_at: string;
  readonly allocation: {
    readonly owner: LifecycleProcessOwnerIdentity;
    readonly created_at: string;
  };
  readonly launch: LifecycleLaunch;
  readonly progress: {
    readonly next_cursor: number;
    readonly retained_from_cursor: number;
    readonly dropped_count: number;
    readonly events: readonly LifecycleProgressEvent[];
  };
  readonly checkpoint?: LifecycleCheckpointLocator;
  readonly final_report?: LifecycleFinalReportLocator;
  readonly recovery?: LifecycleRecoveryEvidence;
}

export interface LifecycleOperationHandle {
  readonly claim: {
    readonly checkpoint_binding_sha256?: string;
  };
}

export type LifecycleOperationName = 'resume' | 'cancel' | 'reconcile' | 'recover' | 'retention';

export type LifecycleAcquireResult =
  | { readonly ok: true; readonly handle: LifecycleOperationHandle }
  | {
      readonly ok: false;
      readonly code: 'operation_in_progress' | 'operation_owner_unknown';
      readonly message: string;
    };

export interface LifecycleStore {
  readonly reserveRun: (input: {
    readonly run_id: string;
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly request: CircuitStartInputV1;
    readonly runtime_assets_sha256: string;
    readonly owner: LifecycleProcessOwnerIdentity;
    readonly summary: string;
  }) => Awaitable<LifecycleRunRecord>;
  /**
   * Publishes a new run and its initial reconcile claim as one durable unit.
   * No other server may observe a claimable starting run between these writes.
   */
  readonly reserveRunClaimed: (input: {
    readonly run_id: string;
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly request: CircuitStartInputV1;
    readonly runtime_assets_sha256: string;
    readonly owner: LifecycleProcessOwnerIdentity;
    readonly summary: string;
  }) => Awaitable<{
    readonly record: LifecycleRunRecord;
    readonly handle: LifecycleOperationHandle;
  }>;
  readonly readRun: (
    workspace: LifecycleWorkspaceIdentity,
    runId: string,
  ) => Awaitable<LifecycleRunRecord>;
  readonly acquireOperation: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run_id: string;
    readonly operation: LifecycleOperationName;
    readonly owner: LifecycleProcessOwnerIdentity;
    readonly checkpoint_binding_sha256?: string;
  }) => Awaitable<LifecycleAcquireResult>;
  readonly advanceLaunch: (input: {
    readonly handle: LifecycleOperationHandle;
    readonly launch: LifecycleLaunch;
    readonly summary?: string;
  }) => Awaitable<LifecycleRunRecord>;
  readonly transitionRun: (input: {
    readonly handle: LifecycleOperationHandle;
    readonly to: McpRunStateV1;
    readonly summary: string;
    readonly launch?: LifecycleLaunch;
    readonly checkpoint?: LifecycleCheckpointLocator | null;
    readonly final_report?: LifecycleFinalReportLocator | null;
    readonly recovery?: LifecycleRecoveryEvidence | null;
    readonly failure?: { readonly code: string; readonly message: string } | null;
  }) => Awaitable<LifecycleRunRecord>;
  readonly releaseOperation: (handle: LifecycleOperationHandle) => Awaitable<void>;
  readonly listRuns: (
    workspace: LifecycleWorkspaceIdentity,
    options?: { readonly limit?: number },
  ) => Awaitable<{
    readonly runs: readonly {
      readonly run_id: string;
      readonly flow: CircuitStartInputV1['flow'];
      readonly state: McpRunStateV1;
      readonly updated_at: string;
      readonly checkpoint_available: boolean;
      readonly summary: string;
    }[];
    readonly truncated: boolean;
  }>;
  readonly recoverRun: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run_id: string;
    readonly owner: LifecycleProcessOwnerIdentity;
  }) => Awaitable<{
    readonly record: LifecycleRunRecord;
    readonly cleanup_confirmed: true;
    readonly lease_released: true;
  }>;
  /**
   * Ingests durable supervisor observations and canonical run artifacts. This
   * is also where an interrupted server closes launch crash windows.
   */
  readonly reconcileRun: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run_id: string;
    readonly owner: LifecycleProcessOwnerIdentity;
    readonly include_progress?: boolean;
  }) => Awaitable<LifecycleRunRecord>;
  readonly waitForChange?: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run_id: string;
    readonly after_revision: number;
    readonly wait_ms: number;
    readonly signal: AbortSignal;
  }) => Awaitable<void>;
  readonly controlDirectory: (
    workspace: LifecycleWorkspaceIdentity,
    runId: string,
  ) => Awaitable<string>;
}

export interface LifecycleCleanupController {
  readonly cancel: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run: LifecycleRunRecord;
  }) => Promise<{
    readonly cleanup_confirmed: boolean;
    readonly supervisor_status: 'alive' | 'absent' | 'unknown';
    readonly runtime_status?: 'alive' | 'absent' | 'unknown';
    readonly process_group_status: 'alive' | 'absent' | 'unknown';
  }>;
}

export interface LifecycleCheckpointView {
  readonly token: string;
  readonly prompt: string;
  readonly choices: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
}

export interface LifecycleCheckpointReader {
  readonly read: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run: LifecycleRunRecord;
  }) => Promise<LifecycleCheckpointView>;
  readonly assertResume: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run: LifecycleRunRecord;
    readonly checkpoint_token: string;
    readonly choice_id: string;
  }) => Promise<{ readonly checkpoint_binding_sha256: string }>;
}

export interface LifecycleReportReader {
  readonly read: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run: LifecycleRunRecord;
  }) => Promise<{
    readonly schema: string;
    readonly summary: string;
    readonly data: unknown;
    // The receipt Markdown, present when the run bound an operator summary
    // and its bytes still match. Omitted — never a failure — otherwise.
    readonly operator_summary_markdown?: string;
  }>;
}

export interface LifecycleWorkerLaunch {
  readonly worker_entrypoint: string;
  readonly launch_payload: unknown;
}

export interface LifecycleWorkerFactory<TPrepared = unknown> {
  readonly createStart: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run: LifecycleRunRecord;
    readonly authorization_token: string;
    readonly runtime_assets: McpRuntimeAssetPins;
    readonly prepared_launch: TPrepared;
  }) => Promise<LifecycleWorkerLaunch>;
  readonly createResume: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run: LifecycleRunRecord;
    readonly checkpoint_token: string;
    readonly choice_id: string;
    readonly authorization_token: string;
    readonly runtime_assets: McpRuntimeAssetPins;
    readonly prepared_launch: TPrepared;
  }) => Promise<LifecycleWorkerLaunch>;
}
