import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { checkpointBindingSha256 } from '../../src/hosts/codex-mcp/checkpoint-view.js';
import {
  McpStateStore,
  McpStateStoreError,
  type ProcessIdentity,
  type ProcessOwnerIdentity,
  type ProcessStatus,
  type StoredCheckpoint,
  type StoredLaunch,
  StoredLaunchV1,
  trustedWorkspaceIdentity,
} from '../../src/hosts/codex-mcp/state-store.js';

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const RUN_C = '33333333-3333-4333-8333-333333333333';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const NOW = '2026-07-20T08:00:00.000Z';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'circuit-mcp-state-'));
  roots.push(root);
  const stateRoot = join(root, 'codex-home', 'circuit', 'mcp', 'v1');
  const workspaceAPath = join(root, 'workspace-a');
  const workspaceBPath = join(root, 'workspace-b');
  mkdirSync(workspaceAPath, { mode: 0o700, recursive: true });
  mkdirSync(workspaceBPath, { mode: 0o700, recursive: true });
  return {
    root,
    stateRoot,
    workspaceA: trustedWorkspaceIdentity(workspaceAPath),
    workspaceB: trustedWorkspaceIdentity(workspaceBPath),
  };
}

function processIdentity(id: string): ProcessIdentity {
  return {
    pid: id.charCodeAt(0),
    process_group_id: id.charCodeAt(0),
    started_at: NOW,
    birth_token: `birth-${id}`,
    executable: {
      real_path: '/usr/bin/node',
      device: '1',
      inode: '2',
      sha256: SHA_B,
    },
  };
}

function runtimeIdentity(): ProcessIdentity {
  return { ...processIdentity('r'), birth_token: SHA_A };
}

function owner(id: string): ProcessOwnerIdentity {
  return { ...processIdentity(id), instance_id: `instance-${id}` };
}

function store(
  stateRoot: string,
  statuses: (identity: ProcessIdentity) => ProcessStatus = () => 'unknown',
): McpStateStore {
  return new McpStateStore({
    stateRoot,
    now: () => new Date(NOW),
    inspectProcess: statuses,
    inspectProcessGroup: statuses,
  });
}

function reserve(
  state: McpStateStore,
  workspace: ReturnType<typeof trustedWorkspaceIdentity>,
  runId = RUN_A,
  allocationOwner = owner('a'),
) {
  return state.reserveRun({
    run_id: runId,
    workspace,
    request: { flow: 'review', goal: 'Review this change' },
    runtime_assets_sha256: SHA_A,
    owner: allocationOwner,
    summary: 'Circuit is preparing Review.',
  });
}

function confirmedLaunch(generation = 1): StoredLaunch {
  return {
    generation,
    phase: 'exited',
    allocation_owner: owner('a'),
    supervisor: processIdentity('s'),
    runtime: runtimeIdentity(),
    authorization_sha256: SHA_A,
    authorized_at: NOW,
    exit: {
      observed_at: NOW,
      exit_code: 0,
      process_group_cleanup: 'confirmed',
    },
  };
}

it('rejects stored worker identity that differs from the committed launch token', () => {
  expect(
    StoredLaunchV1.safeParse({
      ...confirmedLaunch(),
      runtime: { ...runtimeIdentity(), birth_token: 'wrong-worker-token' },
    }).success,
  ).toBe(false);
});

function advanceToExited(
  state: McpStateStore,
  handle: Parameters<McpStateStore['advanceLaunch']>[0]['handle'],
  cleanup: 'confirmed' | 'unconfirmed' = 'confirmed',
  allocationOwner = owner('a'),
  generation = 1,
): StoredLaunch {
  state.advanceLaunch({
    handle,
    launch: {
      generation,
      phase: 'supervisor_recorded',
      allocation_owner: allocationOwner,
      supervisor: processIdentity('s'),
    },
  });
  state.advanceLaunch({
    handle,
    launch: {
      generation,
      phase: 'launch_authorized',
      allocation_owner: allocationOwner,
      supervisor: processIdentity('s'),
      authorization_sha256: SHA_A,
      authorized_at: NOW,
    },
  });
  state.advanceLaunch({
    handle,
    launch: {
      generation,
      phase: 'runtime_recorded',
      allocation_owner: allocationOwner,
      supervisor: processIdentity('s'),
      runtime: runtimeIdentity(),
      authorization_sha256: SHA_A,
      authorized_at: NOW,
    },
  });
  return state.advanceLaunch({
    handle,
    launch: {
      ...confirmedLaunch(generation),
      allocation_owner: allocationOwner,
      exit: { observed_at: NOW, exit_code: 0, process_group_cleanup: cleanup },
    },
  }).launch;
}

function checkpoint(generation = 1): StoredCheckpoint {
  const allowedChoices = ['continue', 'stop'];
  return {
    generation,
    step_id: 'pick-direction',
    attempt: 1,
    request_path: 'reports/checkpoints/pick-request.json',
    request_sha256: SHA_A,
    allowed_choices: allowedChoices,
    choices_sha256: createHash('sha256').update(JSON.stringify(allowedChoices)).digest('hex'),
  };
}

function checkpointBinding(
  workspace: ReturnType<typeof trustedWorkspaceIdentity>,
  runId = RUN_A,
  value = checkpoint(),
): string {
  return checkpointBindingSha256({
    workspace_key: workspace.key,
    run_id: runId,
    checkpoint: value,
  });
}

function simulateOrphanStaging(
  state: McpStateStore,
  workspace: ReturnType<typeof trustedWorkspaceIdentity>,
): string {
  const record = reserve(state, workspace);
  const paths = state.pathsForRun(workspace, RUN_A);
  const staging = join(resolve(paths.run_dir, '..'), `.${RUN_A}.${record.lease_id}.tmp`);
  renameSync(paths.run_dir, staging);
  rmSync(paths.lease_file);
  return staging;
}

function expectStoreError(action: () => unknown, code: string, nextAction?: string): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(McpStateStoreError);
    expect((error as McpStateStoreError).code).toBe(code);
    if (nextAction !== undefined) {
      expect((error as McpStateStoreError).next_action).toBe(nextAction);
    }
  }
}

