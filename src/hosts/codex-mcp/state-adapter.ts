import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertCheckpointResume,
  checkpointBindingSha256,
  readCheckpointView,
} from './checkpoint-view.js';
import type {
  LifecycleCheckpointReader,
  LifecycleExecutableIdentity,
  LifecycleOperationHandle,
  LifecycleProcessOwnerIdentity,
  LifecycleRunRecord,
  LifecycleStore,
  LifecycleWorkspaceIdentity,
} from './lifecycle-types.js';
import { CODEX_SANDBOX_METADATA_KEY } from './resources.js';
import type {
  McpRunRecord,
  McpStateStore,
  McpWorkspaceIdentity,
  OperationHandle,
  ProcessIdentity,
  ProcessOwnerIdentity,
  ProcessStatus,
  StoredCheckpoint,
  StoredLaunch,
  StoredRecovery,
} from './state-store.js';
import {
  type SupervisorJournalObservations,
  readSupervisorJournals,
} from './supervisor-journal.js';
import { SupervisorProgressError, readSupervisorProgress } from './supervisor-progress.js';

type ExitObservation = NonNullable<SupervisorJournalObservations['exit']>;

export type RuntimeExitClassification =
  | {
      readonly state: 'complete';
      readonly summary: string;
      readonly final_report: NonNullable<McpRunRecord['final_report']>;
    }
  | {
      readonly state: 'waiting_for_input';
      readonly summary: string;
      readonly checkpoint: StoredCheckpoint;
    }
  | {
      readonly state: 'needs_attention' | 'interrupted';
      readonly summary: string;
      readonly failure?: { readonly code: string; readonly message: string };
    };

export interface RuntimeArtifactReconciler {
  readonly classifyExit: (input: {
    readonly record: McpRunRecord;
    readonly exit: ExitObservation;
  }) => Promise<RuntimeExitClassification>;
}

export interface McpLifecycleStateAdapterOptions {
  readonly store: McpStateStore;
  readonly artifacts: RuntimeArtifactReconciler;
  readonly inspectProcess: (identity: ProcessIdentity) => ProcessStatus;
  readonly inspectProcessGroup: (identity: ProcessIdentity) => ProcessStatus;
  readonly retainedTerminalRuns?: number;
  readonly now?: () => Date;
}

function stateWorkspace(workspace: LifecycleWorkspaceIdentity): McpWorkspaceIdentity {
  return workspace as McpWorkspaceIdentity;
}

function stateOwner(owner: LifecycleProcessOwnerIdentity): ProcessOwnerIdentity {
  return owner as ProcessOwnerIdentity;
}

function stateHandle(handle: LifecycleOperationHandle): OperationHandle {
  return handle as OperationHandle;
}

function lifecycleRecord(record: McpRunRecord): LifecycleRunRecord {
  return record as LifecycleRunRecord;
}

function withExecutable(
  observation: {
    readonly pid: number;
    readonly process_group_id: number;
    readonly birth_token: string;
    readonly started_at: string;
  },
  executable: LifecycleExecutableIdentity,
): ProcessIdentity {
  return { ...observation, executable };
}

function recovery(
  now: () => Date,
  reason: string,
  statuses: Partial<
    Pick<
      StoredRecovery,
      'owner_status' | 'supervisor_status' | 'runtime_status' | 'process_group_status'
    >
  >,
  cancellationRequested = false,
): StoredRecovery {
  const timestamp = now().toISOString();
  return {
    reason,
    detected_at: timestamp,
    last_checked_at: timestamp,
    cancellation_requested: cancellationRequested,
    ...statuses,
  };
}

function exited(
  launch: StoredLaunch,
  now: () => Date,
  cleanup: 'confirmed' | 'unconfirmed',
  evidence: Partial<NonNullable<StoredLaunch['exit']>> = {},
): StoredLaunch {
  return {
    ...launch,
    phase: 'exited',
    exit: {
      observed_at: evidence.observed_at ?? now().toISOString(),
      process_group_cleanup: cleanup,
      ...(evidence.exit_code === undefined ? {} : { exit_code: evidence.exit_code }),
      ...(evidence.signal === undefined ? {} : { signal: evidence.signal }),
    },
  };
}

function allAbsent(statuses: readonly ProcessStatus[]): boolean {
  return statuses.length > 0 && statuses.every((status) => status === 'absent');
}

function anyUnknown(statuses: readonly ProcessStatus[]): boolean {
  return statuses.includes('unknown');
}

