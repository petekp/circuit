import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { McpRuntimeAssetPins } from './asset-pins.js';
import {
  type CircuitStartInputV1,
  MCP_SCHEMA_VERSION,
  MCP_TOOL_INPUT_SCHEMAS,
  type McpErrorResponseV1,
} from './contracts.js';
import type {
  LifecycleCheckpointReader,
  LifecycleCleanupController,
  LifecycleLaunch,
  LifecycleOperationHandle,
  LifecycleProcessOwnerIdentity,
  LifecycleReportReader,
  LifecycleRunRecord,
  LifecycleStore,
  LifecycleWorkerFactory,
  LifecycleWorkspaceIdentity,
} from './lifecycle-types.js';
import type { CircuitMcpToolCall, CircuitMcpToolHandler } from './server.js';
import { SupervisorJournalError } from './supervisor-journal.js';
import type { SupervisorLaunchSession, SupervisorLauncher } from './supervisor-launcher.js';

const ACTIVE_STATES = new Set(['starting', 'running', 'resuming', 'cancelling']);
const CLOSED_STATES = new Set(['complete', 'needs_attention', 'cancelled', 'interrupted']);
const CANCEL_CLAIM_ATTEMPTS = 3;

export class McpLifecycleError extends Error {
  readonly code: string;
  readonly next_action: string | undefined;

  constructor(code: string, message: string, nextAction?: string) {
    super(message);
    this.name = 'McpLifecycleError';
    this.code = code;
    this.next_action = nextAction;
  }
}

interface ErrorWithCode {
  readonly code?: unknown;
  readonly next_action?: unknown;
  readonly nextAction?: unknown;
  readonly message?: unknown;
}

function errorResponse(error: unknown): McpErrorResponseV1 {
  const value = typeof error === 'object' && error !== null ? (error as ErrorWithCode) : undefined;
  const code =
    typeof value?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.code)
      ? value.code
      : 'internal_error';
  const knownMessage = typeof value?.message === 'string' ? value.message.trim() : '';
  const message =
    code === 'internal_error' || knownMessage.length === 0 || knownMessage.length > 1_000
      ? 'Circuit could not complete this request safely.'
      : knownMessage;
  const candidateNextAction = value?.next_action ?? value?.nextAction;
  const nextAction =
    typeof candidateNextAction === 'string' &&
    candidateNextAction.trim().length > 0 &&
    candidateNextAction.trim().length <= 1_000
      ? candidateNextAction.trim()
      : undefined;
  return {
    schema_version: MCP_SCHEMA_VERSION,
    ok: false,
    error: {
      code,
      message,
      ...(nextAction === undefined ? {} : { next_action: nextAction }),
    },
  };
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function exitedLaunch(
  launch: LifecycleLaunch,
  now: () => Date,
  cleanup: 'confirmed' | 'unconfirmed',
): LifecycleLaunch {
  return {
    ...launch,
    phase: 'exited',
    exit:
      launch.exit === undefined
        ? { observed_at: nowIso(now), process_group_cleanup: cleanup }
        : { ...launch.exit, process_group_cleanup: cleanup },
  };
}

function recoveryEvidence(
  now: () => Date,
  reason: string,
  cancellationRequested: boolean,
  statuses: {
    readonly owner_status?: 'alive' | 'absent' | 'unknown';
    readonly supervisor_status?: 'alive' | 'absent' | 'unknown';
    readonly runtime_status?: 'alive' | 'absent' | 'unknown';
    readonly process_group_status?: 'alive' | 'absent' | 'unknown';
  } = {},
) {
  const timestamp = nowIso(now);
  return {
    reason,
    detected_at: timestamp,
    last_checked_at: timestamp,
    cancellation_requested: cancellationRequested,
    ...statuses,
  };
}

function acquireOrThrow(
  result:
    | { readonly ok: true; readonly handle: LifecycleOperationHandle }
    | { readonly ok: false; readonly code: string; readonly message: string },
): LifecycleOperationHandle {
  if (result.ok) return result.handle;
  throw new McpLifecycleError(
    result.code,
    result.message,
    'Wait for the current Circuit operation to finish, then retry.',
  );
}

