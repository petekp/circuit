import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
const NOW = '2026-07-21T08:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const FIRST_AUTHORIZATION = 'b'.repeat(64);
const SECOND_AUTHORIZATION = 'c'.repeat(64);
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
}): CircuitMcpLifecycle<undefined> {
  const reports: CreateCircuitMcpLifecycleOptions['reports'] = {
    read: async () => {
      throw new Error('A waiting or running run has no final report.');
    },
  };
  return new CircuitMcpLifecycle({
    platform: 'darwin',
    loadRuntimeAssets: async () => RUNTIME_ASSETS,
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
    randomRunId: () => RUN_ID,
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

afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('Circuit MCP durable lifecycle restart', () => {
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