export class McpLifecycleStateAdapter implements LifecycleStore {
  readonly #store: McpStateStore;
  readonly #artifacts: RuntimeArtifactReconciler;
  readonly #inspectProcess: (identity: ProcessIdentity) => ProcessStatus;
  readonly #inspectProcessGroup: (identity: ProcessIdentity) => ProcessStatus;
  readonly #retainedTerminalRuns: number | undefined;
  readonly #now: () => Date;

  constructor(options: McpLifecycleStateAdapterOptions) {
    this.#store = options.store;
    this.#artifacts = options.artifacts;
    this.#inspectProcess = options.inspectProcess;
    this.#inspectProcessGroup = options.inspectProcessGroup;
    this.#retainedTerminalRuns = options.retainedTerminalRuns;
    this.#now = options.now ?? (() => new Date());
  }

  reserveRun(input: Parameters<LifecycleStore['reserveRun']>[0]): LifecycleRunRecord {
    if (this.#retainedTerminalRuns !== undefined) {
      this.#store.pruneTerminalRuns({
        workspace: stateWorkspace(input.workspace),
        owner: stateOwner(input.owner),
        retain: this.#retainedTerminalRuns,
      });
    }
    return lifecycleRecord(
      this.#store.reserveRun({
        ...input,
        workspace: stateWorkspace(input.workspace),
        owner: stateOwner(input.owner),
      }),
    );
  }

  reserveRunClaimed(
    input: Parameters<LifecycleStore['reserveRunClaimed']>[0],
  ): ReturnType<LifecycleStore['reserveRunClaimed']> {
    if (this.#retainedTerminalRuns !== undefined) {
      this.#store.pruneTerminalRuns({
        workspace: stateWorkspace(input.workspace),
        owner: stateOwner(input.owner),
        retain: this.#retainedTerminalRuns,
      });
    }
    const reserved = this.#store.reserveRunClaimed({
      ...input,
      workspace: stateWorkspace(input.workspace),
      owner: stateOwner(input.owner),
    });
    return {
      record: lifecycleRecord(reserved.record),
      handle: reserved.handle as unknown as LifecycleOperationHandle,
    };
  }

  readRun(workspace: LifecycleWorkspaceIdentity, runId: string): LifecycleRunRecord {
    return lifecycleRecord(this.#store.readRun(stateWorkspace(workspace), runId));
  }

  acquireOperation(input: Parameters<LifecycleStore['acquireOperation']>[0]) {
    const acquired = this.#store.acquireOperation({
      workspace: stateWorkspace(input.workspace),
      run_id: input.run_id,
      operation: input.operation,
      owner: stateOwner(input.owner),
      ...(input.checkpoint_binding_sha256 === undefined
        ? {}
        : { checkpoint_binding_sha256: input.checkpoint_binding_sha256 }),
    });
    return acquired.ok
      ? { ok: true as const, handle: acquired.handle as unknown as LifecycleOperationHandle }
      : acquired;
  }

  advanceLaunch(input: Parameters<LifecycleStore['advanceLaunch']>[0]): LifecycleRunRecord {
    return lifecycleRecord(
      this.#store.advanceLaunch({
        handle: stateHandle(input.handle),
        launch: input.launch as StoredLaunch,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      }),
    );
  }

  transitionRun(input: Parameters<LifecycleStore['transitionRun']>[0]): LifecycleRunRecord {
    return lifecycleRecord(
      this.#store.transitionRun({
        handle: stateHandle(input.handle),
        to: input.to,
        summary: input.summary,
        ...(input.launch === undefined ? {} : { launch: input.launch as StoredLaunch }),
        ...(input.checkpoint === undefined
          ? {}
          : { checkpoint: input.checkpoint as StoredCheckpoint | null }),
        ...(input.final_report === undefined
          ? {}
          : {
              final_report: input.final_report as NonNullable<McpRunRecord['final_report']> | null,
            }),
        ...(input.failure === undefined ? {} : { failure: input.failure }),
        ...(input.recovery === undefined
          ? {}
          : { recovery: input.recovery as StoredRecovery | null }),
      }),
    );
  }

  releaseOperation(handle: LifecycleOperationHandle): void {
    this.#store.releaseOperation(stateHandle(handle));
  }

  listRuns(workspace: LifecycleWorkspaceIdentity, options: { readonly limit?: number } = {}) {
    return this.#store.listRuns(stateWorkspace(workspace), {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      checkpointAvailable: (record) =>
        record.state === 'waiting_for_input' && record.checkpoint !== undefined,
    });
  }

  async recoverRun(input: Parameters<LifecycleStore['recoverRun']>[0]) {
    const workspace = stateWorkspace(input.workspace);
    const current = this.#store.readRun(workspace, input.run_id);
    if (current.state === 'recovery_required') {
      await this.#reconcileRecoveryRequired(current, input.owner);
    }
    const recovered = this.#store.recoverRun({
      workspace,
      run_id: input.run_id,
      owner: stateOwner(input.owner),
    });
    return { ...recovered, record: lifecycleRecord(recovered.record) };
  }

  controlDirectory(workspace: LifecycleWorkspaceIdentity, runId: string): string {
    const path = this.#store.pathsForRun(stateWorkspace(workspace), runId).run_dir;
    return realpathSync.native(path);
  }

  async waitForChange(input: Parameters<NonNullable<LifecycleStore['waitForChange']>>[0]) {
    const deadline = Date.now() + Math.min(input.wait_ms, 10_000);
    while (!input.signal.aborted && Date.now() < deadline) {
      const current = this.#store.readRun(stateWorkspace(input.workspace), input.run_id);
      if (current.revision !== input.after_revision) return;
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }

  async reconcileRun(
    input: Parameters<LifecycleStore['reconcileRun']>[0],
  ): Promise<LifecycleRunRecord> {
    const workspace = stateWorkspace(input.workspace);
    let current = this.#store.readRun(workspace, input.run_id);
    if (current.state === 'recovery_required') {
      current = await this.#reconcileRecoveryRequired(current, input.owner);
      return input.include_progress === false
        ? lifecycleRecord(current)
        : await this.#project(current);
    }
    if (
      current.state === 'complete' ||
      current.state === 'needs_attention' ||
      current.state === 'cancelled' ||
      current.state === 'interrupted' ||
      current.state === 'waiting_for_input'
    ) {
      return input.include_progress === false
        ? lifecycleRecord(current)
        : await this.#project(current);
    }
    const acquired = this.#store.acquireOperation({
      workspace,
      run_id: input.run_id,
      operation: 'reconcile',
      owner: stateOwner(input.owner),
    });
    if (!acquired.ok) {
      return input.include_progress === false
        ? lifecycleRecord(current)
        : await this.#project(current);
    }
    try {
      current = this.#store.readRun(workspace, input.run_id);
      current = await this.#reconcileClaimed(current, acquired.handle);
      return input.include_progress === false
        ? lifecycleRecord(current)
        : await this.#project(current);
    } finally {
      this.#store.releaseOperation(acquired.handle);
    }
  }

  async #project(record: McpRunRecord): Promise<LifecycleRunRecord> {
    let captured: ReturnType<typeof readSupervisorProgress>;
    try {
      captured = readSupervisorProgress({
        control_directory: this.controlDirectory(record.workspace, record.run_id),
        run_id: record.run_id,
        generations: record.launch.generation,
      });
    } catch (error) {
      if (error instanceof SupervisorProgressError) return lifecycleRecord(record);
      throw error;
    }
    for (const progress of captured) {
      if (progress.event.flow_id !== record.request.flow) {
        return lifecycleRecord(record);
      }
    }
    const retained = captured.slice(-512);
    const retainedFromCursor = captured.length - retained.length;
    return lifecycleRecord({
      ...record,
      progress: {
        next_cursor: captured.length,
        retained_from_cursor: retainedFromCursor,
        dropped_count: retainedFromCursor,
        events: retained.map((progress, index) => ({
          cursor: retainedFromCursor + index,
          kind: progress.event.type,
          recorded_at: progress.event.recorded_at,
          summary: progress.event.display.text,
        })),
      },
    });
  }

  async #reconcileRecoveryRequired(
    current: McpRunRecord,
    owner: LifecycleProcessOwnerIdentity,
  ): Promise<McpRunRecord> {
    if (
      current.launch.authorization_sha256 === undefined ||
      current.launch.phase === 'reserved' ||
      current.launch.phase === 'supervisor_recorded'
    ) {
      return current;
    }
    const acquired = this.#store.acquireOperation({
      workspace: current.workspace,
      run_id: current.run_id,
      operation: 'recover',
      owner: stateOwner(owner),
    });
    if (!acquired.ok) return current;
    try {
      let record = this.#store.readRun(current.workspace, current.run_id);
      const observations = readSupervisorJournals({
        control_directory: this.controlDirectory(record.workspace, record.run_id),
        run_id: record.run_id,
        generation: record.launch.generation,
        authorization_sha256: record.launch.authorization_sha256 ?? '',
      });
      if (observations.runtime !== undefined && record.launch.phase === 'launch_authorized') {
        record = this.#store.advanceLaunch({
          handle: acquired.handle,
          launch: {
            ...record.launch,
            phase: 'runtime_recorded',
            runtime: withExecutable(
              observations.runtime.runtime,
              observations.runtime.runtime_executable,
            ),
          },
          summary: 'Circuit recovered the worker identity from durable supervisor evidence.',
        });
      }
      if (observations.exit !== undefined && record.launch.phase === 'runtime_recorded') {
        record = this.#store.advanceLaunch({
          handle: acquired.handle,
          launch: exited(
            record.launch,
            this.#now,
            observations.exit.process_group_cleanup,
            observations.exit,
          ),
          summary: 'Circuit recovered the worker exit from durable supervisor evidence.',
        });
      }
      return record;
    } finally {
      this.#store.releaseOperation(acquired.handle);
    }
  }

  async #reconcileClaimed(current: McpRunRecord, handle: OperationHandle): Promise<McpRunRecord> {
    let record = current;
    if (record.launch.phase === 'reserved') {
      const owner = this.#inspectProcess(record.launch.allocation_owner);
      if (owner === 'alive') return record;
      if (owner === 'unknown') {
        return this.#store.transitionRun({
          handle,
          to: 'recovery_required',
          summary: 'Circuit cannot confirm whether the interrupted launch owner is absent.',
          recovery: recovery(this.#now, 'launch_owner_unknown', { owner_status: owner }),
        });
      }
      return this.#store.transitionRun({
        handle,
        to: 'interrupted',
        summary: 'Circuit confirmed that the interrupted launch did not start a worker.',
        launch: exited(record.launch, this.#now, 'confirmed'),
      });
    }

    const observations =
      record.launch.authorization_sha256 === undefined
        ? {}
        : readSupervisorJournals({
            control_directory: this.controlDirectory(record.workspace, record.run_id),
            run_id: record.run_id,
            generation: record.launch.generation,
            authorization_sha256: record.launch.authorization_sha256,
          });
    if (observations.runtime !== undefined && record.launch.phase === 'launch_authorized') {
      record = this.#store.advanceLaunch({
        handle,
        launch: {
          ...record.launch,
          phase: 'runtime_recorded',
          runtime: withExecutable(
            observations.runtime.runtime,
            observations.runtime.runtime_executable,
          ),
        },
        summary: 'Circuit recovered the worker identity from durable supervisor evidence.',
      });
    }
    if (
      record.launch.phase === 'runtime_recorded' &&
      (record.state === 'starting' || record.state === 'resuming')
    ) {
      record = this.#store.transitionRun({
        handle,
        to: 'running',
        summary: `Circuit is running the ${record.request.flow} flow.`,
      });
    }

    if (observations.exit !== undefined) {
      if (record.launch.supervisor !== undefined) {
        const supervisorStatuses = [
          this.#inspectProcess(record.launch.supervisor),
          this.#inspectProcessGroup(record.launch.supervisor),
        ];
        if (supervisorStatuses.includes('alive')) return record;
        if (supervisorStatuses.includes('unknown')) {
          return this.#store.transitionRun({
            handle,
            to: 'recovery_required',
            summary: 'Circuit cannot confirm that the worker supervisor exited.',
            recovery: recovery(this.#now, 'supervisor_exit_unknown', {
              supervisor_status: supervisorStatuses[0],
              process_group_status: supervisorStatuses[1],
            }),
          });
        }
      }
      return await this.#applyExit(record, handle, observations.exit);
    }
    const identities = [
      ...(record.launch.supervisor === undefined ? [] : [record.launch.supervisor]),
      ...(record.launch.runtime === undefined ? [] : [record.launch.runtime]),
    ];
    const processStatuses = identities.map(this.#inspectProcess);
    const groupStatuses = identities.map(this.#inspectProcessGroup);
    const statuses = [...processStatuses, ...groupStatuses];
    if (statuses.includes('alive')) return record;
    if (anyUnknown(statuses)) {
      return this.#store.transitionRun({
        handle,
        to: 'recovery_required',
        summary: 'Circuit cannot confirm cleanup after the worker connection ended.',
        recovery: recovery(
          this.#now,
          'launch_process_unknown',
          {
            ...(processStatuses[0] === undefined ? {} : { supervisor_status: processStatuses[0] }),
            ...(processStatuses[1] === undefined ? {} : { runtime_status: processStatuses[1] }),
            process_group_status: groupStatuses.includes('unknown') ? 'unknown' : 'absent',
          },
          record.state === 'cancelling',
        ),
      });
    }
    if (!allAbsent(statuses)) return record;
    if (record.launch.phase === 'supervisor_recorded') {
      return this.#store.transitionRun({
        handle,
        to: 'interrupted',
        summary: 'Circuit confirmed that the interrupted supervisor did not leave a worker.',
        launch: exited(record.launch, this.#now, 'confirmed'),
      });
    }
    if (record.launch.runtime === undefined) {
      return this.#store.transitionRun({
        handle,
        to: 'recovery_required',
        summary: 'Circuit cannot prove that the gated worker process has exited.',
        recovery: recovery(this.#now, 'runtime_identity_missing', {
          supervisor_status: 'absent',
          runtime_status: 'unknown',
          process_group_status: 'unknown',
        }),
      });
    }
    const syntheticExit: ExitObservation = {
      schema_version: 1,
      record_kind: 'circuit.mcp.exit-observation',
      run_id: record.run_id,
      generation: record.launch.generation,
      authorization_sha256: record.launch.authorization_sha256 ?? '',
      runtime: {
        pid: record.launch.runtime.pid,
        process_group_id: record.launch.runtime.process_group_id,
        birth_token: record.launch.runtime.birth_token,
        started_at: record.launch.runtime.started_at,
      },
      observed_at: this.#now().toISOString(),
      process_group_cleanup: 'confirmed',
    };
    return await this.#applyExit(record, handle, syntheticExit);
  }

  async #applyExit(
    current: McpRunRecord,
    handle: OperationHandle,
    observation: ExitObservation,
  ): Promise<McpRunRecord> {
    let record = current;
    if (record.launch.runtime === undefined) {
      throw new Error('Supervisor exit evidence is missing the recorded runtime identity.');
    }
    if (record.launch.phase !== 'exited') {
      record = this.#store.advanceLaunch({
        handle,
        launch: exited(record.launch, this.#now, observation.process_group_cleanup, observation),
        summary: 'Circuit observed the worker exit.',
      });
    }
    if (observation.process_group_cleanup !== 'confirmed') {
      return this.#store.transitionRun({
        handle,
        to: 'recovery_required',
        summary:
          'Circuit observed the worker exit but could not prove that its recorded owned process group is absent.',
        recovery: recovery(
          this.#now,
          'worker_cleanup_unconfirmed',
          {
            supervisor_status: 'unknown',
            runtime_status: 'unknown',
            process_group_status: 'unknown',
          },
          record.state === 'cancelling',
        ),
      });
    }
    if (record.state === 'cancelling') {
      return this.#store.transitionRun({
        handle,
        to: 'cancelled',
        summary:
          'Circuit observed that its recorded owned process group is absent after the cancellation request.',
        checkpoint: null,
      });
    }
    const classification = await this.#artifacts.classifyExit({
      record,
      exit: observation,
    });
    switch (classification.state) {
      case 'complete':
        return this.#store.transitionRun({
          handle,
          to: 'complete',
          summary: classification.summary,
          final_report: classification.final_report,
        });
      case 'waiting_for_input':
        return this.#store.transitionRun({
          handle,
          to: 'waiting_for_input',
          summary: classification.summary,
          checkpoint: classification.checkpoint,
        });
      case 'needs_attention':
      case 'interrupted':
        return this.#store.transitionRun({
          handle,
          to: classification.state,
          summary: classification.summary,
          ...(classification.failure === undefined ? {} : { failure: classification.failure }),
        });
    }
  }
}