function waitForClaimChild(child: ChildProcessWithoutNullStreams): {
  readonly ready: Promise<void>;
  readonly result: Promise<{ readonly ok: boolean; readonly code?: string }>;
} {
  let markReady: (() => void) | undefined;
  let resolveResult:
    | ((value: { readonly ok: boolean; readonly code?: string }) => void)
    | undefined;
  let rejectResult: ((reason: Error) => void) | undefined;
  const ready = new Promise<void>((resolveReady) => {
    markReady = resolveReady;
  });
  const result = new Promise<{ readonly ok: boolean; readonly code?: string }>(
    (resolveChild, rejectChild) => {
      resolveResult = resolveChild;
      rejectResult = rejectChild;
    },
  );
  let stdout = '';
  let stderr = '';
  let parsedResult: { readonly ok: boolean; readonly code?: string } | undefined;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    for (const line of stdout.split('\n')) {
      if (line === 'READY') markReady?.();
      if (line.startsWith('{')) {
        parsedResult = JSON.parse(line) as { readonly ok: boolean; readonly code?: string };
      }
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('error', (error) => rejectResult?.(error));
  child.on('close', (code) => {
    if (parsedResult === undefined || code !== 0) {
      rejectResult?.(
        new Error(`claim child exited ${String(code)} without a result: ${stderr || stdout}`),
      );
      return;
    }
    resolveResult?.(parsedResult);
  });
  return { ready, result };
}

describe('MCP private state storage', () => {
  it('rejects an existing state root that is not private', async () => {
    const { stateRoot } = await fixture();
    mkdirSync(stateRoot, { mode: 0o755, recursive: true });
    chmodSync(stateRoot, 0o755);

    expectStoreError(() => store(stateRoot), 'state_permissions');
  });

  it('creates one atomic workspace lease and private state files', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const first = store(stateRoot);

    reserve(first, workspaceA);

    const paths = first.pathsForRun(workspaceA, RUN_A);
    expect(lstatSync(stateRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(stateRoot, 'runs')).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(stateRoot, 'leases')).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.run_dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.state_file).mode & 0o777).toBe(0o600);
    expect(lstatSync(paths.lease_file).mode & 0o777).toBe(0o600);

    expectStoreError(
      () => reserve(store(stateRoot), workspaceA, RUN_B, owner('b')),
      'workspace_busy',
    );
  });

  it('rejects broad permissions, symlinked records, and unknown record fields', async () => {
    const { root, stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA);
    const paths = state.pathsForRun(workspaceA, RUN_A);

    chmodSync(paths.state_file, 0o644);
    expectStoreError(() => state.readRun(workspaceA, RUN_A), 'state_permissions');
    chmodSync(paths.state_file, 0o600);

    const original = readFileSync(paths.state_file, 'utf8');
    const target = join(root, 'outside-state.json');
    writeFileSync(target, original, { mode: 0o600 });
    rmSync(paths.state_file, { force: true });
    symlinkSync(target, paths.state_file);
    expectStoreError(() => state.readRun(workspaceA, RUN_A), 'state_unsafe_file');

    rmSync(paths.state_file, { force: true });
    const parsed = JSON.parse(original) as Record<string, unknown>;
    const request = parsed.request as Record<string, unknown>;
    Reflect.deleteProperty(request, 'web_search');
    writeFileSync(paths.state_file, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    expectStoreError(() => state.readRun(workspaceA, RUN_A), 'state_corrupt');

    parsed.request = { ...request, web_search: 'off' };
    writeFileSync(paths.state_file, `${JSON.stringify({ ...parsed, surprise: true })}\n`, {
      mode: 0o600,
    });
    expectStoreError(() => state.readRun(workspaceA, RUN_A), 'state_corrupt');
  });

  it('removes an unleased start staging directory only after its owner and group are absent', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const staging = simulateOrphanStaging(store(stateRoot), workspaceA);

    reserve(
      store(stateRoot, () => 'absent'),
      workspaceA,
      RUN_B,
      owner('b'),
    );
    expect(lstatSync(staging, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(store(stateRoot).pathsForRun(workspaceA, RUN_B).run_dir).isDirectory()).toBe(
      true,
    );
  });

  it('removes an empty start stage left after its guarded creator exited', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot, () => 'absent');
    const workspaceRunsRoot = join(state.runsRoot, workspaceA.key);
    mkdirSync(workspaceRunsRoot, { mode: 0o700 });
    const emptyStage = join(workspaceRunsRoot, `.${RUN_A}.${RUN_B}.tmp`);
    mkdirSync(emptyStage, { mode: 0o700 });

    reserve(state, workspaceA, RUN_C, owner('c'));
    expect(lstatSync(emptyStage, { throwIfNoEntry: false })).toBeUndefined();
  });

  it.each(['alive', 'unknown'] as const)(
    'keeps unleased start staging when its owner or group is %s',
    async (status) => {
      const { stateRoot, workspaceA } = await fixture();
      const staging = simulateOrphanStaging(store(stateRoot), workspaceA);

      expectStoreError(
        () =>
          reserve(
            store(stateRoot, () => status),
            workspaceA,
            RUN_B,
            owner('b'),
          ),
        status === 'alive' ? 'workspace_busy' : 'workspace_owner_unknown',
      );
      expect(lstatSync(staging).isDirectory()).toBe(true);
    },
  );

  it('reclaims control staging by exact owner PID even when Codex still owns the shared group', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const staging = simulateOrphanStaging(store(stateRoot), workspaceA);
    const state = new McpStateStore({
      stateRoot,
      inspectProcess: () => 'absent',
      inspectProcessGroup: () => 'alive',
    });

    reserve(state, workspaceA, RUN_B, owner('b'));
    expect(lstatSync(staging, { throwIfNoEntry: false })).toBeUndefined();
  });
});

