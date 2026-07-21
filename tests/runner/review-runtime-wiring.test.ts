import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import {
  type ReviewFinding,
  ReviewIntake,
  ReviewRelayResult,
  ReviewResult,
  type ReviewResultVerdict,
  computeReviewVerdict,
} from '../../src/flows/review/reports.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { ProgressEvent } from '../../src/schemas/progress-event.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import type { RuntimeGitOperation, RuntimeGitReader } from '../../src/shared/runtime-git-reader.js';

const FIXTURE_PATH = resolve('generated/flows/review/circuit.json');

function loadFixture(): { bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  CompiledFlow.parse(raw);
  return { bytes };
}

function loadFixtureWithRenamedAnalyzeResultPath(resultPath: string): {
  bytes: Buffer;
} {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
    steps: Array<{
      id: string;
      writes?: { result?: string };
      reads?: string[];
    }>;
  };
  for (const step of raw.steps) {
    if (step.id === 'audit-step' && step.writes !== undefined) {
      step.writes.result = resultPath;
    }
    if (step.id === 'verdict-step' && step.reads !== undefined) {
      step.reads = step.reads.map((path) =>
        path === 'stages/analyze/review-raw-findings.json' ? resultPath : path,
      );
    }
  }
  const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
  CompiledFlow.parse(raw);
  return { bytes };
}

// Stub reviewer prose attached to every NO_ISSUES_FOUND relay payload these
// tests fabricate. The schema requires `assessment`, `verification`, and
// `confidence_limitations` on every verdict, so each fixture body needs them
// even when the test cares only about routing and trace shape.
function stubProse(): {
  assessment: string;
  verification: string[];
  confidence_limitations: string[];
} {
  return {
    assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
    verification: ['Inspected the relayed intake report.'],
    confidence_limitations: [],
  };
}

function cleanRelayResult(): ReviewRelayResult {
  return { verdict: 'NO_ISSUES_FOUND', findings: [], ...stubProse() };
}

function relayerWith(result: ReviewRelayResult): RelayFn {
  return relayerWithBody(JSON.stringify(result));
}