export class McpCheckpointAdapter implements LifecycleCheckpointReader {
  async read(input: Parameters<LifecycleCheckpointReader['read']>[0]) {
    if (input.run.checkpoint === undefined) {
      throw new Error('The waiting Circuit run has no checkpoint locator.');
    }
    return await readCheckpointView({
      workspace: {
        identity_source: input.workspace.identity_source ?? CODEX_SANDBOX_METADATA_KEY,
        workspace: input.workspace.canonical_path,
      },
      run_id: input.run.run_id,
      checkpoint: input.run.checkpoint as StoredCheckpoint,
    });
  }

  async assertResume(input: Parameters<LifecycleCheckpointReader['assertResume']>[0]) {
    if (input.run.checkpoint === undefined) {
      throw new Error('The Circuit run is not waiting for checkpoint input.');
    }
    await assertCheckpointResume({
      workspace: {
        identity_source: input.workspace.identity_source ?? CODEX_SANDBOX_METADATA_KEY,
        workspace: input.workspace.canonical_path,
      },
      run_id: input.run.run_id,
      checkpoint: input.run.checkpoint as StoredCheckpoint,
      checkpoint_token: input.checkpoint_token,
      choice_id: input.choice_id,
    });
    return {
      checkpoint_binding_sha256: checkpointBindingSha256({
        workspace_key: input.workspace.key,
        run_id: input.run.run_id,
        checkpoint: input.run.checkpoint as StoredCheckpoint,
      }),
    };
  }
}
