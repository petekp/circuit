// Unit tests for the fix.change-set@v1 writer's buildResult logic.
//
// loadCommands just emits the git-state helper command the runtime will
// spawn; we don't retest spawn here. What matters is that buildResult
// correctly:
//   - subtracts pre-fix dirty paths from the post-fix snapshot so observed
//     reflects only what the fix touched
//   - flags undeclared extras and missing declared files with status 'fail'
//     and a clear reason
//   - flags HEAD divergence as fail even when sets happen to align
//   - flags hidden_index_flags (assume-unchanged or skip-worktree) as fail
//   - detects baseline-dirty-path mutation: a path that was already dirty
//     pre-fix and got further modified by fix-act shows up in observed via
//     fingerprint comparison
//   - handles renames (entries with status 'R ') by treating destination as
//     the observed path

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fixCompiledFlowPackage } from '../../src/flows/fix/index.js';
import type { FixBaselineSnapshot, FixChange, FixChangeSet } from '../../src/flows/fix/reports.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../src/flows/registries/verification-writers/types.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';

function requireFixChangeSetWriter(): VerificationBuilder {
  const writer = fixCompiledFlowPackage.writers.verification.find(
    (w) => w.resultSchemaName === 'fix.change-set@v1',
  );
  if (writer === undefined) {
    throw new Error('fix.change-set@v1 verification writer is not registered');
  }
  return writer;
}

const fixChangeSetWriter = requireFixChangeSetWriter();

const tempRoots: string[] = [];

function tempRunFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'fix-change-set-writer-'));
  tempRoots.push(root);
  return root;
}

function writeJson(runFolder: string, relPath: string, body: unknown): void {
  const fullPath = join(runFolder, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function makeFixture(options: {
  baseline: FixBaselineSnapshot;
  change: FixChange;
  priorChangeSet?: FixChangeSet;
  runFolder?: string;
  projectRoot?: string;
}): { runFolder: string; context: VerificationBuildContext } {
  const runFolder = options.runFolder ?? tempRunFolder();
  writeJson(runFolder, 'reports/fix/baseline-snapshot.json', options.baseline);
  writeJson(runFolder, 'reports/fix/change.json', options.change);
  if (options.priorChangeSet !== undefined) {
    writeJson(runFolder, 'reports/fix/change-set.json', options.priorChangeSet);
  }
  // Minimal CompiledFlow stub: only the `steps` lookup that
  // reportPathForSchemaInRuntimeFlow uses needs to resolve.
  const flow = {
    steps: [
      {
        id: 'fix-baseline-snapshot',
        kind: 'verification',
        writes: {
          report: {
            schema: 'fix.baseline-snapshot@v1',
            path: 'reports/fix/baseline-snapshot.json',
          },
        },
      },
      {
        id: 'fix-act',
        kind: 'relay',
        writes: {
          report: {
            schema: 'fix.change@v1',
            path: 'reports/fix/change.json',
          },
        },
      },
      {
        id: 'fix-change-set',
        kind: 'verification',
        writes: {
          report: {
            schema: 'fix.change-set@v1',
            path: 'reports/fix/change-set.json',
          },
        },
      },
    ],
  } as unknown as CompiledFlow;
  const step = {
    id: 'fix-change-set',
    kind: 'verification',
    reads: ['reports/fix/baseline-snapshot.json', 'reports/fix/change.json'],
    writes: {
      report: { schema: 'fix.change-set@v1', path: 'reports/fix/change-set.json' },
    },
  } as unknown as VerificationBuildContext['step'];
  return {
    runFolder,
    context: {
      runFolder,
      ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
      flow,
      step,
    },
  };
}

function helperObservation(
  command: VerificationCommand,
  payload: {
    head_sha: string;
    entries?: ReadonlyArray<{
      status_code: string;
      path: string;
      fingerprint: string;
      from?: string;
    }>;
    hidden_index_flags?: ReadonlyArray<{ tag: string; path: string }>;
  },
): VerificationCommandObservation {
  return {
    command,
    exit_code: 0,
    status: 'passed',
    duration_ms: 1,
    stdout_summary: JSON.stringify({
      head_sha: payload.head_sha,
      entries: payload.entries ?? [],
      hidden_index_flags: payload.hidden_index_flags ?? [],
    }),
    stderr_summary: '',
    timed_out: false,
  };
}

function loadCommandsForContext(context: VerificationBuildContext): readonly VerificationCommand[] {
  return fixChangeSetWriter.loadCommands(context);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HEAD_BEFORE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_AFTER_SAME = HEAD_BEFORE;
const HEAD_AFTER_MOVED = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BLOB_A = '0000000000000000000000000000000000000001';
const BLOB_A_PRIME = '0000000000000000000000000000000000000002';
const BLOB_B = '0000000000000000000000000000000000000003';

const NOOP_CHANGE: FixChange = {
  verdict: 'accept',
  summary: 'noop',
  diagnosis_ref: 'fix.diagnosis@v1',
  changed_files: ['src/a.ts'],
  evidence: ['noop'],
};

describe('fixChangeSetWriter.loadCommands', () => {
  it('emits one command (the git-state helper) for the runtime to spawn', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: NOOP_CHANGE,
    });
    const commands = loadCommandsForContext(context);
    expect(commands).toHaveLength(1);
    const command = commands[0];
    if (command === undefined) throw new Error('expected one command');
    // argv[0] is the runtime's node binary (process.execPath); argv[1] is
    // the helper script path. We don't pin the binary, but we do pin the
    // helper script name.
    expect(command.argv[1]).toMatch(/git-state\.ts$/);
    expect(command.cwd).toBe('.');
  });

  it('rejects schematics that do not declare reads on the required inputs', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: NOOP_CHANGE,
    });
    const stepWithoutReads = {
      ...context.step,
      reads: [],
    } as VerificationBuildContext['step'];
    expect(() => fixChangeSetWriter.loadCommands({ ...context, step: stepWithoutReads })).toThrow(
      /requires step .* to read/,
    );
  });
});