function relayerWithBody(body: string): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      expect(input.prompt).toContain('Accepted verdicts: NO_ISSUES_FOUND, ISSUES_FOUND');
      expect(input.prompt).toContain('"findings"');
      expect(input.prompt).toContain('"findings": []');
      expect(input.prompt).toContain('"severity": "<critical|high|medium|low>"');
      expect(input.prompt).not.toContain('info');
      return {
        request_payload: input.prompt,
        receipt_id: 'stub-receipt-review',
        result_body: body,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

function traceEntryLabel(trace_entry: {
  kind: string;
  step_id?: unknown;
  subject?: unknown;
  scope?: { step_id?: unknown };
}): string {
  if (trace_entry.kind === 'guidance.decision' && typeof trace_entry.subject === 'string') {
    const scopedStep = trace_entry.scope?.step_id;
    return typeof scopedStep === 'string'
      ? `${trace_entry.kind}:${trace_entry.subject}:${scopedStep}`
      : `${trace_entry.kind}:${trace_entry.subject}`;
  }
  return typeof trace_entry.step_id === 'string'
    ? `${trace_entry.kind}:${trace_entry.step_id}`
    : trace_entry.kind;
}

async function readTraceEntries(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

let runFolderBase: string;

const CASES: Array<{
  name: string;
  runId: string;
  relay: ReviewRelayResult;
  expectedVerdict: ReviewResultVerdict;
  expectedOutcome: 'complete' | 'stopped';
}> = [
  {
    name: 'clean review',
    runId: '79000000-0000-0000-0000-000000000001',
    relay: cleanRelayResult(),
    expectedVerdict: 'CLEAN',
    expectedOutcome: 'complete',
  },
  {
    name: 'review with high finding',
    runId: '79000000-0000-0000-0000-000000000002',
    relay: {
      verdict: 'ISSUES_FOUND',
      findings: [
        {
          severity: 'high',
          id: 'REVIEW-HIGH-1',
          text: 'High severity issue found by the reviewer.',
          file_refs: ['src/example.ts:12'],
        },
      ] satisfies ReviewFinding[],
      ...stubProse(),
    },
    expectedVerdict: 'ISSUES_FOUND',
    expectedOutcome: 'stopped',
  },
];

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-review-runtime-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('registered review compose writer', () => {
  it('writes schema-valid review.result with the default compose writer', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'default-registered-review-writer');
    const goal = 'Review scope with the default registered compose writer';

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000000',
      goal,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');

    const reportPath = join(runFolder, 'reports', 'review-result.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = ReviewResult.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
    const prose = stubProse();
    expect(report).toEqual({
      scope: goal,
      findings: [],
      verdict: 'CLEAN',
      outcome: 'complete',
      assessment: prose.assessment,
      verification: prose.verification,
      confidence_limitations: prose.confidence_limitations,
      evidence_summary: {
        kind: 'unavailable',
        message: 'CompiledFlowInvocation.projectRoot was not provided',
      },
      evidence_warnings: [
        {
          kind: 'evidence_unavailable',
          message: 'CompiledFlowInvocation.projectRoot was not provided',
        },
      ],
    });
  });

  it('passes working tree evidence into the reviewer relay when projectRoot is available', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'working-tree-evidence');
    const projectRoot = join(runFolderBase, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'review-target.ts'), 'const answer = 42;\n');
    execFileSync('git', ['add', 'src/review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000005',
      goal: 'review the current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'claude-code',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('"kind": "git-working-tree"');
          expect(input.prompt).toContain('"status_short"');
          expect(input.prompt).toContain('src/review-target.ts');
          expect(input.prompt).toContain('+const answer = 42;');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-review-evidence',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
  });

  it('uses the injected bounded Git reader instead of ordinary Review Git commands', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'bounded-git-reader');
    const projectRoot = join(runFolderBase, 'bounded-git-project');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'notes.txt'), 'bounded untracked note\n');
    const seen: RuntimeGitOperation[] = [];
    const outputs: Readonly<Record<RuntimeGitOperation, string>> = {
      status: ' M src/app.ts\0?? notes.txt\0',
      staged_diff: 'diff --git a/src/app.ts b/src/app.ts\n',
      unstaged_diff: '',
      staged_diff_stat: ' src/app.ts | 1 +\n',
      untracked_files: 'notes.txt\0',
      submodules: '',
    };
    const gitReader: RuntimeGitReader = {
      read: async ({ operation, projectRoot: requestedRoot }) => {
        expect(requestedRoot).toBe(projectRoot);
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
      runId: '79000000-0000-0000-0000-000000000019',
      goal: 'review through the bounded Git reader',
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
    expect(seen).toEqual([
      'status',
      'staged_diff',
      'unstaged_diff',
      'staged_diff_stat',
      'untracked_files',
    ]);
  });

  it('keeps bounded partial diff evidence when the injected Git reader reaches its output limit', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'bounded-git-partial-diff');
    const projectRoot = join(runFolderBase, 'bounded-git-partial-project');
    const marker = 'bounded-partial-diff-marker';
    mkdirSync(projectRoot, { recursive: true });
    const gitReader: RuntimeGitReader = {
      read: async ({ operation }) => {
        const partial = operation === 'staged_diff';
        return {
          schema_version: 1,
          ok: !partial,
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
      goal: 'review the bounded partial diff',
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

    expect(outcome.outcome).toBe('complete');
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
  });

  it('omits untracked file contents by default while keeping path metadata', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'untracked-metadata-only');
    const projectRoot = join(runFolderBase, 'metadata-only-project');
    const secret = 'secret-like scratch content must not be relayed by default';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'scratch-notes.txt'), `${secret}\n`);

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000009',
      goal: 'review the current untracked files',
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
    const runFolder = join(runFolderBase, 'untracked-content-opt-in');
    const projectRoot = join(runFolderBase, 'content-opt-in-project');
    const scratch = 'operator explicitly allowed this untracked content';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'scratch-notes.txt'), `${scratch}\n`);

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000010',
      goal: 'review the current untracked files',
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
    const runFolder = join(runFolderBase, 'large-diff-evidence');
    const projectRoot = join(runFolderBase, 'large-diff-project');
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

    expect(outcome.outcome).toBe('complete');
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
  });

  it('skips unreadable untracked files instead of aborting review intake', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'unreadable-untracked-evidence');
    const projectRoot = join(runFolderBase, 'unreadable-project');
    const unreadablePath = join(projectRoot, 'unreadable.txt');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(unreadablePath, 'do not read me\n');
    chmodSync(unreadablePath, 0o000);

    try {
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000007',
        goal: 'review the current untracked files',
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
    const runFolder = join(runFolderBase, 'untracked-content-redaction');
    const projectRoot = join(runFolderBase, 'redaction-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'binary.dat'), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(join(projectRoot, 'large.txt'), `${'x'.repeat(25_000)}\n`);

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000011',
      goal: 'review the current untracked files',
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
  });

  it('surfaces unavailable evidence as an explicit warning in intake and result', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'unavailable-evidence-warning');
    const progress: ProgressEvent[] = [];

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000008',
      goal: 'review without project root evidence',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      relayer: relayerWith(cleanRelayResult()),
      progress: (event) => progress.push(ProgressEvent.parse(event)),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'evidence_unavailable' }),
    );
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'evidence_unavailable' }),
    );
    expect(progress).toContainEqual(
      expect.objectContaining({
        type: 'evidence.warning',
        warning_kind: 'evidence_unavailable',
        display: expect.objectContaining({ tone: 'warning' }),
      }),
    );
  });

  it('emits scope_empty when the working tree has no staged or unstaged diff so a CLEAN verdict cannot quietly stand in for "nothing was reviewed"', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'scope-empty-warning');
    const projectRoot = join(runFolderBase, 'scope-empty-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    // No staged changes, no unstaged changes, no untracked files. The reviewer
    // is given a scope hint pointing at content that is not part of the
    // working-tree diff (e.g., already-committed code, HEAD~1 history).

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000020',
      goal: 'review the new evil.js — flag any safety problems',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence.kind).toBe('git-working-tree');
    if (intake.evidence.kind !== 'git-working-tree') return;
    expect(intake.evidence.staged_diff.text).toBe('');
    expect(intake.evidence.unstaged_diff.text).toBe('');
    expect(intake.evidence_warnings).toContainEqual(
      expect.objectContaining({
        kind: 'scope_empty',
        message: expect.stringContaining('HEAD~1 differences not examined'),
      }),
    );
    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'scope_empty' }),
    );
  });

  it('does not emit scope_empty when an untracked file with content is being relayed — that file IS uncommitted scope', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'scope-empty-not-emitted-untracked-content');
    const projectRoot = join(runFolderBase, 'scope-empty-untracked-content-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'scratch.js'), "console.log('hello');\n");

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000022',
      goal: 'review the new untracked scratch.js',
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

  it('still emits scope_empty when untracked files exist but their content is not relayed (metadata-only)', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'scope-empty-still-fires-metadata-only');
    const projectRoot = join(runFolderBase, 'scope-empty-metadata-only-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'scratch.js'), "console.log('hello');\n");

    // Default content policy is metadata-only — untracked file paths/sizes
    // are relayed, but not the file contents the reviewer would need to
    // audit. The reviewer effectively has nothing to inspect.
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000023',
      goal: 'review the new untracked scratch.js without --include-untracked-content',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'scope_empty' }),
    );
  });

  it('does not emit scope_empty when the working tree contains a staged diff', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'scope-empty-not-emitted-with-diff');
    const projectRoot = join(runFolderBase, 'scope-empty-not-emitted-project');
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

  it('derives the analyze result path from the live flow graph', async () => {
    const renamedResultPath = 'stages/analyze/review-findings-renamed.json';
    const { bytes } = loadFixtureWithRenamedAnalyzeResultPath(renamedResultPath);
    const runFolder = join(runFolderBase, 'renamed-analyze-result-path');
    const goal = 'Review scope with renamed analyze result path';
    const relay = {
      verdict: 'ISSUES_FOUND',
      findings: [
        {
          severity: 'low',
          id: 'LOW-1',
          text: 'Low severity issue found by the reviewer.',
          file_refs: ['src/example.ts:22'],
        },
      ],
      ...stubProse(),
    } satisfies ReviewRelayResult;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000003',
      goal,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      relayer: relayerWith(relay),
    });

    expect(outcome.outcome).toBe('complete');
    expect(existsSync(join(runFolder, renamedResultPath))).toBe(true);
    expect(existsSync(join(runFolder, 'stages', 'analyze', 'review-raw-findings.json'))).toBe(
      false,
    );

    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.scope).toBe(goal);
    expect(report.findings).toEqual(relay.findings);
    expect(report.verdict).toBe('CLEAN');
  });

  it('aborts instead of throwing when the admitted relay result is not review-shaped', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'bad-review-relay-shape');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000004',
      goal: 'Review scope with malformed admitted relay body',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      relayer: relayerWithBody('{"verdict":"NO_ISSUES_FOUND","findings":"not-an-array"}'),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toContain("step 'verdict-step' handler threw");
    expect(outcome.reason).toContain('"findings"');
    expect(existsSync(join(runFolder, 'reports', 'review-result.json'))).toBe(false);

    const traceEntries = await readTraceEntries(runFolder);
    const verdictAbort = traceEntries.find(
      (trace_entry) =>
        trace_entry.kind === 'step.aborted' && trace_entry.step_id === 'verdict-step',
    );
    if (verdictAbort?.kind !== 'step.aborted') throw new Error('expected verdict abort trace');
    expect(verdictAbort.reason).toContain('"findings"');

    expect(traceEntries.map(traceEntryLabel)).toEqual([
      'run.bootstrapped',
      'guidance.decision:flow_selection',
      'step.entered:intake-step',
      'step.report_written:intake-step',
      'step.completed:intake-step',
      'step.entered:audit-step',
      'guidance.decision:relay_execution:audit-step',
      'relay.started:audit-step',
      'relay.request:audit-step',
      'relay.receipt:audit-step',
      'relay.result:audit-step',
      'relay.completed:audit-step',
      'check.evaluated:audit-step',
      'step.completed:audit-step',
      'step.entered:verdict-step',
      'step.aborted:verdict-step',
      'run.closed',
    ]);
  });

  it.each(CASES)(
    'runs the live review fixture end-to-end for $name',
    async ({ name, runId, relay, expectedVerdict, expectedOutcome }) => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, name.replaceAll(' ', '-'));
      const goal = `Review scope for ${name}`;

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId,
        goal,
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
        relayer: relayerWith(relay),
      });

      expect(outcome.outcome).toBe(expectedOutcome);

      const rawRelayPath = join(runFolder, 'stages', 'analyze', 'review-raw-findings.json');
      expect(existsSync(rawRelayPath)).toBe(true);
      expect(ReviewRelayResult.parse(JSON.parse(readFileSync(rawRelayPath, 'utf8')))).toEqual(
        relay,
      );

      const reportPath = join(runFolder, 'reports', 'review-result.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = ReviewResult.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
      expect(report.scope).toBe(goal);
      expect(report.findings).toEqual(relay.findings);
      expect(report.verdict).toBe(expectedVerdict);
      expect(report.verdict).toBe(computeReviewVerdict(report.findings));

      const traceEntries = await readTraceEntries(runFolder);
      const relayCompleted = traceEntries.find(
        (trace_entry) => trace_entry.kind === 'relay.completed',
      );
      if (relayCompleted?.kind !== 'relay.completed') {
        throw new Error('expected relay.completed');
      }
      expect(relayCompleted.verdict).toBe(relay.verdict);

      const reviewCheck = traceEntries.find(
        (trace_entry) =>
          trace_entry.kind === 'check.evaluated' && trace_entry.step_id === 'audit-step',
      );
      if (reviewCheck?.kind !== 'check.evaluated') {
        throw new Error('expected review check.evaluated trace_entry');
      }
      expect(reviewCheck.check_kind).toBe('result_verdict');
      expect(reviewCheck.outcome).toBe('pass');

      // The analyze stage is a relay stage, so its durable report
      // evidence is relay.result rather than step.report_written.
      // The sequence below proves frame -> analyze -> close execution
      // and the expected trace_entry ordering for each stage.
      expect(traceEntries.map(traceEntryLabel)).toEqual([
        'run.bootstrapped',
        'guidance.decision:flow_selection',
        'step.entered:intake-step',
        'step.report_written:intake-step',
        'step.completed:intake-step',
        'step.entered:audit-step',
        'guidance.decision:relay_execution:audit-step',
        'relay.started:audit-step',
        'relay.request:audit-step',
        'relay.receipt:audit-step',
        'relay.result:audit-step',
        'relay.completed:audit-step',
        'check.evaluated:audit-step',
        'step.completed:audit-step',
        'step.entered:verdict-step',
        'step.report_written:verdict-step',
        'step.completed:verdict-step',
        'run.closed',
      ]);
    },
  );

  // Regression (launch blocker): an honest ISSUES_FOUND review must not close
  // `complete`. Review arms `binds_terminal_outcome_to_primary_result` and the
  // verdict step derives review.result.outcome from the verdict (CLEAN →
  // complete, ISSUES_FOUND → stopped). The engine binds the terminal run
  // outcome to that primary-result outcome, so a review that finds a blocking
  // issue closes `stopped` (operator-visible "needs attention"), never a green
  // `complete` over a known defect.
  it('closes stopped, not complete, when the reviewer returns a blocking ISSUES_FOUND verdict', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'issues-found-binds-stopped');
    const relay: ReviewRelayResult = {
      verdict: 'ISSUES_FOUND',
      findings: [
        {
          severity: 'high',
          id: 'REVIEW-BLOCKING-1',
          text: 'Blocking defect the operator must address before shipping.',
          file_refs: ['src/example.ts:7'],
        },
      ],
      ...stubProse(),
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-0000000000f1',
      goal: 'Review the change that has a blocking defect',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      relayer: relayerWith(relay),
    });

    // The load-bearing assertion: the run outcome tracks the verdict.
    expect(outcome.outcome).toBe('stopped');

    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.verdict).toBe('ISSUES_FOUND');
    expect(report.outcome).toBe('stopped');

    const traceEntries = await readTraceEntries(runFolder);
    const closed = traceEntries.find((entry) => entry.kind === 'run.closed');
    if (closed?.kind !== 'run.closed') throw new Error('expected run.closed trace entry');
    expect(closed.outcome).toBe('stopped');
  });

  it('still closes complete when the reviewer returns a CLEAN verdict', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'clean-binds-complete');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-0000000000f2',
      goal: 'Review a clean change',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');

    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.verdict).toBe('CLEAN');
    expect(report.outcome).toBe('complete');
  });
});