describe('MCP state transitions and operation claims', () => {
  it('publishes the initial start claim atomically with the new run', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const first = store(stateRoot, () => 'alive');
    const second = store(stateRoot, () => 'alive');
    const reserved = first.reserveRunClaimed({
      run_id: RUN_A,
      workspace: workspaceA,
      request: { flow: 'review', goal: 'Review this change' },
      runtime_assets_sha256: SHA_A,
      owner: owner('a'),
      summary: 'Circuit is preparing Review.',
    });

    expect(second.readRun(workspaceA, RUN_A)).toMatchObject({ state: 'starting' });
    expect(
      second.acquireOperation({
        workspace: workspaceA,
        run_id: RUN_A,
        operation: 'cancel',
        owner: owner('b'),
      }),
    ).toMatchObject({ ok: false, code: 'operation_in_progress' });

    first.releaseOperation(reserved.handle);
    expect(
      second.acquireOperation({
        workspace: workspaceA,
        run_id: RUN_A,
        operation: 'cancel',
        owner: owner('b'),
      }),
    ).toMatchObject({ ok: true });
  });

  it('persists each launch handshake phase before a run becomes active', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('l'),
    });
    if (!claim.ok) throw new Error('expected claim');

    expectStoreError(
      () =>
        state.transitionRun({
          handle: claim.handle,
          to: 'running',
          summary: 'Reserved is not running.',
        }),
      'invalid_state_record',
    );
    state.advanceLaunch({
      handle: claim.handle,
      launch: {
        generation: 1,
        phase: 'supervisor_recorded',
        allocation_owner: owner('a'),
        supervisor: processIdentity('s'),
      },
    });
    state.advanceLaunch({
      handle: claim.handle,
      launch: {
        generation: 1,
        phase: 'launch_authorized',
        allocation_owner: owner('a'),
        supervisor: processIdentity('s'),
        authorization_sha256: SHA_A,
        authorized_at: NOW,
      },
    });
    state.advanceLaunch({
      handle: claim.handle,
      launch: {
        generation: 1,
        phase: 'runtime_recorded',
        allocation_owner: owner('a'),
        supervisor: processIdentity('s'),
        runtime: runtimeIdentity(),
        authorization_sha256: SHA_A,
        authorized_at: NOW,
      },
    });
    expect(
      state.transitionRun({
        handle: claim.handle,
        to: 'running',
        summary: 'Circuit is running.',
      }).launch.phase,
    ).toBe('runtime_recorded');
    state.releaseOperation(claim.handle);
  });

  it('does not report success or a checkpoint when launch exited before recording a runtime', async () => {
    for (const target of ['running', 'waiting_for_input', 'complete'] as const) {
      const { stateRoot, workspaceA } = await fixture();
      const state = store(stateRoot);
      reserve(state, workspaceA);
      const claim = state.acquireOperation({
        workspace: workspaceA,
        run_id: RUN_A,
        operation: 'reconcile',
        owner: owner('l'),
      });
      if (!claim.ok) throw new Error('expected claim');
      state.advanceLaunch({
        handle: claim.handle,
        launch: {
          generation: 1,
          phase: 'exited',
          allocation_owner: owner('a'),
          exit: {
            observed_at: NOW,
            exit_code: 1,
            process_group_cleanup: 'confirmed',
          },
        },
      });

      expectStoreError(
        () =>
          state.transitionRun({
            handle: claim.handle,
            to: target,
            summary: 'A worker was never recorded.',
            ...(target === 'waiting_for_input' ? { checkpoint: checkpoint() } : {}),
            ...(target === 'complete'
              ? {
                  final_report: {
                    schema: 'review.result@1',
                    path: 'reports/review.json',
                    sha256: SHA_A,
                    byte_length: 120,
                    summary: 'Review completed.',
                  },
                }
              : {}),
          }),
        'invalid_state_record',
      );
      state.releaseOperation(claim.handle);
    }
  });

  it('keeps the workspace lease while waiting and releases it only after a confirmed terminal state', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA);

    const waitingClaim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('w'),
    });
    expect(waitingClaim.ok).toBe(true);
    if (!waitingClaim.ok) throw new Error('expected operation claim');
    advanceToExited(state, waitingClaim.handle);
    state.transitionRun({
      handle: waitingClaim.handle,
      to: 'waiting_for_input',
      summary: 'Circuit needs a choice.',
      checkpoint: checkpoint(),
    });
    state.releaseOperation(waitingClaim.handle);

    expectStoreError(
      () => reserve(store(stateRoot), workspaceA, RUN_B, owner('b')),
      'workspace_busy',
    );

    const cancelClaim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'cancel',
      owner: owner('c'),
    });
    expect(cancelClaim.ok).toBe(true);
    if (!cancelClaim.ok) throw new Error('expected operation claim');
    const cancelled = state.transitionRun({
      handle: cancelClaim.handle,
      to: 'cancelled',
      summary: 'Circuit stopped the waiting run.',
      checkpoint: null,
    });
    state.releaseOperation(cancelClaim.handle);

    expect(cancelled.finished_at).toBe(NOW);
    expect(
      lstatSync(state.pathsForRun(workspaceA, RUN_A).lease_file, { throwIfNoEntry: false }),
    ).toBeUndefined();
    expect(() => reserve(state, workspaceA, RUN_B, owner('b'))).not.toThrow();
  });

  it('rejects invalid transitions and makes terminal records immutable', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA);

    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('x'),
    });
    if (!claim.ok) throw new Error('expected operation claim');
    advanceToExited(state, claim.handle);
    expectStoreError(
      () =>
        state.transitionRun({
          handle: claim.handle,
          to: 'waiting_for_input',
          summary: 'Missing checkpoint.',
        }),
      'invalid_state_record',
    );
    state.transitionRun({
      handle: claim.handle,
      to: 'complete',
      summary: 'Review completed.',
      final_report: {
        schema: 'review.result@1',
        path: 'reports/review.json',
        sha256: SHA_A,
        byte_length: 120,
        summary: 'Review completed.',
      },
    });
    expectStoreError(
      () =>
        state.transitionRun({
          handle: claim.handle,
          to: 'running',
          summary: 'Cannot restart.',
        }),
      'invalid_transition',
    );
    state.releaseOperation(claim.handle);
  });

  it('requires a new launch generation and token-bound claim before resume', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA);
    const waiting = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('w'),
    });
    if (!waiting.ok) throw new Error('expected waiting claim');
    advanceToExited(state, waiting.handle);
    state.transitionRun({
      handle: waiting.handle,
      to: 'waiting_for_input',
      summary: 'Circuit needs a choice.',
      checkpoint: checkpoint(),
    });
    state.releaseOperation(waiting.handle);

    const resume = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'resume',
      owner: owner('r'),
      checkpoint_binding_sha256: checkpointBinding(workspaceA),
    });
    if (!resume.ok) throw new Error('expected resume claim');
    expectStoreError(
      () =>
        state.transitionRun({
          handle: resume.handle,
          to: 'resuming',
          summary: 'Old generation must not resume.',
          launch: { generation: 1, phase: 'reserved', allocation_owner: owner('r') },
        }),
      'invalid_resume_generation',
    );
    expect(
      state.transitionRun({
        handle: resume.handle,
        to: 'resuming',
        summary: 'Circuit is resuming.',
        launch: { generation: 2, phase: 'reserved', allocation_owner: owner('r') },
      }).launch.generation,
    ).toBe(2);
    state.releaseOperation(resume.handle);
  });

  it('recovers a resume crash before supervisor launch from the new generation owner', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot, (identity) =>
      'instance_id' in identity && identity.instance_id === owner('r').instance_id
        ? 'absent'
        : 'unknown',
    );
    reserve(state, workspaceA);
    const waiting = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('w'),
    });
    if (!waiting.ok) throw new Error('expected waiting claim');
    advanceToExited(state, waiting.handle);
    state.transitionRun({
      handle: waiting.handle,
      to: 'waiting_for_input',
      summary: 'Circuit needs a choice.',
      checkpoint: checkpoint(),
    });
    state.releaseOperation(waiting.handle);

    const resume = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'resume',
      owner: owner('r'),
      checkpoint_binding_sha256: checkpointBinding(workspaceA),
    });
    if (!resume.ok) throw new Error('expected resume claim');
    state.transitionRun({
      handle: resume.handle,
      to: 'resuming',
      summary: 'Circuit is resuming.',
      launch: { generation: 2, phase: 'reserved', allocation_owner: owner('r') },
    });
    state.transitionRun({
      handle: resume.handle,
      to: 'recovery_required',
      summary: 'Resume stopped before launch.',
      recovery: {
        reason: 'resume_launch_interrupted',
        detected_at: NOW,
        last_checked_at: NOW,
        cancellation_requested: false,
      },
    });
    state.releaseOperation(resume.handle);

    expect(
      state.recoverRun({ workspace: workspaceA, run_id: RUN_A, owner: owner('q') }).record.state,
    ).toBe('interrupted');
  });

  it('rejects a resume binding that became stale before the operation claim was won', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA);
    const waiting = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('w'),
    });
    if (!waiting.ok) throw new Error('expected waiting claim');
    advanceToExited(state, waiting.handle);
    const firstCheckpoint = checkpoint();
    state.transitionRun({
      handle: waiting.handle,
      to: 'waiting_for_input',
      summary: 'Circuit needs a choice.',
      checkpoint: firstCheckpoint,
    });
    state.releaseOperation(waiting.handle);
    const staleBinding = checkpointBinding(workspaceA, RUN_A, firstCheckpoint);

    const currentResume = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'resume',
      owner: owner('b'),
      checkpoint_binding_sha256: staleBinding,
    });
    if (!currentResume.ok) throw new Error('expected current resume claim');
    state.transitionRun({
      handle: currentResume.handle,
      to: 'resuming',
      summary: 'Circuit is resuming.',
      launch: { generation: 2, phase: 'reserved', allocation_owner: owner('b') },
    });
    advanceToExited(state, currentResume.handle, 'confirmed', owner('b'), 2);
    const nextCheckpoint = checkpoint(2);
    state.transitionRun({
      handle: currentResume.handle,
      to: 'waiting_for_input',
      summary: 'Circuit needs another choice.',
      checkpoint: nextCheckpoint,
    });
    state.releaseOperation(currentResume.handle);

    expectStoreError(
      () =>
        state.acquireOperation({
          workspace: workspaceA,
          run_id: RUN_A,
          operation: 'resume',
          owner: owner('a'),
          checkpoint_binding_sha256: staleBinding,
        }),
      'checkpoint_stale',
    );
  });

  it('lets only one store own an operation and never lets an old handle remove its replacement', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const firstOwner = owner('a');
    const secondOwner = owner('b');
    const status = (identity: ProcessIdentity): ProcessStatus =>
      'instance_id' in identity && identity.instance_id === firstOwner.instance_id
        ? 'absent'
        : 'alive';
    const first = store(stateRoot, status);
    const second = store(stateRoot, status);
    reserve(first, workspaceA, RUN_A, owner('z'));

    const stale = first.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: firstOwner,
    });
    if (!stale.ok) throw new Error('expected first claim');

    const replacement = second.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'cancel',
      owner: secondOwner,
    });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error('expected reclaimed claim');

    expectStoreError(
      () =>
        first.transitionRun({
          handle: stale.handle,
          to: 'running',
          summary: 'A replaced claim must not write.',
        }),
      'operation_claim_changed',
    );
    expectStoreError(() => first.releaseOperation(stale.handle), 'operation_claim_changed');
    expect(readFileSync(second.pathsForRun(workspaceA, RUN_A).operation_file, 'utf8')).toContain(
      replacement.handle.claim.claim_id,
    );
    second.releaseOperation(replacement.handle);
  });

  it('clears a late old release marker before publishing a replacement claim', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const firstOwner = owner('a');
    const first = store(stateRoot, () => 'alive');
    reserve(first, workspaceA);
    const stale = first.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: firstOwner,
    });
    if (!stale.ok) throw new Error('expected stale claim');

    let injected = false;
    const replacementStore = new McpStateStore({
      stateRoot,
      inspectProcess: (identity) =>
        'instance_id' in identity && identity.instance_id === firstOwner.instance_id
          ? 'absent'
          : 'alive',
      afterOperationClaimReclaimed: (claim) => {
        injected = true;
        writeFileSync(
          first.pathsForRun(workspaceA, RUN_A).operation_release_file,
          `${JSON.stringify(claim)}\n`,
          { mode: 0o600, flag: 'wx' },
        );
      },
    });
    const replacement = replacementStore.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'cancel',
      owner: owner('b'),
    });
    if (!replacement.ok) throw new Error('expected replacement claim');
    expect(injected).toBe(true);
    expect(
      lstatSync(first.pathsForRun(workspaceA, RUN_A).operation_release_file, {
        throwIfNoEntry: false,
      }),
    ).toBeUndefined();
    replacementStore.releaseOperation(replacement.handle);
  });

  it('replaces an old marker published after the replacement claim became current', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const firstOwner = owner('a');
    const first = store(stateRoot, () => 'alive');
    reserve(first, workspaceA);
    const stale = first.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: firstOwner,
    });
    if (!stale.ok) throw new Error('expected stale claim');

    const replacementStore = new McpStateStore({
      stateRoot,
      inspectProcess: (identity) =>
        'instance_id' in identity && identity.instance_id === firstOwner.instance_id
          ? 'absent'
          : 'alive',
    });
    const replacement = replacementStore.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'cancel',
      owner: owner('b'),
    });
    if (!replacement.ok) throw new Error('expected replacement claim');

    // This is the last possible old-owner race: A passed its ownership check
    // before B reclaimed, but did not publish its release marker until after B
    // had finished both acquisition-time marker clears.
    writeFileSync(
      first.pathsForRun(workspaceA, RUN_A).operation_release_file,
      `${JSON.stringify(stale.handle.claim)}\n`,
      { mode: 0o600, flag: 'wx' },
    );

    replacementStore.releaseOperation(replacement.handle);
    expect(
      lstatSync(first.pathsForRun(workspaceA, RUN_A).operation_file, {
        throwIfNoEntry: false,
      }),
    ).toBeUndefined();
    expect(
      lstatSync(first.pathsForRun(workspaceA, RUN_A).operation_release_file, {
        throwIfNoEntry: false,
      }),
    ).toBeUndefined();
  });

  it('does not reclaim a claim when process identity is alive or unknown', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const first = store(stateRoot, () => 'alive');
    reserve(first, workspaceA);
    const held = first.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('a'),
    });
    if (!held.ok) throw new Error('expected first claim');

    expect(
      store(stateRoot, () => 'alive').acquireOperation({
        workspace: workspaceA,
        run_id: RUN_A,
        operation: 'cancel',
        owner: owner('b'),
      }),
    ).toMatchObject({ ok: false, code: 'operation_in_progress' });
    expect(
      store(stateRoot, () => 'unknown').acquireOperation({
        workspace: workspaceA,
        run_id: RUN_A,
        operation: 'cancel',
        owner: owner('c'),
      }),
    ).toMatchObject({ ok: false, code: 'operation_owner_unknown' });

    first.releaseOperation(held.handle);
  });

  it('allows exactly one real Node process to acquire a run operation', async () => {
    const { root, stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA);
    const bundle = join(root, 'state-store.bundle.mjs');
    await build({
      entryPoints: [resolve('src/hosts/codex-mcp/state-store.ts')],
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
    });
    const barrier = join(root, 'claim-race-start');
    const source = `
        import { existsSync } from 'node:fs';
        import { setTimeout as delay } from 'node:timers/promises';
        import { McpStateStore } from ${JSON.stringify(pathToFileURL(bundle).href)};
        const stateRoot = ${JSON.stringify(stateRoot)};
        const workspace = ${JSON.stringify(workspaceA)};
        const runId = ${JSON.stringify(RUN_A)};
        const barrier = ${JSON.stringify(barrier)};
        const identity = {
          pid: process.pid,
          process_group_id: process.pid,
          started_at: '${NOW}',
          birth_token: 'birth-' + process.pid,
          executable: {
            real_path: process.execPath,
            device: '1',
            inode: '2',
            sha256: '${SHA_B}',
          },
          instance_id: 'instance-' + process.pid,
        };
        const inspect = (candidate) => {
          try {
            process.kill(candidate.pid, 0);
            return 'alive';
          } catch (error) {
            return error?.code === 'ESRCH' ? 'absent' : 'unknown';
          }
        };
        const state = new McpStateStore({
          stateRoot,
          inspectProcess: inspect,
          inspectProcessGroup: inspect,
        });
        console.log('READY');
        while (!existsSync(barrier)) await delay(5);
        const acquired = state.acquireOperation({
          workspace,
          run_id: runId,
          operation: 'reconcile',
          owner: identity,
        });
        const result = acquired.ok ? { ok: true } : { ok: false, code: acquired.code };
        if (acquired.ok) {
          await delay(500);
          state.releaseOperation(acquired.handle);
        }
        console.log(JSON.stringify(result));
      `;
    const first = waitForClaimChild(
      spawn(process.execPath, ['--input-type=module', '--eval', source]),
    );
    const second = waitForClaimChild(
      spawn(process.execPath, ['--input-type=module', '--eval', source]),
    );
    await Promise.all([first.ready, second.ready]);
    writeFileSync(barrier, 'start', { mode: 0o600 });

    const results = await Promise.all([first.result, second.result]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: 'operation_in_progress' }),
    ]);
  }, 15_000);

  it('durably releases an operation while another action holds the workspace guard', async () => {
    const { stateRoot, workspaceA } = await fixture();
    let releaseDuringGuard: () => void = () => {
      throw new Error('release callback was not initialized');
    };
    let releaseReturned = false;
    const state = new McpStateStore({
      stateRoot,
      now: () => new Date(NOW),
      inspectProcess: () => 'alive',
      beforeTerminalLeaseRelease: () => {
        releaseDuringGuard();
        releaseReturned = true;
      },
    });
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('t'),
    });
    if (!claim.ok) throw new Error('expected terminal claim');
    releaseDuringGuard = () => state.releaseOperation(claim.handle);
    advanceToExited(state, claim.handle);
    state.transitionRun({
      handle: claim.handle,
      to: 'complete',
      summary: 'Review completed.',
      final_report: {
        schema: 'review.result@1',
        path: 'reports/review.json',
        sha256: SHA_A,
        byte_length: 120,
        summary: 'Review completed.',
      },
    });
    expect(releaseReturned).toBe(true);

    const replacementStore = store(stateRoot, () => 'alive');
    const replacement = replacementStore.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('n'),
    });
    if (!replacement.ok) throw new Error('expected replacement claim');
    expect(
      lstatSync(state.pathsForRun(workspaceA, RUN_A).operation_release_file, {
        throwIfNoEntry: false,
      }),
    ).toBeUndefined();
    replacementStore.releaseOperation(replacement.handle);
  });
});

