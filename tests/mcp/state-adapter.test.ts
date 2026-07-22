import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  LifecycleExecutableIdentity,
  LifecycleProcessOwnerIdentity,
} from '../../src/hosts/codex-mcp/lifecycle-types.js';
import {
  McpCheckpointAdapter,
  McpLifecycleStateAdapter,
  type RuntimeArtifactReconciler,
} from '../../src/hosts/codex-mcp/state-adapter.js';
import {
  McpStateStore,
  type ProcessIdentity,
  type ProcessStatus,
  trustedWorkspaceIdentity,
} from '../../src/hosts/codex-mcp/state-store.js';
import { SupervisorProgressWriter } from '../../src/hosts/codex-mcp/supervisor-progress.js';
import { sha256OfJson } from '../../src/schemas/hashing.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-07-21T08:00:00.000Z';
const AUTHORIZATION = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const EXECUTABLE: LifecycleExecutableIdentity = {
  real_path: '/usr/local/bin/node',
  device: '1',
  inode: '2',
  sha256: 'c'.repeat(64),
};
const roots: string[] = [];

function owner(instance: string, pid: number): LifecycleProcessOwnerIdentity {
  return {
    instance_id: instance,
    pid,
    process_group_id: pid,
    birth_token: `${instance}-birth`,
    started_at: NOW,
    executable: EXECUTABLE,
  };
}

function supervisor(): ProcessIdentity {
  return {
    pid: 200,
    process_group_id: 200,
    birth_token: 'supervisor-birth',
    started_at: NOW,
    executable: EXECUTABLE,
  };
}

