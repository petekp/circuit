import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { McpFinalReportReader } from '../../src/hosts/codex-mcp/final-report-reader.js';
import type {
  LifecycleRunRecord,
  LifecycleWorkspaceIdentity,
} from '../../src/hosts/codex-mcp/lifecycle-types.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-07-21T08:00:00.000Z';
const roots: string[] = [];

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-report-')));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const runRoot = join(workspace, '.circuit', 'runs', RUN_ID);
  await mkdir(join(runRoot, 'reports'), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from('{"verdict":"pass"}\n');
  const reportPath = join(runRoot, 'reports', 'final.json');
  await writeFile(reportPath, bytes, { mode: 0o600 });
  const workspaceInfo = await lstat(workspace, { bigint: true });
  const identity: LifecycleWorkspaceIdentity = {
    key: 'a'.repeat(64),
    canonical_path: workspace,
    device: String(workspaceInfo.dev),
    inode: String(workspaceInfo.ino),
  };
  const executable = {
    real_path: '/usr/local/bin/node',
    device: '1',
    inode: '3',
    sha256: 'b'.repeat(64),
  };
  const owner = {
    instance_id: 'server',
    pid: 10,
    process_group_id: 10,
    birth_token: 'server-birth',
    started_at: NOW,
    executable,
  };
  const runtime = { ...owner, pid: 20, process_group_id: 20 };
  const run: LifecycleRunRecord = {
    revision: 5,
    run_id: RUN_ID,
    workspace: identity,
    request: { flow: 'review', goal: 'Review', web_search: 'off' },
    state: 'complete',
    summary: 'Complete.',
    runtime_assets_sha256: 'c'.repeat(64),
    updated_at: NOW,
    allocation: { owner, created_at: NOW },
    launch: {
      generation: 1,
      allocation_owner: owner,
      phase: 'exited',
      supervisor: runtime,
      runtime,
      authorization_sha256: 'd'.repeat(64),
      authorized_at: NOW,
      exit: { observed_at: NOW, exit_code: 0, process_group_cleanup: 'confirmed' },
    },
    progress: { next_cursor: 0, retained_from_cursor: 0, dropped_count: 0, events: [] },
    final_report: {
      schema: 'review.report',
      path: 'reports/final.json',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byte_length: bytes.byteLength,
      summary: 'Review passed.',
    },
  };
  return { root, workspace: identity, runRoot, reportPath, run };
}

afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('MCP final report reader', () => {
  it('returns the hash-bound JSON report and public summary', async () => {
    const context = await fixture();
    const reader = new McpFinalReportReader();
    await expect(reader.read({ workspace: context.workspace, run: context.run })).resolves.toEqual({
      schema: 'review.report',
      summary: 'Review passed.',
      data: { verdict: 'pass' },
    });
  });

  // The receipt path: when the completed run bound an operator summary, the
  // reader returns its Markdown alongside the structured report so the host can
  // render the human-facing receipt verbatim at completion.
  it('returns the digest-bound operator summary Markdown when present', async () => {
    const context = await fixture();
    const report = context.run.final_report;
    if (report === undefined) throw new Error('Test fixture is missing its final report.');
    const markdown = '# Review\n\nReview passed: no issues found.\n';
    const bytes = Buffer.from(markdown);
    await writeFile(join(context.runRoot, 'reports', 'operator-summary.md'), bytes, {
      mode: 0o600,
    });
    const run = {
      ...context.run,
      final_report: {
        ...report,
        operator_summary: {
          path: 'reports/operator-summary.md',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byte_length: bytes.byteLength,
        },
      },
    };
    await expect(
      new McpFinalReportReader().read({ workspace: context.workspace, run }),
    ).resolves.toEqual({
      schema: 'review.report',
      summary: 'Review passed.',
      data: { verdict: 'pass' },
      operator_summary_markdown: markdown,
    });
  });

  // A tampered or vanished receipt must not sink the completion render: the
  // bound structured report still returns, the Markdown is simply omitted.
  it('omits the operator summary when its bytes no longer match', async () => {
    const context = await fixture();
    const report = context.run.final_report;
    if (report === undefined) throw new Error('Test fixture is missing its final report.');
    const bytes = Buffer.from('# Review\n\nOriginal receipt.\n');
    await writeFile(
      join(context.runRoot, 'reports', 'operator-summary.md'),
      '# Review\n\nRewritten after close.\n',
      { mode: 0o600 },
    );
    const run = {
      ...context.run,
      final_report: {
        ...report,
        operator_summary: {
          path: 'reports/operator-summary.md',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byte_length: bytes.byteLength,
        },
      },
    };
    await expect(
      new McpFinalReportReader().read({ workspace: context.workspace, run }),
    ).resolves.toEqual({
      schema: 'review.report',
      summary: 'Review passed.',
      data: { verdict: 'pass' },
    });
  });

  it('rejects changed report bytes and stale size evidence', async () => {
    const context = await fixture();
    const reader = new McpFinalReportReader();
    const report = context.run.final_report;
    if (report === undefined) throw new Error('Test fixture is missing its final report.');
    await writeFile(context.reportPath, '{"verdict":"fail"}\n');
    await expect(reader.read({ workspace: context.workspace, run: context.run })).rejects.toThrow(
      /contents no longer match/i,
    );

    const stale = {
      ...context.run,
      final_report: { ...report, byte_length: 1 },
    };
    await expect(reader.read({ workspace: context.workspace, run: stale })).rejects.toThrow(
      /size no longer matches/i,
    );
  });

  it('rejects report paths through symlinks and hard links', async () => {
    const context = await fixture();
    const reader = new McpFinalReportReader();
    const outside = join(context.root, 'outside.json');
    await writeFile(outside, '{"verdict":"pass"}\n', { mode: 0o600 });
    await rm(context.reportPath);
    await symlink(outside, context.reportPath);
    await expect(reader.read({ workspace: context.workspace, run: context.run })).rejects.toThrow(
      /not one ordinary file/i,
    );

    await rm(context.reportPath);
    await link(outside, context.reportPath);
    await expect(reader.read({ workspace: context.workspace, run: context.run })).rejects.toThrow(
      /not one ordinary file/i,
    );
  });

  it('rejects a workspace whose saved filesystem identity no longer matches', async () => {
    const context = await fixture();
    await expect(
      new McpFinalReportReader().read({
        workspace: { ...context.workspace, inode: 'not-the-workspace-inode' },
        run: context.run,
      }),
    ).rejects.toThrow(/workspace changed/i);
  });

  it('rejects invalid JSON even when its saved hash and size match', async () => {
    const context = await fixture();
    const report = context.run.final_report;
    if (report === undefined) throw new Error('Test fixture is missing its final report.');
    const bytes = Buffer.from('{bad json\n');
    await writeFile(context.reportPath, bytes);
    const run = {
      ...context.run,
      final_report: {
        ...report,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byte_length: bytes.byteLength,
      },
    };
    await expect(
      new McpFinalReportReader().read({ workspace: context.workspace, run }),
    ).rejects.toThrow(/not valid JSON/i);
  });
});