async function boundedWorkerPreparation<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new Error('worker preparation was cancelled');
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('worker preparation timed out')), timeoutMs);
    timer.unref();
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('worker preparation was cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, timeout, cancelled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal.removeEventListener('abort', abort);
  }
}

export interface CreateCircuitMcpLifecycleOptions<TPrepared = unknown> {
  readonly platform?: NodeJS.Platform;
  readonly loadRuntimeAssets: () => Promise<McpRuntimeAssetPins>;
  readonly validateStart?: (input: CircuitStartInputV1) => Promise<void>;
  readonly preflightLaunch: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly request: CircuitStartInputV1;
    readonly runtime_assets: McpRuntimeAssetPins;
  }) => Promise<TPrepared>;
  readonly resolveWorkspace: (call: CircuitMcpToolCall) => Promise<LifecycleWorkspaceIdentity>;
  readonly owner: () => Promise<LifecycleProcessOwnerIdentity>;
  readonly store: LifecycleStore;
  readonly launcher: SupervisorLauncher;
  readonly workerFactory: LifecycleWorkerFactory<TPrepared>;
  readonly checkpoints: LifecycleCheckpointReader;
  readonly reports: LifecycleReportReader;
  readonly cleanup: LifecycleCleanupController;
  readonly workerPreparationMs?: number;
  readonly now?: () => Date;
  readonly randomRunId?: () => string;
}

export class CircuitMcpLifecycle<TPrepared = unknown> {
  readonly #options: CreateCircuitMcpLifecycleOptions<TPrepared>;
  readonly #now: () => Date;
  readonly #randomRunId: () => string;
  readonly #workerPreparationMs: number;