describe('fixChangeSetWriter.buildResult', () => {
  it('carries forward still-observed declarations from a prior accepted act attempt', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'review rework changed one file',
        diagnosis_ref: 'fix.review@v1',
        changed_files: ['src/rework.ts'],
        evidence: ['review finding fixed'],
      },
      priorChangeSet: {
        status: 'pass',
        overall_status: 'passed',
        baseline_head_sha: HEAD_BEFORE,
        head_sha: HEAD_BEFORE,
        declared: ['src/first-pass.ts'],
        observed: ['src/first-pass.ts'],
        undeclared_extras: [],
        missing_declared: [],
        baseline_dirty_mutated: [],
        hidden_index_flags: [],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [
            { status_code: ' M', path: 'src/first-pass.ts', fingerprint: BLOB_A },
            { status_code: ' M', path: 'src/rework.ts', fingerprint: BLOB_B },
          ],
        }),
      ],
      context,
    ) as FixChangeSet;

    expect(result.status).toBe('pass');
    expect(result.declared).toEqual(['src/first-pass.ts', 'src/rework.ts']);
    expect(result.observed).toEqual(['src/first-pass.ts', 'src/rework.ts']);
    expect(result.undeclared_extras).toEqual([]);
    expect(result.missing_declared).toEqual([]);
  });

  it('drops a prior declaration when a rework restores that path to the baseline', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'rework restored the old path and changed another',
        diagnosis_ref: 'fix.review@v1',
        changed_files: ['src/rework.ts'],
        evidence: ['review finding fixed'],
      },
      priorChangeSet: {
        status: 'pass',
        overall_status: 'passed',
        baseline_head_sha: HEAD_BEFORE,
        head_sha: HEAD_BEFORE,
        declared: ['src/restored.ts'],
        observed: ['src/restored.ts'],
        undeclared_extras: [],
        missing_declared: [],
        baseline_dirty_mutated: [],
        hidden_index_flags: [],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [{ status_code: ' M', path: 'src/rework.ts', fingerprint: BLOB_B }],
        }),
      ],
      context,
    ) as FixChangeSet;

    expect(result.status).toBe('pass');
    expect(result.declared).toEqual(['src/rework.ts']);
    expect(result.observed).toEqual(['src/rework.ts']);
  });

  it('does not carry declarations from a prior failed change-set', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'retry changed only the declared rework file',
        diagnosis_ref: 'fix.change-set@v1',
        changed_files: ['src/rework.ts'],
        evidence: ['change-set retry completed'],
      },
      priorChangeSet: {
        status: 'fail',
        overall_status: 'failed',
        reason: 'missing declared: src/unproven.ts',
        baseline_head_sha: HEAD_BEFORE,
        head_sha: HEAD_BEFORE,
        declared: ['src/unproven.ts'],
        observed: [],
        undeclared_extras: [],
        missing_declared: ['src/unproven.ts'],
        baseline_dirty_mutated: [],
        hidden_index_flags: [],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [
            { status_code: ' M', path: 'src/rework.ts', fingerprint: BLOB_B },
            { status_code: ' M', path: 'src/unproven.ts', fingerprint: BLOB_A },
          ],
        }),
      ],
      context,
    ) as FixChangeSet;

    expect(result.status).toBe('fail');
    expect(result.declared).toEqual(['src/rework.ts']);
    expect(result.undeclared_extras).toEqual(['src/unproven.ts']);
  });

  it('rejects a prior change-set from a different baseline', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'current attempt',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts'],
        evidence: ['current evidence'],
      },
      priorChangeSet: {
        status: 'pass',
        overall_status: 'passed',
        baseline_head_sha: HEAD_AFTER_MOVED,
        head_sha: HEAD_AFTER_MOVED,
        declared: ['src/a.ts'],
        observed: ['src/a.ts'],
        undeclared_extras: [],
        missing_declared: [],
        baseline_dirty_mutated: [],
        hidden_index_flags: [],
      },
    });
    const [helper] = loadCommandsForContext(context);

    expect(() =>
      fixChangeSetWriter.buildResult(
        [
          helperObservation(helper as VerificationCommand, {
            head_sha: HEAD_AFTER_SAME,
            entries: [{ status_code: ' M', path: 'src/a.ts', fingerprint: BLOB_A }],
          }),
        ],
        context,
      ),
    ).toThrow(/prior change-set baseline.*does not match current baseline/);
  });

  it('returns pass when declared exactly matches observed', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'pass case',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [{ status_code: ' M', path: 'src/a.ts', fingerprint: BLOB_A }],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.status).toBe('pass');
    expect(result.observed).toEqual(['src/a.ts']);
    expect(result.undeclared_extras).toEqual([]);
    expect(result.missing_declared).toEqual([]);
    expect(result.baseline_dirty_mutated).toEqual([]);
    expect(result.hidden_index_flags).toEqual([]);
  });

  it('flags undeclared extras as fail', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'lying about scope',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [
            { status_code: ' M', path: 'src/a.ts', fingerprint: BLOB_A },
            { status_code: ' M', path: 'src/extra.ts', fingerprint: BLOB_B },
          ],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.status).toBe('fail');
    expect(result.undeclared_extras).toEqual(['src/extra.ts']);
    expect(result.missing_declared).toEqual([]);
    expect(result.reason).toMatch(/undeclared extras: src\/extra\.ts/);
  });

  it('ignores active run-folder outputs when the run folder is inside the project root', () => {
    const projectRoot = tempRunFolder();
    const runFolder = join(projectRoot, 'circuit-surface-test/run-1');
    const { context } = makeFixture({
      runFolder,
      projectRoot,
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [
          {
            status_code: '??',
            path: 'circuit-surface-test/run-1/trace.ndjson',
            fingerprint: BLOB_A,
          },
        ],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'fix with run outputs present',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [
            { status_code: ' M', path: 'src/a.ts', fingerprint: BLOB_A },
            {
              status_code: '??',
              path: 'circuit-surface-test/run-1/reports/fix/change.json',
              fingerprint: BLOB_B,
            },
            {
              status_code: '??',
              path: 'circuit-surface-test/run-1/trace.ndjson',
              fingerprint: BLOB_A_PRIME,
            },
          ],
          hidden_index_flags: [{ tag: 'h', path: 'circuit-surface-test/run-1/internal.tmp' }],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.status).toBe('pass');
    expect(result.observed).toEqual(['src/a.ts']);
    expect(result.undeclared_extras).toEqual([]);
    expect(result.hidden_index_flags).toEqual([]);
  });

  it('flags missing declared as fail', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'declared but never edited',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts', 'src/b.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [{ status_code: ' M', path: 'src/a.ts', fingerprint: BLOB_A }],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.status).toBe('fail');
    expect(result.missing_declared).toEqual(['src/b.ts']);
    expect(result.reason).toMatch(/missing declared: src\/b\.ts/);
  });

  it('subtracts pre-fix dirty paths from observed when fingerprint is unchanged', () => {
    // src/preexisting.ts was dirty before the fix and the fix didn't touch
    // it (fingerprint matches baseline). It should not count as part of the
    // fix.
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [{ status_code: ' M', path: 'src/preexisting.ts', fingerprint: BLOB_A }],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'pass when pre-existing dirt is subtracted',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [
            { status_code: ' M', path: 'src/preexisting.ts', fingerprint: BLOB_A },
            { status_code: ' M', path: 'src/a.ts', fingerprint: BLOB_B },
          ],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.status).toBe('pass');
    expect(result.observed).toEqual(['src/a.ts']);
    expect(result.baseline_dirty_mutated).toEqual([]);
  });

  it('flags pre-existing dirty paths as undeclared when their fingerprint changes', () => {
    // src/preexisting.ts was dirty (fingerprint A) at baseline. Post-fix
    // fingerprint is A' — fix-act further modified it. The implementer
    // omitted it from changed_files; the writer should detect it via
    // fingerprint comparison and flag as an undeclared extra.
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [{ status_code: ' M', path: 'src/preexisting.ts', fingerprint: BLOB_A }],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'fix-act sneakily mutated a baseline-dirty path',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [
            { status_code: ' M', path: 'src/preexisting.ts', fingerprint: BLOB_A_PRIME },
            { status_code: ' M', path: 'src/a.ts', fingerprint: BLOB_B },
          ],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.status).toBe('fail');
    expect(result.undeclared_extras).toEqual(['src/preexisting.ts']);
    expect(result.baseline_dirty_mutated).toEqual(['src/preexisting.ts']);
    expect(result.observed).toEqual(['src/a.ts', 'src/preexisting.ts']);
  });

  it('treats a baseline-dirty path that is now clean as a touch (still detects mutation)', () => {
    // src/preexisting.ts was dirty at baseline. Post-fix the file matches
    // HEAD again — fix-act reverted operator's prior edit. That counts as
    // fix-act touching the file.
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [{ status_code: ' M', path: 'src/preexisting.ts', fingerprint: BLOB_A }],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'silently reverted operator edit',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          // src/preexisting.ts no longer dirty; only src/a.ts is.
          entries: [{ status_code: ' M', path: 'src/a.ts', fingerprint: BLOB_B }],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.status).toBe('fail');
    expect(result.undeclared_extras).toEqual(['src/preexisting.ts']);
    expect(result.baseline_dirty_mutated).toEqual(['src/preexisting.ts']);
  });

  it('flags HEAD divergence as fail even when set differences are clean', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'committed mid-run',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_MOVED,
          entries: [],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/HEAD moved during the fix run/);
    expect(result.baseline_head_sha).toBe(HEAD_BEFORE);
    expect(result.head_sha).toBe(HEAD_AFTER_MOVED);
  });

  it('flags HEAD divergence as fail even when path sets exactly match declared', () => {
    // The path-set algebra would happily say 'pass' here — declared and
    // observed both equal ['src/a.ts'] — but HEAD moved, so the writer must
    // override to 'fail'.
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'declared the right file but committed it',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_MOVED,
          entries: [{ status_code: ' M', path: 'src/a.ts', fingerprint: BLOB_A }],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/HEAD moved during the fix run/);
  });

  it('flags hidden_index_flags from the post-fix snapshot as fail', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'tries to hide an edit behind assume-unchanged',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/a.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [{ status_code: ' M', path: 'src/a.ts', fingerprint: BLOB_A }],
          hidden_index_flags: [{ tag: 'h', path: 'src/locked.ts' }],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.status).toBe('fail');
    expect(result.hidden_index_flags).toEqual([{ tag: 'h', path: 'src/locked.ts' }]);
    expect(result.reason).toMatch(/hidden index flags present/);
  });

  it('handles rename porcelain entries by taking the destination path', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'rename declared as the new path',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/new.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [
            {
              status_code: 'R ',
              path: 'src/new.ts',
              fingerprint: BLOB_A,
              from: 'src/old.ts',
            },
          ],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.observed).toEqual(['src/new.ts']);
    expect(result.status).toBe('pass');
  });

  it('preserves paths with spaces — helper output is null-delimited so quoting is gone', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: {
        verdict: 'accept',
        summary: 'path with spaces declared',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/has space.ts'],
        evidence: ['ok'],
      },
    });
    const [helper] = loadCommandsForContext(context);
    const result = fixChangeSetWriter.buildResult(
      [
        helperObservation(helper as VerificationCommand, {
          head_sha: HEAD_AFTER_SAME,
          entries: [{ status_code: ' M', path: 'src/has space.ts', fingerprint: BLOB_A }],
        }),
      ],
      context,
    ) as FixChangeSet;
    expect(result.observed).toEqual(['src/has space.ts']);
    expect(result.status).toBe('pass');
  });

  it('throws a clear error when the helper observation failed', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: NOOP_CHANGE,
    });
    const [helper] = loadCommandsForContext(context);
    const failingObservation: VerificationCommandObservation = {
      command: helper as VerificationCommand,
      exit_code: 1,
      status: 'failed',
      duration_ms: 1,
      stdout_summary: '',
      stderr_summary: 'fix-git-state: git rev-parse HEAD failed: not a git repository',
      timed_out: false,
    };
    expect(() => fixChangeSetWriter.buildResult([failingObservation], context)).toThrow(
      /git-state helper failed/,
    );
  });

  it('throws a clear error when the helper output is not valid JSON', () => {
    const { context } = makeFixture({
      baseline: {
        overall_status: 'passed',
        head_sha: HEAD_BEFORE,
        entries: [],
        hidden_index_flags: [],
      },
      change: NOOP_CHANGE,
    });
    const [helper] = loadCommandsForContext(context);
    const malformedObservation: VerificationCommandObservation = {
      command: helper as VerificationCommand,
      exit_code: 0,
      status: 'passed',
      duration_ms: 1,
      stdout_summary: 'not json {',
      stderr_summary: '',
      timed_out: false,
    };
    expect(() => fixChangeSetWriter.buildResult([malformedObservation], context)).toThrow(
      /not valid JSON/,
    );
  });
});
