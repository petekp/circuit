import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { ReviewIntake, ReviewResult } from '../../src/flows/review/reports.js';
import { ProgressEvent } from '../../src/schemas/progress-event.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import { runtimeGitTextIsValidUtf8 } from '../../src/shared/runtime-git-reader.js';
import type { RuntimeGitOperation, RuntimeGitReader } from '../../src/shared/runtime-git-reader.js';
import {
  TEST_COMMIT_A,
  TEST_COMMIT_B,
  cleanRelayResult,
  loadFixture,
  pinnedTargetFor,
  relayerWith,
  reviewRunFolderBase,
  runCompiledFlow,
  useReviewRunFolders,
} from './review-wiring-harness.js';

// What the collected evidence is allowed to claim: truncation, binary and
// opaque changes, submodules, untracked-file policy, and the empty-scope stops.
// Every case here answers the same question — when Review cannot see all of the
// selected code, does it say so instead of closing clean?
describe('review evidence honesty', () => {
  useReviewRunFolders();

  it('uses the injected bounded Git reader instead of ordinary Review Git commands', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'bounded-git-reader');
    const projectRoot = join(reviewRunFolderBase(), 'bounded-git-project');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'notes.txt'), 'bounded untracked note\n');
    const seen: RuntimeGitOperation[] = [];
    const outputs: Readonly<Record<RuntimeGitOperation, string>> = {
      status: 'M  src/app.ts\0?? notes.txt\0',
      staged_diff: 'diff --git a/src/app.ts b/src/app.ts\n',
      unstaged_diff: '',
      staged_diff_stat: ' src/app.ts | 1 +\n',
      unstaged_diff_stat: '',
      resolve_target: '',
      target_diff: '',
      target_diff_stat: '',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: 'notes.txt\0',
    };
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        expect(request.projectRoot).toBe(projectRoot);
        seen.push(request.operation);
        return {
          schema_version: 1,
          ok: true,
          operation: request.operation,
          stdout: outputs[request.operation],
          stderr: '',
          exit_code: 0,
          truncated: false,
          limit_bytes: 2 * 1024 * 1024,
          cleanup_confirmed: true,
          ...(request.operation === 'resolve_target'
            ? { resolved_target: pinnedTargetFor(request.target) }
            : {}),
        };
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000019',
      goal: 'review my changes through the bounded Git reader',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('src/app.ts');
          expect(input.prompt).toContain('notes.txt');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-bounded-git',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    // One pass. Review reads the working tree once and pins what it read.
    expect(seen).toEqual([
      'hidden_index_flags',
      'status',
      'staged_diff',
      'unstaged_diff',
      'staged_diff_stat',
      'unstaged_diff_stat',
      'staged_changed_gitlinks',
      'unstaged_changed_gitlinks',
      'untracked_files',
    ]);
  });

  it('reports changed submodule gitlinks as incomplete rather than clean', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'bounded-git-submodule-caveat');
    const projectRoot = join(reviewRunFolderBase(), 'bounded-git-submodule-caveat-project');
    mkdirSync(projectRoot, { recursive: true });
    const outputs: Readonly<Record<RuntimeGitOperation, string>> = {
      status: 'M  root.ts\0M  modules/child\0',
      staged_diff: [
        'diff --git a/root.ts b/root.ts',
        '+const root = true;',
        'diff --git a/modules/child b/modules/child',
        `index ${TEST_COMMIT_A}..${TEST_COMMIT_B} 160000`,
        '--- a/modules/child',
        '+++ b/modules/child',
        '@@ -1 +1 @@',
        `-Subproject commit ${TEST_COMMIT_A}`,
        `+Subproject commit ${TEST_COMMIT_B}`,
        '',
      ].join('\n'),
      unstaged_diff: '',
      staged_diff_stat: ' root.ts | 1 +\n',
      unstaged_diff_stat: '',
      resolve_target: '',
      target_diff: '',
      target_diff_stat: '',
      hidden_index_flags: '',
      staged_changed_gitlinks: `:160000 160000 ${TEST_COMMIT_A} ${TEST_COMMIT_B} M\0modules/child\0`,
      unstaged_changed_gitlinks: '',
      untracked_files: '',
    };
    const gitReader: RuntimeGitReader = {
      read: async (request) => ({
        schema_version: 1,
        ok: true,
        operation: request.operation,
        stdout: outputs[request.operation],
        stderr: '',
        exit_code: 0,
        truncated: false,
        limit_bytes: 2 * 1024 * 1024,
        cleanup_confirmed: true,
        ...(request.operation === 'resolve_target'
          ? { resolved_target: pinnedTargetFor(request.target) }
          : {}),
      }),
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000099',
      goal: 'review my current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 9, 30, 0)),
      projectRoot,
      gitReader,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('stopped');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence_warnings).toContainEqual({
      kind: 'submodule_content_not_inspected',
      path: 'modules/child',
      message: 'nested submodule source content was not inspected',
    });
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it.each([
    {
      mode: 'all',
      goal: 'review my current changes',
      diffOperation: 'staged_diff',
      statOperation: 'staged_diff_stat',
      status: 'M  root.ts\0',
      runId: '79000000-0000-0000-0000-00000000010a',
    },
    {
      mode: 'staged',
      goal: 'review staged changes',
      diffOperation: 'staged_diff',
      statOperation: 'staged_diff_stat',
      status: '',
      runId: '79000000-0000-0000-0000-000000000113',
    },
    {
      mode: 'unstaged',
      goal: 'review unstaged changes',
      diffOperation: 'unstaged_diff',
      statOperation: 'unstaged_diff_stat',
      status: '',
      runId: '79000000-0000-0000-0000-000000000114',
    },
  ] as const)(
    'does not treat an unchanged registered submodule as incomplete $mode Review evidence',
    async ({ mode, goal, diffOperation, statOperation, status, runId }) => {
      const { bytes } = loadFixture();
      const runFolder = join(reviewRunFolderBase(), `bounded-git-clean-submodule-${mode}`);
      const projectRoot = join(
        reviewRunFolderBase(),
        `bounded-git-clean-submodule-${mode}-project`,
      );
      mkdirSync(projectRoot, { recursive: true });
      const gitReader: RuntimeGitReader = {
        read: async (request) => {
          const operation = request.operation as string;
          const stdout =
            operation === 'status'
              ? status
              : operation === diffOperation
                ? 'diff --git a/root.ts b/root.ts\n+const root = true;\n'
                : operation === statOperation
                  ? ' root.ts | 1 +\n'
                  : operation === 'submodules'
                    ? `160000 ${TEST_COMMIT_A} 0\tmodules/child\0`
                    : '';
          return {
            schema_version: 1,
            ok: true,
            operation: request.operation,
            stdout,
            stderr: '',
            exit_code: 0,
            truncated: false,
            limit_bytes: 2 * 1024 * 1024,
            cleanup_confirmed: true,
          };
        },
      };

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId,
        goal,
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 10, 30, 0)),
        projectRoot,
        gitReader,
        relayer: relayerWith(cleanRelayResult()),
      });

      expect(outcome.outcome).toBe('complete');
      const intake = ReviewIntake.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
      );
      expect(intake.evidence_warnings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'submodule_content_not_inspected' }),
        ]),
      );
    },
  );

  // Covered through real Git only. The injected reader would hand the same
  // gitlink diff to the same classifier, so a second copy proved the fixture,
  // not the behaviour.
  it('detects a dirty nested submodule worktree through direct Git evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'direct-dirty-submodule');
    const childSource = join(reviewRunFolderBase(), 'direct-dirty-submodule-source');
    const projectRoot = join(reviewRunFolderBase(), 'direct-dirty-submodule-project');
    mkdirSync(childSource, { recursive: true });
    execFileSync('git', ['init'], { cwd: childSource, stdio: 'pipe' });
    writeFileSync(join(childSource, 'child.ts'), 'export const child = 1;\n');
    execFileSync('git', ['add', 'child.ts'], { cwd: childSource, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-m',
        'child base',
      ],
      { cwd: childSource, stdio: 'pipe' },
    );
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', childSource, 'modules/child'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-am',
        'parent base',
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'modules', 'child', 'child.ts'), 'export const child = 2;\n');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000116',
      goal: 'review unstaged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 33, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence).toMatchObject({
      kind: 'git-working-tree',
      unstaged_diff: { text: expect.stringMatching(/Subproject commit/u) },
    });
    expect(intake.evidence_warnings).toContainEqual({
      kind: 'submodule_content_not_inspected',
      path: 'modules/child',
      message: 'nested submodule source content was not inspected',
    });
    expect(outcome.outcome).toBe('stopped');
  });

  it('stops before relay when cleanup for the selected staged evidence is uncertain', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'staged-cleanup-uncertain');
    const projectRoot = join(reviewRunFolderBase(), 'staged-cleanup-uncertain-project');
    mkdirSync(projectRoot, { recursive: true });
    let relayCalls = 0;
    const gitReader: RuntimeGitReader = {
      read: async ({ operation }) => ({
        schema_version: 1,
        ok: operation !== 'staged_diff',
        operation,
        stdout: '',
        stderr: operation === 'staged_diff' ? 'cleanup state is uncertain' : '',
        exit_code: operation === 'staged_diff' ? null : 0,
        truncated: false,
        limit_bytes: 2 * 1024 * 1024,
        cleanup_confirmed: operation !== 'staged_diff',
      }),
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000031',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('reviewer must not run with uncertain Git cleanup');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/cleanup|staged/i);
    expect(relayCalls).toBe(0);
  });

  it.each([
    {
      operation: 'status' as const,
      goal: 'review current changes',
    },
    {
      operation: 'staged_diff_stat' as const,
      goal: 'review staged changes',
    },
  ])(
    'stops before relay when $operation returns truncated non-diff output',
    async ({ operation: truncatedOperation, goal }) => {
      const { bytes } = loadFixture();
      const runFolder = join(reviewRunFolderBase(), `truncated-${truncatedOperation}`);
      const projectRoot = join(reviewRunFolderBase(), `truncated-${truncatedOperation}-project`);
      mkdirSync(projectRoot, { recursive: true });
      let relayCalls = 0;
      const gitReader: RuntimeGitReader = {
        read: async ({ operation }) => ({
          schema_version: 1,
          ok: true,
          operation,
          stdout:
            operation === 'status'
              ? 'M  tracked.ts\0'
              : operation === 'staged_diff'
                ? 'diff --git a/tracked.ts b/tracked.ts\n+tracked\n'
                : operation === 'staged_diff_stat'
                  ? ' tracked.ts | 1 +\n'
                  : '',
          stderr: '',
          exit_code: 0,
          truncated: operation === truncatedOperation,
          limit_bytes: 2 * 1024 * 1024,
          cleanup_confirmed: true,
        }),
      };

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId:
          truncatedOperation === 'status'
            ? '79000000-0000-0000-0000-00000000003c'
            : '79000000-0000-0000-0000-00000000003d',
        goal,
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
        projectRoot,
        gitReader,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            return {
              request_payload: 'unexpected truncated metadata',
              receipt_id: 'stub-receipt-truncated-metadata',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/truncat/i);
      expect(relayCalls).toBe(0);
    },
  );

  it.each([
    {
      name: 'process failure',
      result: {
        ok: false,
        stdout: '',
        stderr: 'untracked listing failed',
        exit_code: 1,
        truncated: false,
        cleanup_confirmed: true,
      },
    },
    {
      name: 'truncated output',
      result: {
        ok: true,
        stdout: 'partial.ts\0',
        stderr: '',
        exit_code: 0,
        truncated: true,
        cleanup_confirmed: true,
      },
    },
    {
      name: 'uncertain cleanup',
      result: {
        ok: false,
        stdout: '',
        stderr: 'cleanup state is uncertain',
        exit_code: null,
        truncated: false,
        cleanup_confirmed: false,
      },
    },
  ])(
    'stops explicit current-changes Review when untracked enumeration has $name',
    async ({ name, result }) => {
      const { bytes } = loadFixture();
      const runFolder = join(
        reviewRunFolderBase(),
        `untracked-enumeration-${name.replaceAll(' ', '-')}`,
      );
      const projectRoot = join(reviewRunFolderBase(), `untracked-enumeration-${name}-project`);
      mkdirSync(projectRoot, { recursive: true });
      let relayCalls = 0;
      const gitReader: RuntimeGitReader = {
        read: async ({ operation }) => ({
          schema_version: 1,
          operation,
          ...(operation === 'untracked_files'
            ? result
            : {
                ok: true,
                stdout:
                  operation === 'status'
                    ? 'M  tracked.ts\0?? omitted.ts\0'
                    : operation === 'staged_diff'
                      ? 'diff --git a/tracked.ts b/tracked.ts\n+tracked\n'
                      : '',
                stderr: '',
                exit_code: 0,
                truncated: false,
                cleanup_confirmed: true,
              }),
          limit_bytes: 2 * 1024 * 1024,
        }),
      };

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000037',
        goal: 'review current changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
        projectRoot,
        gitReader,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            throw new Error('reviewer must not run with incomplete untracked evidence');
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/untracked|cleanup|truncat/i);
      expect(relayCalls).toBe(0);
    },
  );

  it('keeps bounded partial diff evidence when the injected Git reader reaches its output limit', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'bounded-git-partial-diff');
    const projectRoot = join(reviewRunFolderBase(), 'bounded-git-partial-project');
    const marker = 'bounded-partial-diff-marker';
    mkdirSync(projectRoot, { recursive: true });
    const gitReader: RuntimeGitReader = {
      read: async ({ operation }) => {
        const partial = operation === 'staged_diff';
        return {
          schema_version: 1,
          ok: true,
          operation,
          stdout:
            operation === 'status'
              ? 'A  src/large.ts\0'
              : partial
                ? `diff --git a/src/large.ts b/src/large.ts\n+${marker}\n`
                : '',
          stderr: partial ? 'Git output reached its bounded limit.' : '',
          exit_code: partial ? null : 0,
          truncated: partial,
          limit_bytes: 2 * 1024 * 1024,
          cleanup_confirmed: true,
        };
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000020',
      goal: 'review my current changes through the bounded partial diff',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 15, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain(marker);
          expect(input.prompt).toContain('[truncated by the bounded Git reader]');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-bounded-partial-git',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('stopped');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence.kind).toBe('git-working-tree');
    if (intake.evidence.kind !== 'git-working-tree') return;
    expect(intake.evidence.staged_diff).toMatchObject({
      text: expect.stringContaining(marker),
      truncated: true,
    });
    expect(intake.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'diff_truncated' }),
    );
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('does not split a valid Unicode character when truncating diff evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'unicode-safe-diff-truncation');
    const projectRoot = join(reviewRunFolderBase(), 'unicode-safe-diff-truncation-project');
    mkdirSync(projectRoot, { recursive: true });
    const diff = `${'x'.repeat(119_999)}😀tail`;
    const gitReader: RuntimeGitReader = {
      read: async ({ operation }) => ({
        schema_version: 1,
        ok: true,
        operation,
        stdout:
          operation === 'status' ? 'M  src/large.ts\0' : operation === 'staged_diff' ? diff : '',
        stderr: '',
        exit_code: 0,
        truncated: false,
        limit_bytes: 2 * 1024 * 1024,
        cleanup_confirmed: true,
      }),
    };

    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000120',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 30, 0)),
      projectRoot,
      gitReader,
      relayer: relayerWith(cleanRelayResult()),
    });

    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence.kind).toBe('git-working-tree');
    if (intake.evidence.kind !== 'git-working-tree') return;
    expect(intake.evidence.staged_diff.truncated).toBe(true);
    expect(runtimeGitTextIsValidUtf8(intake.evidence.staged_diff.text)).toBe(true);
  });

  // D2: metadata-only untracked evidence is the default posture. It is reported
  // as a limitation and does not hold the verdict hostage.
  it('omits untracked file contents by default and still closes the review', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'untracked-metadata-only');
    const projectRoot = join(reviewRunFolderBase(), 'metadata-only-project');
    const secret = 'secret-like scratch content must not be relayed by default';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'tracked.ts'), 'export const tracked = true;\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'scratch-notes.txt'), `${secret}\n`);

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000009',
      goal: 'review my current changes, including untracked files',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'claude-code',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('scratch-notes.txt');
          expect(input.prompt).toContain('"untracked_content_policy": "metadata-only"');
          expect(input.prompt).not.toContain(secret);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-review-metadata-only',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    const result = JSON.parse(
      readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8'),
    ) as { verdict: string; confidence_limitations: readonly string[] };
    expect(result.verdict).toBe('CLEAN');
    expect(result.confidence_limitations.join(' ')).toMatch(/untracked/i);
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence.kind).toBe('git-working-tree');
    if (intake.evidence.kind !== 'git-working-tree') return;
    expect(intake.evidence.untracked_content_policy).toBe('metadata-only');
    expect(intake.evidence.untracked_files).toContainEqual({
      path: 'scratch-notes.txt',
      byte_length: Buffer.byteLength(`${secret}\n`),
    });
    expect(intake.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'untracked_file_content_omitted' }),
    );
  });

  it('includes untracked file contents only with explicit evidence policy opt-in', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'untracked-content-opt-in');
    const projectRoot = join(reviewRunFolderBase(), 'content-opt-in-project');
    const scratch = 'operator explicitly allowed this untracked content';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'scratch-notes.txt'), `${scratch}\n`);

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000010',
      goal: 'review my current changes, including untracked files',
      depth: 'medium',
      evidencePolicy: { includeUntrackedFileContent: true },
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'claude-code',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('"untracked_content_policy": "include-content"');
          expect(input.prompt).toContain(scratch);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-review-content-opt-in',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence.kind).toBe('git-working-tree');
    if (intake.evidence.kind !== 'git-working-tree') return;
    expect(intake.evidence.untracked_content_policy).toBe('include-content');
    expect(intake.evidence.untracked_files[0]).toMatchObject({
      path: 'scratch-notes.txt',
      content: { text: `${scratch}\n`, truncated: false },
    });
    expect(intake.evidence_warnings).not.toContainEqual(
      expect.objectContaining({ kind: 'untracked_file_content_omitted' }),
    );
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.evidence_summary).toMatchObject({
      kind: 'git-working-tree',
      untracked_content_policy: 'include-content',
      untracked_file_count: 1,
      untracked_files_sampled: 1,
      untracked_files_truncated: false,
    });
  });

  it('keeps review evidence from large diffs instead of replacing it with a git buffer error', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'large-diff-evidence');
    const projectRoot = join(reviewRunFolderBase(), 'large-diff-project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });

    const marker = 'large-review-diff-marker';
    writeFileSync(join(projectRoot, 'src', 'large-review-target.txt'), `${marker}\n`);
    const largeBody = `${marker}-${'x'.repeat(11 * 1024 * 1024)}\n`;
    writeFileSync(join(projectRoot, 'src', 'large-review-target.txt'), largeBody);
    execFileSync('git', ['add', 'src/large-review-target.txt'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000006',
      goal: 'review the current large staged diff',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'claude-code',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('"kind": "git-working-tree"');
          expect(input.prompt).toContain(`+${marker}-`);
          expect(input.prompt).not.toContain('ENOBUFS');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-review-large-diff',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome, outcome.reason).toBe('stopped');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence.kind).toBe('git-working-tree');
    if (intake.evidence.kind !== 'git-working-tree') return;
    expect(intake.evidence.staged_diff.text).toContain(`+${marker}-`);
    expect(intake.evidence.staged_diff.text).not.toContain('ENOBUFS');
    expect(intake.evidence.staged_diff.truncated).toBe(true);
    expect(intake.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'diff_truncated' }),
    );
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'diff_truncated' }),
    );
    expect(report).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('keeps bounded partial target evidence instead of treating the target as unavailable', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'bounded-git-partial-target');
    const projectRoot = join(reviewRunFolderBase(), 'bounded-git-partial-target-project');
    const marker = 'partial-target-prefix-marker';
    mkdirSync(projectRoot, { recursive: true });
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        if (request.operation === 'resolve_target') {
          return {
            schema_version: 1,
            ok: true,
            operation: request.operation,
            stdout: '',
            stderr: '',
            exit_code: 0,
            truncated: false,
            limit_bytes: 2 * 1024 * 1024,
            cleanup_confirmed: true,
            resolved_target: pinnedTargetFor(request.target),
          };
        }
        if (request.operation === 'target_diff') {
          return {
            schema_version: 1,
            ok: true,
            operation: request.operation,
            stdout: `diff --git a/large.ts b/large.ts\n+${marker}\n`,
            stderr: 'Git output exceeded the bounded reader limit.',
            exit_code: null,
            truncated: true,
            limit_bytes: 2 * 1024 * 1024,
            cleanup_confirmed: true,
          };
        }
        return {
          schema_version: 1,
          ok: true,
          operation: request.operation,
          stdout: request.operation === 'target_diff_stat' ? ' large.ts | 100000 +\n' : '',
          stderr: '',
          exit_code: 0,
          truncated: false,
          limit_bytes: 2 * 1024 * 1024,
          cleanup_confirmed: true,
        };
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000002b',
      goal: 'review commit abcdef1',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain(marker);
          expect(input.prompt).toContain('"diff_truncated"');
          expect(input.prompt).not.toContain('"target_unavailable"');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-partial-target',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('stopped');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'diff_truncated' }),
    );
    expect(intake.evidence_warnings).not.toContainEqual(
      expect.objectContaining({ kind: 'target_unavailable' }),
    );
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  // Covered through real Git only, for the same reason as the submodule case:
  // hand-written "Binary files ... differ" stdout tests the fixture, and the
  // classifier downstream of both collectors is the thing under test.
  it('does not report a direct working-tree Review as clean when Git hides a binary change', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'direct-opaque-binary-change');
    const projectRoot = join(reviewRunFolderBase(), 'direct-opaque-binary-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, '.gitattributes'), '*.bin -diff\n');
    writeFileSync(join(projectRoot, 'opaque.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    execFileSync('git', ['add', '.gitattributes', 'opaque.bin'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000040',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'claude-code',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('Binary files /dev/null and b/opaque.bin differ');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-direct-opaque-binary',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('stopped');
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('does not let colored Git output hide an opaque staged submodule change', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'colored-opaque-submodule-change');
    const projectRoot = join(reviewRunFolderBase(), 'colored-opaque-submodule-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['update-index', '--add', '--cacheinfo', `160000,${TEST_COMMIT_A},modules/child`],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    execFileSync('git', ['update-index', '--cacheinfo', `160000,${TEST_COMMIT_B},modules/child`], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', '--local', 'color.ui', 'always'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', '--local', 'color.diff', 'always'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000105',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 0, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('stopped');
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('skips unreadable untracked files instead of aborting review intake', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'unreadable-untracked-evidence');
    const projectRoot = join(reviewRunFolderBase(), 'unreadable-project');
    const unreadablePath = join(projectRoot, 'unreadable.txt');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'tracked.ts'), 'export const tracked = true;\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(unreadablePath, 'do not read me\n');
    chmodSync(unreadablePath, 0o000);

    try {
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000007',
        goal: 'review my current changes, including untracked files',
        depth: 'medium',
        evidencePolicy: { includeUntrackedFileContent: true },
        now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
        projectRoot,
        relayer: relayerWith(cleanRelayResult()),
      });

      expect(outcome.outcome).toBe('stopped');
      const intake = ReviewIntake.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
      );
      expect(intake.evidence.kind).toBe('git-working-tree');
      if (intake.evidence.kind !== 'git-working-tree') return;
      const unreadable = intake.evidence.untracked_files.find(
        (file) => file.path === 'unreadable.txt',
      );
      expect(unreadable?.content).toBeUndefined();
      expect(unreadable?.skipped_reason).toMatch(/failed to read|permission|EACCES/i);
      expect(intake.evidence_warnings).toContainEqual(
        expect.objectContaining({ kind: 'untracked_file_skipped', path: 'unreadable.txt' }),
      );
      const report = ReviewResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
      );
      expect(report.evidence_warnings).toContainEqual(
        expect.objectContaining({ kind: 'untracked_file_skipped', path: 'unreadable.txt' }),
      );
    } finally {
      chmodSync(unreadablePath, 0o600);
    }
  });

  it('skips binary untracked files and truncates large untracked text after opt-in', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'untracked-content-redaction');
    const projectRoot = join(reviewRunFolderBase(), 'redaction-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'binary.dat'), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(join(projectRoot, 'large.txt'), `${'x'.repeat(25_000)}\n`);

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000011',
      goal: 'review my current changes, including untracked files',
      depth: 'medium',
      evidencePolicy: { includeUntrackedFileContent: true },
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('stopped');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence.kind).toBe('git-working-tree');
    if (intake.evidence.kind !== 'git-working-tree') return;
    expect(intake.evidence.untracked_content_policy).toBe('include-content');
    expect(intake.evidence.untracked_files).toContainEqual(
      expect.objectContaining({
        path: 'binary.dat',
        skipped_reason: 'binary file skipped',
      }),
    );
    expect(
      intake.evidence.untracked_files.find((file) => file.path === 'binary.dat')?.content,
    ).toBeUndefined();
    const large = intake.evidence.untracked_files.find((file) => file.path === 'large.txt');
    expect(large?.content?.truncated).toBe(true);
    expect(large?.content?.text).toContain('[truncated');
    expect(intake.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'untracked_file_skipped', path: 'binary.dat' }),
    );
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report).toMatchObject({
      verdict: 'ISSUES_FOUND',
      outcome: 'stopped',
      findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
    });
  });

  it('stops before relay when the workspace root is unavailable', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'unavailable-evidence-warning');
    const progress: ProgressEvent[] = [];
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000008',
      goal: 'review the latest commit without project root evidence',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('reviewer must not run without workspace evidence');
        },
      },
      progress: (event) => progress.push(ProgressEvent.parse(event)),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/workspace|project root|evidence/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-result.json'))).toBe(false);
    expect(progress.some((event) => event.type === 'relay.started')).toBe(false);
  });

  it('stops before relay when the requested working tree has no source content to review', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'scope-empty-warning');
    const projectRoot = join(reviewRunFolderBase(), 'scope-empty-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    // No staged changes, no unstaged changes, no untracked files. The reviewer
    // is given a scope hint pointing at content that is not part of the
    // working-tree diff (e.g., already-committed code, HEAD~1 history).

    let relayCalls = 0;
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000020',
      goal: 'review my current changes; focus on the new evil.js and flag any safety problems',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('empty explicit target must stop before relay');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/no changes to inspect|empty/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
  });

  it('does not emit scope_empty when an untracked file with content is being relayed — that file IS uncommitted scope', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'scope-empty-not-emitted-untracked-content');
    const projectRoot = join(reviewRunFolderBase(), 'scope-empty-untracked-content-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'scratch.js'), "console.log('hello');\n");

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000022',
      goal: 'review my current changes, including the new untracked scratch.js',
      depth: 'medium',
      evidencePolicy: { includeUntrackedFileContent: true },
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence_warnings).not.toContainEqual(
      expect.objectContaining({ kind: 'scope_empty' }),
    );
  });

  it('stops before relay when the only selected evidence is an empty untracked file', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'empty-untracked-content');
    const projectRoot = join(reviewRunFolderBase(), 'empty-untracked-content-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'empty.txt'), '');

    let relayCalls = 0;
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000010a',
      goal: 'review my current changes',
      depth: 'medium',
      evidencePolicy: { includeUntrackedFileContent: true },
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('empty untracked evidence must stop before relay');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/no changes to inspect|empty/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
  });

  it('stops before relay when only metadata for untracked files would be available', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'scope-empty-still-fires-metadata-only');
    const projectRoot = join(reviewRunFolderBase(), 'scope-empty-metadata-only-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'scratch.js'), "console.log('hello');\n");

    // Default content policy is metadata-only — untracked file paths/sizes
    // are relayed, but not the file contents the reviewer would need to
    // audit. The reviewer effectively has nothing to inspect.
    let relayCalls = 0;
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000023',
      goal: 'review my current changes, including the new untracked scratch.js without --include-untracked-content',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('metadata-only target must stop before relay');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/include-untracked-content/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
  });

  it('does not emit scope_empty when the working tree contains a staged diff', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'scope-empty-not-emitted-with-diff');
    const projectRoot = join(reviewRunFolderBase(), 'scope-empty-not-emitted-project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'review-target.ts'), 'const answer = 42;\n');
    execFileSync('git', ['add', 'src/review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000021',
      goal: 'review the staged change',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence_warnings).not.toContainEqual(
      expect.objectContaining({ kind: 'scope_empty' }),
    );
  });

  it.each([
    {
      name: 'assume-unchanged entry',
      result: {
        ok: true,
        stdout: 'h hidden.ts\0',
        stderr: '',
        truncated: false,
        cleanup_confirmed: true,
      },
      reason: /assume-unchanged|skip-worktree|hidden index/i,
    },
    {
      name: 'skip-worktree entry',
      result: {
        ok: true,
        stdout: 'S hidden.ts\0',
        stderr: '',
        truncated: false,
        cleanup_confirmed: true,
      },
      reason: /assume-unchanged|skip-worktree|hidden index/i,
    },
    {
      name: 'malformed output',
      result: {
        ok: true,
        stdout: 'malformed\0',
        stderr: '',
        truncated: false,
        cleanup_confirmed: true,
      },
      reason: /malformed|invalid/i,
    },
    {
      name: 'truncated output',
      result: {
        ok: true,
        stdout: 'h hidden',
        stderr: '',
        truncated: true,
        cleanup_confirmed: true,
      },
      reason: /truncat/i,
    },
    {
      name: 'failed read',
      result: {
        ok: false,
        stdout: '',
        stderr: 'hidden index inspection failed',
        truncated: false,
        cleanup_confirmed: true,
      },
      reason: /hidden index inspection failed|could not be inspected/i,
    },
  ])('stops injected working-tree Review for $name', async ({ name, result, reason }) => {
    const { bytes } = loadFixture();
    const runFolder = join(
      reviewRunFolderBase(),
      `injected-hidden-index-${name.replaceAll(' ', '-')}`,
    );
    const projectRoot = join(
      reviewRunFolderBase(),
      `injected-hidden-index-${name.replaceAll(' ', '-')}-project`,
    );
    mkdirSync(projectRoot, { recursive: true });
    const seen: string[] = [];
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        const operation = request.operation as string;
        seen.push(operation);
        if (operation === 'hidden_index_flags') {
          return {
            schema_version: 1,
            operation: request.operation,
            ...result,
            exit_code: result.ok ? 0 : 1,
            limit_bytes: 2 * 1024 * 1024,
          };
        }
        return {
          schema_version: 1,
          ok: true,
          operation: request.operation,
          stdout:
            operation === 'status'
              ? 'M  visible.ts\0'
              : operation === 'staged_diff'
                ? 'diff --git a/visible.ts b/visible.ts\n+visible\n'
                : operation === 'staged_diff_stat'
                  ? ' visible.ts | 1 +\n'
                  : '',
          stderr: '',
          exit_code: 0,
          truncated: false,
          limit_bytes: 2 * 1024 * 1024,
          cleanup_confirmed: true,
        };
      },
    };
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000010d',
      goal: 'review current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 40, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'hidden index state must not reach the reviewer',
            receipt_id: 'stub-receipt-hidden-index-injected',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(reason);
    expect(seen).toContain('hidden_index_flags');
    expect(relayCalls).toBe(0);
  });

  it('stops direct Review instead of relaying invalid UTF-8 from a tracked diff', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'direct-invalid-utf8-tracked');
    const projectRoot = join(reviewRunFolderBase(), 'direct-invalid-utf8-tracked-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'invalid.txt'), 'valid\n');
    execFileSync('git', ['add', 'invalid.txt'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'invalid.txt'), Buffer.from([0xff, 0x0a]));
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000010e',
      goal: 'review unstaged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 45, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'invalid UTF-8 must not reach the reviewer',
            receipt_id: 'stub-receipt-invalid-utf8-tracked',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/UTF-8|encoding/i);
    expect(relayCalls).toBe(0);
  });

  it('maps an opaque submodule change to its exact machine-readable path', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'exact-changed-submodule-path');
    const projectRoot = join(reviewRunFolderBase(), 'exact-changed-submodule-path-project');
    mkdirSync(projectRoot, { recursive: true });
    const rawChangedGitlink = `:160000 160000 ${TEST_COMMIT_A} ${TEST_COMMIT_B} M\0modules/child2\0`;
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        const operation = request.operation as string;
        const stdout =
          operation === 'staged_diff'
            ? [
                'diff --git a/modules/child2 b/modules/child2',
                `index ${TEST_COMMIT_A}..${TEST_COMMIT_B} 160000`,
                '--- a/modules/child2',
                '+++ b/modules/child2',
                '@@ -1 +1 @@',
                `-Subproject commit ${TEST_COMMIT_A}`,
                `+Subproject commit ${TEST_COMMIT_B}`,
                '',
              ].join('\n')
            : operation === 'staged_diff_stat'
              ? ' modules/child2 | 2 +-\n'
              : operation === 'staged_changed_gitlinks'
                ? rawChangedGitlink
                : operation === 'submodules'
                  ? `160000 ${TEST_COMMIT_A} 0\tmodules/child\0` +
                    `160000 ${TEST_COMMIT_A} 0\tmodules/child2\0`
                  : '';
        return {
          schema_version: 1,
          ok: true,
          operation: request.operation,
          stdout,
          stderr: '',
          exit_code: 0,
          truncated: false,
          limit_bytes: 2 * 1024 * 1024,
          cleanup_confirmed: true,
        };
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000117',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 25, 0)),
      projectRoot,
      gitReader,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('stopped');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence_warnings).toContainEqual({
      kind: 'submodule_content_not_inspected',
      path: 'modules/child2',
      message: 'nested submodule source content was not inspected',
    });
    expect(intake.evidence_warnings).not.toContainEqual(
      expect.objectContaining({
        kind: 'submodule_content_not_inspected',
        path: 'modules/child',
      }),
    );
  });

  it('stops untracked-only Review with the consent remedy before relay', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'untracked-only-without-content');
    const projectRoot = join(reviewRunFolderBase(), 'untracked-only-without-content-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'new.ts'), 'export const newValue = true;\n');
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000110',
      goal: 'review current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 55, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'untracked content without consent must not be relayed',
            receipt_id: 'stub-receipt-untracked-only-no-content',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/include-untracked-content/i);
    expect(outcome.reason).not.toMatch(/working tree changes are empty/i);
    expect(relayCalls).toBe(0);
  });

  it('stops invalid UTF-8 in opted-in untracked content without relaying replacement text', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'untracked-invalid-utf8');
    const projectRoot = join(reviewRunFolderBase(), 'untracked-invalid-utf8-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'invalid.txt'), Buffer.from([0xff, 0x0a]));
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000111',
      goal: 'review current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 0, 0)),
      projectRoot,
      evidencePolicy: { includeUntrackedFileContent: true },
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'invalid untracked UTF-8 must not be relayed',
            receipt_id: 'stub-receipt-untracked-invalid-utf8',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/UTF-8|usable|inspect/i);
    expect(relayCalls).toBe(0);
  });

  it('keeps a valid UTF-8 prefix when the untracked byte limit cuts through a character', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'untracked-utf8-boundary');
    const projectRoot = join(reviewRunFolderBase(), 'untracked-utf8-boundary-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'boundary.txt'), `${'x'.repeat(19_999)}😀tail`);

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000121',
      goal: 'review current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 35, 0)),
      projectRoot,
      evidencePolicy: { includeUntrackedFileContent: true },
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('stopped');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence.kind).toBe('git-working-tree');
    if (intake.evidence.kind !== 'git-working-tree') return;
    const boundary = intake.evidence.untracked_files.find((file) => file.path === 'boundary.txt');
    expect(boundary?.skipped_reason).toBeUndefined();
    expect(boundary?.content?.truncated).toBe(true);
    expect(runtimeGitTextIsValidUtf8(boundary?.content?.text ?? '')).toBe(true);
  });

  it('does not treat an opted-in zero-byte untracked file as usable Review evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'untracked-zero-byte');
    const projectRoot = join(reviewRunFolderBase(), 'untracked-zero-byte-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'empty.txt'), '');
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000112',
      goal: 'review current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 5, 0)),
      projectRoot,
      evidencePolicy: { includeUntrackedFileContent: true },
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'zero-byte untracked content must not be treated as reviewable',
            receipt_id: 'stub-receipt-untracked-zero-byte',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/no changes|no usable|empty/i);
    expect(relayCalls).toBe(0);
  });
});
