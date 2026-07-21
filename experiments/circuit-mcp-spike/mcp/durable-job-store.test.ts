import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DurableJobStore } from './durable-job-store.mjs';

const cleanupRoots: string[] = [];

async function tempRoot(prefix = 'circuit-mcp-durable-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupRoots.push(root);
  return await realpath(root);
}

async function harness(options: Partial<ConstructorParameters<typeof DurableJobStore>[0]> = {}) {
  const root = await tempRoot();
  const stateRoot = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const store = new DurableJobStore({ stateRoot, ownerId: 'owner-a', ownerPid: 101, ...options });
  return { root, stateRoot, workspace, store };
}

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('durable MCP job store', () => {
  it('atomically creates bounded records and store-owned artifact files', async () => {
    const { stateRoot, workspace, store } = await harness();
    const recovery = await store.initialize();
    expect(recovery.jobs).toEqual([]);

    const created = await store.createJob({ runId: 'run-1', workspace, flow: 'review' });
    expect(created).toMatchObject({
      runId: 'run-1',
      state: 'starting',
      workspace,
      events: [],
      eventsDropped: 0,
    });
    expect(created.runFolder).toBe(path.join(stateRoot, 'runs', 'run-1'));
    expect(created.artifacts).toEqual({
      root: path.join(stateRoot, 'mcp-jobs-v1', 'artifacts', 'run-1'),
      stdoutPath: path.join(stateRoot, 'mcp-jobs-v1', 'artifacts', 'run-1', 'stdout.log'),
      stderrPath: path.join(stateRoot, 'mcp-jobs-v1', 'artifacts', 'run-1', 'stderr.log'),
      progressPath: path.join(stateRoot, 'mcp-jobs-v1', 'artifacts', 'run-1', 'progress.jsonl'),
    });
    await expect(readFile(created.artifacts.stdoutPath, 'utf8')).resolves.toBe('');
    await expect(readFile(created.artifacts.stderrPath, 'utf8')).resolves.toBe('');
    await expect(readFile(created.artifacts.progressPath, 'utf8')).resolves.toBe('');

    const files = await readdir(path.join(stateRoot, 'mcp-jobs-v1', 'jobs'));
    expect(files).toEqual(['run-1.json']);
    expect(
      JSON.parse(await readFile(path.join(stateRoot, 'mcp-jobs-v1', 'jobs', 'run-1.json'), 'utf8')),
    ).toMatchObject({
      runId: 'run-1',
      state: 'starting',
    });
  });

  it('allows only one lease for different paths to the same canonical workspace', async () => {
    const { workspace, store } = await harness();
    await mkdir(path.join(workspace, 'nested'));
    await store.initialize();
    await store.createJob({ runId: 'first', workspace, flow: 'review' });

    await expect(
      store.createJob({
        runId: 'second',
        workspace: path.join(workspace, 'nested', '..'),
        flow: 'review',
      }),
    ).rejects.toThrow('holds this workspace lease');
  });

  it('recovers terminal jobs by run id after a server restart', async () => {
    const { stateRoot, workspace, store } = await harness();
    await store.initialize();
    await store.createJob({ runId: 'terminal', workspace, flow: 'review' });
    await store.appendEvent(workspace, 'terminal', { type: 'step.complete', label: 'Review' });
    await store.updateJob(workspace, 'terminal', {
      state: 'running',
      worker: { pid: 202 },
    });
    await store.updateJob(workspace, 'terminal', {
      state: 'complete',
      final: { outcome: 'complete' },
      report: { verdict: 'NO_ISSUES' },
    });

    const restarted = new DurableJobStore({
      stateRoot,
      ownerId: 'owner-b',
      ownerPid: 303,
      processProbe: () => 'absent',
    });
    const recovery = await restarted.initialize();
    expect(recovery.terminalRunIds).toContain('terminal');
    await expect(restarted.getJob(workspace, 'terminal')).resolves.toMatchObject({
      state: 'complete',
      final: { outcome: 'complete' },
      report: { verdict: 'NO_ISSUES' },
      events: [{ cursor: 0, type: 'step.complete', label: 'Review' }],
    });
  });

  it('repairs an orphan lease only after confirming its owner is gone', async () => {
    const { stateRoot, workspace, store } = await harness();
    await store.initialize();
    await store.createJob({ runId: 'missing-record', workspace, flow: 'review' });
    await unlink(path.join(stateRoot, 'mcp-jobs-v1', 'jobs', 'missing-record.json'));

    const restarted = new DurableJobStore({
      stateRoot,
      ownerId: 'owner-b',
      ownerPid: 303,
      processProbe: (pid) => (pid === 101 ? 'absent' : 'alive'),
    });
    await expect(restarted.initialize()).resolves.toMatchObject({
      jobs: [],
      releasedLeaseRunIds: ['missing-record'],
      blocked: [],
    });
    await expect(
      restarted.createJob({ runId: 'replacement', workspace, flow: 'review' }),
    ).resolves.toMatchObject({ runId: 'replacement' });
  });

  it.each(['alive', 'unknown'] as const)(
    'keeps an orphan lease when its owner is %s',
    async (ownerStatus) => {
      const { stateRoot, workspace, store } = await harness();
      await store.initialize();
      await store.createJob({ runId: `missing-${ownerStatus}`, workspace, flow: 'review' });
      await unlink(path.join(stateRoot, 'mcp-jobs-v1', 'jobs', `missing-${ownerStatus}.json`));

      const restarted = new DurableJobStore({
        stateRoot,
        ownerId: 'owner-b',
        ownerPid: 303,
        processProbe: () => ownerStatus,
      });
      const recovery = await restarted.initialize();
      expect(recovery.releasedLeaseRunIds).toEqual([]);
      expect(recovery.blocked).toEqual([
        expect.objectContaining({
          runId: `missing-${ownerStatus}`,
          reason: 'The lease points to a missing job record, and its owner may still be running.',
        }),
      ]);
      await expect(
        restarted.createJob({ runId: 'replacement', workspace, flow: 'review' }),
      ).rejects.toThrow('holds this workspace lease');
    },
  );

  it('marks a possibly live orphan honestly and never steals its lease because it is old', async () => {
    let now = 0;
    const { stateRoot, workspace, store } = await harness({ now: () => now, leaseStaleMs: 100 });
    await store.initialize();
    await store.createJob({ runId: 'live', workspace, flow: 'review' });
    await store.updateJob(workspace, 'live', {
      state: 'running',
      worker: { pid: 202 },
    });

    now = 10_000;
    const restarted = new DurableJobStore({
      stateRoot,
      ownerId: 'owner-b',
      ownerPid: 303,
      now: () => now,
      leaseStaleMs: 100,
      processProbe: (pid) => (pid === 101 ? 'absent' : 'alive'),
    });
    const recovery = await restarted.initialize();
    expect(recovery.blocked).toEqual([expect.objectContaining({ runId: 'live', workspace })]);
    await expect(restarted.getJob(workspace, 'live')).resolves.toMatchObject({
      state: 'recovery_required',
      recovery: {
        ambiguous: true,
        reason: 'recorded_worker_may_be_alive',
        workerStatus: 'alive',
      },
    });
    await expect(
      restarted.createJob({ runId: 'replacement', workspace, flow: 'review' }),
    ).rejects.toThrow('age alone is not proof');
  });

  it('reconciles durable terminal output only after the old owner and worker are gone', async () => {
    const { stateRoot, workspace, store } = await harness();
    await store.initialize();
    await store.createJob({ runId: 'recover-final', workspace, flow: 'review' });
    await store.updateJob(workspace, 'recover-final', {
      state: 'running',
      worker: { pid: 202 },
    });

    let workerStatus: 'alive' | 'absent' = 'alive';
    const restarted = new DurableJobStore({
      stateRoot,
      ownerId: 'owner-b',
      ownerPid: 303,
      processProbe: (pid) => (pid === 101 ? 'absent' : workerStatus),
    });
    await restarted.initialize();
    await expect(
      restarted.commitRecoveredTerminal(workspace, 'recover-final', {
        state: 'complete',
        final: { outcome: 'complete' },
      }),
    ).rejects.toThrow('until both old processes are gone');

    workerStatus = 'absent';
    await expect(
      restarted.commitRecoveredTerminal(workspace, 'recover-final', {
        state: 'complete',
        final: { outcome: 'complete' },
        report: { verdict: 'NO_ISSUES' },
      }),
    ).resolves.toMatchObject({
      state: 'complete',
      final: { outcome: 'complete' },
      report: { verdict: 'NO_ISSUES' },
      recovery: { ambiguous: false, reason: 'durable_output_reconciled' },
    });
    await expect(
      restarted.createJob({ runId: 'next', workspace, flow: 'review' }),
    ).resolves.toMatchObject({ runId: 'next' });
  });

  it('recovers a checkpoint result, releases its old lease, and resumes normally', async () => {
    const { stateRoot, workspace, store } = await harness();
    await store.initialize();
    await store.createJob({ runId: 'recover-checkpoint', workspace, flow: 'review' });
    await store.updateJob(workspace, 'recover-checkpoint', {
      state: 'running',
      worker: { pid: 202 },
    });

    const restarted = new DurableJobStore({
      stateRoot,
      ownerId: 'owner-b',
      ownerPid: 303,
      processProbe: () => 'absent',
    });
    await restarted.initialize();
    const checkpoint = {
      outcome: 'checkpoint_waiting',
      checkpoint: {
        step_id: 'review-decision',
        allowed_choices: ['continue', 'stop'],
      },
    };
    await expect(
      restarted.commitRecoveredResult(workspace, 'recover-checkpoint', {
        state: 'waiting_for_input',
        final: checkpoint,
      }),
    ).resolves.toMatchObject({
      state: 'waiting_for_input',
      final: checkpoint,
      recovery: { ambiguous: false, reason: 'durable_output_reconciled' },
    });
    await expect(
      restarted.commitRecoveredTerminal(workspace, 'recover-checkpoint', {
        state: 'waiting_for_input',
        final: checkpoint,
      } as never),
    ).rejects.toThrow('requires a terminal state');

    await expect(restarted.claimResume(workspace, 'recover-checkpoint')).resolves.toMatchObject({
      runId: 'recover-checkpoint',
      state: 'resuming',
    });
    await expect(
      restarted.updateJob(workspace, 'recover-checkpoint', {
        state: 'running',
        worker: { pid: 404 },
      }),
    ).resolves.toMatchObject({ state: 'running', worker: { pid: 404 } });
  });

  it('gives a waiting run to exactly one same-server or cross-server resume claimant', async () => {
    const { stateRoot, workspace, store } = await harness();
    await store.initialize();
    await store.createJob({ runId: 'resume-once', workspace, flow: 'review' });
    await store.updateJob(workspace, 'resume-once', { state: 'running', worker: { pid: 202 } });
    await store.updateJob(workspace, 'resume-once', {
      state: 'waiting_for_input',
      final: {
        outcome: 'checkpoint_waiting',
        checkpoint: { allowed_choices: ['continue'] },
      },
    });

    const secondStore = new DurableJobStore({
      stateRoot,
      ownerId: 'owner-b',
      ownerPid: 303,
      processProbe: () => 'alive',
    });
    await secondStore.initialize();
    const claims = await Promise.allSettled([
      store.claimResume(workspace, 'resume-once'),
      store.claimResume(workspace, 'resume-once'),
      secondStore.claimResume(workspace, 'resume-once'),
    ]);

    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'rejected')).toHaveLength(2);
    const winner = claims.find((claim) => claim.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('No resume claimant won the race.');
    expect(winner.value).toMatchObject({ runId: 'resume-once', state: 'resuming' });
    await expect(store.getJob(workspace, 'resume-once')).resolves.toMatchObject({
      state: 'resuming',
    });
  });

  it.each(['resume', 'cancel'] as const)(
    'lets %s win the durable checkpoint decision without a stale overwrite',
    async (winner) => {
      let markClaimed: (() => void) | undefined;
      let releaseClaim: (() => void) | undefined;
      const claimed = new Promise<void>((resolvePromise) => {
        markClaimed = resolvePromise;
      });
      const claimGate = new Promise<void>((resolvePromise) => {
        releaseClaim = resolvePromise;
      });
      const { stateRoot, workspace, store } = await harness({
        processProbe: () => 'alive',
        afterCheckpointDecisionClaim: async () => {
          markClaimed?.();
          await claimGate;
        },
      });
      await store.initialize();
      await store.createJob({ runId: 'resume-or-cancel', workspace, flow: 'review' });
      await store.updateJob(workspace, 'resume-or-cancel', {
        state: 'running',
        worker: { pid: 202 },
      });
      await store.updateJob(workspace, 'resume-or-cancel', {
        state: 'waiting_for_input',
        final: {
          outcome: 'checkpoint_waiting',
          checkpoint: { allowed_choices: ['continue'] },
        },
      });

      const secondStore = new DurableJobStore({
        stateRoot,
        ownerId: 'owner-b',
        ownerPid: 303,
        processProbe: () => 'alive',
      });
      await secondStore.initialize();
      const winningDecision =
        winner === 'resume'
          ? store.claimResume(workspace, 'resume-or-cancel')
          : store.cancelWaitingCheckpoint(workspace, 'resume-or-cancel');
      await claimed;
      const losingDecision =
        winner === 'resume'
          ? secondStore.cancelWaitingCheckpoint(workspace, 'resume-or-cancel')
          : secondStore.claimResume(workspace, 'resume-or-cancel');
      try {
        await expect(losingDecision).rejects.toThrow(
          'Another MCP server is deciding this waiting Circuit checkpoint',
        );
        if (winner === 'resume') {
          await expect(
            secondStore.reconcileJob(workspace, 'resume-or-cancel'),
          ).resolves.toMatchObject({ state: 'waiting_for_input' });
          await expect(
            secondStore.createJob({ runId: 'must-wait', workspace, flow: 'review' }),
          ).rejects.toThrow('holds this workspace lease');
        }
      } finally {
        releaseClaim?.();
      }
      await winningDecision;

      const job = await store.getJob(workspace, 'resume-or-cancel');
      if (winner === 'resume') {
        expect(job).toMatchObject({ state: 'resuming' });
      } else {
        expect(job).toMatchObject({ state: 'cancelled', interruptionConfirmed: true });
        expect(job.final).toBeUndefined();
      }
    },
  );

  it('cancels an idle checkpoint while another run holds the workspace lease', async () => {
    const { workspace, store } = await harness();
    await store.initialize();
    await store.createJob({ runId: 'waiting', workspace, flow: 'review' });
    await store.updateJob(workspace, 'waiting', { state: 'running', worker: { pid: 202 } });
    await store.updateJob(workspace, 'waiting', {
      state: 'waiting_for_input',
      final: { outcome: 'checkpoint_waiting', checkpoint: { allowed_choices: ['continue'] } },
    });
    await store.createJob({ runId: 'active', workspace, flow: 'review' });

    await expect(store.cancelWaitingCheckpoint(workspace, 'waiting')).resolves.toMatchObject({
      state: 'cancelled',
      interruptionConfirmed: true,
    });
    await expect(store.getJob(workspace, 'active')).resolves.toMatchObject({ state: 'starting' });
  });

  it('can reconcile an orphaned job after recovery creates a replacement lease', async () => {
    const { stateRoot, workspace, store } = await harness();
    await store.initialize();
    await store.createJob({ runId: 'orphan', workspace, flow: 'review' });
    await store.updateJob(workspace, 'orphan', {
      state: 'running',
      worker: { pid: 202 },
    });
    const leasesRoot = path.join(stateRoot, 'mcp-jobs-v1', 'leases');
    const [leaseName] = await readdir(leasesRoot);
    expect(leaseName).toBeDefined();
    await rm(path.join(leasesRoot, leaseName ?? ''), { recursive: true });

    const restarted = new DurableJobStore({
      stateRoot,
      ownerId: 'owner-b',
      ownerPid: 303,
      processProbe: () => 'absent',
    });
    const recovery = await restarted.initialize();
    expect(recovery.blocked).toEqual([expect.objectContaining({ runId: 'orphan' })]);
    await expect(
      restarted.commitRecoveredTerminal(workspace, 'orphan', {
        state: 'needs_attention',
        final: { outcome: 'stopped' },
      }),
    ).resolves.toMatchObject({
      state: 'needs_attention',
      final: { outcome: 'stopped' },
      recovery: { ambiguous: false, reason: 'durable_output_reconciled' },
    });
  });

  it('requires an explicit process-exit confirmation to resolve an ambiguous recovery', async () => {
    const { stateRoot, workspace, store } = await harness();
    await store.initialize();
    await store.createJob({ runId: 'ambiguous', workspace, flow: 'review' });

    const restarted = new DurableJobStore({
      stateRoot,
      ownerId: 'owner-b',
      ownerPid: 303,
      processProbe: (pid) => (pid === 101 ? 'absent' : 'unknown'),
    });
    await restarted.initialize();
    const unsafeResolve = restarted.resolveRecovery.bind(restarted) as (
      workspace: string,
      runId: string,
      options: { confirmedNoProcesses: boolean },
    ) => Promise<unknown>;
    await expect(
      unsafeResolve(workspace, 'ambiguous', { confirmedNoProcesses: false }),
    ).rejects.toThrow('requires confirmedNoProcesses: true');
    await expect(
      restarted.resolveRecovery(workspace, 'ambiguous', { confirmedNoProcesses: true }),
    ).resolves.toMatchObject({
      state: 'interrupted',
      interruptionConfirmed: true,
      recovery: { ambiguous: false, reason: 'operator_confirmed_no_processes' },
    });
  });

  it('caps events and reports without persisting arbitrary event fields', async () => {
    const { workspace, store } = await harness({
      maxEvents: 2,
      maxEventBytes: 10_000,
      maxEventItemBytes: 4_096,
      maxReportBytes: 100,
    });
    await store.initialize();
    await store.createJob({ runId: 'bounded', workspace, flow: 'review' });
    await store.updateJob(workspace, 'bounded', { state: 'running', worker: { pid: 202 } });
    await store.appendEvent(workspace, 'bounded', {
      type: 'relay.progress',
      text: 'first',
      secretCommand: '/tmp/do-not-persist',
    });
    await store.appendEvent(workspace, 'bounded', { type: 'relay.progress', text: 'second' });
    await expect(
      store.appendEvent(workspace, 'bounded', { type: 'relay.progress', text: 'third' }),
    ).resolves.toMatchObject({ recorded: false, eventsDropped: 1 });

    const bounded = await store.getJob(workspace, 'bounded');
    expect(bounded.events).toHaveLength(2);
    expect(bounded.events[0]).not.toHaveProperty('secretCommand');
    await expect(
      store.updateJob(workspace, 'bounded', {
        state: 'complete',
        report: { payload: 'x'.repeat(200) },
      }),
    ).rejects.toThrow('report is too large');
    await expect(
      store.updateJob(workspace, 'bounded', {
        state: 'complete',
        final: { outcome: 'complete' },
        report: { verdict: 'OK' },
      }),
    ).resolves.toMatchObject({ state: 'complete', eventsDropped: 1 });
  });

  it('persists cooperative cancellation as a terminal state and releases the lease', async () => {
    const { workspace, store } = await harness();
    await store.initialize();
    await store.createJob({ runId: 'cancelled', workspace, flow: 'review' });
    await store.updateJob(workspace, 'cancelled', {
      state: 'running',
      worker: { pid: 202 },
    });
    await expect(
      store.updateJob(workspace, 'cancelled', {
        state: 'cancelled',
        final: { outcome: 'cancelled' },
        interruptionConfirmed: true,
      }),
    ).resolves.toMatchObject({
      state: 'cancelled',
      final: { outcome: 'cancelled' },
      interruptionConfirmed: true,
    });
    await expect(
      store.createJob({ runId: 'after-cancel', workspace, flow: 'review' }),
    ).resolves.toMatchObject({ runId: 'after-cancel' });
  });

  it('cleans up old terminal metadata without following artifact symlinks', async () => {
    const { root, workspace, store } = await harness({
      retentionMs: Number.MAX_SAFE_INTEGER,
      maxTerminalJobs: 0,
    });
    await store.initialize();
    const job = await store.createJob({ runId: 'old', workspace, flow: 'review' });
    await store.updateJob(workspace, 'old', { state: 'failed', error: 'fixture failure' });

    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await rm(job.artifacts.root, { recursive: true });
    await symlink(outside, job.artifacts.root);

    await expect(store.cleanupRetention()).resolves.toEqual({
      removedRunIds: ['old'],
      removedRunFolderLinks: [],
      removedArtifactLinks: ['old'],
      retainedTerminalJobs: 0,
    });
    await expect(readFile(path.join(outside, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    await expect(store.getJob(workspace, 'old')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps terminal metadata until interrupted artifact cleanup can be retried', async () => {
    const { stateRoot, workspace, store } = await harness({
      retentionMs: Number.MAX_SAFE_INTEGER,
      maxTerminalJobs: 0,
    });
    await store.initialize();
    await store.createJob({ runId: 'retry-cleanup', workspace, flow: 'review' });
    await store.updateJob(workspace, 'retry-cleanup', {
      state: 'failed',
      error: 'fixture failure',
    });

    const artifactsRoot = path.join(stateRoot, 'mcp-jobs-v1', 'artifacts');
    await chmod(artifactsRoot, 0o500);
    try {
      await expect(store.cleanupRetention()).rejects.toBeDefined();
      await expect(store.getJob(workspace, 'retry-cleanup')).resolves.toMatchObject({
        state: 'failed',
      });
    } finally {
      await chmod(artifactsRoot, 0o700);
    }

    await expect(store.cleanupRetention()).resolves.toMatchObject({
      removedRunIds: ['retry-cleanup'],
    });
    await expect(store.getJob(workspace, 'retry-cleanup')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed on path escapes, workspace symlinks, and linked job records', async () => {
    const { root, stateRoot, workspace, store } = await harness();
    await store.initialize();
    await expect(
      store.createJob({ runId: '../escape', workspace, flow: 'review' }),
    ).rejects.toThrow('path-safe id');

    const workspaceLink = path.join(root, 'workspace-link');
    await symlink(workspace, workspaceLink);
    await expect(
      store.createJob({ runId: 'linked-workspace', workspace: workspaceLink, flow: 'review' }),
    ).rejects.toThrow('not a symbolic link');

    await store.createJob({ runId: 'linked-job', workspace, flow: 'review' });
    const jobFile = path.join(stateRoot, 'mcp-jobs-v1', 'jobs', 'linked-job.json');
    const outside = path.join(root, 'outside-job.json');
    await writeFile(outside, '{"state":"complete"}\n');
    await unlink(jobFile);
    await symlink(outside, jobFile);
    await expect(store.getJob(workspace, 'linked-job')).rejects.toThrow('symbolic link');
    expect(() => new DurableJobStore({ stateRoot, ownerId: '../owner-escape' })).toThrow(
      'ownerId must be a path-safe id',
    );
  });

  it('rejects a symbolic-link state root and never removes an incomplete lease', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'target');
    const linkedState = path.join(root, 'linked-state');
    await mkdir(target);
    await symlink(target, linkedState);
    await expect(new DurableJobStore({ stateRoot: linkedState }).initialize()).rejects.toThrow(
      'state root must not be a symbolic link',
    );

    const stateRoot = path.join(root, 'state');
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const first = new DurableJobStore({ stateRoot, ownerId: 'owner-a', ownerPid: 101 });
    await first.initialize();
    await first.createJob({ runId: 'lease-owner', workspace, flow: 'review' });
    const leaseNames = await readdir(path.join(stateRoot, 'mcp-jobs-v1', 'leases'));
    expect(leaseNames).toHaveLength(1);
    const leaseDirectory = path.join(stateRoot, 'mcp-jobs-v1', 'leases', leaseNames[0] ?? '');
    await unlink(path.join(leaseDirectory, 'lease.json'));

    const restarted = new DurableJobStore({
      stateRoot,
      ownerId: 'owner-b',
      ownerPid: 303,
      processProbe: () => 'absent',
    });
    await expect(restarted.initialize()).rejects.toThrow('incomplete');
    await expect(readdir(leaseDirectory)).resolves.toEqual([]);
  });
});
