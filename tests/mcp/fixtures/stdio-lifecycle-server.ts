import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { McpRuntimeAssetPins } from '../../../src/hosts/codex-mcp/asset-pins.js';
import type {
  LifecycleProcessIdentity,
  LifecycleProcessOwnerIdentity,
} from '../../../src/hosts/codex-mcp/lifecycle-types.js';
import { CircuitMcpLifecycle } from '../../../src/hosts/codex-mcp/lifecycle.js';
import { createCircuitMcpServer } from '../../../src/hosts/codex-mcp/server.js';
import {
  McpCheckpointAdapter,
  McpLifecycleStateAdapter,
  type RuntimeArtifactReconciler,
} from '../../../src/hosts/codex-mcp/state-adapter.js';
import {
  McpStateStore,
  type ProcessIdentity,
  type ProcessStatus,
  trustedWorkspaceIdentity,
} from '../../../src/hosts/codex-mcp/state-store.js';
import type { SupervisorLauncher } from '../../../src/hosts/codex-mcp/supervisor-launcher.js';
import { sha256OfJson } from '../../../src/schemas/hashing.js';

const NOW = '2026-07-21T08:00:00.000Z';
const CHECKPOINT_PATH = 'steps/choose/request.json';
const CHECKPOINT_REQUEST = {
  schema_version: 1,
  step_id: 'choose',
  prompt: 'Choose the Prototype to continue.',
  allowed_choices: ['continue'],
  choices: [{ id: 'continue', label: 'Continue' }],
  execution_context: { flow: 'prototype' },
} as const;
const CHECKPOINT_BYTES = `${JSON.stringify(CHECKPOINT_REQUEST)}\n`;
const RUNTIME_ASSETS: McpRuntimeAssetPins = {
  schema_version: 1,
  digest_sha256: 'a'.repeat(64),
  assets: [],
};
const EXECUTABLE = {
  real_path: process.execPath,
  device: '1',
  inode: '2',
  sha256: 'd'.repeat(64),
};

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`Missing required --${name} argument.`);
  }
  return value;
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) return undefined;
  if (value.length === 0 || value.startsWith('--')) {
    throw new Error(`Invalid --${name} argument.`);
  }
  return value;
}

const stateRoot = resolve(requiredArgument('state-root'));
const workspacePath = resolve(requiredArgument('workspace'));
const instanceId = requiredArgument('instance-id');
const runId = requiredArgument('run-id');
const startBarrierArgument = optionalArgument('start-barrier');
const startBarrier = startBarrierArgument === undefined ? undefined : resolve(startBarrierArgument);
const workspace = trustedWorkspaceIdentity(workspacePath);
const syncWaitArray = new Int32Array(new SharedArrayBuffer(4));
let startBarrierUsed = false;
let guardHoldUsed = false;

function processStatus(identity: ProcessIdentity): ProcessStatus {
  try {
    process.kill(identity.pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown';
  }
}

function deterministicUuidFactory(): () => string {
  let sequence = 0;
  return () => {
    const hex = createHash('sha256').update(`${instanceId}:${sequence++}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(
      17,
      20,
    )}-${hex.slice(20, 32)}`;
  };
}

function ownerIdentity(): LifecycleProcessOwnerIdentity {
  return {
    instance_id: instanceId,
    pid: process.pid,
    process_group_id: process.pid,
    birth_token: `${instanceId}-server-birth`,
    started_at: NOW,
    executable: EXECUTABLE,
  };
}

function launchedIdentity(
  kind: 'supervisor' | 'runtime',
  generation: number,
): LifecycleProcessIdentity {
  return {
    pid: process.pid,
    process_group_id: process.pid,
    birth_token: `${instanceId}-${kind}-${generation}`,
    started_at: NOW,
    executable: EXECUTABLE,
  };
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
}

async function waitForBarrierFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for test barrier ${path}.`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

async function enterStartBarrier(): Promise<void> {
  if (startBarrier === undefined || startBarrierUsed) return;
  startBarrierUsed = true;
  writeFileSync(join(startBarrier, `ready-${instanceId}`), 'ready\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await waitForBarrierFile(join(startBarrier, 'release-start'));
}

function holdWorkspaceGuardForRace(): void {
  if (startBarrier === undefined || guardHoldUsed) return;
  guardHoldUsed = true;
  writeFileSync(join(startBarrier, `guard-held-${instanceId}`), 'held\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const release = join(startBarrier, 'release-owner');
  const deadline = Date.now() + 5_000;
  while (!existsSync(release)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for test barrier ${release}.`);
    Atomics.wait(syncWaitArray, 0, 0, 5);
  }
}

function writeCheckpoint(runIdValue: string): void {
  const requestPath = join(
    workspace.canonical_path,
    '.circuit',
    'runs',
    runIdValue,
    CHECKPOINT_PATH,
  );
  mkdirSync(dirname(requestPath), { recursive: true, mode: 0o700 });
  writeFileSync(requestPath, CHECKPOINT_BYTES, { mode: 0o600, flag: 'wx' });
}

