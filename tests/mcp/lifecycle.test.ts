import { describe, expect, it, vi } from 'vitest';

import type {
  LifecycleCheckpointReader,
  LifecycleCleanupController,
  LifecycleLaunch,
  LifecycleOperationHandle,
  LifecycleProcessIdentity,
  LifecycleProcessOwnerIdentity,
  LifecycleReportReader,
  LifecycleRunRecord,
  LifecycleStore,
  LifecycleWorkerFactory,
  LifecycleWorkspaceIdentity,
} from '../../src/hosts/codex-mcp/lifecycle-types.js';
import {
  CircuitMcpLifecycle,
  type CreateCircuitMcpLifecycleOptions,
} from '../../src/hosts/codex-mcp/lifecycle.js';
import type { CircuitMcpToolCall } from '../../src/hosts/codex-mcp/server.js';
import {
  SupervisorLaunchError,
  type SupervisorLauncher,
} from '../../src/hosts/codex-mcp/supervisor-launcher.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-07-21T08:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const RUNTIME_ASSETS = {
  schema_version: 1 as const,
  digest_sha256: DIGEST,
  assets: [],
};
const WORKSPACE: LifecycleWorkspaceIdentity = {
  key: 'b'.repeat(64),
  canonical_path: '/tmp/circuit-mcp-workspace',
  device: '1',
  inode: '2',
};
const EXECUTABLE = {
  real_path: '/usr/local/bin/node',
  device: '1',
  inode: '3',
  sha256: 'c'.repeat(64),
};
const OWNER: LifecycleProcessOwnerIdentity = {
  instance_id: 'server-one',
  pid: 100,
  process_group_id: 100,
  birth_token: 'server-start',
  started_at: NOW,
  executable: EXECUTABLE,
};
const SUPERVISOR: LifecycleProcessIdentity = {
  pid: 200,
  process_group_id: 200,
  birth_token: 'supervisor-start',
  started_at: NOW,
  executable: EXECUTABLE,
};
const RUNTIME: LifecycleProcessIdentity = {
  pid: 300,
  process_group_id: 300,
  birth_token: 'runtime-start',
  started_at: NOW,
  executable: EXECUTABLE,
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeRun(
  state: LifecycleRunRecord['state'] = 'starting',
  overrides: Partial<LifecycleRunRecord> = {},
): LifecycleRunRecord {
  const launch: LifecycleLaunch =
    state === 'waiting_for_input'
      ? {
          generation: 1,
          allocation_owner: OWNER,
          phase: 'exited',
          supervisor: SUPERVISOR,
          runtime: RUNTIME,
          authorization_sha256: 'd'.repeat(64),
          authorized_at: NOW,
          exit: { observed_at: NOW, exit_code: 0, process_group_cleanup: 'confirmed' },
        }
      : state === 'running' || state === 'complete' || state === 'cancelling'
        ? {
            generation: 1,
            allocation_owner: OWNER,
            phase: 'runtime_recorded',
            supervisor: SUPERVISOR,
            runtime: RUNTIME,
            authorization_sha256: 'd'.repeat(64),
            authorized_at: NOW,
          }
        : { generation: 1, allocation_owner: OWNER, phase: 'reserved' };
  return {
    revision: 0,
    run_id: RUN_ID,
    workspace: WORKSPACE,
    request: { flow: 'review', goal: 'Review this change', web_search: 'off' },
    state,
    summary: `Run is ${state}.`,
    runtime_assets_sha256: DIGEST,
    updated_at: NOW,
    allocation: { owner: OWNER, created_at: NOW },
    launch,
    progress: { next_cursor: 0, retained_from_cursor: 0, dropped_count: 0, events: [] },
    ...(state === 'waiting_for_input'
      ? {
          checkpoint: {
            generation: 1,
            step_id: 'choose',
            attempt: 1,
            request_path: 'steps/choose/request.json',
            request_sha256: 'e'.repeat(64),
            allowed_choices: ['continue'],
            choices_sha256: 'f'.repeat(64),
          },
        }
      : {}),
    ...(state === 'complete'
      ? {
          final_report: {
            schema: 'review.report',
            path: 'report.json',
            sha256: '1'.repeat(64),
            byte_length: 20,
            summary: 'Review complete.',
          },
        }
      : {}),
    ...overrides,
  };
}

class FakeStore implements LifecycleStore {
  readonly calls: string[] = [];
  readonly records = new Map<string, LifecycleRunRecord>();
  #active: { handle: LifecycleOperationHandle; runId: string } | undefined;
  waitForChangeImpl:
    | ((input: Parameters<NonNullable<LifecycleStore['waitForChange']>>[0]) => Promise<void>)
    | undefined;

  seed(record: LifecycleRunRecord): void {
    this.records.set(record.run_id, clone(record));
  }

  reserveRun(input: Parameters<LifecycleStore['reserveRun']>[0]): LifecycleRunRecord {
    this.calls.push('reserve');
    const record = makeRun('starting', {
      run_id: input.run_id,
      workspace: input.workspace,
      request: input.request,
      runtime_assets_sha256: input.runtime_assets_sha256,
      summary: input.summary,
      allocation: { owner: input.owner, created_at: NOW },
      launch: { generation: 1, allocation_owner: input.owner, phase: 'reserved' },
    });
    this.seed(record);
    return clone(record);
  }

  readRun(_workspace: LifecycleWorkspaceIdentity, runId: string): LifecycleRunRecord {
    this.calls.push('read');
    const record = this.records.get(runId);
    if (record === undefined)
      throw Object.assign(new Error('Circuit could not find this run.'), { code: 'run_not_found' });
    return clone(record);
  }

  acquireOperation(input: Parameters<LifecycleStore['acquireOperation']>[0]) {
    this.calls.push(`acquire:${input.operation}`);
    if (this.#active !== undefined) {
      return { ok: false as const, code: 'operation_in_progress' as const, message: 'Busy.' };
    }
    const checkpointBinding = input.checkpoint_binding_sha256;
    const handle: LifecycleOperationHandle = {
      claim:
        checkpointBinding === undefined ? {} : { checkpoint_binding_sha256: checkpointBinding },
    };
    this.#active = { handle, runId: input.run_id };
    return { ok: true as const, handle };
  }

  advanceLaunch(input: Parameters<LifecycleStore['advanceLaunch']>[0]): LifecycleRunRecord {
    this.calls.push(`advance:${input.launch.phase}`);
    return this.#update(input.handle, {
      launch: input.launch,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    });
  }

  transitionRun(input: Parameters<LifecycleStore['transitionRun']>[0]): LifecycleRunRecord {
    this.calls.push(`transition:${input.to}`);
    const current = this.#recordFor(input.handle);
    const next = {
      ...current,
      state: input.to,
      summary: input.summary,
      ...(input.launch === undefined ? {} : { launch: input.launch }),
      ...(input.recovery === undefined
        ? {}
        : input.recovery === null
          ? { recovery: undefined }
          : { recovery: input.recovery }),
      ...(input.checkpoint === undefined
        ? {}
        : input.checkpoint === null
          ? { checkpoint: undefined }
          : { checkpoint: input.checkpoint }),
      revision: current.revision + 1,
    } as LifecycleRunRecord;
    this.records.set(next.run_id, clone(next));
    return clone(next);
  }

  releaseOperation(handle: LifecycleOperationHandle): void {
    this.calls.push('release');
    if (this.#active?.handle === handle) this.#active = undefined;
  }

  listRuns(_workspace: LifecycleWorkspaceIdentity, options?: { readonly limit?: number }) {
    this.calls.push('list');
    const all = [...this.records.values()].slice(0, options?.limit ?? 20);
    return {
      runs: all.map((record) => ({
        run_id: record.run_id,
        flow: record.request.flow,
        state: record.state,
        updated_at: record.updated_at,
        checkpoint_available: record.state === 'waiting_for_input',
        summary: record.summary,
      })),
      truncated: false,
    };
  }

  recoverRun(input: Parameters<LifecycleStore['recoverRun']>[0]) {
    this.calls.push('recover');
    const current = this.records.get(input.run_id);
    if (current?.state !== 'recovery_required') {
      throw Object.assign(new Error('Only a recovery_required run can be recovered.'), {
        code: 'run_not_recoverable',
      });
    }
    const record = { ...current, state: 'interrupted' as const, summary: 'Recovery complete.' };
    this.records.set(record.run_id, record);
    return { record, cleanup_confirmed: true as const, lease_released: true as const };
  }

  reconcileRun(input: Parameters<LifecycleStore['reconcileRun']>[0]): LifecycleRunRecord {
    this.calls.push('reconcile');
    return this.readRun(input.workspace, input.run_id);
  }

  controlDirectory(): string {
    this.calls.push('control-directory');
    return '/tmp/circuit-mcp-control';
  }

  waitForChange(input: Parameters<NonNullable<LifecycleStore['waitForChange']>>[0]): Promise<void> {
    this.calls.push(`wait:${input.wait_ms}`);
    return this.waitForChangeImpl?.(input) ?? Promise.resolve();
  }

  #recordFor(handle: LifecycleOperationHandle): LifecycleRunRecord {
    if (this.#active?.handle !== handle) throw new Error('wrong operation handle');
    const record = this.records.get(this.#active.runId);
    if (record === undefined) throw new Error('missing record');
    return record;
  }

  #update(
    handle: LifecycleOperationHandle,
    update: { readonly launch: LifecycleLaunch; readonly summary?: string },
  ): LifecycleRunRecord {
    const current = this.#recordFor(handle);
    const next = {
      ...current,
      launch: update.launch,
      summary: update.summary ?? current.summary,
      revision: current.revision + 1,
    };
    this.records.set(next.run_id, clone(next));
    return clone(next);
  }
}

