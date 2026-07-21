import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { DurableJobStore } from './durable-job-store.mjs';
import {
  CircuitLifecycle,
  assertCodexOnlyConfigSummary,
  assertControlPlaneSafe,
  parseStartArguments,
} from './lifecycle.mjs';
import { readRuntimeChildRecord, runtimeSupervisorPaths } from './runtime-supervisor.mjs';
import { prepareSealedStateRoot, snapshotPackagedAssets } from './sealed-policy.mjs';

const EXPERIMENT_ROOT = path.resolve(import.meta.dirname, '..');
const REPOSITORY_ROOT = path.resolve(EXPERIMENT_ROOT, '../..');
const FAKE_RUNTIME = path.join(import.meta.dirname, 'fixtures/fake-runtime.mjs');
const FLOW_ROOT = path.join(REPOSITORY_ROOT, 'plugins/codex/flows');
const PLUGIN_ROOT = path.join(REPOSITORY_ROOT, 'plugins/codex');
const PROOF_RUNNER = path.join(import.meta.dirname, 'proof-sandbox-worker.mjs');
const SUPERVISOR = path.join(import.meta.dirname, 'runtime-supervisor.mjs');
const EXITING_SUPERVISOR = path.join(import.meta.dirname, 'fixtures/supervisor-exits.mjs');

type StoredPolicyFixture = {
  connector: {
    executable: string;
    executable_version: string;
    executable_identity: { inode: string };
    codex_home: string;
  };
};

const cleanupRoots: string[] = [];

async function tempRoot(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  cleanupRoots.push(root);
  return root;
}