const artifacts: RuntimeArtifactReconciler = {
  classifyExit: async ({ record }) => {
    if (record.request.flow !== 'prototype') {
      throw new Error('The stdio restart fixture accepts only Prototype.');
    }
    const requestPath = join(
      record.workspace.canonical_path,
      '.circuit',
      'runs',
      record.run_id,
      CHECKPOINT_PATH,
    );
    const requestBytes = readFileSync(requestPath);
    return {
      state: 'waiting_for_input',
      summary: 'Prototype is waiting for a choice.',
      checkpoint: {
        generation: record.launch.generation,
        step_id: CHECKPOINT_REQUEST.step_id,
        attempt: 1,
        request_path: CHECKPOINT_PATH,
        request_sha256: createHash('sha256').update(requestBytes).digest('hex'),
        allowed_choices: [...CHECKPOINT_REQUEST.allowed_choices],
        choices_sha256: sha256OfJson(CHECKPOINT_REQUEST.allowed_choices),
      },
    };
  },
};

const state = new McpStateStore({
  stateRoot,
  now: () => new Date(NOW),
  randomId: deterministicUuidFactory(),
  inspectProcess: processStatus,
  inspectProcessGroup: processStatus,
  beforeRunStateRead: holdWorkspaceGuardForRace,
});
const store = new McpLifecycleStateAdapter({
  store: state,
  artifacts,
  inspectProcess: processStatus,
  inspectProcessGroup: processStatus,
  now: () => new Date(NOW),
});

const launcher: SupervisorLauncher = {
  begin: async ({ run_id, generation, control_directory }) => {
    const authorizationToken = createHash('sha256')
      .update(`${instanceId}:authorization:${generation}`)
      .digest('hex');
    const authorizationSha256 = createHash('sha256').update(authorizationToken).digest('hex');
    return {
      supervisor: launchedIdentity('supervisor', generation),
      authorization_token: authorizationToken,
      authorization_sha256: authorizationSha256,
      authorize: async ({ worker }) => {
        const payload = worker.launch_payload as { readonly mode?: unknown };
        const mode = payload.mode;
        if (mode !== 'start' && mode !== 'resume') {
          throw new Error('The deterministic worker payload has an invalid mode.');
        }
        const runtime = {
          ...launchedIdentity('runtime', generation),
          birth_token: authorizationSha256,
        };
        const runtimeObservation = {
          pid: runtime.pid,
          process_group_id: runtime.process_group_id,
          birth_token: runtime.birth_token,
          started_at: runtime.started_at,
        };
        writePrivateJson(join(control_directory, `launch-${generation}-runtime.json`), {
          schema_version: 1,
          record_kind: 'circuit.mcp.runtime-observation',
          run_id,
          generation,
          authorization_sha256: authorizationSha256,
          runtime: runtimeObservation,
          runtime_executable: EXECUTABLE,
          recorded_at: NOW,
        });
        if (mode === 'start') {
          writePrivateJson(join(control_directory, `launch-${generation}-exit.json`), {
            schema_version: 1,
            record_kind: 'circuit.mcp.exit-observation',
            run_id,
            generation,
            authorization_sha256: authorizationSha256,
            runtime: runtimeObservation,
            observed_at: NOW,
            exit_code: 0,
            process_group_cleanup: 'confirmed',
          });
        }
        return runtime;
      },
      closeBeforeAuthorization: async () => true,
    };
  },
};

const lifecycle = new CircuitMcpLifecycle({
  platform: 'darwin',
  loadRuntimeAssets: async () => RUNTIME_ASSETS,
  preflightLaunch: async () => undefined,
  validateStart: async (request) => {
    if (request.flow !== 'prototype') {
      throw new Error('The stdio restart fixture accepts only Prototype.');
    }
  },
  resolveWorkspace: async () => workspace,
  owner: async () => ownerIdentity(),
  store,
  launcher,
  workerFactory: {
    createStart: async ({ run }) => {
      writeCheckpoint(run.run_id);
      return { worker_entrypoint: '/test/worker.mjs', launch_payload: { mode: 'start' } };
    },
    createResume: async ({ run, checkpoint_token, choice_id }) => {
      if (
        run.launch.generation !== 2 ||
        !checkpoint_token.startsWith('cpt1.') ||
        choice_id !== 'continue'
      ) {
        throw new Error('The replacement server received an invalid resume request.');
      }
      return { worker_entrypoint: '/test/worker.mjs', launch_payload: { mode: 'resume' } };
    },
  },
  checkpoints: new McpCheckpointAdapter(),
  reports: {
    read: async () => {
      throw new Error('The stdio restart fixture does not produce a final report.');
    },
  },
  cleanup: {
    cancel: async () => ({
      cleanup_confirmed: true,
      supervisor_status: 'absent',
      runtime_status: 'absent',
      process_group_status: 'absent',
    }),
  },
  now: () => new Date(NOW),
  randomRunId: () => runId,
});

async function main(): Promise<void> {
  const server = createCircuitMcpServer({
    handle: async (call) => {
      if (call.name === 'circuit_start') await enterStartBarrier();
      const response = await lifecycle.handle(call);
      if (
        startBarrier !== undefined &&
        call.name === 'circuit_start' &&
        typeof response === 'object' &&
        response !== null &&
        'ok' in response &&
        response.ok === false
      ) {
        writePrivateJson(join(startBarrier, `refused-${instanceId}.json`), response);
      }
      return response;
    },
  });
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Circuit MCP stdio restart fixture failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
