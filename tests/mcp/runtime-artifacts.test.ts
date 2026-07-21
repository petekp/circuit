import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CanonicalRuntimeArtifactReconciler } from '../../src/hosts/codex-mcp/runtime-artifacts.js';
import type { McpRunRecord } from '../../src/hosts/codex-mcp/state-store.js';
import { trustedWorkspaceIdentity } from '../../src/hosts/codex-mcp/state-store.js';
import { CompiledFlowId, RunId } from '../../src/schemas/ids.js';
import { writeManifestSnapshot } from '../../src/shared/manifest-snapshot.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-07-21T08:00:00.000Z';
const roots: string[] = [];

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-artifacts-')));
  roots.push(root);
  const workspacePath = join(root, 'workspace');
  const runRoot = join(workspacePath, '.circuit', 'runs', RUN_ID);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const manifest = writeManifestSnapshot(runRoot, {
    run_id: RunId.parse(RUN_ID),
    flow_id: CompiledFlowId.parse('review'),
    captured_at: NOW,
    bytes: readFileSync(resolve('generated/flows/review/circuit.json')),
  });
  const change_kind = {
    change_kind: 'discovery',
    failure_mode: 'MCP artifact test',
    acceptance_evidence: 'artifact checks pass',
    alternate_framing: 'hand-authored run folder',
  };
  const trace = [
    {
      schema_version: 1,
      sequence: 0,
      recorded_at: NOW,
      run_id: RUN_ID,
      kind: 'run.bootstrapped',
      flow_id: 'review',
      depth: 'medium',
      goal: 'Review this change',
      change_kind,
      manifest_hash: manifest.hash,
    },
    {
      schema_version: 1,
      sequence: 1,
      recorded_at: NOW,
      run_id: RUN_ID,
      kind: 'run.closed',
      outcome: 'complete',
    },
  ];
  await writeFile(
    join(runRoot, 'trace.ndjson'),
    `${trace.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
  const result = {
    schema_version: 1,
    run_id: RUN_ID,
    flow_id: 'review',
    goal: 'Review this change',
    outcome: 'complete',
    summary: 'Review completed.',
    closed_at: NOW,
    trace_entries_observed: 2,
    manifest_hash: manifest.hash,
  };
  await mkdir(join(runRoot, 'reports'), { mode: 0o700 });
  await writeFile(join(runRoot, 'reports', 'result.json'), `${JSON.stringify(result)}\n`, {
    mode: 0o600,
  });
  const workspace = trustedWorkspaceIdentity(workspacePath);
  const executable = {
    real_path: '/usr/local/bin/node',
    device: '1',
    inode: '2',
    sha256: 'a'.repeat(64),
  };
  const owner = {
    instance_id: 'server',
    pid: 100,
    process_group_id: 100,
    birth_token: 'server-birth',
    started_at: NOW,
    executable,
  };
  const run: McpRunRecord = {
    schema_version: 1,
    record_kind: 'circuit.mcp.run-state',
    revision: 1,
    run_id: RUN_ID,
    lease_id: '22222222-2222-4222-8222-222222222222',
    workspace,
    run_relative_path: `.circuit/runs/${RUN_ID}`,
    request: { flow: 'review', goal: 'Review this change', web_search: 'off' },
    state: 'running',
    summary: 'Running Review.',
    runtime_assets_sha256: 'b'.repeat(64),
    created_at: NOW,
    updated_at: NOW,
    allocation: { owner, created_at: NOW },
    launch: {
      generation: 1,
      allocation_owner: owner,
      phase: 'runtime_recorded',
      supervisor: owner,
      runtime: { ...owner, pid: 200, process_group_id: 200 },
      authorization_sha256: 'c'.repeat(64),
      authorized_at: NOW,
    },
    progress: { next_cursor: 0, retained_from_cursor: 0, dropped_count: 0, events: [] },
  };
  const exit = {
    schema_version: 1 as const,
    record_kind: 'circuit.mcp.exit-observation' as const,
    run_id: RUN_ID,
    generation: 1,
    authorization_sha256: 'c'.repeat(64),
    runtime: { pid: 200, process_group_id: 200, birth_token: 'server-birth', started_at: NOW },
    observed_at: NOW,
    exit_code: 0,
    process_group_cleanup: 'confirmed' as const,
  };
  return { root, runRoot, run, exit };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('MCP canonical runtime artifacts', () => {
  it('binds a completed canonical result into the final report locator', async () => {
    const context = await fixture();
    await expect(
      new CanonicalRuntimeArtifactReconciler().classifyExit({
        record: context.run,
        exit: context.exit,
      }),
    ).resolves.toMatchObject({
      state: 'complete',
      final_report: { schema: 'circuit.review.result', path: 'reports/result.json' },
    });
  });

  it('refuses a final report reached through an intermediate directory symlink', async () => {
    const context = await fixture();
    const outside = join(context.root, 'outside', 'result.json');
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, '{}\n');
    await rm(join(context.runRoot, 'reports'), { recursive: true });
    await symlink(dirname(outside), join(context.runRoot, 'reports'));

    await expect(
      new CanonicalRuntimeArtifactReconciler().classifyExit({
        record: context.run,
        exit: context.exit,
      }),
    ).resolves.toMatchObject({
      state: 'needs_attention',
      failure: { code: 'final_report_invalid' },
    });
  });

  it('does not expose resumable or completed artifacts after a nonzero worker exit', async () => {
    const context = await fixture();
    await expect(
      new CanonicalRuntimeArtifactReconciler().classifyExit({
        record: context.run,
        exit: { ...context.exit, exit_code: 1 },
      }),
    ).resolves.toMatchObject({
      state: 'needs_attention',
      failure: { code: 'worker_exit_nonzero' },
    });
  });
});