describe('MCP list and recovery', () => {
  it('lists only the trusted workspace in stable order and supports lost run-id recovery', async () => {
    const { stateRoot, workspaceA, workspaceB } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA, RUN_A, owner('a'));
    reserve(state, workspaceB, RUN_B, owner('b'));

    const result = state.listRuns(workspaceA, {
      limit: 1,
      checkpointAvailable: (run) => run.checkpoint !== undefined,
    });
    expect(result).toEqual({
      runs: [
        {
          run_id: RUN_A,
          flow: 'review',
          state: 'starting',
          updated_at: NOW,
          checkpoint_available: false,
          summary: 'Circuit is preparing Review.',
        },
      ],
      truncated: false,
    });
  });

  it('fails closed instead of hiding a corrupt matching run from list', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA);
    const stateFile = state.pathsForRun(workspaceA, RUN_A).state_file;
    const record = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(stateFile, `${JSON.stringify({ ...record, unknown: true })}\n`, { mode: 0o600 });

    expectStoreError(() => state.listRuns(workspaceA), 'state_corrupt');
  });

  it('does not let a corrupt run from another workspace break list recovery', async () => {
    const { stateRoot, workspaceA, workspaceB } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA, RUN_A, owner('a'));
    reserve(state, workspaceB, RUN_B, owner('b'));
    const otherState = state.pathsForRun(workspaceB, RUN_B).state_file;
    writeFileSync(otherState, '{broken json', { mode: 0o600 });

    expect(state.listRuns(workspaceA).runs.map((run) => run.run_id)).toEqual([RUN_A]);
  });

  it('prunes only old terminal runs within a bounded workspace history', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot);
    for (const [index, runId] of [RUN_A, RUN_B, RUN_C].entries()) {
      const allocationOwner = owner(String.fromCharCode(97 + index));
      reserve(state, workspaceA, runId, allocationOwner);
      const claim = state.acquireOperation({
        workspace: workspaceA,
        run_id: runId,
        operation: 'reconcile',
        owner: owner(String.fromCharCode(100 + index)),
      });
      if (!claim.ok) throw new Error('expected terminal claim');
      advanceToExited(state, claim.handle, 'confirmed', allocationOwner);
      state.transitionRun({
        handle: claim.handle,
        to: 'complete',
        summary: 'Review completed.',
        final_report: {
          schema: 'review.result@1',
          path: 'reports/review.json',
          sha256: SHA_A,
          byte_length: 120,
          summary: 'Review completed.',
        },
      });
      state.releaseOperation(claim.handle);
    }

    const result = state.pruneTerminalRuns({
      workspace: workspaceA,
      owner: owner('p'),
      retain: 1,
    });
    expect(result).toEqual({
      removed_run_ids: [RUN_A, RUN_B],
      retained_terminal_count: 1,
      skipped_active_count: 0,
      cleaned_interrupted_count: 0,
    });
    expect(state.listRuns(workspaceA).runs.map((run) => run.run_id)).toEqual([RUN_C]);
  });

  it('finishes a retention deletion interrupted after its atomic rename', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot);
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('x'),
    });
    if (!claim.ok) throw new Error('expected terminal claim');
    advanceToExited(state, claim.handle);
    state.transitionRun({
      handle: claim.handle,
      to: 'interrupted',
      summary: 'Circuit was interrupted.',
    });
    state.releaseOperation(claim.handle);

    const runDirectory = state.pathsForRun(workspaceA, RUN_A).run_dir;
    const interrupted = join(resolve(runDirectory, '..'), `.retention.${RUN_A}.${RUN_B}.tmp`);
    renameSync(runDirectory, interrupted);

    expect(
      state.pruneTerminalRuns({ workspace: workspaceA, owner: owner('p'), retain: 10 }),
    ).toMatchObject({ cleaned_interrupted_count: 1 });
    expect(lstatSync(interrupted, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('returns stable read and list results when retention wins the directory race', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const writer = store(stateRoot);
    const finish = (runId: string, allocationOwner: ProcessOwnerIdentity) => {
      reserve(writer, workspaceA, runId, allocationOwner);
      const claim = writer.acquireOperation({
        workspace: workspaceA,
        run_id: runId,
        operation: 'reconcile',
        owner: owner('x'),
      });
      if (!claim.ok) throw new Error('expected terminal claim');
      advanceToExited(writer, claim.handle, 'confirmed', allocationOwner);
      writer.transitionRun({
        handle: claim.handle,
        to: 'interrupted',
        summary: 'Circuit was interrupted.',
      });
      writer.releaseOperation(claim.handle);
    };

    finish(RUN_A, owner('a'));
    let prunedDuringRead = false;
    const readRacer = new McpStateStore({
      stateRoot,
      beforeRunStateRead: () => {
        if (prunedDuringRead) return;
        prunedDuringRead = true;
        writer.pruneTerminalRuns({ workspace: workspaceA, owner: owner('p'), retain: 0 });
      },
    });
    expectStoreError(() => readRacer.readRun(workspaceA, RUN_A), 'run_not_found');

    finish(RUN_B, owner('b'));
    let prunedDuringList = false;
    const listRacer = new McpStateStore({
      stateRoot,
      beforeRunStateRead: () => {
        if (prunedDuringList) return;
        prunedDuringList = true;
        writer.pruneTerminalRuns({ workspace: workspaceA, owner: owner('p'), retain: 0 });
      },
    });
    expect(listRacer.listRuns(workspaceA)).toEqual({ runs: [], truncated: false });
  });

  it('repairs an exact terminal lease on the next start without touching its successor', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot, () => 'absent');
    reserve(state, workspaceA);
    const leaseFile = state.pathsForRun(workspaceA, RUN_A).lease_file;
    const oldLease = readFileSync(leaseFile, 'utf8');
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('t'),
    });
    if (!claim.ok) throw new Error('expected terminal claim');
    advanceToExited(state, claim.handle);
    state.transitionRun({
      handle: claim.handle,
      to: 'complete',
      summary: 'Review completed.',
      final_report: {
        schema: 'review.result@1',
        path: 'reports/review.json',
        sha256: SHA_A,
        byte_length: 120,
        summary: 'Review completed.',
      },
    });
    state.releaseOperation(claim.handle);

    // Simulate a crash after the terminal state became durable but before the
    // old lease was removed.
    writeFileSync(leaseFile, oldLease, { mode: 0o600, flag: 'wx' });
    reserve(state, workspaceA, RUN_B, owner('b'));
    expect(state.reconcileTerminalLease(workspaceA, RUN_A, owner('r'))).toBe(false);
    expect(JSON.parse(readFileSync(leaseFile, 'utf8'))).toMatchObject({ run_id: RUN_B });
  });

  it('holds the workspace guard across terminal state and lease finalization', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const successor = store(stateRoot, () => 'alive');
    let overlapError: unknown;
    const state = new McpStateStore({
      stateRoot,
      now: () => new Date(NOW),
      inspectProcess: () => 'alive',
      beforeTerminalLeaseRelease: () => {
        try {
          reserve(successor, workspaceA, RUN_B, owner('b'));
        } catch (error) {
          overlapError = error;
        }
      },
    });
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('t'),
    });
    if (!claim.ok) throw new Error('expected terminal claim');
    advanceToExited(state, claim.handle);

    expect(() =>
      state.transitionRun({
        handle: claim.handle,
        to: 'complete',
        summary: 'Review completed.',
        final_report: {
          schema: 'review.result@1',
          path: 'reports/review.json',
          sha256: SHA_A,
          byte_length: 120,
          summary: 'Review completed.',
        },
      }),
    ).not.toThrow();
    state.releaseOperation(claim.handle);
    expect(overlapError).toBeInstanceOf(McpStateStoreError);
    expect((overlapError as McpStateStoreError).code).toBe('workspace_guard_busy');
    reserve(successor, workspaceA, RUN_B, owner('b'));
    expect(
      JSON.parse(readFileSync(state.pathsForRun(workspaceA, RUN_A).lease_file, 'utf8')),
    ).toMatchObject({ run_id: RUN_B });
  });

  it('recovers only recovery_required runs after exact process and group absence is proven', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot, () => 'absent');
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('x'),
    });
    if (!claim.ok) throw new Error('expected claim');
    advanceToExited(state, claim.handle, 'unconfirmed');
    state.transitionRun({
      handle: claim.handle,
      to: 'recovery_required',
      summary: 'Circuit could not confirm cleanup.',
      recovery: {
        reason: 'cleanup_unconfirmed',
        detected_at: NOW,
        last_checked_at: NOW,
        cancellation_requested: false,
      },
    });
    state.releaseOperation(claim.handle);

    const recovered = state.recoverRun({
      workspace: workspaceA,
      run_id: RUN_A,
      owner: owner('r'),
    });
    expect(recovered.record.state).toBe('interrupted');
    expect(recovered.cleanup_confirmed).toBe(true);
    expect(recovered.lease_released).toBe(true);
    expect(
      lstatSync(state.pathsForRun(workspaceA, RUN_A).lease_file, { throwIfNoEntry: false }),
    ).toBeUndefined();
  });

  it('recovers an accepted pre-supervisor exit from its exact allocation owner', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = new McpStateStore({
      stateRoot,
      now: () => new Date(NOW),
      inspectProcess: () => 'absent',
      inspectProcessGroup: () => 'alive',
    });
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('x'),
    });
    if (!claim.ok) throw new Error('expected recovery setup claim');
    state.advanceLaunch({
      handle: claim.handle,
      launch: {
        generation: 1,
        phase: 'exited',
        allocation_owner: owner('a'),
        exit: {
          observed_at: NOW,
          exit_code: 1,
          process_group_cleanup: 'unconfirmed',
        },
      },
    });
    state.transitionRun({
      handle: claim.handle,
      to: 'recovery_required',
      summary: 'Circuit stopped before supervisor launch.',
      recovery: {
        reason: 'start_interrupted',
        detected_at: NOW,
        last_checked_at: NOW,
        cancellation_requested: false,
      },
    });
    state.releaseOperation(claim.handle);

    const recovered = state.recoverRun({
      workspace: workspaceA,
      run_id: RUN_A,
      owner: owner('r'),
    });
    expect(recovered.record.state).toBe('interrupted');
    expect(recovered.lease_released).toBe(true);
  });

  it('does not let recovery rewrite saved exit evidence', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot, () => 'absent');
    reserve(state, workspaceA);
    const setup = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('x'),
    });
    if (!setup.ok) throw new Error('expected setup claim');
    advanceToExited(state, setup.handle, 'unconfirmed');
    state.transitionRun({
      handle: setup.handle,
      to: 'recovery_required',
      summary: 'Circuit could not confirm cleanup.',
      recovery: {
        reason: 'cleanup_unconfirmed',
        detected_at: NOW,
        last_checked_at: NOW,
        cancellation_requested: false,
      },
    });
    state.releaseOperation(setup.handle);

    const recovery = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'recover',
      owner: owner('r'),
    });
    if (!recovery.ok) throw new Error('expected recovery claim');
    const current = state.readRun(workspaceA, RUN_A);
    expectStoreError(
      () =>
        state.transitionRun({
          handle: recovery.handle,
          to: 'interrupted',
          summary: 'Circuit confirmed cleanup.',
          launch: {
            ...current.launch,
            exit: {
              ...current.launch.exit,
              observed_at: '2026-07-20T08:00:01.000Z',
              process_group_cleanup: 'confirmed',
            },
          },
        }),
      'invalid_recovery_evidence',
    );
    state.releaseOperation(recovery.handle);
  });

  it.each(['alive', 'unknown'] as const)(
    'keeps state and lease unchanged when process inspection is %s',
    async (processStatus) => {
      const { stateRoot, workspaceA } = await fixture();
      const state = store(stateRoot, () => processStatus);
      reserve(state, workspaceA);
      const claim = state.acquireOperation({
        workspace: workspaceA,
        run_id: RUN_A,
        operation: 'reconcile',
        owner: owner('x'),
      });
      if (!claim.ok) throw new Error('expected claim');
      state.transitionRun({
        handle: claim.handle,
        to: 'recovery_required',
        summary: 'Circuit could not confirm cleanup.',
        recovery: {
          reason: 'start_interrupted',
          detected_at: NOW,
          last_checked_at: NOW,
          cancellation_requested: false,
        },
      });
      state.releaseOperation(claim.handle);

      expectStoreError(
        () =>
          state.recoverRun({
            workspace: workspaceA,
            run_id: RUN_A,
            owner: owner('r'),
          }),
        processStatus === 'alive' ? 'recovery_process_alive' : 'recovery_process_unknown',
        processStatus === 'alive'
          ? 'Call circuit_cancel for this run, then retry circuit_recover.'
          : 'Wait briefly, then retry circuit_recover with this run ID. If Circuit still cannot confirm cleanup, stop and report the run ID; do not force-unlock the workspace.',
      );
      expect(state.readRun(workspaceA, RUN_A).state).toBe('recovery_required');
      expect(lstatSync(state.pathsForRun(workspaceA, RUN_A).lease_file).isFile()).toBe(true);
    },
  );

  it('recovers a reserved launch by exact owner PID even when Codex still owns the shared group', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = new McpStateStore({
      stateRoot,
      now: () => new Date(NOW),
      inspectProcess: () => 'absent',
      inspectProcessGroup: () => 'alive',
    });
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('x'),
    });
    if (!claim.ok) throw new Error('expected claim');
    state.transitionRun({
      handle: claim.handle,
      to: 'recovery_required',
      summary: 'Circuit could not confirm cleanup.',
      recovery: {
        reason: 'start_interrupted',
        detected_at: NOW,
        last_checked_at: NOW,
        cancellation_requested: false,
      },
    });
    state.releaseOperation(claim.handle);

    expect(
      state.recoverRun({ workspace: workspaceA, run_id: RUN_A, owner: owner('r') }).record.state,
    ).toBe('interrupted');
    expect(
      lstatSync(state.pathsForRun(workspaceA, RUN_A).lease_file, { throwIfNoEntry: false }),
    ).toBeUndefined();
  });

  it('does not recover when the worker is absent but its process group is unknown', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = new McpStateStore({
      stateRoot,
      now: () => new Date(NOW),
      inspectProcess: () => 'absent',
      inspectProcessGroup: () => 'unknown',
    });
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('x'),
    });
    if (!claim.ok) throw new Error('expected claim');
    advanceToExited(state, claim.handle, 'unconfirmed');
    state.transitionRun({
      handle: claim.handle,
      to: 'recovery_required',
      summary: 'Circuit could not confirm cleanup.',
      recovery: {
        reason: 'cleanup_unconfirmed',
        detected_at: NOW,
        last_checked_at: NOW,
        cancellation_requested: false,
      },
    });
    state.releaseOperation(claim.handle);

    expectStoreError(
      () => state.recoverRun({ workspace: workspaceA, run_id: RUN_A, owner: owner('r') }),
      'recovery_process_unknown',
    );
    expect(lstatSync(state.pathsForRun(workspaceA, RUN_A).lease_file).isFile()).toBe(true);
  });

  it('never releases an authorized launch whose runtime identity is missing', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot, () => 'absent');
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('x'),
    });
    if (!claim.ok) throw new Error('expected claim');
    const supervisor = processIdentity('s');
    state.advanceLaunch({
      handle: claim.handle,
      launch: {
        generation: 1,
        phase: 'supervisor_recorded',
        allocation_owner: owner('a'),
        supervisor,
      },
    });
    state.advanceLaunch({
      handle: claim.handle,
      launch: {
        generation: 1,
        phase: 'launch_authorized',
        allocation_owner: owner('a'),
        supervisor,
        authorization_sha256: SHA_A,
        authorized_at: NOW,
      },
    });
    state.transitionRun({
      handle: claim.handle,
      to: 'recovery_required',
      summary: 'Process inspection was temporarily unknown.',
      recovery: {
        reason: 'launch_process_unknown',
        detected_at: NOW,
        last_checked_at: NOW,
        supervisor_status: 'unknown',
        runtime_status: 'unknown',
        process_group_status: 'unknown',
        cancellation_requested: false,
      },
    });
    state.releaseOperation(claim.handle);

    expectStoreError(
      () => state.recoverRun({ workspace: workspaceA, run_id: RUN_A, owner: owner('r') }),
      'recovery_process_unknown',
    );
    expect(state.readRun(workspaceA, RUN_A).state).toBe('recovery_required');
    expect(lstatSync(state.pathsForRun(workspaceA, RUN_A).lease_file).isFile()).toBe(true);
  });

  it('checks a distinct runtime process group before recovery releases the lease', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const runtimeGroup = runtimeIdentity().process_group_id;
    const state = new McpStateStore({
      stateRoot,
      now: () => new Date(NOW),
      inspectProcess: () => 'absent',
      inspectProcessGroup: (identity) =>
        identity.process_group_id === runtimeGroup ? 'alive' : 'absent',
    });
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('x'),
    });
    if (!claim.ok) throw new Error('expected claim');
    advanceToExited(state, claim.handle, 'unconfirmed');
    state.transitionRun({
      handle: claim.handle,
      to: 'recovery_required',
      summary: 'Circuit could not confirm cleanup.',
      recovery: {
        reason: 'cleanup_unconfirmed',
        detected_at: NOW,
        last_checked_at: NOW,
        cancellation_requested: false,
      },
    });
    state.releaseOperation(claim.handle);

    expectStoreError(
      () => state.recoverRun({ workspace: workspaceA, run_id: RUN_A, owner: owner('r') }),
      'recovery_process_alive',
    );
    expect(lstatSync(state.pathsForRun(workspaceA, RUN_A).lease_file).isFile()).toBe(true);
  });

  it('checks a shared supervisor and runtime process group only once during recovery', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const supervisor = processIdentity('s');
    const runtime = { ...runtimeIdentity(), process_group_id: supervisor.process_group_id };
    const inspectedGroups: number[] = [];
    const state = new McpStateStore({
      stateRoot,
      now: () => new Date(NOW),
      inspectProcess: () => 'absent',
      inspectProcessGroup: (identity) => {
        inspectedGroups.push(identity.process_group_id);
        return 'absent';
      },
    });
    reserve(state, workspaceA);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_A,
      operation: 'reconcile',
      owner: owner('x'),
    });
    if (!claim.ok) throw new Error('expected claim');
    state.advanceLaunch({
      handle: claim.handle,
      launch: {
        generation: 1,
        phase: 'supervisor_recorded',
        allocation_owner: owner('a'),
        supervisor,
      },
    });
    state.advanceLaunch({
      handle: claim.handle,
      launch: {
        generation: 1,
        phase: 'launch_authorized',
        allocation_owner: owner('a'),
        supervisor,
        authorization_sha256: SHA_A,
        authorized_at: NOW,
      },
    });
    state.advanceLaunch({
      handle: claim.handle,
      launch: {
        generation: 1,
        phase: 'runtime_recorded',
        allocation_owner: owner('a'),
        supervisor,
        runtime,
        authorization_sha256: SHA_A,
        authorized_at: NOW,
      },
    });
    state.advanceLaunch({
      handle: claim.handle,
      launch: {
        generation: 1,
        phase: 'exited',
        allocation_owner: owner('a'),
        supervisor,
        runtime,
        authorization_sha256: SHA_A,
        authorized_at: NOW,
        exit: {
          observed_at: NOW,
          exit_code: 1,
          process_group_cleanup: 'unconfirmed',
        },
      },
    });
    state.transitionRun({
      handle: claim.handle,
      to: 'recovery_required',
      summary: 'Circuit could not confirm cleanup.',
      recovery: {
        reason: 'cleanup_unconfirmed',
        detected_at: NOW,
        last_checked_at: NOW,
        cancellation_requested: false,
      },
    });
    state.releaseOperation(claim.handle);

    expect(
      state.recoverRun({ workspace: workspaceA, run_id: RUN_A, owner: owner('q') }).record.state,
    ).toBe('interrupted');
    expect(inspectedGroups).toEqual([supervisor.process_group_id]);
  });

  it('uses cancelled when recovery follows a cancellation request', async () => {
    const { stateRoot, workspaceA } = await fixture();
    const state = store(stateRoot, () => 'absent');
    reserve(state, workspaceA, RUN_C);
    const claim = state.acquireOperation({
      workspace: workspaceA,
      run_id: RUN_C,
      operation: 'cancel',
      owner: owner('c'),
    });
    if (!claim.ok) throw new Error('expected claim');
    state.transitionRun({
      handle: claim.handle,
      to: 'recovery_required',
      summary: 'Cancellation cleanup is uncertain.',
      recovery: {
        reason: 'cancel_cleanup_unconfirmed',
        detected_at: NOW,
        last_checked_at: NOW,
        cancellation_requested: true,
      },
    });
    state.releaseOperation(claim.handle);

    expect(
      state.recoverRun({ workspace: workspaceA, run_id: RUN_C, owner: owner('r') }).record.state,
    ).toBe('cancelled');
  });
});