async function createHarness(
  options: {
    maxRunMs?: number;
    interruptGraceMs?: number;
    verifyHost?: () => void | Promise<void>;
    supervisorPath?: string;
    jobStoreFactory?: (stateRoot: string) => DurableJobStore;
  } = {},
) {
  const root = await tempRoot('circuit-mcp-lifecycle-');
  const workspace = path.join(root, 'workspace');
  const stateRoot = path.join(root, 'state');
  await mkdir(workspace, { recursive: true });
  const codexHome = path.join(root, 'codex-home');
  await mkdir(codexHome);
  const assets = await snapshotPackagedAssets({
    pluginRoot: PLUGIN_ROOT,
    runtimePath: path.join(PLUGIN_ROOT, 'runtime', 'circuit.js'),
    flowRoot: FLOW_ROOT,
  });
  const managerOptions = {
    runtimePath: FAKE_RUNTIME,
    flowRoot: FLOW_ROOT,
    pluginRoot: PLUGIN_ROOT,
    stateRoot,
    baseEnv: { ...process.env, CIRCUIT_MCP_SENTINEL: 'must-not-leak' },
    codexExecutable: process.execPath,
    host: {
      codex: {
        executable: process.execPath,
        source: 'test',
        version: process.version,
        identity: { device: 'test', inode: 'test', size: 1, modified_ms: 1 },
      },
      codexHome: { path: codexHome, source: 'test' },
    },
    assets,
    sealedState: await prepareSealedStateRoot(stateRoot),
    proofRunner: PROOF_RUNNER,
    supervisorPath: options.supervisorPath ?? SUPERVISOR,
    verifyHost: options.verifyHost ?? (async () => undefined),
    ...(options.jobStoreFactory === undefined
      ? {}
      : { jobStore: options.jobStoreFactory(stateRoot) }),
    ...(options.maxRunMs === undefined ? {} : { maxRunMs: options.maxRunMs }),
    ...(options.interruptGraceMs === undefined
      ? {}
      : { interruptGraceMs: options.interruptGraceMs }),
  };
  const manager = new CircuitLifecycle(managerOptions);
  return { manager, managerOptions, root, workspace, stateRoot };
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 4_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    const value = await read();
    latest = value;
    if (accept(value)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for fixture state: ${JSON.stringify(latest)}`);
}

function statusState(status: Record<string, unknown>) {
  return status.state as string;
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  if (process.env.CIRCUIT_MCP_KEEP_FIXTURES === '1') return;
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('Circuit MCP lifecycle spike', () => {
  it('accepts only typed flow controls and never accepts paths, commands, argv, env, or config', () => {
    expect(parseStartArguments({ flow: 'review', goal: 'Review the current changes' })).toEqual({
      flow: 'review',
      goal: 'Review the current changes',
    });
    expect(
      parseStartArguments({ flow: 'build', goal: 'Build it', web_search: 'cached' }),
    ).toMatchObject({ flow: 'build', webSearch: 'cached' });
    expect(() =>
      parseStartArguments({ flow: 'build', goal: 'Build it', web_search: 'live' }),
    ).toThrow('web_search must be one of off, cached');
    for (const field of ['cwd', 'command', 'argv', 'env', 'run_folder', 'config']) {
      expect(() =>
        parseStartArguments({ flow: 'review', goal: 'Review', [field]: '/tmp/escape' }),
      ).toThrow('unsupported field');
    }
    expect(() => parseStartArguments({ flow: 'review', goal: 'Review', autonomous: true })).toThrow(
      'does not support autonomous',
    );
    expect(() =>
      parseStartArguments({ flow: 'prototype', goal: 'Compare variants', tournament: 3 }),
    ).toThrow('trusted variant model matrix');
    expect(
      parseStartArguments({ flow: 'explore', goal: 'Compare approaches', tournament: 3 }),
    ).toMatchObject({ flow: 'explore', tournament: 3 });
  });

  it('returns the fixed final report for every public flow', async () => {
    for (const flow of ['build', 'explore', 'fix', 'prototype', 'review']) {
      const { manager, workspace } = await createHarness();
      const started = await manager.start(workspace, {
        flow,
        goal: `Complete ${flow}`,
        web_search: 'off',
      });
      const terminal = await waitFor(
        () => manager.status(workspace, { run_id: started.run_id, wait_ms: 0 }),
        (status) => statusState(status) === 'complete',
      );
      expect(terminal).toMatchObject({
        flow,
        result: { flow, report: { assessment: `Fixture ${flow} completed.` } },
      });
      await manager.shutdown();
    }
  });

  it('returns immediately, pages progress without duplication, and includes the fixed Review report', async () => {
    const { manager, workspace } = await createHarness();
    const started = await manager.start(workspace, {
      flow: 'review',
      goal: 'Review the fixture',
    });
    expect(started.state).toBe('running');
    const runId = started.run_id as string;

    const terminal = await waitFor(
      () => manager.status(workspace, { run_id: runId, max_events: 1 }),
      (status) => statusState(status) === 'complete',
    );
    expect(terminal.progress).toMatchObject({ next_cursor: 1, has_more: true });
    const secondPage = await manager.status(workspace, {
      run_id: runId,
      after_cursor: 1,
      max_events: 10,
    });
    expect(secondPage.progress).toMatchObject({ next_cursor: 2, has_more: false });
    expect(secondPage.result).toMatchObject({
      outcome: 'complete',
      report: {
        verdict: 'NO_ISSUES',
        environment_sentinel_seen: null,
      },
    });
  });

  it('long-polls instead of returning an empty status response immediately', async () => {
    const { manager, workspace } = await createHarness({ interruptGraceMs: 20 });
    const started = await manager.start(workspace, { flow: 'review', goal: 'slow fixture' });
    const runId = started.run_id as string;
    const current = await waitFor(
      () => manager.status(workspace, { run_id: runId, wait_ms: 0 }),
      (status) => ((status.progress as { next_cursor: number }).next_cursor ?? 0) >= 2,
    );
    const cursor = (current.progress as { next_cursor: number }).next_cursor;
    const startedWaiting = Date.now();
    const quiet = await manager.status(workspace, {
      run_id: runId,
      after_cursor: cursor,
      wait_ms: 40,
    });
    expect(Date.now() - startedWaiting).toBeGreaterThanOrEqual(30);
    expect(quiet.progress).toMatchObject({ events: [], next_cursor: cursor });
    await manager.cancel(workspace, { run_id: runId });
  });

  it('rejects a cursor that is ahead of retained progress', async () => {
    const { manager, workspace } = await createHarness({ interruptGraceMs: 20 });
    const started = await manager.start(workspace, { flow: 'review', goal: 'slow fixture' });
    await expect(
      manager.status(workspace, { run_id: started.run_id, after_cursor: 100, wait_ms: 0 }),
    ).rejects.toThrow('after_cursor is ahead');
    await manager.cancel(workspace, { run_id: started.run_id });
  });

  it('surfaces a waiting checkpoint, rejects a made-up choice, and resumes the same run', async () => {
    const { manager, workspace } = await createHarness();
    const started = await manager.start(workspace, {
      flow: 'build',
      goal: 'checkpoint fixture',
    });
    const runId = started.run_id as string;
    const waiting = await waitFor(
      () => manager.status(workspace, { run_id: runId }),
      (status) => statusState(status) === 'waiting_for_input',
    );
    expect(waiting.checkpoint).toMatchObject({
      step_id: 'frame-step',
      prompt: 'Confirm the Build brief before implementation starts.',
      request_path: 'reports/checkpoints/frame-step-request.json',
      allowed_choices: ['continue'],
      safe_default_choice: 'continue',
      choices: [
        {
          id: 'continue',
          label: 'Continue',
          description: "Approve the bounded Build route 'continue'.",
        },
      ],
      review_material: [
        {
          path: 'reports/build/brief.json',
          content: {
            schema: 'build.brief@v1',
            scope: 'Make the smallest safe change that satisfies the requested goal.',
          },
        },
      ],
    });
    await expect(
      manager.resume(workspace, { run_id: runId, checkpoint_choice: '../../escape' }),
    ).rejects.toThrow('must be one of continue');

    await expect(
      manager.resume(workspace, { run_id: runId, checkpoint_choice: 'continue' }),
    ).resolves.toMatchObject({ run_id: runId, state: 'running' });
    const completed = await waitFor(
      () => manager.status(workspace, { run_id: runId }),
      (status) => statusState(status) === 'complete',
    );
    expect(completed.result).toMatchObject({
      outcome: 'complete',
      reason: 'fixture resumed with continue',
    });
  });

  it('returns labeled Prototype choices and bounded decision material, then cancels the wait', async () => {
    const { manager, workspace } = await createHarness();
    const started = await manager.start(workspace, {
      flow: 'prototype',
      goal: 'checkpoint fixture',
    });
    const waiting = await waitFor(
      () => manager.status(workspace, { run_id: started.run_id }),
      (status) => statusState(status) === 'waiting_for_input',
    );
    expect(waiting.checkpoint).toMatchObject({
      step_id: 'prototype-checkpoint-step',
      prompt: 'Decide what to do with this verified Prototype artifact.',
      safe_default_choice: 'keep-prototype',
      choices: [
        {
          id: 'keep-prototype',
          label: 'Keep Prototype',
          description: 'Save the prototype as useful evidence and stop here.',
        },
        {
          id: 'save-build-input',
          label: 'Save Build Input',
          description: 'Close with a Build-ready follow-up prompt, without running Build.',
        },
        {
          id: 'discard-prototype',
          label: 'Discard Prototype',
          description: 'Mark the prototype as discarded while keeping the evidence trail.',
        },
      ],
      review_material: expect.arrayContaining([
        expect.objectContaining({
          path: 'reports/prototype/artifact.json',
          content: expect.objectContaining({
            flow: 'prototype',
            source: 'reports/prototype/artifact.json',
            summary: 'Decision material for artifact.',
          }),
        }),
      ]),
    });
    await expect(manager.cancel(workspace, { run_id: started.run_id })).resolves.toMatchObject({
      state: 'cancelled',
      changed: true,
      confirmed: true,
    });
    const cancelled = await manager.status(workspace, { run_id: started.run_id });
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      interruption_confirmed: true,
      error: expect.stringContaining('no process was running'),
    });
    expect(cancelled).not.toHaveProperty('checkpoint');
    expect(cancelled).not.toHaveProperty('result');
  });

  it('cancels a resume claimed before its supervisor starts', async () => {
    let markResumeClaimed: (() => void) | undefined;
    let releaseResumeClaim: (() => void) | undefined;
    const resumeClaimed = new Promise<void>((resolvePromise) => {
      markResumeClaimed = resolvePromise;
    });
    const resumeClaimGate = new Promise<void>((resolvePromise) => {
      releaseResumeClaim = resolvePromise;
    });
    const { manager, workspace } = await createHarness({
      jobStoreFactory: (stateRoot) =>
        new (class extends DurableJobStore {
          override async claimResume(workspaceInput: string, runIdInput: string) {
            const job = await super.claimResume(workspaceInput, runIdInput);
            markResumeClaimed?.();
            await resumeClaimGate;
            return job;
          }
        })({ stateRoot }),
    });
    const started = await manager.start(workspace, {
      flow: 'build',
      goal: 'checkpoint fixture',
    });
    const runId = started.run_id as string;
    await waitFor(
      () => manager.status(workspace, { run_id: runId, wait_ms: 0 }),
      (status) => statusState(status) === 'waiting_for_input',
    );

    const resumeOutcome = manager
      .resume(workspace, {
        run_id: runId,
        checkpoint_choice: 'continue',
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await resumeClaimed;
    const cancelling = manager.cancel(workspace, { run_id: runId });
    setTimeout(() => releaseResumeClaim?.(), 50);

    await expect(cancelling).resolves.toMatchObject({
      state: 'cancelled',
      changed: true,
      confirmed: true,
    });
    const resumeError = await resumeOutcome;
    expect(resumeError).toBeInstanceOf(Error);
    expect((resumeError as Error).message).toContain('cancelled before its runtime started');
    const cancelled = await manager.status(workspace, { run_id: runId, wait_ms: 0 });
    expect(cancelled).toMatchObject({ state: 'cancelled', interruption_confirmed: true });
    expect(cancelled).not.toHaveProperty('result');
  });

  it('cancels a resumed supervisor before its running state is durable', async () => {
    let markRunningWrite: (() => void) | undefined;
    let releaseRunningWrite: (() => void) | undefined;
    const runningWriteReached = new Promise<void>((resolvePromise) => {
      markRunningWrite = resolvePromise;
    });
    const runningWriteGate = new Promise<void>((resolvePromise) => {
      releaseRunningWrite = resolvePromise;
    });
    const { manager, stateRoot, workspace } = await createHarness({
      jobStoreFactory: (stateRoot) =>
        new (class extends DurableJobStore {
          override async updateJob(
            workspaceInput: string,
            runIdInput: string,
            patch: Parameters<DurableJobStore['updateJob']>[2],
          ) {
            if (patch.state === 'running') {
              const current = await this.getJob(workspaceInput, runIdInput);
              if (current.state === 'resuming') {
                markRunningWrite?.();
                await runningWriteGate;
              }
            }
            return await super.updateJob(workspaceInput, runIdInput, patch);
          }
        })({ stateRoot }),
    });
    const started = await manager.start(workspace, {
      flow: 'build',
      goal: 'checkpoint fixture',
    });
    const runId = started.run_id as string;
    await waitFor(
      () => manager.status(workspace, { run_id: runId, wait_ms: 0 }),
      (status) => statusState(status) === 'waiting_for_input',
    );

    const resumeOutcome = manager.resume(workspace, {
      run_id: runId,
      checkpoint_choice: 'continue',
    });
    await runningWriteReached;
    const cancelling = manager.cancel(workspace, { run_id: runId });
    const cancelPath = runtimeSupervisorPaths(stateRoot, runId).cancelPath;
    await waitFor(
      async () => existsSync(cancelPath),
      (present) => present,
    );
    releaseRunningWrite?.();

    await expect(resumeOutcome).resolves.toMatchObject({ run_id: runId, state: 'running' });
    await expect(cancelling).resolves.toMatchObject({
      state: 'cancelled',
      changed: true,
      confirmed: true,
    });
    await expect(manager.status(workspace, { run_id: runId, wait_ms: 0 })).resolves.toMatchObject({
      state: 'cancelled',
      interruption_confirmed: true,
    });
    const replacement = await manager.start(workspace, {
      flow: 'review',
      goal: 'replacement after cancelled resume',
    });
    await waitFor(
      () => manager.status(workspace, { run_id: replacement.run_id, wait_ms: 0 }),
      (status) => statusState(status) === 'complete',
    );
  });

  it('launches only one worker for concurrent resume requests', async () => {
    const { manager, workspace } = await createHarness();
    const started = await manager.start(workspace, {
      flow: 'build',
      goal: 'checkpoint fixture',
    });
    const runId = started.run_id as string;
    await waitFor(
      () => manager.status(workspace, { run_id: runId, wait_ms: 0 }),
      (status) => statusState(status) === 'waiting_for_input',
    );

    const resumes = await Promise.allSettled([
      manager.resume(workspace, { run_id: runId, checkpoint_choice: 'continue' }),
      manager.resume(workspace, { run_id: runId, checkpoint_choice: 'continue' }),
    ]);
    expect(resumes.filter((resume) => resume.status === 'fulfilled')).toHaveLength(1);
    expect(resumes.filter((resume) => resume.status === 'rejected')).toHaveLength(1);

    await waitFor(
      () => manager.status(workspace, { run_id: runId, wait_ms: 0 }),
      (status) => statusState(status) === 'complete',
    );
  });

  it.each([
    [
      'executable path',
      (policy: StoredPolicyFixture) => {
        policy.connector.executable = path.join(tmpdir(), 'different-codex');
      },
    ],
    [
      'executable version',
      (policy: StoredPolicyFixture) => {
        policy.connector.executable_version = 'codex-cli different';
      },
    ],
    [
      'executable file identity',
      (policy: StoredPolicyFixture) => {
        policy.connector.executable_identity.inode = 'different';
      },
    ],
    [
      'CODEX_HOME',
      (policy: StoredPolicyFixture) => {
        policy.connector.codex_home = path.join(tmpdir(), 'different-codex-home');
      },
    ],
  ])('rejects resume when the stored %s pin differs from the host pin', async (_label, mutate) => {
    const { manager, workspace, stateRoot } = await createHarness();
    const started = await manager.start(workspace, {
      flow: 'build',
      goal: 'checkpoint fixture',
    });
    const runId = started.run_id as string;
    await waitFor(
      () => manager.status(workspace, { run_id: runId, wait_ms: 0 }),
      (status) => statusState(status) === 'waiting_for_input',
    );
    const policyPath = path.join(
      stateRoot,
      'mcp-jobs-v1',
      'artifacts',
      runId,
      'sealed-policy.json',
    );
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as StoredPolicyFixture;
    mutate(policy);
    await writeFile(policyPath, `${JSON.stringify(policy)}\n`);

    await expect(
      manager.resume(workspace, { run_id: runId, checkpoint_choice: 'continue' }),
    ).rejects.toThrow('currently pinned Codex host');
    await expect(manager.status(workspace, { run_id: runId, wait_ms: 0 })).resolves.toMatchObject({
      state: 'failed',
    });
  });

  it('allows only one active run per canonical workspace', async () => {
    const { manager, workspace } = await createHarness({ interruptGraceMs: 20 });
    const started = await manager.start(workspace, { flow: 'review', goal: 'slow fixture' });
    await expect(
      manager.start(workspace, { flow: 'review', goal: 'second fixture' }),
    ).rejects.toThrow('already active');
    await manager.cancel(workspace, { run_id: started.run_id });
  });

  it('reserves the workspace before asynchronous config inspection', async () => {
    const { manager, workspace } = await createHarness({ interruptGraceMs: 20 });
    const results = await Promise.allSettled([
      manager.start(workspace, { flow: 'review', goal: 'slow first fixture' }),
      manager.start(workspace, { flow: 'review', goal: 'slow second fixture' }),
    ]);
    const started = results.find(
      (result): result is PromiseFulfilledResult<Record<string, unknown>> =>
        result.status === 'fulfilled',
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(started).toBeDefined();
    expect(rejected?.reason).toMatchObject({ message: expect.stringContaining('already active') });
    await manager.cancel(workspace, { run_id: started?.value.run_id });
  });

  it('caps retained progress and reports that events were dropped', async () => {
    const { manager, workspace } = await createHarness();
    const started = await manager.start(workspace, { flow: 'review', goal: 'noisy fixture' });
    const terminal = await waitFor(
      () => manager.status(workspace, { run_id: started.run_id, max_events: 100 }),
      (status) => statusState(status) === 'complete',
    );
    expect(terminal.progress).toMatchObject({ truncated: true, has_more: true });
  });

  it('does not call Review complete when its required report is missing', async () => {
    const { manager, workspace } = await createHarness();
    const started = await manager.start(workspace, {
      flow: 'review',
      goal: 'missing report fixture',
    });
    const terminal = await waitFor(
      () => manager.status(workspace, { run_id: started.run_id }),
      (status) => statusState(status) === 'needs_attention',
    );
    expect(terminal.error).toContain('Review report could not be read');
  });

  it('returns a bounded runtime diagnosis when stdout is invalid', async () => {
    const { manager, workspace } = await createHarness();
    const started = await manager.start(workspace, {
      flow: 'review',
      goal: 'runtime failure fixture',
    });
    const terminal = await waitFor(
      () => manager.status(workspace, { run_id: started.run_id, wait_ms: 0 }),
      (status) => statusState(status) === 'failed',
    );
    expect(terminal.error).toContain('fixture connector authentication failed');
  });

  it('fails clearly when the detached supervisor exits without a result', async () => {
    const { manager, workspace } = await createHarness({ supervisorPath: EXITING_SUPERVISOR });
    const started = await manager.start(workspace, {
      flow: 'review',
      goal: 'supervisor failure fixture',
    });
    const terminal = await waitFor(
      () => manager.status(workspace, { run_id: started.run_id, wait_ms: 0 }),
      (status) => statusState(status) === 'failed',
    );
    expect(terminal.error).toContain('supervisor stopped with exit 2');
  });

  it('cleans up the supervisor before releasing a run whose worker record could not be saved', async () => {
    class OneShotWorkerFailureStore extends DurableJobStore {
      workerPid: number | undefined;
      failed = false;

      override async updateJob(
        workspace: string,
        runId: string,
        patch: Parameters<DurableJobStore['updateJob']>[2],
      ) {
        if (!this.failed && patch.state === 'running' && patch.worker !== undefined) {
          this.failed = true;
          this.workerPid = patch.worker === null ? undefined : patch.worker.pid;
          throw new Error('fixture durable write failed');
        }
        return await super.updateJob(workspace, runId, patch);
      }
    }

    let store: OneShotWorkerFailureStore | undefined;
    const { manager, workspace } = await createHarness({
      interruptGraceMs: 30,
      jobStoreFactory: (stateRoot) => {
        store = new OneShotWorkerFailureStore({ stateRoot });
        return store;
      },
    });
    await expect(
      manager.start(workspace, { flow: 'review', goal: 'slow fixture' }),
    ).rejects.toThrow('fixture durable write failed');
    expect(store?.workerPid).toBeTypeOf('number');
    await waitFor(
      () => processAlive(store?.workerPid ?? -1),
      (alive) => !alive,
    );

    const next = await manager.start(workspace, { flow: 'review', goal: 'Review' });
    await waitFor(
      () => manager.status(workspace, { run_id: next.run_id, wait_ms: 0 }),
      (status) => statusState(status) === 'complete',
    );
  });

  it('does not hide a nonzero exit behind a valid final response', async () => {
    const { manager, workspace } = await createHarness();
    const started = await manager.start(workspace, {
      flow: 'review',
      goal: 'nonzero complete fixture',
    });
    const terminal = await waitFor(
      () => manager.status(workspace, { run_id: started.run_id, wait_ms: 0 }),
      (status) => statusState(status) === 'needs_attention',
    );
    expect(terminal.error).toContain('fixture teardown failed after result');
  });

  it('ignores poisoned project connector config instead of executing it', async () => {
    const { manager, workspace } = await createHarness();
    await mkdir(path.join(workspace, '.circuit'), { recursive: true });
    const config = path.join(workspace, '.circuit', 'config.yaml');
    await writeFile(config, 'schema_version: 1\nrelay:\n  roles:\n    reviewer: claude-code\n');
    const first = await manager.start(workspace, { flow: 'review', goal: 'Review' });
    await waitFor(
      () => manager.status(workspace, { run_id: first.run_id, wait_ms: 0 }),
      (status) => statusState(status) === 'complete',
    );

    await writeFile(config, 'schema_version: 2\npolicy: {}\n');
    const second = await manager.start(workspace, { flow: 'review', goal: 'Review' });
    await waitFor(
      () => manager.status(workspace, { run_id: second.run_id, wait_ms: 0 }),
      (status) => statusState(status) === 'complete',
    );

    await writeFile(
      config,
      'schema_version: 1\nrelay:\n  connectors:\n    custom-command:\n      command: /tmp/not-run\n',
    );
    const third = await manager.start(workspace, { flow: 'review', goal: 'Review' });
    await waitFor(
      () => manager.status(workspace, { run_id: third.run_id, wait_ms: 0 }),
      (status) => statusState(status) === 'complete',
    );
  });

  it('rejects a .circuit symlink and every known top-level control-plane symlink', async () => {
    const root = await tempRoot('circuit-mcp-symlink-');
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, path.join(workspace, '.circuit'));
    await expect(assertControlPlaneSafe(await realpath(workspace))).rejects.toThrow(
      '.circuit is a symbolic link',
    );

    await rm(path.join(workspace, '.circuit'));
    await mkdir(path.join(workspace, '.circuit'));
    for (const relative of [
      '.gitignore',
      'active-run.md',
      'config.yaml',
      'continuity',
      'history',
      'memory',
      'prototypes',
      'runs',
      'worktrees',
    ]) {
      const candidate = path.join(workspace, '.circuit', relative);
      await symlink(outside, candidate);
      await expect(assertControlPlaneSafe(await realpath(workspace))).rejects.toThrow(
        `.circuit/${relative} is a symbolic link`,
      );
      await rm(candidate);
    }
  });

  it('cooperatively cancels a run and confirms the observed process tree is gone', async () => {
    const { manager, workspace, stateRoot } = await createHarness({ interruptGraceMs: 30 });
    const started = await manager.start(workspace, { flow: 'review', goal: 'slow fixture' });
    const runId = started.run_id as string;
    const workerPidPath = path.join(stateRoot, 'runs', runId, 'worker.pid');
    await waitFor(
      async () => existsSync(workerPidPath),
      (present) => present,
    );
    const workerPid = Number(await readFile(workerPidPath, 'utf8'));
    expect(processAlive(workerPid)).toBe(true);
    await expect(manager.cancel(workspace, { run_id: runId })).resolves.toMatchObject({
      state: 'cancelled',
      changed: true,
      confirmed: true,
    });
    await waitFor(
      () => processAlive(workerPid),
      (alive) => !alive,
    );
    expect(await manager.status(workspace, { run_id: runId })).toMatchObject({
      state: 'cancelled',
      interruption_confirmed: true,
      error: expect.stringContaining('cancelled'),
    });
  });

  it('coalesces concurrent interrupt requests', async () => {
    const { manager, workspace } = await createHarness({ interruptGraceMs: 30 });
    const started = await manager.start(workspace, { flow: 'review', goal: 'slow fixture' });
    const [first, second] = await Promise.all([
      manager.cancel(workspace, { run_id: started.run_id }),
      manager.cancel(workspace, { run_id: started.run_id }),
    ]);
    expect(first).toMatchObject({ state: 'cancelled', confirmed: true });
    expect(second).toMatchObject({ state: 'cancelled', confirmed: true });
  });

  it('recovers a completed run after the MCP server restarts', async () => {
    const { manager, managerOptions, workspace, stateRoot } = await createHarness();
    const started = await manager.start(workspace, {
      flow: 'review',
      goal: 'restart recovery fixture',
    });
    const runId = started.run_id as string;
    await manager.shutdown();

    const restartedStore = new DurableJobStore({
      stateRoot,
      ownerPid: process.pid + 100_000,
      processProbe: (pid) => {
        if (pid === process.pid) return 'absent';
        return processAlive(pid) ? 'alive' : 'absent';
      },
    });
    const restarted = new CircuitLifecycle({ ...managerOptions, jobStore: restartedStore });
    const recovering = await restarted.status(workspace, { run_id: runId, wait_ms: 0 });
    expect(recovering.state).toBe('recovery_required');
    const completed = await waitFor(
      () => restarted.status(workspace, { run_id: runId, wait_ms: 0 }),
      (status) => statusState(status) === 'complete',
    );
    expect(completed.result).toMatchObject({
      outcome: 'complete',
      report: { assessment: 'Fixture review completed.' },
    });
    await restarted.shutdown();
  });

  it('resumes a waiting checkpoint after the MCP server restarts', async () => {
    const { manager, managerOptions, workspace, stateRoot } = await createHarness();
    const started = await manager.start(workspace, {
      flow: 'build',
      goal: 'checkpoint fixture',
    });
    const runId = started.run_id as string;
    await waitFor(
      () => manager.status(workspace, { run_id: runId, wait_ms: 0 }),
      (status) => statusState(status) === 'waiting_for_input',
    );
    await manager.shutdown();

    const restartedStore = new DurableJobStore({
      stateRoot,
      ownerPid: process.pid + 100_010,
      processProbe: (pid) => {
        if (pid === process.pid) return 'absent';
        return processAlive(pid) ? 'alive' : 'absent';
      },
    });
    const restarted = new CircuitLifecycle({ ...managerOptions, jobStore: restartedStore });
    await expect(restarted.status(workspace, { run_id: runId, wait_ms: 0 })).resolves.toMatchObject(
      {
        state: 'waiting_for_input',
        checkpoint: {
          step_id: 'frame-step',
          prompt: 'Confirm the Build brief before implementation starts.',
        },
      },
    );
    await expect(
      restarted.resume(workspace, { run_id: runId, checkpoint_choice: 'continue' }),
    ).resolves.toMatchObject({ state: 'running' });
    const completed = await waitFor(
      () => restarted.status(workspace, { run_id: runId, wait_ms: 0 }),
      (status) => statusState(status) === 'complete',
    );
    expect(completed.result).toMatchObject({
      outcome: 'complete',
      reason: 'fixture resumed with continue',
    });
    await restarted.shutdown();
  });

  it('cancels a still-running supervisor after the MCP server restarts', async () => {
    const { manager, managerOptions, workspace, stateRoot } = await createHarness();
    const started = await manager.start(workspace, { flow: 'review', goal: 'slow fixture' });
    const runId = started.run_id as string;
    const workerPidPath = path.join(stateRoot, 'runs', runId, 'worker.pid');
    await waitFor(
      async () => existsSync(workerPidPath),
      (present) => present,
    );
    const workerPid = Number(await readFile(workerPidPath, 'utf8'));
    await manager.shutdown();

    const restartedStore = new DurableJobStore({
      stateRoot,
      ownerPid: process.pid + 100_001,
      processProbe: (pid) => {
        if (pid === process.pid) return 'absent';
        return processAlive(pid) ? 'alive' : 'absent';
      },
    });
    const restarted = new CircuitLifecycle({ ...managerOptions, jobStore: restartedStore });
    await expect(restarted.cancel(workspace, { run_id: runId })).resolves.toMatchObject({
      state: 'cancelled',
      changed: true,
      confirmed: true,
    });
    await waitFor(
      () => processAlive(workerPid),
      (alive) => !alive,
    );
    await restarted.shutdown();
  });

  it('does not signal a persisted runtime pid after its supervisor crashes', async () => {
    const { manager, managerOptions, workspace, stateRoot } = await createHarness();
    const started = await manager.start(workspace, { flow: 'review', goal: 'slow fixture' });
    const runId = started.run_id as string;
    const childRecord = await waitFor(
      async () => {
        try {
          return await readRuntimeChildRecord(stateRoot, runId);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      },
      (record) => record !== undefined,
    );
    if (childRecord === undefined) throw new Error('The runtime child record was not written.');
    const workerPidPath = path.join(stateRoot, 'runs', runId, 'worker.pid');
    await waitFor(
      async () => existsSync(workerPidPath),
      (present) => present,
    );
    const workerPid = Number(await readFile(workerPidPath, 'utf8'));
    process.kill(childRecord.supervisor_pid, 'SIGKILL');
    await waitFor(
      () => processAlive(childRecord.supervisor_pid),
      (alive) => !alive,
    );
    await waitFor(
      () => manager.status(workspace, { run_id: runId, wait_ms: 0 }),
      (status) => statusState(status) === 'recovery_required',
    );
    await manager.shutdown();

    const restartedStore = new DurableJobStore({
      stateRoot,
      ownerPid: process.pid + 100_002,
      processProbe: (pid) => {
        if (pid === process.pid) return 'absent';
        return processAlive(pid) ? 'alive' : 'absent';
      },
    });
    const restarted = new CircuitLifecycle({ ...managerOptions, jobStore: restartedStore });
    await expect(restarted.cancel(workspace, { run_id: runId })).resolves.toMatchObject({
      state: 'recovery_required',
      changed: true,
      confirmed: false,
    });
    expect(processAlive(childRecord.child_pid)).toBe(true);
    expect(processAlive(workerPid)).toBe(true);

    // The test owns these exact fresh processes, so it may clean them up. The
    // restarted lifecycle deliberately cannot make that identity claim.
    for (const pid of [workerPid, childRecord.child_pid]) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
    await waitFor(
      () => processAlive(workerPid),
      (alive) => !alive,
    );
    await waitFor(
      () => processAlive(childRecord.child_pid),
      (alive) => !alive,
    );
    await restarted.shutdown();
  });

  it('does not launch after shutdown begins during boundary checks', async () => {
    let releaseBoundaryCheck: (() => void) | undefined;
    let markBoundaryCheckStarted: (() => void) | undefined;
    const boundaryCheckStarted = new Promise<void>((resolvePromise) => {
      markBoundaryCheckStarted = resolvePromise;
    });
    const boundaryCheckGate = new Promise<void>((resolvePromise) => {
      releaseBoundaryCheck = resolvePromise;
    });
    const { manager, workspace, stateRoot } = await createHarness({
      verifyHost: async () => {
        markBoundaryCheckStarted?.();
        await boundaryCheckGate;
      },
    });
    const starting = manager.start(workspace, { flow: 'review', goal: 'Review' });
    await boundaryCheckStarted;
    const stopping = manager.shutdown();
    releaseBoundaryCheck?.();
    await expect(starting).rejects.toThrow('lifecycle is stopping');
    await stopping;
    expect(await readdir(path.join(stateRoot, 'runs'))).toEqual([]);
    await expect(
      manager.start(workspace, { flow: 'review', goal: 'Review again' }),
    ).rejects.toThrow('lifecycle is stopping');
  });

  it('turns the fixed wall-clock timeout into interrupted rather than a false success', async () => {
    const { manager, workspace } = await createHarness({ maxRunMs: 40, interruptGraceMs: 20 });
    const started = await manager.start(workspace, { flow: 'review', goal: 'slow fixture' });
    const runId = started.run_id as string;
    const interrupted = await waitFor(
      () => manager.status(workspace, { run_id: runId }),
      (status) => statusState(status) === 'interrupted',
    );
    expect(interrupted.error).toContain('wall-clock limit');
  });

  it('rejects non-Codex config summaries directly', () => {
    const summary = {
      layers: [
        {
          layer: 'project',
          config: {
            relay: {
              default: 'auto',
              roles: {},
              flows: { review: { kind: 'builtin', name: 'cursor-agent' } },
              connectors: {},
            },
            flows: {},
          },
        },
      ],
    };
    expect(() => assertCodexOnlyConfigSummary(summary, 'review', true)).toThrow(
      'non-Codex connector override for review',
    );
  });

  it('resolves runtime and flows from a relocated plugin root', async () => {
    const root = await tempRoot('circuit-mcp-relocated-');
    await mkdir(path.join(root, 'runtime'), { recursive: true });
    await cp(import.meta.dirname, path.join(root, 'mcp'), { recursive: true });
    await cp(
      path.join(PLUGIN_ROOT, 'runtime', 'circuit.js'),
      path.join(root, 'runtime', 'circuit.js'),
    );
    await cp(
      path.join(PLUGIN_ROOT, 'runtime', 'git-state.js'),
      path.join(root, 'runtime', 'git-state.js'),
    );
    await cp(FLOW_ROOT, path.join(root, 'flows'), { recursive: true });

    const relocated = await import(
      `${pathToFileURL(path.join(root, 'mcp', 'server.mjs')).href}?v=1`
    );
    const layout = relocated.resolvePackagedLayout() as {
      pluginRoot: string;
      runtimePath: string;
      flowRoot: string;
    };
    expect(layout).toEqual({
      pluginRoot: `${root}${path.sep}`,
      runtimePath: path.join(root, 'runtime', 'circuit.js'),
      flowRoot: path.join(root, 'flows'),
    });
    expect(existsSync(path.join(root, 'runtime', 'git-state.js'))).toBe(true);
    const preview = spawnSync(
      process.execPath,
      [layout.runtimePath, 'preview', 'review', '--json'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    expect(preview.status, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ flowId: 'review' });
  });
});