function call(name: CircuitMcpToolCall['name'], input: unknown): CircuitMcpToolCall {
  return { name, input, metadata: undefined, signal: new AbortController().signal };
}

function fixture(
  overrides: {
    readonly platform?: NodeJS.Platform;
    readonly store?: FakeStore;
    readonly launcher?: SupervisorLauncher;
    readonly verify?: () => Promise<void>;
    readonly validateStart?: (
      input: Parameters<NonNullable<CreateCircuitMcpLifecycleOptions['validateStart']>>[0],
    ) => Promise<void>;
    readonly preflightLaunch?: NonNullable<CreateCircuitMcpLifecycleOptions['preflightLaunch']>;
    readonly cleanup?: LifecycleCleanupController;
    readonly checkpoints?: LifecycleCheckpointReader;
  } = {},
) {
  const store = overrides.store ?? new FakeStore();
  const order = store.calls;
  const verify =
    overrides.verify ??
    (async () => {
      order.push('verify');
    });
  const launcher: SupervisorLauncher =
    overrides.launcher ??
    ({
      begin: async () => {
        order.push('begin-supervisor');
        return {
          supervisor: SUPERVISOR,
          authorization_token: '2'.repeat(64),
          authorization_sha256: '3'.repeat(64),
          authorize: async () => {
            order.push('authorize-worker');
            return RUNTIME;
          },
          closeBeforeAuthorization: async () => {
            order.push('close-supervisor');
            return true;
          },
        };
      },
    } satisfies SupervisorLauncher);
  const workerFactory: LifecycleWorkerFactory = {
    createStart: async ({ authorization_token, runtime_assets }) => {
      order.push('build-start-worker');
      return {
        worker_entrypoint: '/tmp/worker.mjs',
        launch_payload: {
          authorization: authorization_token,
          asset_digest_sha256: DIGEST,
          runtime_assets,
        },
      };
    },
    createResume: async ({ authorization_token, choice_id, runtime_assets }) => {
      order.push(`build-resume-worker:${choice_id}`);
      return {
        worker_entrypoint: '/tmp/worker.mjs',
        launch_payload: {
          authorization: authorization_token,
          asset_digest_sha256: DIGEST,
          runtime_assets,
        },
      };
    },
  };
  const checkpoints: LifecycleCheckpointReader = overrides.checkpoints ?? {
    read: async () => ({
      token: `cpt1.${'4'.repeat(64)}`,
      prompt: 'Continue?',
      choices: [{ id: 'continue', label: 'Continue' }],
    }),
    assertResume: async ({ run, checkpoint_token, choice_id }) => {
      if (run.state !== 'waiting_for_input') {
        throw Object.assign(new Error('Only a waiting run can be resumed.'), {
          code: 'run_not_waiting',
        });
      }
      if (checkpoint_token !== `cpt1.${'4'.repeat(64)}` || choice_id !== 'continue') {
        throw Object.assign(new Error('The checkpoint choice is stale.'), {
          code: 'checkpoint_stale',
        });
      }
      return { checkpoint_binding_sha256: '4'.repeat(64) };
    },
  };
  const reports: LifecycleReportReader = {
    read: async () => ({
      schema: 'review.report',
      summary: 'Review complete.',
      data: { ok: true },
    }),
  };
  const cleanup = overrides.cleanup ?? {
    cancel: async () => ({
      cleanup_confirmed: true,
      supervisor_status: 'absent',
      runtime_status: 'absent',
      process_group_status: 'absent',
    }),
  };
  const lifecycle = new CircuitMcpLifecycle({
    platform: overrides.platform ?? 'darwin',
    publicFlows: new Set(['review', 'fix', 'build', 'explore', 'prototype']),
    loadRuntimeAssets: async () => {
      await verify();
      return RUNTIME_ASSETS;
    },
    ...(overrides.validateStart === undefined ? {} : { validateStart: overrides.validateStart }),
    ...(overrides.preflightLaunch === undefined
      ? {}
      : { preflightLaunch: overrides.preflightLaunch }),
    resolveWorkspace: async () => {
      order.push('resolve-workspace');
      return WORKSPACE;
    },
    owner: async () => OWNER,
    store,
    launcher,
    workerFactory,
    checkpoints,
    reports,
    cleanup,
    now: () => new Date(NOW),
    randomRunId: () => RUN_ID,
  });
  return { lifecycle, store, order };
}

