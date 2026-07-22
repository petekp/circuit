import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { McpRuntimeAssetPins } from '../../src/hosts/codex-mcp/asset-pins.js';
import {
  CircuitListResponseV1,
  CircuitResumeResponseV1,
  CircuitStartResponseV1,
  CircuitStatusResponseV1,
} from '../../src/hosts/codex-mcp/contracts.js';
import type {
  LifecycleProcessIdentity,
  LifecycleProcessOwnerIdentity,
  LifecycleWorkerFactory,
  LifecycleWorkspaceIdentity,
} from '../../src/hosts/codex-mcp/lifecycle-types.js';
import {
  CircuitMcpLifecycle,
  type CreateCircuitMcpLifecycleOptions,
} from '../../src/hosts/codex-mcp/lifecycle.js';
import type { CircuitMcpToolCall } from '../../src/hosts/codex-mcp/server.js';
import {
  McpCheckpointAdapter,
  McpLifecycleStateAdapter,
  type RuntimeArtifactReconciler,
} from '../../src/hosts/codex-mcp/state-adapter.js';
import { McpStateStore, trustedWorkspaceIdentity } from '../../src/hosts/codex-mcp/state-store.js';
import type { SupervisorLauncher } from '../../src/hosts/codex-mcp/supervisor-launcher.js';
import { sha256OfJson } from '../../src/schemas/hashing.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const NEXT_RUN_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-07-21T08:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const FIRST_AUTHORIZATION = 'b'.repeat(64);
const SECOND_AUTHORIZATION = 'c'.repeat(64);
const FROZEN_V1_FIXTURE_SHA256 = 'f24b8f96d4fc435fc7cf82891894882e3487f53c46f1e93bb2602e5257508a26';
const RUNTIME_ASSETS: McpRuntimeAssetPins = {
  schema_version: 1,
  digest_sha256: DIGEST,
  assets: [],
};
const EXECUTABLE = {
  real_path: '/usr/local/bin/node',
  device: '1',
  inode: '2',
  sha256: 'd'.repeat(64),
};
const roots: string[] = [];

interface DurableStateV1Fixture {
  readonly fixture_kind: 'circuit.mcp.durable-state-fixture';
  readonly fixture_version: 1;
  readonly captured_from_circuit_version: '0.1.1';
  readonly checkpoint_request: Record<string, unknown>;
  readonly waiting_run: Record<string, unknown>;
  readonly waiting_lease: Record<string, unknown>;
  readonly recovery_run: Record<string, unknown>;
  readonly recovery_lease: Record<string, unknown>;
}

function owner(instanceId: string, pid: number): LifecycleProcessOwnerIdentity {
  return {
    instance_id: instanceId,
    pid,
    process_group_id: pid,
    birth_token: `${instanceId}-birth`,
    started_at: NOW,
    executable: EXECUTABLE,
  };
}

function processIdentity(pid: number, birthToken: string): LifecycleProcessIdentity {
  return {
    pid,
    process_group_id: pid,
    birth_token: birthToken,
    started_at: NOW,
    executable: EXECUTABLE,
  };
}

function call(name: CircuitMcpToolCall['name'], input: unknown): CircuitMcpToolCall {
  return { name, input, metadata: undefined, signal: new AbortController().signal };
}

function createLifecycle(input: {
  workspace: LifecycleWorkspaceIdentity;
  owner: LifecycleProcessOwnerIdentity;
  store: McpLifecycleStateAdapter;
  launcher: SupervisorLauncher;
  workerFactory: LifecycleWorkerFactory;
  runtimeAssets?: McpRuntimeAssetPins;
  randomRunId?: () => string;
}): CircuitMcpLifecycle<undefined> {
  const reports: CreateCircuitMcpLifecycleOptions['reports'] = {
    read: async () => {
      throw new Error('A waiting or running run has no final report.');
    },
  };
  return new CircuitMcpLifecycle({
    platform: 'darwin',
    loadRuntimeAssets: async () => input.runtimeAssets ?? RUNTIME_ASSETS,
    preflightLaunch: async () => undefined,
    resolveWorkspace: async () => input.workspace,
    owner: async () => input.owner,
    store: input.store,
    launcher: input.launcher,
    workerFactory: input.workerFactory,
    checkpoints: new McpCheckpointAdapter(),
    reports,
    cleanup: {
      cancel: async () => ({
        cleanup_confirmed: true,
        supervisor_status: 'absent',
        runtime_status: 'absent',
        process_group_status: 'absent',
      }),
    },
    now: () => new Date(NOW),
    randomRunId: input.randomRunId ?? (() => RUN_ID),
  });
}