  constructor(options: CreateCircuitMcpLifecycleOptions<TPrepared>) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#randomRunId = options.randomRunId ?? randomUUID;
    this.#workerPreparationMs = options.workerPreparationMs ?? 10_000;
    if (this.#workerPreparationMs < 100 || this.#workerPreparationMs > 30_000) {
      throw new Error('workerPreparationMs must be between 100 and 30000 milliseconds');
    }
  }

  readonly handle: CircuitMcpToolHandler = async (call) => {
    try {
      switch (call.name) {
        case 'circuit_start':
          return await this.#start(call);
        case 'circuit_status':
          return await this.#status(call);
        case 'circuit_resume':
          return await this.#resume(call);
        case 'circuit_cancel':
          return await this.#cancel(call);
        case 'circuit_list':
          return await this.#list(call);
        case 'circuit_recover':
          return await this.#recover(call);
      }
    } catch (error) {
      return errorResponse(error);
    }
  };

  async #workspace(call: CircuitMcpToolCall): Promise<LifecycleWorkspaceIdentity> {
    return await this.#options.resolveWorkspace(call);
  }

  #requireMacOs(): void {
    if ((this.#options.platform ?? process.platform) !== 'darwin') {
      throw new McpLifecycleError(
        'unsupported_platform',
        'Circuit MCP currently supports macOS only.',
        'Run Circuit from the ordinary CLI on this platform.',
      );
    }
  }

  async #start(call: CircuitMcpToolCall): Promise<unknown> {
    const input = MCP_TOOL_INPUT_SCHEMAS.circuit_start.parse(call.input);
    // This check intentionally precedes workspace resolution, state-root
    // creation, run allocation, and every other durable action.
    this.#requireMacOs();
    await this.#options.validateStart?.(input);
    const runtimeAssets = await this.#options.loadRuntimeAssets();
    const workspace = await this.#workspace(call);
    const preparedLaunch = await this.#options.preflightLaunch({
      workspace,
      request: input,
      runtime_assets: runtimeAssets,
    });
    const owner = await this.#options.owner();
    const runId = this.#randomRunId();
    const reserved = await this.#options.store.reserveRunClaimed({
      run_id: runId,
      workspace,
      request: input,
      runtime_assets_sha256: runtimeAssets.digest_sha256,
      owner,
      summary: `Circuit is starting the ${input.flow} flow.`,
    });
    const handle = reserved.handle;
    try {
      const running = await this.#launch({
        workspace,
        run: reserved.record,
        handle,
        runtime_assets: runtimeAssets,
        signal: call.signal,
        makeWorker: async (session, run) =>
          await this.#options.workerFactory.createStart({
            workspace,
            run,
            authorization_token: session.authorization_token,
            runtime_assets: runtimeAssets,
            prepared_launch: preparedLaunch,
          }),
      });
      return {
        schema_version: MCP_SCHEMA_VERSION,
        ok: true,
        run_id: running.run_id,
        state: 'running',
        next_cursor: running.progress.next_cursor,
        summary: `Circuit started the ${input.flow} flow.`,
      };
    } finally {
      await this.#options.store.releaseOperation(handle);
    }
  }

  async #launch(input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run: LifecycleRunRecord;
    readonly handle: LifecycleOperationHandle;
    readonly runtime_assets: McpRuntimeAssetPins;
    readonly signal: AbortSignal;
    readonly makeWorker: (
      session: SupervisorLaunchSession,
      run: LifecycleRunRecord,
    ) => ReturnType<LifecycleWorkerFactory<TPrepared>['createStart']>;
  }): Promise<LifecycleRunRecord> {
    let current = input.run;
    let session: SupervisorLaunchSession | undefined;
    let authorizationPersisted = false;
    try {
      const controlDirectory = await this.#options.store.controlDirectory(
        input.workspace,
        current.run_id,
      );
      session = await this.#options.launcher.begin({
        run_id: current.run_id,
        generation: current.launch.generation,
        control_directory: controlDirectory,
        runtime_assets: input.runtime_assets,
      });
      current = await this.#options.store.advanceLaunch({
        handle: input.handle,
        launch: {
          ...current.launch,
          phase: 'supervisor_recorded',
          supervisor: session.supervisor,
        },
        summary: 'Circuit recorded the worker supervisor.',
      });
      const worker = await boundedWorkerPreparation(
        input.makeWorker(session, current),
        this.#workerPreparationMs,
        input.signal,
      );
      current = await this.#options.store.advanceLaunch({
        handle: input.handle,
        launch: {
          ...current.launch,
          phase: 'launch_authorized',
          authorization_sha256: session.authorization_sha256,
          authorized_at: nowIso(this.#now),
        },
        summary: 'Circuit authorized the sealed worker launch.',
      });
      authorizationPersisted = true;
      const runtime = await session.authorize({ worker });
      current = await this.#options.store.advanceLaunch({
        handle: input.handle,
        launch: {
          ...current.launch,
          phase: 'runtime_recorded',
          runtime,
        },
        summary: 'Circuit recorded the worker process.',
      });
      return await this.#options.store.transitionRun({
        handle: input.handle,
        to: 'running',
        summary: `Circuit is running the ${current.request.flow} flow.`,
      });
    } catch (_error) {
      const reportedCleanupConfirmed =
        typeof _error === 'object' &&
        _error !== null &&
        'cleanup_confirmed' in _error &&
        (_error as { readonly cleanup_confirmed?: unknown }).cleanup_confirmed === true;
      const cleanupConfirmed =
        reportedCleanupConfirmed ||
        (session !== undefined && !authorizationPersisted
          ? await session.closeBeforeAuthorization().catch(() => false)
          : false);
      if (cleanupConfirmed) {
        await this.#options.store.transitionRun({
          handle: input.handle,
          to: 'interrupted',
          summary:
            'Circuit could not launch the worker and observed that its recorded owned process group is absent.',
          launch: exitedLaunch(current.launch, this.#now, 'confirmed'),
          failure: { code: 'launch_failed', message: 'The Circuit worker did not start.' },
        });
      } else {
        await this.#options.store.transitionRun({
          handle: input.handle,
          to: 'recovery_required',
          summary: 'Circuit could not confirm worker cleanup after launch failed.',
          recovery: recoveryEvidence(
            this.#now,
            authorizationPersisted ? 'runtime_identity_missing' : 'launch_cleanup_uncertain',
            false,
            {
              supervisor_status: session === undefined ? 'absent' : 'unknown',
              ...(authorizationPersisted ? { runtime_status: 'unknown' as const } : {}),
              process_group_status: session === undefined ? 'absent' : 'unknown',
            },
          ),
          failure: { code: 'launch_failed', message: 'The Circuit worker did not start.' },
        });
      }
      throw new McpLifecycleError(
        cleanupConfirmed ? 'launch_failed' : 'recovery_required',
        cleanupConfirmed
          ? 'Circuit could not start the worker and observed that its recorded owned process group is absent.'
          : 'Circuit could not confirm cleanup after the worker launch failed.',
        cleanupConfirmed
          ? 'Retry the flow.'
          : 'Use circuit_list to find the run, then use circuit_recover after its processes stop.',
      );
    }
  }

  async #status(call: CircuitMcpToolCall): Promise<unknown> {
    const input = MCP_TOOL_INPUT_SCHEMAS.circuit_status.parse(call.input);
    const workspace = await this.#workspace(call);
    const owner = await this.#options.owner();
    let record = await this.#options.store.reconcileRun({
      workspace,
      run_id: input.run_id,
      owner,
    });
    const waitMs = input.wait_ms ?? 0;
    const deadline = Date.now() + waitMs;
    while (
      waitMs > 0 &&
      input.after_cursor !== undefined &&
      record.progress.next_cursor <= input.after_cursor &&
      ACTIVE_STATES.has(record.state) &&
      Date.now() < deadline &&
      !call.signal.aborted
    ) {
      const remaining = Math.min(100, deadline - Date.now());
      if (remaining <= 0) break;
      if (this.#options.store.waitForChange !== undefined) {
        await this.#options.store.waitForChange({
          workspace,
          run_id: input.run_id,
          after_revision: record.revision,
          wait_ms: Math.min(remaining, 10_000),
          signal: call.signal,
        });
      } else {
        await delay(remaining, undefined, { signal: call.signal }).catch((error: unknown) => {
          if (!call.signal.aborted) throw error;
        });
      }
      if (call.signal.aborted) break;
      record = await this.#options.store.reconcileRun({
        workspace,
        run_id: input.run_id,
        owner,
      });
    }

    const startCursor = input.after_cursor ?? record.progress.retained_from_cursor;
    const eligible = record.progress.events.filter((event) => event.cursor >= startCursor);
    const maximum = input.max_events ?? 100;
    const events = eligible.slice(0, maximum);
    const cursorTruncated = startCursor < record.progress.retained_from_cursor;
    const countTruncated = eligible.length > events.length;
    const nextCursor =
      events.length === 0
        ? record.progress.next_cursor
        : (events.at(-1)?.cursor ?? record.progress.next_cursor - 1) + 1;
    const checkpoint =
      record.state === 'waiting_for_input'
        ? await this.#options.checkpoints.read({ workspace, run: record })
        : undefined;
    const finalReport =
      record.state === 'complete'
        ? await this.#options.reports.read({ workspace, run: record })
        : undefined;
    return {
      schema_version: MCP_SCHEMA_VERSION,
      ok: true,
      run_id: record.run_id,
      state: record.state,
      events,
      next_cursor: nextCursor,
      truncated: cursorTruncated || countTruncated,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(finalReport === undefined ? {} : { final_report: finalReport }),
      summary: record.summary,
    };
  }

  async #resume(call: CircuitMcpToolCall): Promise<unknown> {
    const input = MCP_TOOL_INPUT_SCHEMAS.circuit_resume.parse(call.input);
    this.#requireMacOs();
    const runtimeAssets = await this.#options.loadRuntimeAssets();
    const workspace = await this.#workspace(call);
    const owner = await this.#options.owner();
    let waiting = await this.#options.store.reconcileRun({
      workspace,
      run_id: input.run_id,
      owner,
      include_progress: false,
    });
    const preparedLaunch = await this.#options.preflightLaunch({
      workspace,
      request: waiting.request,
      runtime_assets: runtimeAssets,
    });
    if (waiting.runtime_assets_sha256 !== runtimeAssets.digest_sha256) {
      throw new McpLifecycleError(
        'runtime_asset_changed',
        'Circuit runtime assets changed after this run started.',
        'Reinstall the Circuit plugin, then start a new run.',
      );
    }
    const assertion = await this.#options.checkpoints.assertResume({
      workspace,
      run: waiting,
      checkpoint_token: input.checkpoint_token,
      choice_id: input.choice_id,
    });
    const handle = acquireOrThrow(
      await this.#options.store.acquireOperation({
        workspace,
        run_id: input.run_id,
        operation: 'resume',
        owner,
        checkpoint_binding_sha256: assertion.checkpoint_binding_sha256,
      }),
    );
    try {
      waiting = await this.#options.store.readRun(workspace, input.run_id);
      const resuming = await this.#options.store.transitionRun({
        handle,
        to: 'resuming',
        summary: 'Circuit accepted the checkpoint choice and is resuming.',
        launch: {
          generation: waiting.launch.generation + 1,
          allocation_owner: owner,
          phase: 'reserved',
        },
        checkpoint: null,
      });
      const running = await this.#launch({
        workspace,
        run: resuming,
        handle,
        runtime_assets: runtimeAssets,
        signal: call.signal,
        makeWorker: async (session, run) =>
          await this.#options.workerFactory.createResume({
            workspace,
            run,
            checkpoint_token: input.checkpoint_token,
            choice_id: input.choice_id,
            authorization_token: session.authorization_token,
            runtime_assets: runtimeAssets,
            prepared_launch: preparedLaunch,
          }),
      });
      const projected = await this.#options.store.reconcileRun({
        workspace,
        run_id: running.run_id,
        owner,
      });
      return {
        schema_version: MCP_SCHEMA_VERSION,
        ok: true,
        run_id: running.run_id,
        state: 'running',
        next_cursor: projected.progress.next_cursor,
        summary: 'Circuit resumed the run.',
      };
    } finally {
      await this.#options.store.releaseOperation(handle);
    }
  }

  async #cancel(call: CircuitMcpToolCall): Promise<unknown> {
    const input = MCP_TOOL_INPUT_SCHEMAS.circuit_cancel.parse(call.input);
    const workspace = await this.#workspace(call);
    const owner = await this.#options.owner();
    let current: LifecycleRunRecord;
    try {
      current = await this.#options.store.reconcileRun({
        workspace,
        run_id: input.run_id,
        owner,
        include_progress: false,
      });
    } catch (error) {
      if (!(error instanceof SupervisorJournalError)) throw error;
      current = await this.#options.store.readRun(workspace, input.run_id);
    }
    if (CLOSED_STATES.has(current.state)) {
      throw new McpLifecycleError('run_not_cancellable', 'This Circuit run is already closed.');
    }
    let operation: 'cancel' | 'recover' =
      current.state === 'recovery_required' ? 'recover' : 'cancel';
    let handle: LifecycleOperationHandle | undefined;
    for (let attempt = 0; attempt < CANCEL_CLAIM_ATTEMPTS; attempt += 1) {
      const claimed = acquireOrThrow(
        await this.#options.store.acquireOperation({
          workspace,
          run_id: input.run_id,
          operation,
          owner,
        }),
      );
      try {
        current = await this.#options.store.readRun(workspace, input.run_id);
      } catch (error) {
        await this.#options.store.releaseOperation(claimed);
        throw error;
      }
      const claimedOperation: 'cancel' | 'recover' =
        current.state === 'recovery_required' ? 'recover' : 'cancel';
      if (CLOSED_STATES.has(current.state) || claimedOperation === operation) {
        handle = claimed;
        break;
      }
      await this.#options.store.releaseOperation(claimed);
      operation = claimedOperation;
    }
    if (handle === undefined) {
      throw new McpLifecycleError(
        'operation_in_progress',
        'This Circuit run changed while cancellation was starting.',
        'Retry cancellation.',
      );
    }
    try {
      if (CLOSED_STATES.has(current.state)) {
        throw new McpLifecycleError('run_not_cancellable', 'This Circuit run is already closed.');
      }
      const recoveryCancellation = current.state === 'recovery_required';
      if (
        recoveryCancellation &&
        current.launch.runtime === undefined &&
        current.launch.phase !== 'supervisor_recorded'
      ) {
        throw new McpLifecycleError(
          'recovery_required',
          'Circuit does not have an exact worker identity to cancel safely.',
          'Keep the run for inspection; do not force-unlock its workspace lease.',
        );
      }
      if (current.launch.phase === 'launch_authorized' && current.launch.runtime === undefined) {
        throw new McpLifecycleError(
          'recovery_required',
          'Circuit cannot safely identify the authorized worker process.',
          'Keep the run for inspection; do not force-unlock its workspace lease.',
        );
      }
      if (current.state === 'waiting_for_input') {
        const cancelled = await this.#options.store.transitionRun({
          handle,
          to: 'cancelled',
          summary: 'Circuit closed the waiting checkpoint.',
          checkpoint: null,
        });
        return {
          schema_version: MCP_SCHEMA_VERSION,
          ok: true,
          run_id: cancelled.run_id,
          state: 'cancelled',
          cleanup_confirmed: true,
          summary: 'Circuit closed the waiting checkpoint; no worker process group was active.',
        };
      }
      if (current.state !== 'cancelling' && current.state !== 'recovery_required') {
        current = await this.#options.store.transitionRun({
          handle,
          to: 'cancelling',
          summary: 'Circuit is stopping its recorded owned process group.',
        });
      }
      let cleanup: Awaited<ReturnType<LifecycleCleanupController['cancel']>>;
      try {
        cleanup = await this.#options.cleanup.cancel({ workspace, run: current });
      } catch {
        cleanup = {
          cleanup_confirmed: false,
          supervisor_status: 'unknown',
          runtime_status: 'unknown',
          process_group_status: 'unknown',
        };
      }
      if (cleanup.cleanup_confirmed) {
        const cancelled = await this.#options.store.transitionRun({
          handle,
          to: 'cancelled',
          summary: 'Circuit observed that its recorded owned process group is absent.',
          launch: exitedLaunch(current.launch, this.#now, 'confirmed'),
          checkpoint: null,
        });
        return {
          schema_version: MCP_SCHEMA_VERSION,
          ok: true,
          run_id: cancelled.run_id,
          state: 'cancelled',
          cleanup_confirmed: true,
          summary: 'Circuit observed that its recorded owned process group is absent.',
        };
      }
      const recovery = await this.#options.store.transitionRun({
        handle,
        to: 'recovery_required',
        summary: 'Circuit could not prove that its recorded owned process group is absent.',
        recovery: recoveryEvidence(this.#now, 'cancellation_cleanup_uncertain', true, cleanup),
        checkpoint: null,
      });
      return {
        schema_version: MCP_SCHEMA_VERSION,
        ok: true,
        run_id: recovery.run_id,
        state: 'recovery_required',
        cleanup_confirmed: false,
        summary: 'Circuit requested cancellation but could not confirm cleanup.',
      };
    } finally {
      await this.#options.store.releaseOperation(handle);
    }
  }

  async #list(call: CircuitMcpToolCall): Promise<unknown> {
    const input = MCP_TOOL_INPUT_SCHEMAS.circuit_list.parse(call.input);
    const workspace = await this.#workspace(call);
    const listed = await this.#options.store.listRuns(workspace, { limit: input.limit ?? 20 });
    return {
      schema_version: MCP_SCHEMA_VERSION,
      ok: true,
      runs: listed.runs,
      truncated: listed.truncated,
      summary:
        listed.runs.length === 0
          ? 'No recent Circuit runs were found for this workspace.'
          : `Found ${listed.runs.length} recent Circuit ${listed.runs.length === 1 ? 'run' : 'runs'}.`,
    };
  }

  async #recover(call: CircuitMcpToolCall): Promise<unknown> {
    const input = MCP_TOOL_INPUT_SCHEMAS.circuit_recover.parse(call.input);
    const workspace = await this.#workspace(call);
    const owner = await this.#options.owner();
    const recovered = await this.#options.store.recoverRun({
      workspace,
      run_id: input.run_id,
      owner,
    });
    return {
      schema_version: MCP_SCHEMA_VERSION,
      ok: true,
      run_id: recovered.record.run_id,
      state: recovered.record.state,
      recovered: true,
      cleanup_confirmed: recovered.cleanup_confirmed,
      lease_released: recovered.lease_released,
      summary: recovered.record.summary,
    };
  }
}

export function createCircuitMcpLifecycleHandler<TPrepared>(
  options: CreateCircuitMcpLifecycleOptions<TPrepared>,
): CircuitMcpToolHandler {
  return new CircuitMcpLifecycle(options).handle;
}