async function fixture(
  statuses: Map<string, ProcessStatus> | ((identity: ProcessIdentity) => ProcessStatus) = new Map(),
  retainedTerminalRuns?: number,
  tokenStatus: ProcessStatus = 'unknown',
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-adapter-')));
  roots.push(root);
  const workspacePath = join(root, 'workspace');
  const stateRoot = join(root, 'state');
  await mkdir(workspacePath, { mode: 0o700 });
  const inspect =
    typeof statuses === 'function'
      ? statuses
      : (identity: ProcessIdentity): ProcessStatus =>
          statuses.get(identity.birth_token) ?? 'absent';
  const inspectToken = vi.fn(() => tokenStatus);
  const store = new McpStateStore({
    stateRoot,
    inspectProcess: inspect,
    inspectProcessGroup: inspect,
    inspectProcessToken: inspectToken,
    now: () => new Date(NOW),
  });
  const workspace = trustedWorkspaceIdentity(workspacePath);
  const oldOwner = owner('old-server', 100);
  const newOwner = owner('new-server', 101);
  const artifacts: RuntimeArtifactReconciler = {
    classifyExit: async () => ({
      state: 'complete',
      summary: 'Circuit completed the Review flow.',
      final_report: {
        schema: 'review.report',
        path: 'reports/review.json',
        sha256: 'd'.repeat(64),
        byte_length: 20,
        summary: 'Review complete.',
      },
    }),
  };
  const adapter = new McpLifecycleStateAdapter({
    store,
    artifacts,
    inspectProcess: inspect,
    inspectProcessGroup: inspect,
    ...(retainedTerminalRuns === undefined ? {} : { retainedTerminalRuns }),
    now: () => new Date(NOW),
  });
  return {
    root,
    workspacePath,
    store,
    workspace,
    oldOwner,
    newOwner,
    adapter,
    artifacts,
    inspectToken,
  };
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function runtimeObservation() {
  return {
    pid: 300,
    process_group_id: 300,
    birth_token: AUTHORIZATION,
    started_at: NOW,
  };
}

async function reserveAndAuthorize(context: Awaited<ReturnType<typeof fixture>>) {
  context.adapter.reserveRun({
    run_id: RUN_ID,
    workspace: context.workspace,
    request: { flow: 'review', goal: 'Review this change', web_search: 'off' },
    runtime_assets_sha256: DIGEST,
    owner: context.oldOwner,
    summary: 'Starting Review.',
  });
  const acquired = context.store.acquireOperation({
    workspace: context.workspace,
    run_id: RUN_ID,
    operation: 'reconcile',
    owner: context.oldOwner,
  });
  if (!acquired.ok) throw new Error('could not acquire launch claim');
  let record = context.store.readRun(context.workspace, RUN_ID);
  record = context.store.advanceLaunch({
    handle: acquired.handle,
    launch: { ...record.launch, phase: 'supervisor_recorded', supervisor: supervisor() },
  });
  context.store.advanceLaunch({
    handle: acquired.handle,
    launch: {
      ...record.launch,
      phase: 'launch_authorized',
      authorization_sha256: AUTHORIZATION,
      authorized_at: NOW,
    },
  });
  return acquired.handle;
}

afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('MCP lifecycle state adapter', () => {
  it('runs bounded terminal-run retention immediately before reserving a new run', async () => {
    const context = await fixture(new Map(), 100);
    const prune = vi.spyOn(context.store, 'pruneTerminalRuns');

    context.adapter.reserveRun({
      run_id: RUN_ID,
      workspace: context.workspace,
      request: { flow: 'review', goal: 'Review this change', web_search: 'off' },
      runtime_assets_sha256: DIGEST,
      owner: context.oldOwner,
      summary: 'Starting Review.',
    });

    expect(prune).toHaveBeenCalledWith({
      workspace: context.workspace,
      owner: context.oldOwner,
      retain: 100,
    });
  });

  it('closes the server-crash window from supervisor journals', async () => {
    const context = await fixture();
    await reserveAndAuthorize(context);
    const control = context.adapter.controlDirectory(context.workspace, RUN_ID);
    await writePrivate(join(control, 'launch-1-runtime.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.runtime-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      runtime_executable: EXECUTABLE,
      recorded_at: NOW,
    });
    await writePrivate(join(control, 'launch-1-exit.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.exit-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      observed_at: NOW,
      exit_code: 0,
      process_group_cleanup: 'confirmed',
    });
    const progress = new SupervisorProgressWriter({
      control_directory: control,
      run_id: RUN_ID,
      generation: 1,
    });
    progress.ingest(
      `${JSON.stringify({
        schema_version: 1,
        type: 'run.started',
        run_id: RUN_ID,
        flow_id: 'review',
        recorded_at: NOW,
        label: 'Review started',
        display: { text: 'Circuit started Review.', importance: 'major', tone: 'info' },
        run_folder: join(context.workspacePath, '.circuit', 'runs', RUN_ID),
      })}\n`,
    );
    progress.close();

    const reconciled = await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });
    expect(reconciled).toMatchObject({
      state: 'complete',
      launch: {
        phase: 'exited',
        runtime: { pid: 300, executable: EXECUTABLE },
        exit: { process_group_cleanup: 'confirmed' },
      },
      final_report: { schema: 'review.report' },
      progress: {
        next_cursor: 1,
        events: [{ cursor: 0, kind: 'run.started', summary: 'Circuit started Review.' }],
      },
    });
    expect(existsSync(context.store.pathsForRun(context.workspace, RUN_ID).lease_file)).toBe(false);
  });

  it('keeps the lease and requires recovery when cleanup is unconfirmed', async () => {
    const context = await fixture(new Map([[AUTHORIZATION, 'unknown']]));
    await reserveAndAuthorize(context);
    const control = context.adapter.controlDirectory(context.workspace, RUN_ID);
    await writePrivate(join(control, 'launch-1-runtime.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.runtime-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      runtime_executable: EXECUTABLE,
      recorded_at: NOW,
    });
    await writePrivate(join(control, 'launch-1-exit.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.exit-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      observed_at: NOW,
      signal: 'SIGKILL',
      process_group_cleanup: 'unconfirmed',
    });
    const reconciled = await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });
    expect(reconciled).toMatchObject({
      state: 'recovery_required',
      recovery: { process_group_status: 'unknown' },
      launch: { exit: { process_group_cleanup: 'unconfirmed' } },
    });
    expect(() =>
      context.store.recoverRun({
        workspace: context.workspace,
        run_id: RUN_ID,
        owner: context.newOwner,
      }),
    ).toThrow(/could not prove/i);
  });

  it('settles a confirmed exit before requiring recovery for an uncertain supervisor', async () => {
    let supervisorChecks = 0;
    const context = await fixture((identity) => {
      if (identity.birth_token !== 'supervisor-birth') return 'absent';
      supervisorChecks += 1;
      return supervisorChecks <= 2 ? 'unknown' : 'absent';
    });
    await reserveAndAuthorize(context);
    const control = context.adapter.controlDirectory(context.workspace, RUN_ID);
    await writePrivate(join(control, 'launch-1-runtime.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.runtime-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      runtime_executable: EXECUTABLE,
      recorded_at: NOW,
    });
    await writePrivate(join(control, 'launch-1-exit.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.exit-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      observed_at: NOW,
      exit_code: 0,
      process_group_cleanup: 'confirmed',
    });

    const reconciled = await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });
    expect(reconciled).toMatchObject({
      state: 'complete',
      launch: { phase: 'exited', exit: { process_group_cleanup: 'confirmed' } },
    });
    expect(supervisorChecks).toBeGreaterThan(2);
    expect(existsSync(context.store.pathsForRun(context.workspace, RUN_ID).lease_file)).toBe(false);
  });

  it('accepts exact cleanup confirmation without rewriting saved exit evidence', async () => {
    const context = await fixture();
    const handle = await reserveAndAuthorize(context);
    let record = context.store.readRun(context.workspace, RUN_ID);
    record = context.store.advanceLaunch({
      handle,
      launch: {
        ...record.launch,
        phase: 'runtime_recorded',
        runtime: { ...runtimeObservation(), executable: EXECUTABLE },
      },
    });
    record = context.store.advanceLaunch({
      handle,
      launch: {
        ...record.launch,
        phase: 'exited',
        exit: {
          observed_at: '2026-07-21T07:59:00.000Z',
          exit_code: 1,
          signal: 'SIGTERM',
          process_group_cleanup: 'unconfirmed',
        },
      },
    });
    context.store.transitionRun({
      handle,
      to: 'recovery_required',
      summary: 'Cleanup was not confirmed.',
      recovery: {
        reason: 'worker_cleanup_unconfirmed',
        detected_at: NOW,
        last_checked_at: NOW,
        process_group_status: 'unknown',
        cancellation_requested: false,
      },
    });
    context.store.releaseOperation(handle);
    const recovery = context.store.acquireOperation({
      workspace: context.workspace,
      run_id: RUN_ID,
      operation: 'recover',
      owner: context.newOwner,
    });
    if (!recovery.ok) throw new Error('could not acquire recovery claim');
    const current = context.store.readRun(context.workspace, RUN_ID);
    if (current.launch.exit === undefined) throw new Error('missing saved exit evidence');
    const cancelled = context.store.transitionRun({
      handle: recovery.handle,
      to: 'cancelled',
      summary: 'Cleanup confirmed.',
      launch: {
        ...current.launch,
        exit: { ...current.launch.exit, process_group_cleanup: 'confirmed' },
      },
    });
    expect(cancelled.launch.exit).toEqual({
      observed_at: '2026-07-21T07:59:00.000Z',
      exit_code: 1,
      signal: 'SIGTERM',
      process_group_cleanup: 'confirmed',
    });
  });

  it('does not apply an exit journal while the recorded supervisor is alive', async () => {
    const context = await fixture(new Map([['supervisor-birth', 'alive']]));
    await reserveAndAuthorize(context);
    const control = context.adapter.controlDirectory(context.workspace, RUN_ID);
    await writePrivate(join(control, 'launch-1-runtime.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.runtime-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      runtime_executable: EXECUTABLE,
      recorded_at: NOW,
    });
    await writePrivate(join(control, 'launch-1-exit.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.exit-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      observed_at: NOW,
      exit_code: 0,
      process_group_cleanup: 'confirmed',
    });

    const reconciled = await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });
    expect(reconciled).toMatchObject({ state: 'running', launch: { phase: 'runtime_recorded' } });
    expect(existsSync(context.store.pathsForRun(context.workspace, RUN_ID).lease_file)).toBe(true);
  });

  it('ignores advisory progress that names another flow', async () => {
    const context = await fixture();
    await reserveAndAuthorize(context);
    const control = context.adapter.controlDirectory(context.workspace, RUN_ID);
    const progress = new SupervisorProgressWriter({
      control_directory: control,
      run_id: RUN_ID,
      generation: 1,
    });
    progress.ingest(
      `${JSON.stringify({
        schema_version: 1,
        type: 'run.started',
        run_id: RUN_ID,
        flow_id: 'build',
        recorded_at: NOW,
        label: 'Wrong flow',
        display: { text: 'Wrong flow progress.', importance: 'major', tone: 'info' },
        run_folder: join(context.workspacePath, '.circuit', 'runs', RUN_ID),
      })}\n`,
    );
    progress.close();

    const reconciled = await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });
    expect(reconciled.progress).toEqual({
      next_cursor: 0,
      retained_from_cursor: 0,
      dropped_count: 0,
      events: [],
    });
  });

  it('finishes an interrupted cancellation after confirmed supervisor cleanup', async () => {
    const context = await fixture();
    const launchHandle = await reserveAndAuthorize(context);
    let record = context.store.readRun(context.workspace, RUN_ID);
    record = context.store.advanceLaunch({
      handle: launchHandle,
      launch: {
        ...record.launch,
        phase: 'runtime_recorded',
        runtime: { ...runtimeObservation(), executable: EXECUTABLE },
      },
    });
    context.store.transitionRun({
      handle: launchHandle,
      to: 'running',
      summary: 'Running Review.',
    });
    context.store.releaseOperation(launchHandle);

    const cancel = context.store.acquireOperation({
      workspace: context.workspace,
      run_id: RUN_ID,
      operation: 'cancel',
      owner: context.oldOwner,
    });
    if (!cancel.ok) throw new Error('could not acquire cancellation claim');
    context.store.transitionRun({
      handle: cancel.handle,
      to: 'cancelling',
      summary: 'Stopping Review.',
    });
    const control = context.adapter.controlDirectory(context.workspace, RUN_ID);
    await writePrivate(join(control, 'launch-1-runtime.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.runtime-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      runtime_executable: EXECUTABLE,
      recorded_at: NOW,
    });
    await writePrivate(join(control, 'launch-1-exit.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.exit-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      observed_at: NOW,
      signal: 'SIGTERM',
      process_group_cleanup: 'confirmed',
    });

    const reconciled = await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });
    expect(reconciled).toMatchObject({
      state: 'cancelled',
      launch: { phase: 'exited', exit: { process_group_cleanup: 'confirmed' } },
    });
    expect(existsSync(context.store.pathsForRun(context.workspace, RUN_ID).lease_file)).toBe(false);
  });

  it('closes a recorded pre-authorization supervisor only after exact absence', async () => {
    const context = await fixture();
    context.adapter.reserveRun({
      run_id: RUN_ID,
      workspace: context.workspace,
      request: { flow: 'build', goal: 'Build this', web_search: 'off' },
      runtime_assets_sha256: DIGEST,
      owner: context.oldOwner,
      summary: 'Starting Build.',
    });
    const acquired = context.store.acquireOperation({
      workspace: context.workspace,
      run_id: RUN_ID,
      operation: 'reconcile',
      owner: context.oldOwner,
    });
    if (!acquired.ok) throw new Error('could not acquire launch claim');
    const record = context.store.readRun(context.workspace, RUN_ID);
    context.store.advanceLaunch({
      handle: acquired.handle,
      launch: { ...record.launch, phase: 'supervisor_recorded', supervisor: supervisor() },
    });

    const reconciled = await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });
    expect(reconciled).toMatchObject({
      state: 'interrupted',
      launch: { phase: 'exited', exit: { process_group_cleanup: 'confirmed' } },
    });
  });

  it('keeps an authorized launch leased when no worker identity was recorded', async () => {
    const context = await fixture();
    await reserveAndAuthorize(context);

    const reconciled = await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });
    expect(reconciled).toMatchObject({
      state: 'recovery_required',
      recovery: {
        reason: 'runtime_identity_missing',
        runtime_status: 'unknown',
        process_group_status: 'unknown',
      },
    });
    expect(() =>
      context.store.recoverRun({
        workspace: context.workspace,
        run_id: RUN_ID,
        owner: context.newOwner,
      }),
    ).toThrow(/could not prove/i);
    expect(existsSync(context.store.pathsForRun(context.workspace, RUN_ID).lease_file)).toBe(true);
  });

  it('recovers a crash before authorization send only after the precommitted worker token is absent', async () => {
    const context = await fixture(new Map(), undefined, 'absent');
    await reserveAndAuthorize(context);

    await expect(
      context.adapter.reconcileRun({
        workspace: context.workspace,
        run_id: RUN_ID,
        owner: context.newOwner,
      }),
    ).resolves.toMatchObject({ state: 'recovery_required' });

    await expect(
      context.adapter.recoverRun({
        workspace: context.workspace,
        run_id: RUN_ID,
        owner: context.newOwner,
      }),
    ).resolves.toMatchObject({
      record: { state: 'interrupted', launch: { phase: 'exited' } },
      cleanup_confirmed: true,
      lease_released: true,
    });
    expect(context.inspectToken).toHaveBeenCalledWith(AUTHORIZATION);
    expect(existsSync(context.store.pathsForRun(context.workspace, RUN_ID).lease_file)).toBe(false);
  });

  it('keeps the crash-after-send window leased while the precommitted worker token is alive', async () => {
    const context = await fixture(new Map(), undefined, 'alive');
    await reserveAndAuthorize(context);
    await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });

    await expect(
      context.adapter.recoverRun({
        workspace: context.workspace,
        run_id: RUN_ID,
        owner: context.newOwner,
      }),
    ).rejects.toThrow(/process.*still belong|alive/i);
    expect(existsSync(context.store.pathsForRun(context.workspace, RUN_ID).lease_file)).toBe(true);
  });

  it('keeps the crash-after-send window leased when the global token probe is unknown', async () => {
    const context = await fixture(new Map(), undefined, 'unknown');
    await reserveAndAuthorize(context);
    await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });

    await expect(
      context.adapter.recoverRun({
        workspace: context.workspace,
        run_id: RUN_ID,
        owner: context.newOwner,
      }),
    ).rejects.toThrow(/could not prove|unknown/i);
    expect(existsSync(context.store.pathsForRun(context.workspace, RUN_ID).lease_file)).toBe(true);
  });

  it('does not scan by token while the recorded supervisor identity is uncertain', async () => {
    const context = await fixture(new Map([['supervisor-birth', 'unknown']]), undefined, 'absent');
    await reserveAndAuthorize(context);
    await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });

    await expect(
      context.adapter.recoverRun({
        workspace: context.workspace,
        run_id: RUN_ID,
        owner: context.newOwner,
      }),
    ).rejects.toThrow(/could not prove|unknown/i);
    expect(context.inspectToken).not.toHaveBeenCalled();
    expect(existsSync(context.store.pathsForRun(context.workspace, RUN_ID).lease_file)).toBe(true);
  });

  it('releases an authorized missing-runtime launch after restart when the worker token is absent', async () => {
    const context = await fixture();
    await reserveAndAuthorize(context);
    await context.adapter.reconcileRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });

    const inspect = () => 'absent' as const;
    const restartedStore = new McpStateStore({
      stateRoot: join(context.root, 'state'),
      inspectProcess: inspect,
      inspectProcessGroup: inspect,
      inspectProcessToken: inspect,
      now: () => new Date(NOW),
    });
    const restarted = new McpLifecycleStateAdapter({
      store: restartedStore,
      artifacts: context.artifacts,
      inspectProcess: inspect,
      inspectProcessGroup: inspect,
      now: () => new Date(NOW),
    });

    await expect(
      restarted.recoverRun({
        workspace: context.workspace,
        run_id: RUN_ID,
        owner: context.newOwner,
      }),
    ).resolves.toMatchObject({
      record: { state: 'interrupted', launch: { phase: 'exited' } },
      lease_released: true,
    });
  });

  it('hydrates missing worker and exit evidence while recovery remains explicit', async () => {
    const context = await fixture();
    const handle = await reserveAndAuthorize(context);
    context.store.transitionRun({
      handle,
      to: 'recovery_required',
      summary: 'Worker reply was lost.',
      recovery: {
        reason: 'runtime_identity_missing',
        detected_at: NOW,
        last_checked_at: NOW,
        supervisor_status: 'unknown',
        runtime_status: 'unknown',
        process_group_status: 'unknown',
        cancellation_requested: false,
      },
    });
    const control = context.adapter.controlDirectory(context.workspace, RUN_ID);
    await writePrivate(join(control, 'launch-1-runtime.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.runtime-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      runtime_executable: EXECUTABLE,
      recorded_at: NOW,
    });
    await writePrivate(join(control, 'launch-1-exit.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.exit-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: AUTHORIZATION,
      runtime: runtimeObservation(),
      observed_at: NOW,
      exit_code: 0,
      process_group_cleanup: 'confirmed',
    });

    const recovered = await context.adapter.recoverRun({
      workspace: context.workspace,
      run_id: RUN_ID,
      owner: context.newOwner,
    });
    expect(recovered.record).toMatchObject({
      state: 'interrupted',
      launch: {
        phase: 'exited',
        runtime: { pid: 300 },
        exit: { process_group_cleanup: 'confirmed' },
      },
    });
    expect(recovered).toMatchObject({ cleanup_confirmed: true, lease_released: true });
  });

  it('uses the canonical checkpoint reader and returns its exact binding', async () => {
    const context = await fixture();
    const runRoot = join(context.workspacePath, '.circuit', 'runs', RUN_ID);
    const requestPath = 'steps/choose/request.json';
    const request = {
      schema_version: 1,
      step_id: 'choose',
      prompt: 'Choose the next step.',
      allowed_choices: ['continue'],
      choices: [{ id: 'continue', label: 'Continue' }],
      execution_context: {},
    };
    await mkdir(join(runRoot, 'steps', 'choose'), { recursive: true, mode: 0o700 });
    const bytes = `${JSON.stringify(request)}\n`;
    await writeFile(join(runRoot, requestPath), bytes, { mode: 0o600 });
    const checkpoint = {
      generation: 1,
      step_id: 'choose',
      attempt: 1,
      request_path: requestPath,
      request_sha256: createHash('sha256').update(bytes).digest('hex'),
      allowed_choices: ['continue'],
      choices_sha256: sha256OfJson(['continue']),
    };
    const run = {
      ...context.adapter.reserveRun({
        run_id: RUN_ID,
        workspace: context.workspace,
        request: { flow: 'prototype', goal: 'Prototype', web_search: 'off' },
        runtime_assets_sha256: DIGEST,
        owner: context.oldOwner,
        summary: 'Waiting.',
      }),
      state: 'waiting_for_input' as const,
      checkpoint,
    };
    const checkpoints = new McpCheckpointAdapter();
    const view = await checkpoints.read({ workspace: context.workspace, run });
    expect(view).toMatchObject({ prompt: 'Choose the next step.', choices: [{ id: 'continue' }] });
    await expect(
      checkpoints.assertResume({
        workspace: context.workspace,
        run,
        checkpoint_token: view.token,
        choice_id: 'continue',
      }),
    ).resolves.toEqual({
      checkpoint_binding_sha256: view.token.replace('cpt1.', ''),
    });
    await expect(
      checkpoints.assertResume({
        workspace: context.workspace,
        run,
        checkpoint_token: view.token,
        choice_id: 'unknown',
      }),
    ).rejects.toThrow(/not available/i);
  });
});
