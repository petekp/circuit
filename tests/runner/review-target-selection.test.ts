import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { ReviewIntake, ReviewResult } from '../../src/flows/review/reports.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type {
  RuntimeGitOperation,
  RuntimeGitReader,
  RuntimeGitTarget,
} from '../../src/shared/runtime-git-reader.js';
import {
  cleanRelayResult,
  loadFixture,
  pinnedTargetFor,
  readTraceEntries,
  relayerWith,
  reviewRunFolderBase,
  runCompiledFlow,
  stagedReviewProject,
  useReviewRunFolders,
} from './review-wiring-harness.js';

// Which code a Review run is about: goal text, working tree, staged set,
// commit, and range, plus the narrowings that ride along with them (path
// subsets, exclusions, and the change classes Review cannot carve out). What
// the evidence then admits about itself is review-evidence-honesty's subject.
describe('review target selection', () => {
  useReviewRunFolders();

  // D1: an unrecognised goal is not a stop. Review falls back to the working
  // tree and says so in the intake warnings rather than refusing the run.
  it('defaults an unrecognised goal to the working tree and names the assumption', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'assumed-working-tree');
    const projectRoot = stagedReviewProject('assumed-working-tree-project');
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000036',
      goal: 'review this rollout plan for operational risks',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-assumed-target',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
    const intake = JSON.parse(
      readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8'),
    ) as {
      target: { kind: string; mode?: string; explicit?: boolean };
      evidence_warnings: Array<{ kind: string; message: string }>;
    };
    expect(intake.target).toMatchObject({ kind: 'working_tree', mode: 'all', explicit: false });
    expect(intake.evidence_warnings.map((warning) => warning.kind)).toContain('target_assumed');
  });

  // Naming the repository is naming a target. The run still covers the changes,
  // which is less than was asked for, so the gap is what the report has to name
  // — and it must not also claim the goal named nothing.
  it('tells a whole-repository request what it covered instead of claiming no target was named', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'whole-repository-narrowed');
    const projectRoot = stagedReviewProject('whole-repository-narrowed-project');
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000061',
      goal: 'audit this codebase for security problems',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-whole-repository',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
    const intake = JSON.parse(
      readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8'),
    ) as { evidence_warnings: Array<{ kind: string; message: string }> };
    const kinds = intake.evidence_warnings.map((warning) => warning.kind);
    expect(kinds).toContain('whole_repository_narrowed');
    expect(kinds).not.toContain('target_assumed');
    const narrowed = intake.evidence_warnings.find(
      (warning) => warning.kind === 'whole_repository_narrowed',
    );
    expect(narrowed?.message).toMatch(/whole repository/iu);
    expect(narrowed?.message).toMatch(/not something it can do yet/iu);
  });

  // The phrase was understood and could not be honoured. Reporting that is the
  // difference between an answer about a diff and an answer that looks like it
  // was about the code.
  it('names the dropped snapshot request when the goal asks for the code but no path', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'snapshot-not-applied');
    const projectRoot = stagedReviewProject('snapshot-not-applied-project');
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000062',
      goal: 'review my code for latent issues',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 15, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-snapshot-not-applied',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
    const intake = JSON.parse(
      readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8'),
    ) as { evidence_warnings: Array<{ kind: string; message: string }> };
    const dropped = intake.evidence_warnings.find(
      (warning) => warning.kind === 'snapshot_not_applied',
    );
    expect(dropped?.message).toMatch(/as it stands/iu);
    expect(dropped?.message).toMatch(/needs a path to bound it/iu);
  });

  // The clean-tree stop is where the old message was worst: it told the
  // operator they named no target and offered four narrower targets, none of
  // which is a codebase audit.
  it('stops a whole-repository request on a clean tree by naming the real limit', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'whole-repository-clean-tree');
    const projectRoot = join(reviewRunFolderBase(), 'whole-repository-clean-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });

    let relayCalls = 0;
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000063',
      goal: 'review the whole repo',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 16, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('a clean tree must stop before relay');
        },
      },
    });

    expect(relayCalls).toBe(0);
    expect(outcome.reason).toMatch(/whole codebase in one pass/iu);
    expect(outcome.reason).toMatch(/as it stands/iu);
    // The two claims that made the old message unusable.
    expect(outcome.reason).not.toMatch(/did not name a target/iu);
    expect(outcome.reason).not.toMatch(/staged, or unstaged/iu);
  });

  it('reviews actual supplied text without collecting or relaying unrelated working-tree code', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'supplied-goal-only-evidence');
    const projectRoot = join(reviewRunFolderBase(), 'supplied-goal-only-project');
    const unrelatedMarker = 'unrelated-working-tree-marker';
    const suppliedMaterial =
      'Use one pinned source target and stop when that target is unavailable.';
    mkdirSync(projectRoot, { recursive: true });
    let gitReads = 0;
    const gitReader: RuntimeGitReader = {
      read: async ({ operation }) => {
        gitReads += 1;
        throw new Error(`goal-only Review must not request Git operation ${operation}`);
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000120',
      goal: `review this rollout plan:\n${suppliedMaterial}`,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('"kind": "goal"');
          expect(input.prompt).toContain(suppliedMaterial);
          expect(input.prompt).not.toContain(unrelatedMarker);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-supplied-goal-only',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(gitReads).toBe(0);
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.evidence_summary).toEqual({ kind: 'goal' });
  });

  it.each([
    {
      label: 'quoted-target-text',
      goal: 'review the following plan: "Review PR #42"',
      runId: '79000000-0000-0000-0000-000000000123',
    },
    {
      label: 'fenced-target-text',
      goal: 'review the following plan:\n```text\nReview main...HEAD\n```',
      runId: '79000000-0000-0000-0000-000000000124',
    },
  ])(
    'treats $label as supplied text and never as Git authority',
    async ({ goal, label, runId }) => {
      const { bytes } = loadFixture();
      const runFolder = join(reviewRunFolderBase(), label);
      const projectRoot = join(reviewRunFolderBase(), `${label}-project`);
      mkdirSync(projectRoot, { recursive: true });
      let gitReads = 0;
      let relayCalls = 0;
      const gitReader: RuntimeGitReader = {
        read: async ({ operation }) => {
          gitReads += 1;
          throw new Error(`supplied text must not request Git operation ${operation}`);
        },
      };

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId,
        goal,
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 14, 5, 0)),
        projectRoot,
        gitReader,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayCalls += 1;
            expect(input.prompt).toContain('"kind": "goal"');
            return {
              request_payload: input.prompt,
              receipt_id: `stub-receipt-${label}`,
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });

      expect(outcome.outcome).toBe('complete');
      expect(gitReads).toBe(0);
      expect(relayCalls).toBe(1);
    },
  );

  it('uses the injected bounded Git reader for latest-commit Review evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'bounded-git-latest-commit');
    const projectRoot = join(reviewRunFolderBase(), 'bounded-git-latest-project');
    const marker = 'bounded-latest-commit-marker';
    mkdirSync(projectRoot, { recursive: true });
    const seen: RuntimeGitOperation[] = [];
    const outputs: Readonly<Record<RuntimeGitOperation, string>> = {
      status: '',
      staged_diff: '',
      unstaged_diff: '',
      staged_diff_stat: '',
      unstaged_diff_stat: '',
      resolve_target: '',
      target_diff: `diff --git a/src/app.ts b/src/app.ts\n+${marker}\n`,
      target_diff_stat: ' src/app.ts | 1 +\n',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: '',
      tracked_files: '',
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
      runId: '79000000-0000-0000-0000-000000000025',
      goal: 'review HEAD for regressions',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain(marker);
          expect(input.prompt).toContain('"target_diff"');
          expect(input.prompt).not.toContain('"committed_diff"');
          expect(input.prompt.split(marker)).toHaveLength(2);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-bounded-git-head',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(seen).toEqual(['resolve_target', 'target_diff', 'target_diff_stat']);
  });

  it('passes an explicit commit target into the reviewer relay', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'explicit-commit-target');
    const projectRoot = join(reviewRunFolderBase(), 'explicit-commit-project');
    const marker = 'explicit-commit-review-marker';
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'target.ts'), 'const value = "base";\n');
    execFileSync('git', ['add', 'src/target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'src', 'target.ts'), `const value = "${marker}";\n`);
    execFileSync('git', ['add', 'src/target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-m',
        'target',
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000026',
      goal: `review commit ${commit}`,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('"target_kind": "commit"');
          expect(input.prompt).toContain(`"target_ref": "commit ${commit}"`);
          expect(input.prompt).toContain('"target_diff"');
          expect(input.prompt).toContain(marker);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-review-explicit-commit',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
  });

  it('reviews a root commit as an added-file diff', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'root-commit-target');
    const projectRoot = join(reviewRunFolderBase(), 'root-commit-project');
    const marker = 'root-commit-review-marker';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'root.ts'), `export const root = '${marker}';\n`);
    execFileSync('git', ['add', 'root.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'root'],
      { cwd: projectRoot, stdio: 'pipe' },
    );

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000033',
      goal: 'review the latest commit',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain(marker);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-root-commit',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
  });

  it('relays only the requested commit when unrelated working-tree changes exist', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'exclusive-commit-target');
    const projectRoot = join(reviewRunFolderBase(), 'exclusive-commit-project');
    mkdirSync(projectRoot, { recursive: true });
    const seen: RuntimeGitOperation[] = [];
    const requestedMarker = 'requested-commit-marker';
    const stagedMarker = 'unrelated-staged-marker';
    const unstagedMarker = 'unrelated-unstaged-marker';
    const outputs: Readonly<Record<RuntimeGitOperation, string>> = {
      status: 'M  unrelated-staged.ts\0 M unrelated-unstaged.ts\0',
      staged_diff: `diff --git a/unrelated-staged.ts b/unrelated-staged.ts\n+${stagedMarker}\n`,
      unstaged_diff: `diff --git a/unrelated-unstaged.ts b/unrelated-unstaged.ts\n+${unstagedMarker}\n`,
      staged_diff_stat: ' unrelated-staged.ts | 1 +\n',
      unstaged_diff_stat: ' unrelated-unstaged.ts | 1 +\n',
      resolve_target: '',
      target_diff: `diff --git a/requested.ts b/requested.ts\n+${requestedMarker}\n`,
      target_diff_stat: ' requested.ts | 1 +\n',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: 'unrelated-note.txt\0',
      tracked_files: '',
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
      runId: '79000000-0000-0000-0000-000000000029',
      goal: 'review commit abcdef1',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain(requestedMarker);
          expect(input.prompt).not.toContain(stagedMarker);
          expect(input.prompt).not.toContain(unstagedMarker);
          expect(input.prompt).not.toContain('unrelated-note.txt');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-exclusive-commit',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(seen).toEqual(['resolve_target', 'target_diff', 'target_diff_stat']);
  });

  it('keeps staged-only Review evidence separate from unstaged changes', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'staged-only-target');
    const projectRoot = join(reviewRunFolderBase(), 'staged-only-project');
    mkdirSync(projectRoot, { recursive: true });
    const seen: RuntimeGitOperation[] = [];
    const stagedMarker = 'requested-staged-marker';
    const unstagedMarker = 'excluded-unstaged-marker';
    const outputs: Readonly<Record<RuntimeGitOperation, string>> = {
      status: 'M  staged.ts\0 M unstaged.ts\0',
      staged_diff: `diff --git a/staged.ts b/staged.ts\n+${stagedMarker}\n`,
      unstaged_diff: `diff --git a/unstaged.ts b/unstaged.ts\n+${unstagedMarker}\n`,
      staged_diff_stat: ' staged.ts | 1 +\n',
      unstaged_diff_stat: ' unstaged.ts | 1 +\n',
      resolve_target: '',
      target_diff: '',
      target_diff_stat: '',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: '',
      tracked_files: '',
    };
    const gitReader: RuntimeGitReader = {
      read: async ({ operation }) => {
        seen.push(operation);
        return {
          schema_version: 1,
          ok: true,
          operation,
          stdout: outputs[operation],
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
      runId: '79000000-0000-0000-0000-00000000002a',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain(stagedMarker);
          expect(input.prompt).not.toContain(unstagedMarker);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-staged-only',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    // Staged-only evidence never reads the unstaged side.
    expect(seen).toEqual([
      'hidden_index_flags',
      'staged_diff',
      'staged_diff_stat',
      'staged_changed_gitlinks',
    ]);
  });

  it('stops before relay when immutable target resolution is truncated', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'truncated-target-resolution');
    const projectRoot = join(reviewRunFolderBase(), 'truncated-target-resolution-project');
    mkdirSync(projectRoot, { recursive: true });
    const seen: RuntimeGitOperation[] = [];
    let relayCalls = 0;
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        seen.push(request.operation);
        return {
          schema_version: 1,
          ok: true,
          operation: request.operation,
          stdout:
            request.operation === 'target_diff'
              ? 'diff --git a/target.ts b/target.ts\n+target\n'
              : '',
          stderr: '',
          exit_code: 0,
          truncated: request.operation === 'resolve_target',
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
      runId: '79000000-0000-0000-0000-00000000003e',
      goal: 'review commit abc1234',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'unexpected truncated target',
            receipt_id: 'stub-receipt-truncated-target',
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
    expect(seen).toEqual(['resolve_target']);
  });

  it.each([
    {
      name: 'a named tag after commit',
      goal: 'review commit v0.1.1',
      expectedTarget: { kind: 'commit', ref: 'v0.1.1' },
    },
    {
      name: 'a bare first-parent suffix',
      goal: 'review HEAD^',
      expectedTarget: { kind: 'commit', ref: 'HEAD^' },
    },
    {
      name: 'a bare ancestor suffix',
      goal: 'review HEAD~',
      expectedTarget: { kind: 'commit', ref: 'HEAD~' },
    },
  ])('preserves $name as the explicit Review target', async ({ goal, expectedTarget }) => {
    const { bytes } = loadFixture();
    const runFolder = join(
      reviewRunFolderBase(),
      `preserved-target-${goal.replaceAll(/[^A-Za-z0-9]/gu, '-')}`,
    );
    const projectRoot = join(reviewRunFolderBase(), 'preserved-target-project');
    mkdirSync(projectRoot, { recursive: true });
    const seenTargets: unknown[] = [];
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        seenTargets.push(request.target);
        return {
          schema_version: 1,
          ok: true,
          operation: request.operation,
          stdout:
            request.operation === 'target_diff'
              ? 'diff --git a/target.ts b/target.ts\n+preserved-target-marker\n'
              : '',
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
      runId: `79000000-0000-0000-0000-${String(30 + seenTargets.length).padStart(12, '0')}`,
      goal,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');
    const pinnedTarget = pinnedTargetFor(expectedTarget as RuntimeGitTarget);
    expect(seenTargets).toEqual([expectedTarget, pinnedTarget, pinnedTarget]);
  });

  it('keeps "current changes against HEAD" scoped to the working tree', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'current-changes-against-head');
    const projectRoot = join(reviewRunFolderBase(), 'current-changes-against-head-project');
    mkdirSync(projectRoot, { recursive: true });
    const seen: RuntimeGitOperation[] = [];
    const gitReader: RuntimeGitReader = {
      read: async ({ operation }) => {
        seen.push(operation);
        return {
          schema_version: 1,
          ok: true,
          operation,
          stdout:
            operation === 'unstaged_diff'
              ? 'diff --git a/current.ts b/current.ts\n+current-change-marker\n'
              : '',
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
      runId: '79000000-0000-0000-0000-00000000002c',
      goal: 'review current changes against HEAD',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');
    expect(seen).not.toContain('target_diff');
    expect(seen).not.toContain('target_diff_stat');
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

  it('passes an explicit range target through the bounded Git reader', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'bounded-git-range-target');
    const projectRoot = join(reviewRunFolderBase(), 'bounded-git-range-project');
    const marker = 'bounded-range-review-marker';
    mkdirSync(projectRoot, { recursive: true });
    const seen: Array<{
      readonly operation: RuntimeGitOperation;
      readonly target?: unknown;
    }> = [];
    const outputs: Readonly<Record<RuntimeGitOperation, string>> = {
      status: '',
      staged_diff: '',
      unstaged_diff: '',
      staged_diff_stat: '',
      unstaged_diff_stat: '',
      resolve_target: '',
      target_diff: `diff --git a/src/app.ts b/src/app.ts\n+${marker}\n`,
      target_diff_stat: ' src/app.ts | 1 +\n',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: '',
      tracked_files: '',
    };
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        expect(request.projectRoot).toBe(projectRoot);
        seen.push({ operation: request.operation, target: request.target });
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
      runId: '79000000-0000-0000-0000-000000000027',
      goal: 'review main...feature',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('"target_kind": "range"');
          expect(input.prompt).toContain('"target_base_ref": "main"');
          expect(input.prompt).toContain('"target_head_ref": "feature"');
          expect(input.prompt).toContain(marker);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-bounded-git-range',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    const symbolicTarget = {
      kind: 'range' as const,
      base: 'main',
      head: 'feature',
      dots: '...' as const,
    };
    const pinnedTarget = pinnedTargetFor(symbolicTarget);
    expect(seen).toEqual([
      { operation: 'resolve_target', target: symbolicTarget },
      { operation: 'target_diff', target: pinnedTarget },
      { operation: 'target_diff_stat', target: pinnedTarget },
    ]);
  });

  // D5: Review has no fetch story for a pull request. It stops at intake with
  // local instructions rather than reviewing something the operator did not ask
  // for.
  it.each(['review PR #123', 'review https://github.com/acme/widget/pull/123'])(
    'stops %j at intake before any Git read or relay',
    async (goal) => {
      const { bytes } = loadFixture();
      const suffix = goal.includes('http') ? 'url' : 'number';
      const runFolder = join(reviewRunFolderBase(), `pull-request-${suffix}`);
      const projectRoot = join(reviewRunFolderBase(), `pull-request-${suffix}-project`);
      mkdirSync(projectRoot, { recursive: true });
      let relayCalls = 0;
      let gitReads = 0;
      const gitReader: RuntimeGitReader = {
        read: async ({ operation }) => {
          gitReads += 1;
          throw new Error(`a pull-request goal must not request Git operation ${operation}`);
        },
      };

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000028',
        goal,
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
        projectRoot,
        gitReader,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            throw new Error('reviewer must not run for a pull-request goal');
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/Check out the PR branch locally/i);
      expect(gitReads).toBe(0);
      expect(relayCalls).toBe(0);
      expect(existsSync(join(runFolder, 'reports', 'review-result.json'))).toBe(false);
      const traceEntries = await readTraceEntries(runFolder);
      expect(traceEntries.some((entry) => entry.kind === 'relay.started')).toBe(false);
    },
  );

  it('includes the latest committed diff when noun-form Review wording names it', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'latest-commit-evidence');
    const projectRoot = join(reviewRunFolderBase(), 'latest-commit-project');
    const marker = 'latest-commit-review-marker';
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'review-target.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', 'src/review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(
      join(projectRoot, 'src', 'review-target.ts'),
      `export const value = '${marker}';\n`,
    );
    execFileSync('git', ['add', 'src/review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-m',
        'change to review',
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000024',
      goal: "I'd like a review of the latest commit for regressions",
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'claude-code',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('"target_diff"');
          expect(input.prompt).toContain(marker);
          expect(input.prompt).not.toContain('"committed_diff"');
          expect(input.prompt.split(marker)).toHaveLength(2);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-latest-commit-review',
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
    expect(intake.evidence_warnings).not.toContainEqual(
      expect.objectContaining({ kind: 'scope_empty' }),
    );
  });

  it('reviews a merge commit as its first-parent change', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'merge-commit-evidence');
    const projectRoot = join(reviewRunFolderBase(), 'merge-commit-project');
    const marker = 'merged-feature-review-marker';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'base.ts'), 'export const base = true;\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    execFileSync('git', ['switch', '-c', 'feature'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'feature.ts'), `export const feature = '${marker}';\n`);
    execFileSync('git', ['add', 'feature.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-m',
        'feature',
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    execFileSync('git', ['switch', 'main'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'main.ts'), 'export const main = true;\n');
    execFileSync('git', ['add', 'main.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-m',
        'main change',
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'merge',
        '--no-ff',
        'feature',
        '-m',
        'merge feature',
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000002d',
      goal: 'review the latest commit',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain(marker);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-merge-commit',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
  });

  it('rejects a blob object passed as a commit target before relay', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'blob-commit-target');
    const projectRoot = join(reviewRunFolderBase(), 'blob-commit-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'blob-target.ts'), 'blob target must not be a commit\n');
    execFileSync('git', ['add', 'blob-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    const blob = execFileSync('git', ['hash-object', 'blob-target.ts'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000002e',
      goal: `review commit ${blob}`,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('blob target must fail before relay');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/commit|target/i);
    expect(outcome.reason).toMatch(/not available|unavailable|does not resolve/i);
    expect(relayCalls).toBe(0);
  });

  it('narrows to the tracked working tree when the goal excludes untracked files', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'excluded-untracked-file');
    const projectRoot = join(reviewRunFolderBase(), 'excluded-untracked-file-project');
    const trackedMarker = 'TRACKED_CHANGE_UNDER_REVIEW';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'tracked.txt'), `${trackedMarker}\n`);
    writeFileSync(join(projectRoot, 'secret-untracked.txt'), 'excluded-untracked-marker\n');

    let relayCalls = 0;
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000010b',
      goal: 'review current changes except untracked files',
      depth: 'medium',
      // Untracked content is authorized, and the goal still excludes it. The
      // goal wins: an authorization is a ceiling, not an instruction.
      evidencePolicy: { includeUntrackedFileContent: true },
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayCalls += 1;
          expect(input.prompt).toContain(trackedMarker);
          expect(input.prompt).not.toContain('secret-untracked.txt');
          expect(input.prompt).not.toContain('excluded-untracked-marker');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-tracked-only',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.target).toEqual({ kind: 'working_tree', mode: 'tracked', explicit: true });
    // The narrowing was applied, so nothing is reported as unapplied.
    expect(intake.evidence_warnings.map((warning) => warning.kind)).not.toContain(
      'scope_not_applied',
    );
    const trace = readFileSync(join(runFolder, 'trace.ndjson'), 'utf8');
    expect(trace).not.toContain('secret-untracked.txt');
    expect(trace).not.toContain('excluded-untracked-marker');
  });

  it('reviews a commit under the requested path exclusion and names the scope', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'excluded-commit-path');
    const projectRoot = join(reviewRunFolderBase(), 'excluded-commit-path-project');
    const excludedMarker = 'EXCLUDED_COMMIT_CONTENT_MUST_NOT_LEAK';
    const keptMarker = 'KEPT_COMMIT_CONTENT_UNDER_REVIEW';
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'excluded-secret.ts'), 'export const secret = "a";\n');
    writeFileSync(join(projectRoot, 'src', 'kept.ts'), 'export const kept = "a";\n');
    execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(
      join(projectRoot, 'src', 'excluded-secret.ts'),
      `export const secret = "${excludedMarker}";\n`,
    );
    writeFileSync(join(projectRoot, 'src', 'kept.ts'), `export const kept = "${keptMarker}";\n`);
    execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-m',
        'change both files',
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000113',
      goal: 'review latest commit except src/excluded-secret.ts',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 10, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayCalls += 1;
          expect(input.prompt).toContain(keptMarker);
          expect(input.prompt).not.toContain(excludedMarker);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-excluded-commit-path',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.target).toMatchObject({
      kind: 'commit',
      paths: { include: [], exclude: ['src/excluded-secret.ts'] },
    });
    expect(intake.evidence_warnings).toContainEqual(
      expect.objectContaining({
        kind: 'target_scoped',
        message: expect.stringContaining('excluding src/excluded-secret.ts'),
      }),
    );
    // The report has to carry the scope too, or a reader could take the review
    // for a full one.
    const result = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(result.evidence_summary).toMatchObject({
      path_scope: { include: [], exclude: ['src/excluded-secret.ts'] },
    });
    expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(excludedMarker);
  });

  it.each([
    {
      label: 'negated-review-clause',
      goal: 'review latest commit but do not review package-lock.json',
      excludedPath: 'package-lock.json',
      runId: '79000000-0000-0000-0000-000000000114',
    },
    {
      label: 'bare-artifact-name',
      goal: 'review latest commit except the lockfile',
      excludedPath: 'lockfile',
      runId: '79000000-0000-0000-0000-000000000115',
    },
    {
      label: 'bare-directory-name',
      goal: 'review latest commit, leaving out migrations',
      excludedPath: 'migrations/001.sql',
      runId: '79000000-0000-0000-0000-000000000116',
    },
  ])(
    'keeps $label exclusions out of the Git reads and the relay',
    async ({ goal, excludedPath, label, runId }) => {
      const { bytes } = loadFixture();
      const runFolder = join(reviewRunFolderBase(), `excluded-target-clause-${label}`);
      const projectRoot = join(reviewRunFolderBase(), `excluded-target-clause-${label}-project`);
      const excludedMarker = `EXCLUDED_${label.toUpperCase().replaceAll('-', '_')}_MUST_NOT_LEAK`;
      const keptMarker = `KEPT_${label.toUpperCase().replaceAll('-', '_')}_UNDER_REVIEW`;
      mkdirSync(join(projectRoot, 'migrations'), { recursive: true });
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
      writeFileSync(join(projectRoot, excludedPath), `${excludedMarker}\n`);
      writeFileSync(join(projectRoot, 'kept.txt'), `${keptMarker}\n`);
      execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Circuit',
          '-c',
          'user.email=circuit@example.test',
          'commit',
          '-m',
          'excluded target-clause content',
        ],
        { cwd: projectRoot, stdio: 'pipe' },
      );
      let relayCalls = 0;

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId,
        goal,
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 11, 15, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayCalls += 1;
            expect(input.prompt).toContain(keptMarker);
            expect(input.prompt).not.toContain(excludedMarker);
            return {
              request_payload: input.prompt,
              receipt_id: `stub-receipt-${label}`,
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });

      expect(outcome.outcome).toBe('complete');
      expect(relayCalls).toBe(1);
      expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(excludedMarker);
    },
  );

  it('reviews only the paths a commit subset names', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'path-subset-commit');
    const projectRoot = join(reviewRunFolderBase(), 'path-subset-commit-project');
    const selectedMarker = 'PATH_SUBSET_SELECTED_UNDER_REVIEW';
    const unselectedMarker = 'PATH_SUBSET_UNSELECTED_MUST_NOT_LEAK';
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'foo.ts'), `const foo = "${selectedMarker}";\n`);
    writeFileSync(join(projectRoot, 'src', 'bar.ts'), `const bar = "${unselectedMarker}";\n`);
    execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-m',
        'path subset fixture',
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000119',
      goal: 'review latest commit only in src/foo.ts',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 25, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayCalls += 1;
          expect(input.prompt).toContain(selectedMarker);
          expect(input.prompt).not.toContain(unselectedMarker);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-path-subset-commit',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.target).toMatchObject({
      kind: 'commit',
      paths: { include: ['src/foo.ts'], exclude: [] },
    });
    expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(unselectedMarker);
  });

  // The scope has to survive the trip across the reader boundary, because the
  // sandboxed reader is what actually builds the Git arguments in a Codex host.
  it.each([
    {
      goal: 'review latest commit only in src/',
      expected: { include: ['src/'], exclude: [] },
      runId: '79000000-0000-0000-0000-000000000121',
      label: 'directory-subset',
    },
    {
      goal: 'review only src/foo.ts in latest commit',
      expected: { include: ['src/foo.ts'], exclude: [] },
      runId: '79000000-0000-0000-0000-000000000122',
      label: 'reverse-path-subset',
    },
  ])('hands $label to the injected Git reader as a path scope', async (testCase) => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), testCase.label);
    const projectRoot = join(reviewRunFolderBase(), `${testCase.label}-project`);
    const marker = 'SCOPED_READER_DIFF_MARKER';
    mkdirSync(projectRoot, { recursive: true });
    const scopedReads: Array<{ operation: RuntimeGitOperation; paths?: unknown }> = [];
    const outputs: Readonly<Record<RuntimeGitOperation, string>> = {
      status: '',
      staged_diff: '',
      unstaged_diff: '',
      staged_diff_stat: '',
      unstaged_diff_stat: '',
      resolve_target: '',
      target_diff: `diff --git a/src/foo.ts b/src/foo.ts\n+${marker}\n`,
      target_diff_stat: ' src/foo.ts | 1 +\n',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: '',
      tracked_files: '',
    };
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        scopedReads.push({
          operation: request.operation,
          ...(request.paths === undefined ? {} : { paths: request.paths }),
        });
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
      runId: testCase.runId,
      goal: testCase.goal,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 30, 0)),
      projectRoot,
      gitReader,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');
    expect(scopedReads).toEqual([
      // Resolving a ref reads no paths, so the scope must not ride along.
      { operation: 'resolve_target' },
      { operation: 'target_diff', paths: testCase.expected },
      { operation: 'target_diff_stat', paths: testCase.expected },
    ]);
  });

  it('scopes working-tree reads so an excluded file never reaches the reviewer', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'working-tree-path-scope');
    const projectRoot = join(reviewRunFolderBase(), 'working-tree-path-scope-project');
    const keptMarker = 'WORKING_TREE_KEPT_UNDER_REVIEW';
    const excludedMarker = 'WORKING_TREE_EXCLUDED_MUST_NOT_LEAK';
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(projectRoot, 'generated'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'app.ts'), 'const app = "base";\n');
    writeFileSync(join(projectRoot, 'generated', 'bundle.ts'), 'const bundle = "base";\n');
    execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'src', 'app.ts'), `const app = "${keptMarker}";\n`);
    writeFileSync(
      join(projectRoot, 'generated', 'bundle.ts'),
      `const bundle = "${excludedMarker}";\n`,
    );
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000125',
      goal: 'review the working tree except the generated files',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 35, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayCalls += 1;
          expect(input.prompt).toContain(keptMarker);
          expect(input.prompt).not.toContain(excludedMarker);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-working-tree-path-scope',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.target).toMatchObject({
      kind: 'working_tree',
      mode: 'all',
      paths: { include: [], exclude: ['generated'] },
    });
    expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(excludedMarker);
  });

  it('says which narrowing it could not apply instead of reviewing in silence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'scope-not-applied');
    const projectRoot = stagedReviewProject('scope-not-applied-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000126',
      goal: 'review the working tree except deleted files',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 40, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence_warnings).toContainEqual(
      expect.objectContaining({
        kind: 'scope_not_applied',
        message: expect.stringContaining('except deleted'),
      }),
    );
  });

  // A bare path names what to look at, not which changes. Review reads it as
  // the working tree under that path and says the target was assumed.
  it.each([
    {
      label: 'source-file',
      goal: 'review src/foo.ts',
      selectedPath: 'src/foo.ts',
      runId: '79000000-0000-0000-0000-000000000117',
    },
    {
      label: 'plan-file',
      goal: 'review the plan in docs/release/plan.md',
      selectedPath: 'docs/release/plan.md',
      runId: '79000000-0000-0000-0000-000000000118',
    },
  ])(
    'scopes a path-only $label request to that path',
    async ({ goal, label, runId, selectedPath }) => {
      const { bytes } = loadFixture();
      const runFolder = join(reviewRunFolderBase(), `path-only-${label}`);
      const projectRoot = join(reviewRunFolderBase(), `path-only-${label}-project`);
      const selectedMarker = `PATH_ONLY_${label.toUpperCase().replaceAll('-', '_')}_UNDER_REVIEW`;
      const otherMarker = `PATH_ONLY_${label.toUpperCase().replaceAll('-', '_')}_MUST_NOT_LEAK`;
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      mkdirSync(join(projectRoot, 'docs', 'release'), { recursive: true });
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
      writeFileSync(join(projectRoot, selectedPath), 'base\n');
      writeFileSync(join(projectRoot, 'unrelated.txt'), 'base\n');
      execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Circuit',
          '-c',
          'user.email=circuit@example.test',
          'commit',
          '-m',
          'path-only Review fixture',
        ],
        { cwd: projectRoot, stdio: 'pipe' },
      );
      writeFileSync(join(projectRoot, selectedPath), `${selectedMarker}\n`);
      writeFileSync(join(projectRoot, 'unrelated.txt'), `${otherMarker}\n`);
      let relayCalls = 0;

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId,
        goal,
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 11, 20, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayCalls += 1;
            expect(input.prompt).toContain(selectedMarker);
            expect(input.prompt).not.toContain(otherMarker);
            return {
              request_payload: input.prompt,
              receipt_id: `stub-receipt-path-only-${label}`,
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });

      expect(outcome.outcome).toBe('complete');
      expect(relayCalls).toBe(1);
      const intake = ReviewIntake.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
      );
      expect(intake.target).toEqual({
        kind: 'working_tree',
        mode: 'all',
        explicit: false,
        paths: { include: [selectedPath], exclude: [] },
      });
      const warningKinds = intake.evidence_warnings.map((warning) => warning.kind);
      expect(warningKinds).toContain('target_assumed');
      expect(warningKinds).toContain('target_scoped');
      expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(otherMarker);
    },
  );

  // "review src/foo.ts" on a file nobody has touched is the ordinary ask, not
  // an error. There is no diff to show, so the reviewer gets the file itself.
  it('reviews a path with no changes by reading the code as it stands', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'path-only-unchanged');
    const projectRoot = join(reviewRunFolderBase(), 'path-only-unchanged-project');
    const fileMarker = 'SNAPSHOT_CONTENT_UNDER_REVIEW';
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'foo.ts'), `const foo = '${fileMarker}';\n`);
    writeFileSync(join(projectRoot, 'src', 'elsewhere.ts'), "const other = 'OUT_OF_SCOPE';\n");
    execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000127',
      goal: 'review src/foo.ts',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 45, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayCalls += 1;
          expect(input.prompt).toContain(fileMarker);
          // The path scope still binds a snapshot: a sibling file in the same
          // directory is outside what the operator named.
          expect(input.prompt).not.toContain('OUT_OF_SCOPE');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-snapshot',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.target).toEqual({
      kind: 'snapshot',
      paths: { include: ['src/foo.ts'], exclude: [] },
    });
    expect(intake.evidence).toMatchObject({
      kind: 'git-snapshot',
      matched_file_count: 1,
      files_truncated: false,
    });
    // The operator has to be able to tell "nothing is wrong with this change"
    // from "there was no change, so I read the file".
    const fallback = intake.evidence_warnings.find(
      (warning) => warning.kind === 'snapshot_fallback',
    );
    expect(fallback?.message).toContain('src/foo.ts');
  });

  it('says so plainly when a path-only request names nothing Git tracks', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'path-only-missing');
    const projectRoot = join(reviewRunFolderBase(), 'path-only-missing-project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'present.ts'), 'const present = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000128',
      goal: 'review src/typo.ts',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 50, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('an empty target must never reach the reviewer');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toContain('src/typo.ts');
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
  });
});