describe('Circuit MCP lifecycle', () => {
  it('rejects Linux before resolving a workspace or creating state', async () => {
    const { lifecycle, order } = fixture({ platform: 'linux' });
    const result = await lifecycle.handle(
      call('circuit_start', { flow: 'review', goal: 'Review this change' }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported_platform' } });
    expect(order).toEqual([]);
  });

  it('records supervisor identity and authorization before launching a worker', async () => {
    const { lifecycle, order } = fixture();
    const result = await lifecycle.handle(
      call('circuit_start', { flow: 'review', goal: 'Review this change' }),
    );
    expect(result).toMatchObject({ ok: true, run_id: RUN_ID, state: 'running' });
    expect(order).toEqual([
      'verify',
      'resolve-workspace',
      'reserve',
      'acquire:reconcile',
      'control-directory',
      'begin-supervisor',
      'advance:supervisor_recorded',
      'build-start-worker',
      'advance:launch_authorized',
      'authorize-worker',
      'advance:runtime_recorded',
      'transition:running',
      'release',
    ]);
  });

  it('blocks asset drift before start creates a run', async () => {
    const verify = vi.fn(async () => {
      throw Object.assign(new Error('Circuit runtime assets changed.'), {
        code: 'runtime_asset_changed',
      });
    });
    const { lifecycle, order } = fixture({ verify });
    const result = await lifecycle.handle(
      call('circuit_start', { flow: 'build', goal: 'Build this feature' }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'runtime_asset_changed' } });
    expect(order).toEqual([]);
  });

  it('validates relay selection before resolving a workspace or creating a run', async () => {
    const validateStart = vi.fn(async () => {
      throw Object.assign(new Error('This connector does not support effort none.'), {
        code: 'unsupported_effort',
      });
    });
    const { lifecycle, order } = fixture({ validateStart });
    const result = await lifecycle.handle(
      call('circuit_start', { flow: 'build', goal: 'Build this feature' }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported_effort' } });
    expect(order).toEqual([]);
    expect(validateStart).toHaveBeenCalledOnce();
  });

  it('runs launch capability preflight before reserving start state', async () => {
    const preflightLaunch = vi.fn(async () => undefined);
    const { lifecycle, order } = fixture({ preflightLaunch });
    await lifecycle.handle(call('circuit_start', { flow: 'review', goal: 'Review this change' }));
    expect(preflightLaunch).toHaveBeenCalledWith({
      workspace: WORKSPACE,
      request: expect.objectContaining({ flow: 'review' }),
      runtime_assets: RUNTIME_ASSETS,
    });
    expect(order.indexOf('resolve-workspace')).toBeLessThan(order.indexOf('reserve'));
  });

  it.each([
    [true, 'launch_failed', 'interrupted'],
    [false, 'recovery_required', 'recovery_required'],
  ] as const)(
    'records an honest state when supervisor startup cleanup is %s',
    async (cleanupConfirmed, code, state) => {
      const launcher: SupervisorLauncher = {
        begin: async () => {
          throw new SupervisorLaunchError('startup failed', cleanupConfirmed);
        },
      };
      const { lifecycle, store } = fixture({ launcher });
      const result = await lifecycle.handle(
        call('circuit_start', { flow: 'review', goal: 'Review this change' }),
      );
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(store.records.get(RUN_ID)?.state).toBe(state);
      expect(store.calls.at(-1)).toBe('release');
    },
  );

  it('keeps an authorized launch in recovery when the worker reply is lost', async () => {
    const launcher: SupervisorLauncher = {
      begin: async () => ({
        supervisor: SUPERVISOR,
        authorization_token: '2'.repeat(64),
        authorization_sha256: '3'.repeat(64),
        authorize: async () => {
          throw new Error('response pipe closed');
        },
        closeBeforeAuthorization: async () => false,
      }),
    };
    const { lifecycle, store } = fixture({ launcher });
    const result = await lifecycle.handle(
      call('circuit_start', { flow: 'review', goal: 'Review this change' }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
    expect(store.records.get(RUN_ID)).toMatchObject({
      state: 'recovery_required',
      recovery: { reason: 'runtime_identity_missing', runtime_status: 'unknown' },
    });
  });

  it('returns bounded progress and an opaque checkpoint', async () => {
    const store = new FakeStore();
    store.seed(
      makeRun('waiting_for_input', {
        progress: {
          next_cursor: 5,
          retained_from_cursor: 1,
          dropped_count: 1,
          events: [1, 2, 3, 4].map((cursor) => ({
            cursor,
            kind: 'flow.progress',
            recorded_at: NOW,
            summary: `Progress ${cursor}`,
          })),
        },
      }),
    );
    const { lifecycle } = fixture({ store });
    const result = await lifecycle.handle(
      call('circuit_status', { run_id: RUN_ID, after_cursor: 0, max_events: 2 }),
    );
    expect(result).toMatchObject({
      ok: true,
      state: 'waiting_for_input',
      next_cursor: 3,
      truncated: true,
      checkpoint: { token: `cpt1.${'4'.repeat(64)}` },
    });
    expect((result as { events: unknown[] }).events).toHaveLength(2);
  });

  it('long-polls only within the bounded status window', async () => {
    const store = new FakeStore();
    store.seed(makeRun('running'));
    store.waitForChangeImpl = async ({ wait_ms }) => {
      expect(wait_ms).toBeLessThanOrEqual(100);
      const current = store.records.get(RUN_ID);
      if (current === undefined) throw new Error('missing run');
      store.seed({
        ...current,
        revision: current.revision + 1,
        progress: {
          next_cursor: 1,
          retained_from_cursor: 0,
          dropped_count: 0,
          events: [
            { cursor: 0, kind: 'flow.progress', recorded_at: NOW, summary: 'New progress.' },
          ],
        },
      });
    };
    const { lifecycle } = fixture({ store });
    const result = await lifecycle.handle(
      call('circuit_status', { run_id: RUN_ID, after_cursor: 0, wait_ms: 10_000 }),
    );
    expect(result).toMatchObject({ ok: true, next_cursor: 1 });
    expect(store.calls.filter((entry) => entry.startsWith('wait:'))).toHaveLength(1);
  });

  it('returns the bounded final report after reconciliation', async () => {
    const store = new FakeStore();
    store.seed(makeRun('complete'));
    const { lifecycle } = fixture({ store });
    const result = await lifecycle.handle(call('circuit_status', { run_id: RUN_ID }));
    expect(result).toMatchObject({
      ok: true,
      state: 'complete',
      final_report: { schema: 'review.report', data: { ok: true } },
    });
  });

  it('allows exactly one concurrent resume call to win', async () => {
    const store = new FakeStore();
    store.seed(makeRun('waiting_for_input'));
    let releaseRuntime: ((value: LifecycleProcessIdentity) => void) | undefined;
    const runtime = new Promise<LifecycleProcessIdentity>((resolve) => {
      releaseRuntime = resolve;
    });
    const launcher: SupervisorLauncher = {
      begin: async () => ({
        supervisor: SUPERVISOR,
        authorization_token: '2'.repeat(64),
        authorization_sha256: '3'.repeat(64),
        authorize: async () => await runtime,
        closeBeforeAuthorization: async () => false,
      }),
    };
    const { lifecycle } = fixture({ store, launcher });
    const input = {
      run_id: RUN_ID,
      checkpoint_token: `cpt1.${'4'.repeat(64)}`,
      choice_id: 'continue',
    };
    const first = lifecycle.handle(call('circuit_resume', input));
    await vi.waitFor(() => expect(store.records.get(RUN_ID)?.state).toBe('resuming'));
    const second = await lifecycle.handle(call('circuit_resume', input));
    expect(second).toMatchObject({ ok: false, error: { code: 'run_not_waiting' } });
    releaseRuntime?.(RUNTIME);
    await expect(first).resolves.toMatchObject({ ok: true, state: 'running' });
    expect(store.calls.filter((entry) => entry === 'transition:resuming')).toHaveLength(1);
  });

  it('preflights resume and preserves the reconnect progress cursor', async () => {
    const store = new FakeStore();
    store.seed(
      makeRun('waiting_for_input', {
        progress: {
          next_cursor: 7,
          retained_from_cursor: 7,
          dropped_count: 7,
          events: [],
        },
      }),
    );
    const preflightLaunch = vi.fn(async () => undefined);
    const { lifecycle } = fixture({ store, preflightLaunch });
    const result = await lifecycle.handle(
      call('circuit_resume', {
        run_id: RUN_ID,
        checkpoint_token: `cpt1.${'4'.repeat(64)}`,
        choice_id: 'continue',
      }),
    );
    expect(result).toMatchObject({ ok: true, state: 'running', next_cursor: 7 });
    expect(preflightLaunch).toHaveBeenCalledWith({
      workspace: WORKSPACE,
      request: expect.objectContaining({ flow: 'review' }),
      runtime_assets: RUNTIME_ASSETS,
    });
  });

  it('blocks asset drift before resume claims or changes a checkpoint', async () => {
    const store = new FakeStore();
    store.seed(makeRun('waiting_for_input'));
    const { lifecycle } = fixture({
      store,
      verify: async () => {
        throw Object.assign(new Error('Assets changed.'), { code: 'runtime_asset_changed' });
      },
    });
    const result = await lifecycle.handle(
      call('circuit_resume', {
        run_id: RUN_ID,
        checkpoint_token: `cpt1.${'4'.repeat(64)}`,
        choice_id: 'continue',
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'runtime_asset_changed' } });
    expect(store.records.get(RUN_ID)?.state).toBe('waiting_for_input');
    expect(store.calls.some((entry) => entry.startsWith('acquire:'))).toBe(false);
  });

  it('closes a waiting checkpoint without signalling a process', async () => {
    const store = new FakeStore();
    store.seed(makeRun('waiting_for_input'));
    const cleanup = { cancel: vi.fn() } as unknown as LifecycleCleanupController;
    const { lifecycle } = fixture({ store, cleanup });
    const result = await lifecycle.handle(call('circuit_cancel', { run_id: RUN_ID }));
    expect(result).toMatchObject({
      ok: true,
      state: 'cancelled',
      cleanup_confirmed: true,
    });
    expect(cleanup.cancel).not.toHaveBeenCalled();
  });

  it('reports recovery_required when cancellation cleanup is uncertain', async () => {
    const store = new FakeStore();
    store.seed(makeRun('running'));
    const cleanup: LifecycleCleanupController = {
      cancel: async () => ({
        cleanup_confirmed: false,
        supervisor_status: 'unknown',
        runtime_status: 'unknown',
        process_group_status: 'unknown',
      }),
    };
    const { lifecycle } = fixture({ store, cleanup });
    const result = await lifecycle.handle(call('circuit_cancel', { run_id: RUN_ID }));
    expect(result).toMatchObject({
      ok: true,
      state: 'recovery_required',
      cleanup_confirmed: false,
    });
    expect(store.records.get(RUN_ID)?.recovery?.cancellation_requested).toBe(true);
  });

  it('continues cleanup when a previous server crashed during cancellation', async () => {
    const store = new FakeStore();
    store.seed(makeRun('cancelling'));
    const cleanup: LifecycleCleanupController = {
      cancel: vi.fn(async () => ({
        cleanup_confirmed: true as const,
        supervisor_status: 'absent' as const,
        runtime_status: 'absent' as const,
        process_group_status: 'absent' as const,
      })),
    };
    const { lifecycle } = fixture({ store, cleanup });
    const result = await lifecycle.handle(call('circuit_cancel', { run_id: RUN_ID }));
    expect(result).toMatchObject({
      ok: true,
      state: 'cancelled',
      cleanup_confirmed: true,
    });
    expect(cleanup.cancel).toHaveBeenCalledOnce();
    expect(store.records.get(RUN_ID)?.state).toBe('cancelled');
  });

  it('cancels a recovery run after journals restore its exact worker identity', async () => {
    const store = new FakeStore();
    store.seed(
      makeRun('recovery_required', {
        launch: {
          generation: 1,
          allocation_owner: OWNER,
          phase: 'runtime_recorded',
          supervisor: SUPERVISOR,
          runtime: RUNTIME,
          authorization_sha256: 'd'.repeat(64),
          authorized_at: NOW,
        },
        recovery: {
          reason: 'runtime_reply_lost',
          detected_at: NOW,
          last_checked_at: NOW,
          supervisor_status: 'alive',
          runtime_status: 'alive',
          process_group_status: 'alive',
          cancellation_requested: false,
        },
      }),
    );
    const cleanup: LifecycleCleanupController = {
      cancel: vi.fn(async () => ({
        cleanup_confirmed: true as const,
        supervisor_status: 'absent' as const,
        runtime_status: 'absent' as const,
        process_group_status: 'absent' as const,
      })),
    };
    const { lifecycle } = fixture({ store, cleanup });
    const result = await lifecycle.handle(call('circuit_cancel', { run_id: RUN_ID }));
    expect(result).toMatchObject({ ok: true, state: 'cancelled', cleanup_confirmed: true });
    expect(store.calls).toContain('acquire:recover');
    expect(cleanup.cancel).toHaveBeenCalledOnce();
  });

  it('preserves saved exit evidence when cancellation confirms recovery cleanup', async () => {
    const store = new FakeStore();
    store.seed(
      makeRun('recovery_required', {
        launch: {
          generation: 1,
          allocation_owner: OWNER,
          phase: 'exited',
          supervisor: SUPERVISOR,
          runtime: RUNTIME,
          authorization_sha256: 'd'.repeat(64),
          authorized_at: NOW,
          exit: {
            observed_at: '2026-07-21T07:59:00.000Z',
            exit_code: 1,
            signal: 'SIGTERM',
            process_group_cleanup: 'unconfirmed',
          },
        },
        recovery: {
          reason: 'worker_cleanup_unconfirmed',
          detected_at: NOW,
          last_checked_at: NOW,
          supervisor_status: 'absent',
          runtime_status: 'absent',
          process_group_status: 'unknown',
          cancellation_requested: false,
        },
      }),
    );
    const { lifecycle } = fixture({ store });
    const result = await lifecycle.handle(call('circuit_cancel', { run_id: RUN_ID }));
    expect(result).toMatchObject({ ok: true, state: 'cancelled', cleanup_confirmed: true });
    expect(store.records.get(RUN_ID)?.launch.exit).toEqual({
      observed_at: '2026-07-21T07:59:00.000Z',
      exit_code: 1,
      signal: 'SIGTERM',
      process_group_cleanup: 'confirmed',
    });
  });

  it('lists and recovers without checking changed runtime assets', async () => {
    const store = new FakeStore();
    store.seed(
      makeRun('recovery_required', {
        recovery: {
          reason: 'cleanup_uncertain',
          detected_at: NOW,
          last_checked_at: NOW,
          supervisor_status: 'absent',
          process_group_status: 'absent',
          cancellation_requested: false,
        },
      }),
    );
    const verify = vi.fn(async () => {
      throw new Error('must not run');
    });
    const { lifecycle } = fixture({ store, verify });
    await expect(lifecycle.handle(call('circuit_list', {}))).resolves.toMatchObject({ ok: true });
    await expect(
      lifecycle.handle(call('circuit_recover', { run_id: RUN_ID })),
    ).resolves.toMatchObject({
      ok: true,
      state: 'interrupted',
      cleanup_confirmed: true,
      lease_released: true,
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not expose unexpected internal error text', async () => {
    const store = new FakeStore();
    store.seed(makeRun('running'));
    store.reconcileRun = () => {
      throw new Error('secret internal operation name and path');
    };
    const { lifecycle } = fixture({ store });
    const result = await lifecycle.handle(call('circuit_status', { run_id: RUN_ID }));
    expect(result).toEqual({
      schema_version: 1,
      ok: false,
      error: { code: 'internal_error', message: 'Circuit could not complete this request safely.' },
    });
  });
});