function stateAdapter(input: {
  stateRoot: string;
  artifacts: RuntimeArtifactReconciler;
  inspect?: (identity: LifecycleProcessIdentity) => 'alive' | 'absent' | 'unknown';
}): { store: McpStateStore; adapter: McpLifecycleStateAdapter } {
  const inspect = input.inspect ?? (() => 'absent' as const);
  const store = new McpStateStore({
    stateRoot: input.stateRoot,
    inspectProcess: inspect,
    inspectProcessGroup: inspect,
    now: () => new Date(NOW),
  });
  return {
    store,
    adapter: new McpLifecycleStateAdapter({
      store,
      artifacts: input.artifacts,
      inspectProcess: inspect,
      inspectProcessGroup: inspect,
      now: () => new Date(NOW),
    }),
  };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function expectMode(path: string, mode: number): Promise<void> {
  expect((await lstat(path)).mode & 0o777).toBe(mode);
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

function bindFixtureWorkspace<T>(value: T, workspace: LifecycleWorkspaceIdentity): T {
  const replacements = new Map([
    ['__WORKSPACE_KEY__', workspace.key],
    ['__WORKSPACE_PATH__', workspace.canonical_path],
    ['__WORKSPACE_DEVICE__', workspace.device],
    ['__WORKSPACE_INODE__', workspace.inode],
  ]);
  let serialized = JSON.stringify(value);
  for (const [placeholder, replacement] of replacements) {
    serialized = serialized.replaceAll(JSON.stringify(placeholder), JSON.stringify(replacement));
  }
  return JSON.parse(serialized) as T;
}

afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('Circuit MCP durable lifecycle restart', () => {
  it('reads and operates on the frozen v1 durable-state fixture', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-v1-state-')));
    roots.push(root);
    const workspacePath = join(root, 'workspace');
    const stateRoot = join(root, 'state');
    await mkdir(workspacePath, { mode: 0o700 });
    const workspace = trustedWorkspaceIdentity(workspacePath);
    const fixtureBytes = await readFile(
      new URL('./fixtures/durable-state-v1.json', import.meta.url),
      'utf8',
    );
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(FROZEN_V1_FIXTURE_SHA256);
    const frozen = JSON.parse(fixtureBytes) as DurableStateV1Fixture;
    expect(frozen).toMatchObject({
      fixture_kind: 'circuit.mcp.durable-state-fixture',
      fixture_version: 1,
      captured_from_circuit_version: '0.1.1',
    });

    const state = stateAdapter({
      stateRoot,
      inspect: () => 'absent',
      artifacts: {
        classifyExit: async () => {
          throw new Error('The frozen waiting state must not be reclassified.');
        },
      },
    });
    const waitingRun = bindFixtureWorkspace(frozen.waiting_run, workspace);
    const waitingLease = bindFixtureWorkspace(frozen.waiting_lease, workspace);
    const waitingPaths = state.store.pathsForRun(workspace, RUN_ID);
    await mkdir(waitingPaths.run_dir, { recursive: true, mode: 0o700 });
    await writePrivateJson(waitingPaths.state_file, waitingRun);
    await writePrivateJson(waitingPaths.lease_file, waitingLease);

    const checkpointPath = join(
      workspacePath,
      '.circuit',
      'runs',
      RUN_ID,
      'steps',
      'choose',
      'request.json',
    );
    await mkdir(join(checkpointPath, '..'), { recursive: true, mode: 0o700 });
    await writePrivateJson(checkpointPath, frozen.checkpoint_request);

    await expectMode(stateRoot, 0o700);
    await expectMode(state.store.runsRoot, 0o700);
    await expectMode(state.store.leasesRoot, 0o700);
    await expectMode(waitingPaths.run_dir, 0o700);
    await expectMode(waitingPaths.state_file, 0o600);
    await expectMode(waitingPaths.lease_file, 0o600);
    await expectMode(checkpointPath, 0o600);

    const lifecycle = createLifecycle({
      workspace,
      owner: owner('current-server', 501),
      store: state.adapter,
      launcher: {
        begin: async () => {
          throw new Error('The v1 compatibility test must not launch a worker.');
        },
      },
      workerFactory: {
        createStart: async () => {
          throw new Error('The v1 compatibility test must not create a start worker.');
        },
        createResume: async () => {
          throw new Error('The v1 compatibility test must not create a resume worker.');
        },
      },
    });

    await expect(lifecycle.handle(call('circuit_list', {}))).resolves.toMatchObject({
      ok: true,
      runs: [
        expect.objectContaining({
          run_id: RUN_ID,
          state: 'waiting_for_input',
          checkpoint_available: true,
        }),
      ],
    });
    await expect(
      lifecycle.handle(call('circuit_status', { run_id: RUN_ID })),
    ).resolves.toMatchObject({
      ok: true,
      run_id: RUN_ID,
      state: 'waiting_for_input',
      checkpoint: {
        prompt: 'Choose whether to keep the v1 prototype.',
        choices: [{ id: 'continue', label: 'Keep prototype' }],
      },
    });
    await expect(
      lifecycle.handle(call('circuit_cancel', { run_id: RUN_ID })),
    ).resolves.toMatchObject({
      ok: true,
      run_id: RUN_ID,
      state: 'cancelled',
      cleanup_confirmed: true,
    });
    await expectMissing(waitingPaths.lease_file);
    expect(state.store.readRun(workspace, RUN_ID).state).toBe('cancelled');
    await expectMode(waitingPaths.state_file, 0o600);

    const recoveryRun = bindFixtureWorkspace(frozen.recovery_run, workspace);
    const recoveryLease = bindFixtureWorkspace(frozen.recovery_lease, workspace);
    const recoveryPaths = state.store.pathsForRun(workspace, NEXT_RUN_ID);
    await mkdir(recoveryPaths.run_dir, { recursive: true, mode: 0o700 });
    await writePrivateJson(recoveryPaths.state_file, recoveryRun);
    await writePrivateJson(recoveryPaths.lease_file, recoveryLease);

    await expect(lifecycle.handle(call('circuit_list', {}))).resolves.toMatchObject({
      ok: true,
      runs: expect.arrayContaining([
        expect.objectContaining({
          run_id: NEXT_RUN_ID,
          state: 'recovery_required',
          checkpoint_available: false,
        }),
      ]),
    });
    await expect(
      lifecycle.handle(call('circuit_status', { run_id: NEXT_RUN_ID })),
    ).resolves.toMatchObject({
      ok: true,
      run_id: NEXT_RUN_ID,
      state: 'recovery_required',
      summary: 'Circuit could not confirm cleanup.',
    });
    await expectMode(recoveryPaths.run_dir, 0o700);
    await expectMode(recoveryPaths.state_file, 0o600);
    await expectMode(recoveryPaths.lease_file, 0o600);

    await expect(
      lifecycle.handle(call('circuit_recover', { run_id: NEXT_RUN_ID })),
    ).resolves.toMatchObject({
      ok: true,
      run_id: NEXT_RUN_ID,
      state: 'interrupted',
      recovered: true,
      cleanup_confirmed: true,
      lease_released: true,
    });
    await expectMissing(recoveryPaths.lease_file);
    expect(state.store.readRun(workspace, NEXT_RUN_ID).state).toBe('interrupted');
    await expectMode(recoveryPaths.state_file, 0o600);
  });

  it('resumes and reconciles a checkpoint reseeded from the frozen v1 fixture', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-v1-resume-')));
    roots.push(root);
    const workspacePath = join(root, 'workspace');
    const stateRoot = join(root, 'state');
    await mkdir(workspacePath, { mode: 0o700 });
    const workspace = trustedWorkspaceIdentity(workspacePath);
    const fixtureBytes = await readFile(
      new URL('./fixtures/durable-state-v1.json', import.meta.url),
      'utf8',
    );
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(FROZEN_V1_FIXTURE_SHA256);
    const frozen = JSON.parse(fixtureBytes) as DurableStateV1Fixture;

    const resumedSupervisor = processIdentity(202, 'v1-resume-supervisor');
    const resumedRuntime = processIdentity(302, SECOND_AUTHORIZATION);
    let resumedProcessesAlive = true;
    let classifiedExit = false;
    const state = stateAdapter({
      stateRoot,
      inspect: (identity) =>
        identity.birth_token === 'v1-resume-server-birth' ||
        (resumedProcessesAlive &&
          (identity.pid === resumedSupervisor.pid || identity.pid === resumedRuntime.pid))
          ? 'alive'
          : 'absent',
      artifacts: {
        classifyExit: async ({ record, exit }) => {
          expect(record.launch.generation).toBe(2);
          expect(exit).toMatchObject({
            generation: 2,
            authorization_sha256: SECOND_AUTHORIZATION,
            process_group_cleanup: 'confirmed',
          });
          classifiedExit = true;
          return {
            state: 'interrupted',
            summary: 'Circuit reconciled the resumed v1 checkpoint and confirmed cleanup.',
          };
        },
      },
    });
    const waitingRun = bindFixtureWorkspace(frozen.waiting_run, workspace);
    const waitingLease = bindFixtureWorkspace(frozen.waiting_lease, workspace);
    const waitingPaths = state.store.pathsForRun(workspace, RUN_ID);
    await mkdir(waitingPaths.run_dir, { recursive: true, mode: 0o700 });
    await writePrivateJson(waitingPaths.state_file, waitingRun);
    await writePrivateJson(waitingPaths.lease_file, waitingLease);

    const checkpointPath = join(
      workspacePath,
      '.circuit',
      'runs',
      RUN_ID,
      'steps',
      'choose',
      'request.json',
    );
    await mkdir(join(checkpointPath, '..'), { recursive: true, mode: 0o700 });
    await writePrivateJson(checkpointPath, frozen.checkpoint_request);

    const resumedLaunches: {
      generation: number;
      checkpointToken: string;
      choiceId: string;
    }[] = [];
    const supervisorGenerations: number[] = [];
    const lifecycle = createLifecycle({
      workspace,
      owner: owner('v1-resume-server', 102),
      store: state.adapter,
      launcher: {
        begin: async ({ generation }) => {
          supervisorGenerations.push(generation);
          return {
            supervisor: resumedSupervisor,
            authorization_token: '2'.repeat(64),
            authorization_sha256: SECOND_AUTHORIZATION,
            authorize: async () => resumedRuntime,
            closeBeforeAuthorization: async () => true,
          };
        },
      },
      workerFactory: {
        createStart: async () => {
          throw new Error('The v1 resume test must not create a start worker.');
        },
        createResume: async ({ run, checkpoint_token, choice_id }) => {
          resumedLaunches.push({
            generation: run.launch.generation,
            checkpointToken: checkpoint_token,
            choiceId: choice_id,
          });
          return { worker_entrypoint: '/tmp/worker.mjs', launch_payload: {} };
        },
      },
    });

    const status = CircuitStatusResponseV1.parse(
      await lifecycle.handle(call('circuit_status', { run_id: RUN_ID })),
    );
    if (!status.ok || status.checkpoint === undefined) {
      throw new Error('Circuit could not read the frozen v1 checkpoint.');
    }
    const choice = status.checkpoint.choices[0];
    if (choice === undefined) throw new Error('The frozen v1 checkpoint had no advertised choice.');

    const resumed = CircuitResumeResponseV1.parse(
      await lifecycle.handle(
        call('circuit_resume', {
          run_id: RUN_ID,
          checkpoint_token: status.checkpoint.token,
          choice_id: choice.id,
        }),
      ),
    );
    if (!resumed.ok) {
      throw new Error(
        `Circuit could not resume the frozen v1 checkpoint: ${JSON.stringify({ resumed, record: state.store.readRun(workspace, RUN_ID), supervisorGenerations, resumedLaunches })}`,
      );
    }
    expect(resumed).toMatchObject({ ok: true, run_id: RUN_ID, state: 'running' });
    expect(supervisorGenerations).toEqual([2]);
    expect(resumedLaunches).toEqual([
      {
        generation: 2,
        checkpointToken: status.checkpoint.token,
        choiceId: 'continue',
      },
    ]);
    const resumedRecord = state.store.readRun(workspace, RUN_ID);
    expect(resumedRecord.checkpoint).toBeUndefined();
    expect(resumedRecord).toMatchObject({
      state: 'running',
      launch: {
        generation: 2,
        phase: 'runtime_recorded',
        supervisor: resumedSupervisor,
        runtime: resumedRuntime,
      },
    });

    const controlDirectory = state.adapter.controlDirectory(workspace, RUN_ID);
    await writePrivateJson(join(controlDirectory, 'launch-2-runtime.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.runtime-observation',
      run_id: RUN_ID,
      generation: 2,
      authorization_sha256: SECOND_AUTHORIZATION,
      runtime: {
        pid: resumedRuntime.pid,
        process_group_id: resumedRuntime.process_group_id,
        birth_token: resumedRuntime.birth_token,
        started_at: resumedRuntime.started_at,
      },
      runtime_executable: EXECUTABLE,
      recorded_at: NOW,
    });
    await writePrivateJson(join(controlDirectory, 'launch-2-exit.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.exit-observation',
      run_id: RUN_ID,
      generation: 2,
      authorization_sha256: SECOND_AUTHORIZATION,
      runtime: {
        pid: resumedRuntime.pid,
        process_group_id: resumedRuntime.process_group_id,
        birth_token: resumedRuntime.birth_token,
        started_at: resumedRuntime.started_at,
      },
      observed_at: NOW,
      exit_code: 1,
      process_group_cleanup: 'confirmed',
    });
    resumedProcessesAlive = false;

    await expect(
      lifecycle.handle(call('circuit_status', { run_id: RUN_ID })),
    ).resolves.toMatchObject({
      ok: true,
      run_id: RUN_ID,
      state: 'interrupted',
      summary: 'Circuit reconciled the resumed v1 checkpoint and confirmed cleanup.',
    });
    expect(classifiedExit).toBe(true);
    expect(state.store.readRun(workspace, RUN_ID)).toMatchObject({
      state: 'interrupted',
      launch: {
        generation: 2,
        phase: 'exited',
        exit: { exit_code: 1, process_group_cleanup: 'confirmed' },
      },
    });
    await expectMissing(waitingPaths.lease_file);
  });

  it('cancels a waiting run after asset drift before starting a replacement', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-drift-cancel-')));
    roots.push(root);
    const workspacePath = join(root, 'workspace');
    const stateRoot = join(root, 'state');
    await mkdir(workspacePath, { mode: 0o700 });
    const workspace = trustedWorkspaceIdentity(workspacePath);
    const state = stateAdapter({
      stateRoot,
      artifacts: {
        classifyExit: async () => {
          throw new Error('A waiting run must not be reclassified.');
        },
      },
    });

    state.store.reserveRun({
      run_id: RUN_ID,
      workspace,
      request: { flow: 'prototype', goal: 'Keep this checkpoint' },
      runtime_assets_sha256: DIGEST,
      owner: owner('old-server', 100),
      summary: 'Circuit is preparing Prototype.',
    });
    const setup = state.store.acquireOperation({
      workspace,
      run_id: RUN_ID,
      operation: 'reconcile',
      owner: owner('setup-server', 101),
    });
    if (!setup.ok) throw new Error('Expected a setup claim.');
    const supervisor = processIdentity(200, 'old-supervisor');
    const runtime = processIdentity(300, FIRST_AUTHORIZATION);
    state.store.advanceLaunch({
      handle: setup.handle,
      launch: {
        generation: 1,
        phase: 'supervisor_recorded',
        allocation_owner: owner('old-server', 100),
        supervisor,
      },
    });
    state.store.advanceLaunch({
      handle: setup.handle,
      launch: {
        generation: 1,
        phase: 'launch_authorized',
        allocation_owner: owner('old-server', 100),
        supervisor,
        authorization_sha256: FIRST_AUTHORIZATION,
        authorized_at: NOW,
      },
    });
    state.store.advanceLaunch({
      handle: setup.handle,
      launch: {
        generation: 1,
        phase: 'runtime_recorded',
        allocation_owner: owner('old-server', 100),
        supervisor,
        runtime,
        authorization_sha256: FIRST_AUTHORIZATION,
        authorized_at: NOW,
      },
    });
    state.store.advanceLaunch({
      handle: setup.handle,
      launch: {
        generation: 1,
        phase: 'exited',
        allocation_owner: owner('old-server', 100),
        supervisor,
        runtime,
        authorization_sha256: FIRST_AUTHORIZATION,
        authorized_at: NOW,
        exit: {
          observed_at: NOW,
          exit_code: 0,
          process_group_cleanup: 'confirmed',
        },
      },
    });
    state.store.transitionRun({
      handle: setup.handle,
      to: 'waiting_for_input',
      summary: 'Prototype is waiting for a choice.',
      checkpoint: {
        generation: 1,
        step_id: 'choose',
        attempt: 1,
        request_path: 'steps/choose/request.json',
        request_sha256: 'e'.repeat(64),
        allowed_choices: ['continue'],
        choices_sha256: sha256OfJson(['continue']),
      },
    });
    state.store.releaseOperation(setup.handle);

    const currentAssets = { ...RUNTIME_ASSETS, digest_sha256: '9'.repeat(64) };
    const lifecycle = createLifecycle({
      workspace,
      owner: owner('new-server', 102),
      store: state.adapter,
      runtimeAssets: currentAssets,
      randomRunId: () => NEXT_RUN_ID,
      launcher: {
        begin: async () => ({
          supervisor: processIdentity(201, 'new-supervisor'),
          authorization_token: '2'.repeat(64),
          authorization_sha256: SECOND_AUTHORIZATION,
          authorize: async () => processIdentity(301, SECOND_AUTHORIZATION),
          closeBeforeAuthorization: async () => true,
        }),
      },
      workerFactory: {
        createStart: async () => ({ worker_entrypoint: '/tmp/worker.mjs', launch_payload: {} }),
        createResume: async () => {
          throw new Error('A drifted run must not launch a resume worker.');
        },
      },
    });

    const drifted = await lifecycle.handle(
      call('circuit_resume', {
        run_id: RUN_ID,
        checkpoint_token: `cpt1.${'4'.repeat(64)}`,
        choice_id: 'continue',
      }),
    );
    expect(drifted).toMatchObject({
      ok: false,
      error: {
        code: 'runtime_asset_changed',
        next_action:
          'Call circuit_cancel for this run, restart Codex, then start a new Circuit run.',
      },
    });

    await expect(
      lifecycle.handle(call('circuit_cancel', { run_id: RUN_ID })),
    ).resolves.toMatchObject({ ok: true, state: 'cancelled', cleanup_confirmed: true });
    await expect(
      lifecycle.handle(call('circuit_start', { flow: 'review', goal: 'Review after upgrade' })),
    ).resolves.toMatchObject({ ok: true, run_id: NEXT_RUN_ID, state: 'running' });
    expect(state.store.readRun(workspace, NEXT_RUN_ID).state).toBe('running');
  });

  it('lists and resumes a persisted Prototype checkpoint through a fresh server and store', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-restart-')));
    roots.push(root);
    const workspacePath = join(root, 'workspace');
    const stateRoot = join(root, 'state');
    await mkdir(workspacePath, { mode: 0o700 });
    const workspace = trustedWorkspaceIdentity(workspacePath);

    const requestPath = 'steps/choose/request.json';
    const runRoot = join(workspacePath, '.circuit', 'runs', RUN_ID);
    await mkdir(join(runRoot, 'steps', 'choose'), { recursive: true, mode: 0o700 });
    const request = {
      schema_version: 1,
      step_id: 'choose',
      prompt: 'Choose the Prototype to continue.',
      allowed_choices: ['continue'],
      choices: [{ id: 'continue', label: 'Continue' }],
      execution_context: { flow: 'prototype' },
    };
    const requestBytes = `${JSON.stringify(request)}\n`;
    await writeFile(join(runRoot, requestPath), requestBytes, { mode: 0o600 });
    const checkpoint = {
      generation: 1,
      step_id: 'choose',
      attempt: 1,
      request_path: requestPath,
      request_sha256: createHash('sha256').update(requestBytes).digest('hex'),
      allowed_choices: ['continue'],
      choices_sha256: sha256OfJson(['continue']),
    };

    const firstSupervisor = processIdentity(200, 'first-supervisor');
    const firstRuntime = processIdentity(300, FIRST_AUTHORIZATION);
    const firstArtifacts: RuntimeArtifactReconciler = {
      classifyExit: async ({ record }) => {
        expect(record.request.flow).toBe('prototype');
        return {
          state: 'waiting_for_input',
          summary: 'Prototype is waiting for a choice.',
          checkpoint,
        };
      },
    };
    const firstState = stateAdapter({ stateRoot, artifacts: firstArtifacts });
    const firstLifecycle = createLifecycle({
      workspace,
      owner: owner('first-server', 100),
      store: firstState.adapter,
      launcher: {
        begin: async () => ({
          supervisor: firstSupervisor,
          authorization_token: '1'.repeat(64),
          authorization_sha256: FIRST_AUTHORIZATION,
          authorize: async () => firstRuntime,
          closeBeforeAuthorization: async () => true,
        }),
      },
      workerFactory: {
        createStart: async () => ({ worker_entrypoint: '/tmp/worker.mjs', launch_payload: {} }),
        createResume: async () => {
          throw new Error('The first server must not resume the checkpoint.');
        },
      },
    });

    const started = CircuitStartResponseV1.parse(
      await firstLifecycle.handle(
        call('circuit_start', { flow: 'prototype', goal: 'Build a durable prototype' }),
      ),
    );
    expect(started).toMatchObject({ ok: true, run_id: RUN_ID, state: 'running' });

    const firstControl = firstState.adapter.controlDirectory(workspace, RUN_ID);
    await writePrivateJson(join(firstControl, 'launch-1-runtime.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.runtime-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: FIRST_AUTHORIZATION,
      runtime: {
        pid: firstRuntime.pid,
        process_group_id: firstRuntime.process_group_id,
        birth_token: firstRuntime.birth_token,
        started_at: firstRuntime.started_at,
      },
      runtime_executable: EXECUTABLE,
      recorded_at: NOW,
    });
    await writePrivateJson(join(firstControl, 'launch-1-exit.json'), {
      schema_version: 1,
      record_kind: 'circuit.mcp.exit-observation',
      run_id: RUN_ID,
      generation: 1,
      authorization_sha256: FIRST_AUTHORIZATION,
      runtime: {
        pid: firstRuntime.pid,
        process_group_id: firstRuntime.process_group_id,
        birth_token: firstRuntime.birth_token,
        started_at: firstRuntime.started_at,
      },
      observed_at: NOW,
      exit_code: 0,
      process_group_cleanup: 'confirmed',
    });

    const firstStatus = CircuitStatusResponseV1.parse(
      await firstLifecycle.handle(call('circuit_status', { run_id: RUN_ID })),
    );
    if (!firstStatus.ok || firstStatus.checkpoint === undefined) {
      throw new Error(
        `The first server did not persist the Prototype checkpoint: ${JSON.stringify(firstStatus)}`,
      );
    }
    expect(firstStatus.state).toBe('waiting_for_input');
    expect(firstStatus.checkpoint.token).toMatch(/^cpt1\.[a-f0-9]{64}$/);

    // Rebuild every server-side state object from the same private state root.
    // Nothing below this point reuses the first server's store or adapter.
    const secondState = stateAdapter({
      stateRoot,
      inspect: (identity) => (identity.birth_token === 'second-server-birth' ? 'alive' : 'absent'),
      artifacts: {
        classifyExit: async () => {
          throw new Error('A waiting run must not be reclassified during restart.');
        },
      },
    });
    const resumedLaunches: {
      generation: number;
      checkpointToken: string;
      choiceId: string;
    }[] = [];
    const supervisorGenerations: number[] = [];
    const secondSupervisor = processIdentity(201, 'second-supervisor');
    const secondRuntime = processIdentity(301, SECOND_AUTHORIZATION);
    const secondLauncher: SupervisorLauncher = {
      begin: async ({ generation }) => {
        supervisorGenerations.push(generation);
        return {
          supervisor: secondSupervisor,
          authorization_token: '2'.repeat(64),
          authorization_sha256: SECOND_AUTHORIZATION,
          authorize: async () => secondRuntime,
          closeBeforeAuthorization: async () => true,
        };
      },
    };
    const secondLifecycle = createLifecycle({
      workspace,
      owner: owner('second-server', 101),
      store: secondState.adapter,
      launcher: secondLauncher,
      workerFactory: {
        createStart: async () => {
          throw new Error('The replacement server must not start another run.');
        },
        createResume: async ({ run, checkpoint_token, choice_id }) => {
          resumedLaunches.push({
            generation: run.launch.generation,
            checkpointToken: checkpoint_token,
            choiceId: choice_id,
          });
          return { worker_entrypoint: '/tmp/worker.mjs', launch_payload: {} };
        },
      },
    });

    const listed = CircuitListResponseV1.parse(
      await secondLifecycle.handle(call('circuit_list', {})),
    );
    if (!listed.ok) throw new Error('The replacement server could not list persisted runs.');
    expect(listed.runs).toEqual([
      expect.objectContaining({
        run_id: RUN_ID,
        flow: 'prototype',
        state: 'waiting_for_input',
        checkpoint_available: true,
      }),
    ]);
    const recoveredRunId = listed.runs[0]?.run_id;
    if (recoveredRunId === undefined) throw new Error('The lost run ID was not recovered by list.');

    const restartedStatus = CircuitStatusResponseV1.parse(
      await secondLifecycle.handle(call('circuit_status', { run_id: recoveredRunId })),
    );
    if (!restartedStatus.ok || restartedStatus.checkpoint === undefined) {
      throw new Error('The replacement server could not read the persisted checkpoint.');
    }
    expect(restartedStatus).toMatchObject({
      state: 'waiting_for_input',
      checkpoint: { choices: [{ id: 'continue', label: 'Continue' }] },
    });
    expect(restartedStatus.checkpoint.token).toBe(firstStatus.checkpoint.token);
    const selectedChoice = restartedStatus.checkpoint.choices[0];
    if (selectedChoice === undefined) throw new Error('The checkpoint had no advertised choice.');

    const resumed = CircuitResumeResponseV1.parse(
      await secondLifecycle.handle(
        call('circuit_resume', {
          run_id: recoveredRunId,
          checkpoint_token: restartedStatus.checkpoint.token,
          choice_id: selectedChoice.id,
        }),
      ),
    );
    if (!resumed.ok) {
      throw new Error(
        `The replacement server could not resume: ${JSON.stringify({
          response: resumed,
          record: secondState.store.readRun(workspace, RUN_ID),
          supervisorGenerations,
          resumedLaunches,
        })}`,
      );
    }
    expect(resumed).toMatchObject({ ok: true, run_id: RUN_ID, state: 'running' });
    expect(supervisorGenerations).toEqual([2]);
    expect(resumedLaunches).toEqual([
      {
        generation: 2,
        checkpointToken: restartedStatus.checkpoint.token,
        choiceId: 'continue',
      },
    ]);
    const resumedRecord = secondState.store.readRun(workspace, RUN_ID);
    expect(resumedRecord.checkpoint).toBeUndefined();
    expect(resumedRecord).toMatchObject({
      state: 'running',
      launch: {
        generation: 2,
        phase: 'runtime_recorded',
        allocation_owner: { instance_id: 'second-server' },
        supervisor: secondSupervisor,
        runtime: secondRuntime,
      },
    });
  });
});
