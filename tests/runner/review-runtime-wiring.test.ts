import childProcess, { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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
import { runCompiledFlow as runCompiledFlowRaw } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { ProgressEvent } from '../../src/schemas/progress-event.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { runtimeGitTextIsValidUtf8 } from '../../src/shared/runtime-git-reader.js';
import type {
  RuntimeGitOperation,
  RuntimeGitPinnedTarget,
  RuntimeGitReader,
  RuntimeGitTarget,
} from '../../src/shared/runtime-git-reader.js';

const FIXTURE_PATH = resolve('generated/flows/review/circuit.json');
const TEST_COMMIT_A = 'a'.repeat(40);
const TEST_COMMIT_B = 'b'.repeat(40);
const TEST_COMMIT_C = 'c'.repeat(40);

function pinnedTargetFor(target: RuntimeGitTarget): RuntimeGitPinnedTarget {
  if (target.kind === 'commit') {
    const commit =
      /^[0-9a-f]{4,40}$/u.test(target.ref) && target.ref.length < 40
        ? target.ref.padEnd(40, '0')
        : TEST_COMMIT_A;
    return { kind: 'commit', commit };
  }
  if (target.kind === 'range') {
    return {
      kind: 'range',
      base_commit: TEST_COMMIT_A,
      head_commit: TEST_COMMIT_B,
      dots: target.dots,
    };
  }
  return {
    kind: 'pull_request',
    number: target.number,
    ...('repository' in target && target.repository !== undefined
      ? { repository: target.repository }
      : {}),
    merge_commit: TEST_COMMIT_A,
    base_commit: TEST_COMMIT_B,
    head_commit: TEST_COMMIT_C,
  };
}

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
    promptOnlyContext: true,
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      expect(input.promptOnly).toBe(true);
      expect(input.prompt).toContain('Accepted verdicts: NO_ISSUES_FOUND, ISSUES_FOUND');
      expect(input.prompt).toContain('selected Review target is authoritative');
      expect(input.prompt).toContain('Review sees only the captured evidence in this prompt');
      expect(input.prompt).toContain('Do not read repository files');
      expect(input.prompt).toContain('substitute another Git view');
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

async function runCompiledFlow(
  input: Parameters<typeof runCompiledFlowRaw>[0],
): ReturnType<typeof runCompiledFlowRaw> {
  return await runCompiledFlowRaw({
    ...input,
    ...(input.relayer === undefined
      ? {}
      : {
          relayer: {
            ...input.relayer,
            promptOnlyContext: true,
          },
        }),
  });
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

function stagedReviewProject(label: string): string {
  const projectRoot = join(runFolderBase, label);
  mkdirSync(projectRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
  writeFileSync(join(projectRoot, 'review-target.ts'), 'export const reviewTarget = true;\n');
  execFileSync('git', ['add', 'review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
  return projectRoot;
}

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
  it('stops before spend when an injected reviewer cannot prove prompt-only isolation', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'review-relayer-without-prompt-only-boundary');
    let relayCalls = 0;

    const outcome = await runCompiledFlowRaw({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000106',
      goal: 'review this supplied code: const answer = 42',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 5, 0)),
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('unsupported relayer must not be called');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/cannot prove|repository access/i);
    expect(relayCalls).toBe(0);
  });

  it('writes schema-valid review.result with the default compose writer', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'default-registered-review-writer');
    const goal =
      'Review this supplied text: the default registered compose writer should emit a schema-valid result.';
    const projectRoot = stagedReviewProject('default-registered-review-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000000',
      goal,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');

    const reportPath = join(runFolder, 'reports', 'review-result.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = ReviewResult.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
    const prose = stubProse();
    expect(report).toMatchObject({
      scope: goal,
      findings: [],
      verdict: 'CLEAN',
      outcome: 'complete',
      assessment: prose.assessment,
      verification: prose.verification,
      confidence_limitations: prose.confidence_limitations,
      evidence_summary: { kind: 'goal' },
      evidence_warnings: [],
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

  it('ignores hostile inherited Git environment when collecting direct Review evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'hostile-git-environment');
    const projectRoot = join(runFolderBase, 'hostile-git-environment-project-a');
    const hostileRoot = join(runFolderBase, 'hostile-git-environment-project-b');
    const projectMarker = 'selected-project-a-marker';
    const hostileMarker = 'hostile-project-b-marker';

    for (const [root, marker] of [
      [projectRoot, projectMarker],
      [hostileRoot, hostileMarker],
    ] as const) {
      mkdirSync(root, { recursive: true });
      execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
      writeFileSync(join(root, 'review-target.ts'), `export const marker = '${marker}';\n`);
      execFileSync('git', ['add', 'review-target.ts'], { cwd: root, stdio: 'pipe' });
    }

    const hostileEnvironment = {
      GIT_DIR: join(hostileRoot, '.git'),
      GIT_WORK_TREE: hostileRoot,
      GIT_INDEX_FILE: join(hostileRoot, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: join(hostileRoot, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(hostileRoot, '.git', 'objects'),
      GIT_NAMESPACE: 'hostile-project-b',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: hostileRoot,
    } as const;
    const originalEnvironment = Object.fromEntries(
      Object.keys(hostileEnvironment).map((key) => [key, process.env[key]]),
    );
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    let relayedPrompt = '';

    try {
      Object.assign(process.env, hostileEnvironment);
      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-00000000003a',
        goal: 'review the staged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 23, 9, 0, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayedPrompt = input.prompt;
            return {
              request_payload: input.prompt,
              receipt_id: 'stub-receipt-hostile-git-environment',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      for (const [key, originalValue] of Object.entries(originalEnvironment)) {
        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    }

    expect(outcome?.outcome).toBe('complete');
    expect(relayedPrompt).toContain(projectMarker);
    expect(relayedPrompt).not.toContain(hostileMarker);
    for (const [key, originalValue] of Object.entries(originalEnvironment)) {
      expect(process.env[key]).toBe(originalValue);
    }
  });

  it('does not execute a repository-configured fsmonitor during direct Review Git reads', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'hostile-git-fsmonitor');
    const projectRoot = join(runFolderBase, 'hostile-git-fsmonitor-project');
    const probePath = join(projectRoot, '.git', 'fsmonitor-probe.sh');
    const markerPath = join(projectRoot, 'fsmonitor-ran');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(
      probePath,
      `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\nprintf '\\n'\n`,
    );
    chmodSync(probePath, 0o755);
    writeFileSync(join(projectRoot, 'review-target.ts'), 'export const selected = true;\n');
    execFileSync('git', ['add', 'review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['config', '--local', 'core.fsmonitor', probePath], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000003c',
      goal: 'review the staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 23, 9, 10, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');
    expect(existsSync(markerPath)).toBe(false);
  });

  it.each([
    {
      helper: 'clean',
      scriptBody: (markerPath: string) =>
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\n/bin/cat\n`,
    },
    {
      helper: 'process',
      scriptBody: (markerPath: string) =>
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\nexit 1\n`,
    },
  ])(
    'does not execute a repository-configured filter.$helper helper during direct Review Git reads',
    async ({ helper, scriptBody }) => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, `hostile-git-filter-${helper}`);
      const projectRoot = join(runFolderBase, `hostile-git-filter-${helper}-project`);
      const helperPath = join(projectRoot, '.git', `filter-${helper}-probe.sh`);
      const markerPath = join(projectRoot, `filter-${helper}-ran`);
      mkdirSync(projectRoot, { recursive: true });
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
      writeFileSync(join(projectRoot, '.gitattributes'), '*.txt filter=circuit-probe\n');
      writeFileSync(join(projectRoot, 'review-target.txt'), 'base\n');
      execFileSync('git', ['add', '.gitattributes', 'review-target.txt'], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Circuit',
          '-c',
          'user.email=circuit@example.test',
          'commit',
          '-m',
          'base',
        ],
        { cwd: projectRoot, stdio: 'pipe' },
      );
      writeFileSync(helperPath, scriptBody(markerPath));
      chmodSync(helperPath, 0o755);
      execFileSync('git', ['config', '--local', `filter.circuit-probe.${helper}`, helperPath], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      execFileSync('git', ['config', '--local', 'filter.circuit-probe.required', 'true'], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      writeFileSync(join(projectRoot, 'review-target.txt'), 'changed\n');

      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId:
          helper === 'clean'
            ? '79000000-0000-0000-0000-000000000090'
            : '79000000-0000-0000-0000-000000000091',
        goal: 'review unstaged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 0, 0)),
        projectRoot,
        relayer: relayerWith(cleanRelayResult()),
      });

      expect(existsSync(markerPath)).toBe(false);
    },
  );

  it.each([
    { scope: 'local', configScope: '--local', runSuffix: '97' },
    { scope: 'worktree', configScope: '--worktree', runSuffix: '9a' },
  ])(
    'rejects repository $scope Git config includes before they can add an executable filter',
    async ({ scope, configScope, runSuffix }) => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, `hostile-git-config-include-${scope}`);
      const projectRoot = join(runFolderBase, `hostile-git-config-include-${scope}-project`);
      const includedConfigPath = join(runFolderBase, `hostile-filter-${scope}.gitconfig`);
      const helperPath = join(projectRoot, '.git', 'included-filter-probe.sh');
      const markerPath = join(projectRoot, 'included-filter-ran');
      mkdirSync(projectRoot, { recursive: true });
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
      writeFileSync(join(projectRoot, '.gitattributes'), '*.txt filter=circuit-probe\n');
      writeFileSync(join(projectRoot, 'review-target.txt'), 'base\n');
      execFileSync('git', ['add', '.gitattributes', 'review-target.txt'], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Circuit',
          '-c',
          'user.email=circuit@example.test',
          'commit',
          '-m',
          'base',
        ],
        { cwd: projectRoot, stdio: 'pipe' },
      );
      writeFileSync(
        helperPath,
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\n/bin/cat\n`,
      );
      chmodSync(helperPath, 0o755);
      writeFileSync(
        includedConfigPath,
        `[filter "circuit-probe"]\n\tclean = ${helperPath}\n\trequired = true\n`,
      );
      if (configScope === '--worktree') {
        execFileSync('git', ['config', '--local', 'extensions.worktreeConfig', 'true'], {
          cwd: projectRoot,
          stdio: 'pipe',
        });
      }
      execFileSync('git', ['config', configScope, 'include.path', includedConfigPath], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      writeFileSync(join(projectRoot, 'review-target.txt'), 'changed\n');
      let relayCalls = 0;

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: `79000000-0000-0000-0000-0000000000${runSuffix}`,
        goal: 'review unstaged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 5, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            return {
              request_payload: 'unsafe included filter must not be relayed',
              receipt_id: 'stub-receipt-hostile-git-config-include',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/include/i);
      expect(existsSync(markerPath)).toBe(false);
      expect(relayCalls).toBe(0);
    },
  );

  it('does not let repository core.worktree redirect direct Review evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'hostile-core-worktree');
    const projectRoot = join(runFolderBase, 'hostile-core-worktree-project');
    const hostileRoot = join(runFolderBase, 'hostile-core-worktree-outside');
    const selectedMarker = 'selected-worktree-marker';
    const hostileMarker = 'redirected-worktree-marker';
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(hostileRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'review-target.ts'), 'export const value = "base";\n');
    execFileSync('git', ['add', 'review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(
      join(projectRoot, 'review-target.ts'),
      `export const value = '${selectedMarker}';\n`,
    );
    writeFileSync(
      join(hostileRoot, 'review-target.ts'),
      `export const value = '${hostileMarker}';\n`,
    );
    execFileSync('git', ['config', '--local', 'core.worktree', hostileRoot], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    let relayedPrompt = '';

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000003d',
      goal: 'review the current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 23, 9, 15, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayedPrompt = input.prompt;
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-hostile-core-worktree',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayedPrompt).toContain(selectedMarker);
    expect(relayedPrompt).not.toContain(hostileMarker);
  });

  it('rejects an on-disk Git object alternate before direct Review can inspect another repository', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'hostile-git-object-alternate');
    const projectRoot = join(runFolderBase, 'hostile-git-object-alternate-project');
    const alternateRoot = join(runFolderBase, 'hostile-git-object-alternate-source');
    const alternateMarker = 'alternate-repository-commit-marker';
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(alternateRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['init'], { cwd: alternateRoot, stdio: 'pipe' });
    writeFileSync(
      join(alternateRoot, 'alternate.ts'),
      `export const marker = '${alternateMarker}';\n`,
    );
    execFileSync('git', ['add', 'alternate.ts'], { cwd: alternateRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-m',
        'alternate root',
      ],
      { cwd: alternateRoot, stdio: 'pipe' },
    );
    const alternateCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: alternateRoot,
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(projectRoot, '.git', 'objects', 'info', 'alternates'),
      `${join(alternateRoot, '.git', 'objects')}\n`,
    );
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000092',
      goal: `review commit ${alternateCommit}`,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 9, 5, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: alternateMarker,
            receipt_id: 'stub-receipt-hostile-git-object-alternate',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/alternate|object|repository/i);
    expect(relayCalls).toBe(0);
  });

  it('rejects a symbolic-link Git object directory before direct Review reads evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'hostile-git-object-symlink');
    const projectRoot = join(runFolderBase, 'hostile-git-object-symlink-project');
    const objectPath = join(projectRoot, '.git', 'objects');
    const movedObjectPath = join(projectRoot, '.git', 'objects.real');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'review-target.ts'), 'export const selected = true;\n');
    execFileSync('git', ['add', 'review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    fs.renameSync(objectPath, movedObjectPath);
    fs.symlinkSync(movedObjectPath, objectPath);
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000098',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 9, 7, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'unsafe object directory must not be relayed',
            receipt_id: 'stub-receipt-hostile-git-object-symlink',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/objects|symbolic link/i);
    expect(relayCalls).toBe(0);
  });

  it('rejects a vague goal-only Review before collecting Git evidence or calling the relay', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'goal-only-evidence');
    const projectRoot = join(runFolderBase, 'goal-only-project');
    const unrelatedMarker = 'unrelated-working-tree-marker';
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
      runId: '79000000-0000-0000-0000-000000000036',
      goal: 'review this rollout plan for operational risks',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          throw new Error('vague goal-only Review must not call the relay');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/actual|material|source|target|text/i);
    expect(gitReads).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
    expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(unrelatedMarker);
  });

  it('reviews actual supplied text without collecting or relaying unrelated working-tree code', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'supplied-goal-only-evidence');
    const projectRoot = join(runFolderBase, 'supplied-goal-only-project');
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
      const runFolder = join(runFolderBase, label);
      const projectRoot = join(runFolderBase, `${label}-project`);
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
      unstaged_diff_stat: '',
      remote_repositories: '',
      resolve_target: '',
      target_diff: '',
      target_diff_stat: '',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: 'notes.txt\0',
      submodules: '',
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

    expect(outcome.outcome).toBe('stopped');
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
      'status',
      'staged_diff',
      'unstaged_diff',
      'staged_diff_stat',
      'unstaged_diff_stat',
      'staged_changed_gitlinks',
      'unstaged_changed_gitlinks',
      'untracked_files',
      'hidden_index_flags',
    ]);
  });

  it('aborts before relay when the working tree changes while evidence is collected', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'bounded-git-working-tree-race');
    const projectRoot = join(runFolderBase, 'bounded-git-working-tree-race-project');
    const latePath = join(projectRoot, 'late-secret.txt');
    mkdirSync(projectRoot, { recursive: true });
    const calls = new Map<RuntimeGitOperation, number>();
    const stableOutputs: Readonly<Record<RuntimeGitOperation, string>> = {
      status: 'M  tracked.ts\0',
      staged_diff: 'diff --git a/tracked.ts b/tracked.ts\n+const tracked = true;\n',
      unstaged_diff: '',
      staged_diff_stat: ' tracked.ts | 1 +\n',
      unstaged_diff_stat: '',
      remote_repositories: '',
      resolve_target: '',
      target_diff: '',
      target_diff_stat: '',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: '',
      submodules: '',
    };
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        const count = (calls.get(request.operation) ?? 0) + 1;
        calls.set(request.operation, count);
        let stdout = stableOutputs[request.operation];
        if (request.operation === 'untracked_files') {
          if (count === 1) {
            writeFileSync(latePath, 'created after the first Git listing\n');
          } else {
            stdout = 'late-secret.txt\0';
          }
        } else if (request.operation === 'status' && existsSync(latePath)) {
          stdout = 'M  tracked.ts\0?? late-secret.txt\0';
        }
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
          ...(request.operation === 'resolve_target'
            ? { resolved_target: pinnedTargetFor(request.target) }
            : {}),
        };
      },
    };
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000100',
      goal: 'review my current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 9, 35, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'working-tree race must not relay',
            receipt_id: 'stub-receipt-working-tree-race',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/working tree changed while evidence was collected/i);
    expect(calls.get('status')).toBeGreaterThanOrEqual(2);
    expect(calls.get('untracked_files')).toBeGreaterThanOrEqual(2);
    expect(relayCalls).toBe(0);
  });

  it('uses the real Git worktree when Review starts from a nested directory', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'nested-direct-review');
    const repositoryRoot = join(runFolderBase, 'nested-direct-review-project');
    const projectRoot = join(repositoryRoot, 'packages', 'app');
    const marker = 'nested-review-marker';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: repositoryRoot, stdio: 'pipe' });
    writeFileSync(join(repositoryRoot, 'root.ts'), 'export const root = true;\n');
    writeFileSync(join(projectRoot, 'app.ts'), 'export const app = "base";\n');
    execFileSync('git', ['add', '-A'], { cwd: repositoryRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: repositoryRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'app.ts'), `export const app = '${marker}';\n`);
    let relayedPrompt = '';

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000101',
      goal: 'review my current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 9, 40, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayedPrompt = input.prompt;
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-nested-direct-review',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayedPrompt).toContain(marker);
    expect(relayedPrompt).not.toContain('deleted file mode');
    expect(relayedPrompt).not.toContain('root.ts |');
    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence).toMatchObject({
      kind: 'git-working-tree',
      project_root: fs.realpathSync(repositoryRoot),
    });
  });

  it('preserves an exact global safe.directory for direct Review Git reads', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'safe-directory-direct-review');
    const projectRoot = join(runFolderBase, 'safe-directory-direct-review-project');
    const home = mkdtempSync(join(tmpdir(), 'circuit-review-safe-directory-'));
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'tracked.ts'), 'export const tracked = "base";\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'tracked.ts'), 'export const tracked = "changed";\n');
    writeFileSync(join(home, '.gitconfig'), `[safe]\n\tdirectory = ${projectRoot}\n`);

    const mutableChildProcess = childProcess as unknown as {
      spawnSync: (...args: unknown[]) => unknown;
    };
    const originalSpawnSync = mutableChildProcess.spawnSync;
    const previousHome = process.env.HOME;
    let relayCalls = 0;
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    try {
      process.env.HOME = home;
      mutableChildProcess.spawnSync = (...args: unknown[]): unknown => {
        const options = (args[2] ?? {}) as { readonly env?: NodeJS.ProcessEnv };
        return Reflect.apply(originalSpawnSync, childProcess, [
          args[0],
          args[1],
          {
            ...options,
            env: {
              ...options.env,
              GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
            },
          },
        ]);
      };
      syncBuiltinESMExports();

      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000102',
        goal: 'review unstaged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 45, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            return {
              request_payload: 'safe directory review',
              receipt_id: 'stub-receipt-safe-directory-direct-review',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      mutableChildProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
      if (previousHome === undefined) Reflect.deleteProperty(process.env, 'HOME');
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }

    expect(outcome?.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
  });

  it('does not restore a global safe.directory that a later empty value revoked', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'revoked-safe-directory-direct-review');
    const projectRoot = join(runFolderBase, 'revoked-safe-directory-direct-review-project');
    const home = mkdtempSync(join(tmpdir(), 'circuit-review-revoked-safe-directory-'));
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'tracked.ts'), 'export const tracked = "base";\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'tracked.ts'), 'export const tracked = "changed";\n');
    writeFileSync(
      join(home, '.gitconfig'),
      `[safe]\n\tdirectory = ${projectRoot}\n\tdirectory =\n`,
    );

    const mutableChildProcess = childProcess as unknown as {
      spawnSync: (...args: unknown[]) => unknown;
    };
    const originalSpawnSync = mutableChildProcess.spawnSync;
    const previousHome = process.env.HOME;
    let relayCalls = 0;
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    try {
      process.env.HOME = home;
      mutableChildProcess.spawnSync = (...args: unknown[]): unknown => {
        const options = (args[2] ?? {}) as { readonly env?: NodeJS.ProcessEnv };
        return Reflect.apply(originalSpawnSync, childProcess, [
          args[0],
          args[1],
          {
            ...options,
            env: {
              ...options.env,
              GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
            },
          },
        ]);
      };
      syncBuiltinESMExports();

      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000103',
        goal: 'review unstaged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 50, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            return {
              request_payload: 'revoked safe directory must not be reviewed',
              receipt_id: 'stub-receipt-revoked-safe-directory-direct-review',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      mutableChildProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
      if (previousHome === undefined) Reflect.deleteProperty(process.env, 'HOME');
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }

    expect(outcome?.outcome).toBe('aborted');
    expect(outcome?.reason).toMatch(/dubious ownership|safe\.directory/i);
    expect(relayCalls).toBe(0);
  });

  it('reports changed submodule gitlinks as incomplete rather than clean', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'bounded-git-submodule-caveat');
    const projectRoot = join(runFolderBase, 'bounded-git-submodule-caveat-project');
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
      remote_repositories: '',
      resolve_target: '',
      target_diff: '',
      target_diff_stat: '',
      hidden_index_flags: '',
      staged_changed_gitlinks: `:160000 160000 ${TEST_COMMIT_A} ${TEST_COMMIT_B} M\0modules/child\0`,
      unstaged_changed_gitlinks: '',
      untracked_files: '',
      submodules: `160000 ${TEST_COMMIT_A} 0\tmodules/child\0`,
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
      const runFolder = join(runFolderBase, `bounded-git-clean-submodule-${mode}`);
      const projectRoot = join(runFolderBase, `bounded-git-clean-submodule-${mode}-project`);
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

  it('reports a dirty nested submodule worktree as incomplete unstaged evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'bounded-git-dirty-submodule');
    const projectRoot = join(runFolderBase, 'bounded-git-dirty-submodule-project');
    mkdirSync(projectRoot, { recursive: true });
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        const operation = request.operation as string;
        const stdout =
          operation === 'unstaged_diff'
            ? [
                'diff --git a/modules/child b/modules/child',
                `index ${TEST_COMMIT_A}..${TEST_COMMIT_A} 160000`,
                '--- a/modules/child',
                '+++ b/modules/child',
                '@@ -1 +1 @@',
                `-Subproject commit ${TEST_COMMIT_A}`,
                `+Subproject commit ${TEST_COMMIT_A}-dirty`,
                '',
              ].join('\n')
            : operation === 'unstaged_diff_stat'
              ? ' modules/child | 0\n'
              : operation === 'unstaged_changed_gitlinks'
                ? `:160000 160000 ${TEST_COMMIT_A} ${TEST_COMMIT_A} M\0modules/child\0`
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
      runId: '79000000-0000-0000-0000-000000000115',
      goal: 'review unstaged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 32, 0)),
      projectRoot,
      gitReader,
      relayer: relayerWith(cleanRelayResult()),
    });

    const intake = ReviewIntake.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
    );
    expect(intake.evidence).toMatchObject({
      kind: 'git-working-tree',
      unstaged_diff: { text: expect.stringMatching(/160000|Subproject commit/u) },
    });
    expect(intake.evidence_warnings).toContainEqual({
      kind: 'submodule_content_not_inspected',
      path: 'modules/child',
      message: 'nested submodule source content was not inspected',
    });
    expect(outcome.outcome).toBe('stopped');
  });

  it('detects a dirty nested submodule worktree through direct Git evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'direct-dirty-submodule');
    const childSource = join(runFolderBase, 'direct-dirty-submodule-source');
    const projectRoot = join(runFolderBase, 'direct-dirty-submodule-project');
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

  it('uses the injected bounded Git reader for latest-commit Review evidence', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'bounded-git-latest-commit');
    const projectRoot = join(runFolderBase, 'bounded-git-latest-project');
    const marker = 'bounded-latest-commit-marker';
    mkdirSync(projectRoot, { recursive: true });
    const seen: RuntimeGitOperation[] = [];
    const outputs: Readonly<Record<RuntimeGitOperation, string>> = {
      status: '',
      staged_diff: '',
      unstaged_diff: '',
      staged_diff_stat: '',
      unstaged_diff_stat: '',
      remote_repositories: '',
      resolve_target: '',
      target_diff: `diff --git a/src/app.ts b/src/app.ts\n+${marker}\n`,
      target_diff_stat: ' src/app.ts | 1 +\n',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: '',
      submodules: '',
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
    const runFolder = join(runFolderBase, 'explicit-commit-target');
    const projectRoot = join(runFolderBase, 'explicit-commit-project');
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
          expect(input.prompt).toContain(`"target_ref": "${commit}"`);
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
    const runFolder = join(runFolderBase, 'root-commit-target');
    const projectRoot = join(runFolderBase, 'root-commit-project');
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

  it('stops before relay when a shallow clone is missing the requested commit parent', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'shallow-commit-target');
    const sourceRoot = join(runFolderBase, 'shallow-source-project');
    const projectRoot = join(runFolderBase, 'shallow-clone-project');
    mkdirSync(sourceRoot, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: sourceRoot, stdio: 'pipe' });
    writeFileSync(join(sourceRoot, 'base.ts'), 'export const base = true;\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: sourceRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: sourceRoot, stdio: 'pipe' },
    );
    writeFileSync(join(sourceRoot, 'child.ts'), 'export const child = true;\n');
    execFileSync('git', ['add', 'child.ts'], { cwd: sourceRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'child'],
      { cwd: sourceRoot, stdio: 'pipe' },
    );
    execFileSync('git', ['clone', '--depth=1', `file://${sourceRoot}`, projectRoot], {
      cwd: runFolderBase,
      stdio: 'pipe',
    });
    expect(
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim(),
    ).toBe('true');
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000039',
      goal: 'review the latest commit',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'unexpected shallow diff',
            receipt_id: 'stub-receipt-shallow-commit',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/parent|shallow|unavailable/i);
    expect(relayCalls).toBe(0);
  });

  it('ignores replacement refs when reviewing a pinned commit', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'replacement-ref-target');
    const projectRoot = join(runFolderBase, 'replacement-ref-project');
    const originalMarker = 'original-commit-marker';
    const replacementMarker = 'replacement-commit-marker';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'original.ts'), `export const value = '${originalMarker}';\n`);
    execFileSync('git', ['add', 'original.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'root'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    const originalCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    const replacementIndex = join(projectRoot, '.replacement-index');
    writeFileSync(
      join(projectRoot, 'replacement.ts'),
      `export const value = '${replacementMarker}';\n`,
    );
    const replacementEnvironment = {
      ...process.env,
      GIT_INDEX_FILE: replacementIndex,
    };
    execFileSync('git', ['add', 'replacement.ts'], {
      cwd: projectRoot,
      env: replacementEnvironment,
      stdio: 'pipe',
    });
    const replacementTree = execFileSync('git', ['write-tree'], {
      cwd: projectRoot,
      env: replacementEnvironment,
      encoding: 'utf8',
    }).trim();
    const replacementCommit = execFileSync('git', ['commit-tree', replacementTree], {
      cwd: projectRoot,
      env: replacementEnvironment,
      input: 'replacement\n',
      encoding: 'utf8',
    }).trim();
    rmSync(replacementIndex, { force: true });
    rmSync(join(projectRoot, 'replacement.ts'), { force: true });
    execFileSync('git', ['replace', originalCommit, replacementCommit], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    let relayedPrompt = '';

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000003a',
      goal: `review commit ${originalCommit}`,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          relayedPrompt = input.prompt;
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-replacement-ref',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayedPrompt).toContain(originalMarker);
    expect(relayedPrompt).not.toContain(replacementMarker);
  });

  it('stops before relay when legacy graft metadata can rewrite commit ancestry', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'grafted-commit-target');
    const projectRoot = join(runFolderBase, 'grafted-commit-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'base.ts'), 'export const base = true;\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'child.ts'), 'export const child = true;\n');
    execFileSync('git', ['add', 'child.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'child'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    const childCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    mkdirSync(join(projectRoot, '.git', 'info'), { recursive: true });
    writeFileSync(join(projectRoot, '.git', 'info', 'grafts'), `${childCommit}\n`);
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000003b',
      goal: 'review the latest commit',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'unexpected grafted diff',
            receipt_id: 'stub-receipt-grafted-commit',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/graft/i);
    expect(relayCalls).toBe(0);
  });

  it('relays only the requested commit when unrelated working-tree changes exist', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'exclusive-commit-target');
    const projectRoot = join(runFolderBase, 'exclusive-commit-project');
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
      remote_repositories: '',
      resolve_target: '',
      target_diff: `diff --git a/requested.ts b/requested.ts\n+${requestedMarker}\n`,
      target_diff_stat: ' requested.ts | 1 +\n',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: 'unrelated-note.txt\0',
      submodules: '',
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
    const runFolder = join(runFolderBase, 'staged-only-target');
    const projectRoot = join(runFolderBase, 'staged-only-project');
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
      remote_repositories: '',
      resolve_target: '',
      target_diff: '',
      target_diff_stat: '',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: '',
      submodules: '',
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
    expect(seen).toEqual([
      'hidden_index_flags',
      'staged_diff',
      'staged_diff_stat',
      'staged_changed_gitlinks',
      'staged_diff',
      'staged_diff_stat',
      'staged_changed_gitlinks',
      'hidden_index_flags',
    ]);
  });

  it('stops before relay when cleanup for the selected staged evidence is uncertain', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'staged-cleanup-uncertain');
    const projectRoot = join(runFolderBase, 'staged-cleanup-uncertain-project');
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
      const runFolder = join(runFolderBase, `truncated-${truncatedOperation}`);
      const projectRoot = join(runFolderBase, `truncated-${truncatedOperation}-project`);
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

  it('stops before relay when immutable target resolution is truncated', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'truncated-target-resolution');
    const projectRoot = join(runFolderBase, 'truncated-target-resolution-project');
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
      const runFolder = join(runFolderBase, `untracked-enumeration-${name.replaceAll(' ', '-')}`);
      const projectRoot = join(runFolderBase, `untracked-enumeration-${name}-project`);
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
      runFolderBase,
      `preserved-target-${goal.replaceAll(/[^A-Za-z0-9]/gu, '-')}`,
    );
    const projectRoot = join(runFolderBase, 'preserved-target-project');
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
    const runFolder = join(runFolderBase, 'current-changes-against-head');
    const projectRoot = join(runFolderBase, 'current-changes-against-head-project');
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
      'status',
      'staged_diff',
      'unstaged_diff',
      'staged_diff_stat',
      'unstaged_diff_stat',
      'staged_changed_gitlinks',
      'unstaged_changed_gitlinks',
      'untracked_files',
      'hidden_index_flags',
    ]);
  });

  it('passes an explicit range target through the bounded Git reader', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'bounded-git-range-target');
    const projectRoot = join(runFolderBase, 'bounded-git-range-project');
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
      remote_repositories: '',
      resolve_target: '',
      target_diff: `diff --git a/src/app.ts b/src/app.ts\n+${marker}\n`,
      target_diff_stat: ' src/app.ts | 1 +\n',
      hidden_index_flags: '',
      staged_changed_gitlinks: '',
      unstaged_changed_gitlinks: '',
      untracked_files: '',
      submodules: '',
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

  it('stops before relay when an explicit PR target is unavailable', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'unavailable-pr-target');
    const projectRoot = join(runFolderBase, 'unavailable-pr-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000028',
      goal: 'review PR #123',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('reviewer must not run without the requested PR evidence');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/PR #123/i);
    expect(outcome.reason).toMatch(/not available|unavailable/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-result.json'))).toBe(false);
    const traceEntries = await readTraceEntries(runFolder);
    expect(traceEntries.some((entry) => entry.kind === 'relay.started')).toBe(false);
  });

  it('reviews a locally proven PR snapshot independently of the checked-out branch', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'local-pr-snapshot');
    const projectRoot = join(runFolderBase, 'local-pr-snapshot-project');
    const marker = 'local-pr-feature-marker';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync(
      'git',
      [
        'config',
        '--add',
        'remote.origin.fetch',
        '+refs/pull/*/merge:refs/circuit/github.com/acme/widget/pull/*/merge',
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
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
    const featureCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
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
    const mergeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    execFileSync(
      'git',
      ['update-ref', 'refs/circuit/github.com/acme/widget/pull/123/merge', mergeCommit],
      {
        cwd: projectRoot,
        stdio: 'pipe',
      },
    );
    execFileSync('git', ['update-ref', 'refs/pull/123/head', featureCommit], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync('git', ['switch', 'feature'], { cwd: projectRoot, stdio: 'pipe' });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000002f',
      goal: 'review https://github.com/acme/widget/pull/123/files?diff=split',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain(marker);
          expect(input.prompt).toContain('"target_kind": "pull_request"');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-local-pr-snapshot',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
  });

  it('rejects a bare PR number when a worktree-only remote makes its repository ambiguous', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'worktree-remote-ambiguous-pr');
    const projectRoot = join(runFolderBase, 'worktree-remote-ambiguous-pr-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync(
      'git',
      [
        'config',
        '--add',
        'remote.origin.fetch',
        '+refs/pull/*/merge:refs/circuit/github.com/acme/widget/pull/*/merge',
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'base.ts'), 'export const base = true;\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    execFileSync('git', ['switch', '-c', 'feature'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'feature.ts'), 'export const feature = true;\n');
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
    const mergeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    execFileSync(
      'git',
      ['update-ref', 'refs/circuit/github.com/acme/widget/pull/123/merge', mergeCommit],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    execFileSync('git', ['config', '--local', 'extensions.worktreeConfig', 'true'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync(
      'git',
      ['config', '--worktree', 'remote.other.url', 'https://github.com/other/project.git'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000104',
      goal: 'review PR #123',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 9, 55, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'ambiguous PR repository must not be reviewed',
            receipt_id: 'stub-receipt-worktree-remote-ambiguous-pr',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/repository|multiple|ambiguous/i);
    expect(relayCalls).toBe(0);
  });

  it('rejects a PR URL for a different repository before relay', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'foreign-pr-url');
    const projectRoot = join(runFolderBase, 'foreign-pr-url-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widget.git'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    writeFileSync(join(projectRoot, 'target.ts'), 'export const target = true;\n');
    execFileSync('git', ['add', 'target.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000030',
      goal: 'review https://github.com/other/project/pull/123',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('foreign PR URL must fail before relay');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/other\/project|repository/i);
    expect(relayCalls).toBe(0);
  });

  it('rejects a local PR ref whose repository provenance no longer matches the remote', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'stale-local-pr-provenance');
    const projectRoot = join(runFolderBase, 'stale-local-pr-provenance-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    writeFileSync(join(projectRoot, 'base.ts'), 'export const base = true;\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    execFileSync('git', ['switch', '-c', 'feature'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(
      join(projectRoot, 'feature.ts'),
      "export const sourceRepository = 'acme/widget';\n",
    );
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
    const mergeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-ref', 'refs/pull/123/merge', mergeCommit], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    // The local PR ref above was created while origin identified acme/widget.
    // Reusing it after origin changes to other/project must not make that old
    // snapshot count as proof of other/project#123.
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/other/project.git'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000003b',
      goal: 'review https://github.com/other/project/pull/123',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 23, 9, 5, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'stale local PR ref must not be relayed',
            receipt_id: 'stub-receipt-stale-local-pr-provenance',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/provenance|repository|local PR ref/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-result.json'))).toBe(false);
  });

  it.each([
    {
      label: 'URL',
      goal: 'review https://github.com/acme/widget/pull/123',
    },
    {
      label: 'bare number',
      goal: 'review PR #123',
    },
  ])(
    'rejects a $label PR target when no local GitHub repository identity can prove it',
    async ({ label, goal }) => {
      const { bytes } = loadFixture();
      const suffix = label.replaceAll(' ', '-').toLowerCase();
      const runFolder = join(runFolderBase, `unproven-pr-repository-${suffix}`);
      const projectRoot = join(runFolderBase, `unproven-pr-repository-${suffix}-project`);
      mkdirSync(projectRoot, { recursive: true });
      let relayCalls = 0;
      const seen: RuntimeGitOperation[] = [];
      const gitReader: RuntimeGitReader = {
        read: async (request) => {
          seen.push(request.operation);
          return {
            schema_version: 1,
            ok: true,
            operation: request.operation,
            stdout:
              request.operation === 'target_diff'
                ? 'diff --git a/pr.ts b/pr.ts\n+unproven-pr-marker\n'
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
        runId: `79000000-0000-0000-0000-00000000003${label === 'URL' ? '7' : '8'}`,
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
              request_payload: goal,
              receipt_id: 'stub-receipt-unproven-pr',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/local GitHub repository|GitHub remote|repository identity/i);
      expect(relayCalls).toBe(0);
      expect(seen).toEqual(['remote_repositories']);
    },
  );

  it('uses the repository named by an exact PR URL when the workspace has origin and upstream', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'exact-pr-repository');
    const projectRoot = join(runFolderBase, 'exact-pr-repository-project');
    mkdirSync(projectRoot, { recursive: true });
    const seen: Array<{ readonly operation: RuntimeGitOperation; readonly target?: unknown }> = [];
    const marker = 'exact-pr-repository-marker';
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        seen.push({
          operation: request.operation,
          ...('target' in request ? { target: request.target } : {}),
        });
        return {
          schema_version: 1,
          ok: true,
          operation: request.operation,
          stdout:
            request.operation === 'remote_repositories'
              ? 'github.com/acme/widget\ngithub.com/acme/widget-fork\n'
              : request.operation === 'target_diff'
                ? `diff --git a/pr.ts b/pr.ts\n+${marker}\n`
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
      runId: '79000000-0000-0000-0000-000000000039',
      goal: 'review https://github.com/acme/widget/pull/123',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain(marker);
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-exact-pr-repository',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(seen).toContainEqual({
      operation: 'resolve_target',
      target: {
        kind: 'pull_request',
        number: 123,
        repository: 'github.com/acme/widget',
      },
    });
  });

  it('binds a bare PR to the one proven local repository and rejects a different resolved repository', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'bare-pr-repository-binding');
    const projectRoot = join(runFolderBase, 'bare-pr-repository-binding-project');
    mkdirSync(projectRoot, { recursive: true });
    const seen: Array<{ readonly operation: RuntimeGitOperation; readonly target?: unknown }> = [];
    let relayCalls = 0;
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        seen.push({
          operation: request.operation,
          ...('target' in request ? { target: request.target } : {}),
        });
        return {
          schema_version: 1,
          ok: true,
          operation: request.operation,
          stdout:
            request.operation === 'remote_repositories'
              ? 'github.com/acme/repository-a\n'
              : request.operation === 'target_diff'
                ? 'diff --git a/pr.ts b/pr.ts\n+wrong-repository-marker\n'
                : '',
          stderr: '',
          exit_code: 0,
          truncated: false,
          limit_bytes: 2 * 1024 * 1024,
          cleanup_confirmed: true,
          ...(request.operation === 'resolve_target'
            ? {
                resolved_target: {
                  kind: 'pull_request' as const,
                  number: 123,
                  repository: 'github.com/acme/repository-b',
                  merge_commit: TEST_COMMIT_A,
                  base_commit: TEST_COMMIT_B,
                  head_commit: TEST_COMMIT_C,
                },
              }
            : {}),
        };
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000093',
      goal: 'review PR #123',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 9, 10, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'wrong repository target must not be relayed',
            receipt_id: 'stub-receipt-bare-pr-repository-binding',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/different target|repository/i);
    expect(seen).toEqual([
      { operation: 'remote_repositories' },
      {
        operation: 'resolve_target',
        target: {
          kind: 'pull_request',
          number: 123,
          repository: 'github.com/acme/repository-a',
        },
      },
    ]);
    expect(relayCalls).toBe(0);
  });

  it('rejects an ambiguous bare PR snapshot when the workspace has multiple GitHub repositories', async () => {
    const label = 'bare number';
    const goal = 'review PR #123';
    const { bytes } = loadFixture();
    const suffix = label.replaceAll(' ', '-').toLowerCase();
    const runFolder = join(runFolderBase, `ambiguous-pr-repository-${suffix}`);
    const projectRoot = join(runFolderBase, `ambiguous-pr-repository-${suffix}-project`);
    mkdirSync(projectRoot, { recursive: true });
    let relayCalls = 0;
    const seen: RuntimeGitOperation[] = [];
    const gitReader: RuntimeGitReader = {
      read: async ({ operation }) => {
        seen.push(operation);
        return {
          schema_version: 1,
          ok: true,
          operation,
          stdout:
            operation === 'remote_repositories'
              ? 'github.com/acme/widget\ngithub.com/acme/widget-fork\n'
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
      runId: '79000000-0000-0000-0000-000000000032',
      goal,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('ambiguous PR snapshot must fail before relay');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/ambiguous|multiple|repository/i);
    expect(relayCalls).toBe(0);
    expect(seen).toEqual(['remote_repositories']);
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
    const runFolder = join(runFolderBase, 'unicode-safe-diff-truncation');
    const projectRoot = join(runFolderBase, 'unicode-safe-diff-truncation-project');
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

  it('omits untracked file contents by default and does not report the full target clean', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'untracked-metadata-only');
    const projectRoot = join(runFolderBase, 'metadata-only-project');
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

    expect(outcome.outcome).toBe('stopped');
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

  it('fails closed when an untracked file becomes a symlink immediately before open', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'untracked-final-symlink-swap');
    const projectRoot = join(runFolderBase, 'untracked-final-symlink-swap-project');
    const scratchPath = join(projectRoot, 'scratch.txt');
    const movedScratchPath = join(projectRoot, 'scratch.original.txt');
    const outsidePath = join(runFolderBase, 'outside-untracked-secret.txt');
    const outsideSecret = 'outside-secret-must-not-be-relayed';
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(scratchPath, `${'x'.repeat(outsideSecret.length)}\n`);
    writeFileSync(outsidePath, `${outsideSecret}\n`);
    const canonicalScratchPath = fs.realpathSync(scratchPath);

    const mutableFs = fs as unknown as { openSync: (...args: unknown[]) => number };
    const originalOpenSync = mutableFs.openSync;
    let swapped = false;
    let relayedPrompt = '';
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    try {
      mutableFs.openSync = (...args: unknown[]): number => {
        if (!swapped && args[0] === canonicalScratchPath) {
          swapped = true;
          fs.renameSync(scratchPath, movedScratchPath);
          fs.symlinkSync(outsidePath, scratchPath);
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      };
      syncBuiltinESMExports();

      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000094',
        goal: 'review my current changes, including untracked files',
        depth: 'medium',
        evidencePolicy: { includeUntrackedFileContent: true },
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 15, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayedPrompt = input.prompt;
            return {
              request_payload: input.prompt,
              receipt_id: 'stub-receipt-untracked-final-symlink-swap',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      mutableFs.openSync = originalOpenSync;
      syncBuiltinESMExports();
    }

    expect(swapped).toBe(true);
    expect(relayedPrompt).not.toContain(outsideSecret);
    expect(outcome?.outcome).not.toBe('complete');
    const reportPath = join(runFolder, 'reports', 'review-result.json');
    if (existsSync(reportPath)) {
      const report = ReviewResult.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
      expect(report).toMatchObject({
        verdict: 'ISSUES_FOUND',
        outcome: 'stopped',
        findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
      });
    }
  });

  it('fails closed when an untracked file parent becomes an outside symlink before open', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'untracked-parent-symlink-swap');
    const projectRoot = join(runFolderBase, 'untracked-parent-symlink-swap-project');
    const nestedRoot = join(projectRoot, 'nested');
    const movedNestedRoot = join(projectRoot, 'nested.original');
    const scratchPath = join(nestedRoot, 'scratch.txt');
    const outsideRoot = join(runFolderBase, 'outside-untracked-parent');
    const outsidePath = join(outsideRoot, 'scratch.txt');
    const outsideSecret = 'outside-parent-secret-must-not-be-relayed';
    mkdirSync(nestedRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(scratchPath, 'safe content before parent swap\n');
    writeFileSync(outsidePath, `${outsideSecret}\n`);
    const canonicalScratchPath = fs.realpathSync(scratchPath);

    const mutableFs = fs as unknown as { openSync: (...args: unknown[]) => number };
    const originalOpenSync = mutableFs.openSync;
    let swapped = false;
    let relayedPrompt = '';
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    try {
      mutableFs.openSync = (...args: unknown[]): number => {
        if (!swapped && args[0] === canonicalScratchPath) {
          swapped = true;
          fs.renameSync(nestedRoot, movedNestedRoot);
          fs.symlinkSync(outsideRoot, nestedRoot);
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      };
      syncBuiltinESMExports();

      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000096',
        goal: 'review my current changes, including untracked files',
        depth: 'medium',
        evidencePolicy: { includeUntrackedFileContent: true },
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 17, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayedPrompt = input.prompt;
            return {
              request_payload: input.prompt,
              receipt_id: 'stub-receipt-untracked-parent-symlink-swap',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      mutableFs.openSync = originalOpenSync;
      syncBuiltinESMExports();
    }

    expect(swapped).toBe(true);
    expect(relayedPrompt).not.toContain(outsideSecret);
    expect(outcome?.outcome).not.toBe('complete');
  });

  it('fails closed when an untracked file grows after inspection but before open', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'untracked-final-growth-swap');
    const projectRoot = join(runFolderBase, 'untracked-final-growth-swap-project');
    const scratchPath = join(projectRoot, 'scratch.txt');
    const initialContent = 'short\n';
    const omittedMarker = 'changed-after-inspection-marker';
    const replacementContent = `${initialContent}${'x'.repeat(25_000)}${omittedMarker}\n`;
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(scratchPath, initialContent);
    const canonicalScratchPath = fs.realpathSync(scratchPath);

    const mutableFs = fs as unknown as { openSync: (...args: unknown[]) => number };
    const originalOpenSync = mutableFs.openSync;
    let swapped = false;
    let relayedPrompt = '';
    let outcome: Awaited<ReturnType<typeof runCompiledFlow>> | undefined;
    try {
      mutableFs.openSync = (...args: unknown[]): number => {
        if (!swapped && args[0] === canonicalScratchPath) {
          swapped = true;
          fs.writeFileSync(scratchPath, replacementContent);
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      };
      syncBuiltinESMExports();

      outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '79000000-0000-0000-0000-000000000095',
        goal: 'review my current changes, including untracked files',
        depth: 'medium',
        evidencePolicy: { includeUntrackedFileContent: true },
        now: deterministicNow(Date.UTC(2026, 6, 24, 9, 20, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
            relayedPrompt = input.prompt;
            return {
              request_payload: input.prompt,
              receipt_id: 'stub-receipt-untracked-final-growth-swap',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });
    } finally {
      mutableFs.openSync = originalOpenSync;
      syncBuiltinESMExports();
    }

    expect(swapped).toBe(true);
    expect(relayedPrompt).not.toContain(omittedMarker);
    expect(outcome?.outcome).not.toBe('complete');
    const reportPath = join(runFolder, 'reports', 'review-result.json');
    if (existsSync(reportPath)) {
      const report = ReviewResult.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
      expect(report).toMatchObject({
        verdict: 'ISSUES_FOUND',
        outcome: 'stopped',
        findings: [expect.objectContaining({ id: 'circuit-review-evidence-incomplete' })],
      });
    }
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
    const runFolder = join(runFolderBase, 'bounded-git-partial-target');
    const projectRoot = join(runFolderBase, 'bounded-git-partial-target-project');
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

  it('does not report a direct working-tree Review as clean when Git hides a binary change', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'direct-opaque-binary-change');
    const projectRoot = join(runFolderBase, 'direct-opaque-binary-project');
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
    const runFolder = join(runFolderBase, 'colored-opaque-submodule-change');
    const projectRoot = join(runFolderBase, 'colored-opaque-submodule-project');
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

  it('does not report an injected Git Review as clean when Git hides a binary change', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'injected-opaque-binary-change');
    const projectRoot = join(runFolderBase, 'injected-opaque-binary-project');
    mkdirSync(projectRoot, { recursive: true });
    const gitReader: RuntimeGitReader = {
      read: async (request) => ({
        schema_version: 1,
        ok: true,
        operation: request.operation,
        stdout:
          request.operation === 'staged_diff'
            ? [
                'diff --git a/opaque.bin b/opaque.bin',
                'index 1f2e3d4..5a6b7c8 100644',
                'Binary files a/opaque.bin and b/opaque.bin differ',
                '',
              ].join('\n')
            : request.operation === 'staged_diff_stat'
              ? ' opaque.bin | Bin 12 -> 24 bytes\n'
              : '',
        stderr: '',
        exit_code: 0,
        truncated: false,
        limit_bytes: 2 * 1024 * 1024,
        cleanup_confirmed: true,
      }),
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000041',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 20, 14, 0, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('Binary files a/opaque.bin and b/opaque.bin differ');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-injected-opaque-binary',
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

  it('skips unreadable untracked files instead of aborting review intake', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'unreadable-untracked-evidence');
    const projectRoot = join(runFolderBase, 'unreadable-project');
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
    const runFolder = join(runFolderBase, 'unavailable-evidence-warning');
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
    const runFolder = join(runFolderBase, 'scope-empty-warning');
    const projectRoot = join(runFolderBase, 'scope-empty-project');
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

  it('includes the latest committed diff when noun-form Review wording names it', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'latest-commit-evidence');
    const projectRoot = join(runFolderBase, 'latest-commit-project');
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
    const runFolder = join(runFolderBase, 'merge-commit-evidence');
    const projectRoot = join(runFolderBase, 'merge-commit-project');
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
    const runFolder = join(runFolderBase, 'blob-commit-target');
    const projectRoot = join(runFolderBase, 'blob-commit-project');
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
    const runFolder = join(runFolderBase, 'empty-untracked-content');
    const projectRoot = join(runFolderBase, 'empty-untracked-content-project');
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

  it('rejects an untracked-file exclusion before collecting or relaying that file', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'excluded-untracked-file');
    const projectRoot = join(runFolderBase, 'excluded-untracked-file-project');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    writeFileSync(join(projectRoot, 'tracked.txt'), 'changed\n');
    writeFileSync(join(projectRoot, 'secret-untracked.txt'), 'excluded-untracked-marker\n');

    let relayCalls = 0;
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-00000000010b',
      goal: 'review current changes except untracked files',
      depth: 'medium',
      evidencePolicy: { includeUntrackedFileContent: true },
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('excluded untracked evidence must never reach relay');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/untracked|exclusion|target/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
    const trace = readFileSync(join(runFolder, 'trace.ndjson'), 'utf8');
    expect(trace).not.toContain('secret-untracked.txt');
    expect(trace).not.toContain('excluded-untracked-marker');
  });

  it('stops before relay when only metadata for untracked files would be available', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'scope-empty-still-fires-metadata-only');
    const projectRoot = join(runFolderBase, 'scope-empty-metadata-only-project');
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
    const goal =
      'Review this supplied text: the analyze result should use the renamed live-flow path.';
    const projectRoot = stagedReviewProject('renamed-analyze-result-project');
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
      projectRoot,
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
    const projectRoot = stagedReviewProject('bad-review-relay-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000004',
      goal: 'review staged changes with a malformed admitted relay body',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
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
      const goal = `review staged changes for ${name}`;
      const projectRoot = stagedReviewProject(`${name.replaceAll(' ', '-')}-project`);

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId,
        goal,
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
        projectRoot,
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
    const projectRoot = stagedReviewProject('issues-found-project');
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
      projectRoot,
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
    const projectRoot = stagedReviewProject('clean-binds-complete-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-0000000000f2',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');

    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.verdict).toBe('CLEAN');
    expect(report.outcome).toBe('complete');
  });

  it.each(['--assume-unchanged', '--skip-worktree'] as const)(
    'stops direct working-tree Review when a tracked path uses %s',
    async (flag) => {
      const { bytes } = loadFixture();
      const label = flag.slice(2);
      const runFolder = join(runFolderBase, `direct-hidden-index-${label}`);
      const projectRoot = join(runFolderBase, `direct-hidden-index-${label}-project`);
      mkdirSync(projectRoot, { recursive: true });
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
      writeFileSync(join(projectRoot, 'hidden.ts'), 'export const value = 1;\n');
      execFileSync('git', ['add', 'hidden.ts'], { cwd: projectRoot, stdio: 'pipe' });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Circuit',
          '-c',
          'user.email=circuit@example.test',
          'commit',
          '-m',
          'base',
        ],
        { cwd: projectRoot, stdio: 'pipe' },
      );
      execFileSync('git', ['update-index', flag, 'hidden.ts'], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      writeFileSync(join(projectRoot, 'hidden.ts'), 'export const value = 2;\n');
      let relayCalls = 0;

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId:
          flag === '--assume-unchanged'
            ? '79000000-0000-0000-0000-00000000010b'
            : '79000000-0000-0000-0000-00000000010c',
        goal: 'review unstaged changes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 10, 35, 0)),
        projectRoot,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            return {
              request_payload: 'hidden index state must not reach the reviewer',
              receipt_id: 'stub-receipt-hidden-index-direct',
              result_body: JSON.stringify(cleanRelayResult()),
              duration_ms: 1,
              cli_version: '0.0.0-stub',
            };
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/assume-unchanged|skip-worktree|hidden index/i);
      expect(relayCalls).toBe(0);
    },
  );

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
    const runFolder = join(runFolderBase, `injected-hidden-index-${name.replaceAll(' ', '-')}`);
    const projectRoot = join(
      runFolderBase,
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
    const runFolder = join(runFolderBase, 'direct-invalid-utf8-tracked');
    const projectRoot = join(runFolderBase, 'direct-invalid-utf8-tracked-project');
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

  it('stops injected Review instead of relaying replacement characters from a tracked diff', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'injected-invalid-utf8-tracked');
    const projectRoot = join(runFolderBase, 'injected-invalid-utf8-tracked-project');
    mkdirSync(projectRoot, { recursive: true });
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        const operation = request.operation as string;
        return {
          schema_version: 1,
          ok: true,
          operation: request.operation,
          stdout:
            operation === 'staged_diff'
              ? 'diff --git a/invalid.txt b/invalid.txt\n+\uFFFD\n'
              : operation === 'staged_diff_stat'
                ? ' invalid.txt | 1 +\n'
                : operation === 'status'
                  ? 'M  invalid.txt\0'
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
      runId: '79000000-0000-0000-0000-00000000010f',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 50, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'replacement characters must not reach the reviewer',
            receipt_id: 'stub-receipt-invalid-utf8-injected',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/UTF-8|encoding|replacement/i);
    expect(relayCalls).toBe(0);
  });

  it('never relays auxiliary Git configuration output as a truncated staged diff', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'auxiliary-config-output');
    const projectRoot = join(runFolderBase, 'auxiliary-config-output-project');
    const secretMarker = 'AUXILIARY_GIT_CONFIG_MUST_NOT_REACH_REVIEW';
    mkdirSync(projectRoot, { recursive: true });
    const gitReader: RuntimeGitReader = {
      read: async (request) => ({
        schema_version: 1,
        ok: request.operation !== 'staged_diff',
        operation: request.operation,
        stdout:
          request.operation === 'staged_diff'
            ? `credential.helper\n${secretMarker}\n`
            : request.operation === 'staged_diff_stat'
              ? ' source.ts | 1 +\n'
              : '',
        stderr: request.operation === 'staged_diff' ? 'Git configuration output was limited.' : '',
        exit_code: request.operation === 'staged_diff' ? null : 0,
        truncated: request.operation === 'staged_diff',
        limit_bytes: 2 * 1024 * 1024,
        cleanup_confirmed: true,
      }),
    };
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000115',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 15, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'auxiliary config must not be relayed',
            receipt_id: 'stub-receipt-auxiliary-config-output',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/configuration|staged changes could not be read|failed/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
    expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(secretMarker);
  });

  it('rejects a working-tree snapshot when its selected diff stat changes', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'changed-diff-stat');
    const projectRoot = join(runFolderBase, 'changed-diff-stat-project');
    mkdirSync(projectRoot, { recursive: true });
    let statReads = 0;
    const gitReader: RuntimeGitReader = {
      read: async (request) => {
        const operation = request.operation as string;
        const stdout =
          operation === 'staged_diff'
            ? 'diff --git a/source.ts b/source.ts\n+stable selected diff\n'
            : operation === 'staged_diff_stat'
              ? `${statReads++ === 0 ? 'source.ts' : 'different.ts'} | 1 +\n`
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
    let relayCalls = 0;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000116',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 11, 20, 0)),
      projectRoot,
      gitReader,
      relayer: {
        connectorName: 'codex',
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: 'unstable stat must not be relayed',
            receipt_id: 'stub-receipt-changed-diff-stat',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/working tree changed while evidence was collected/i);
    expect(statReads).toBe(2);
    expect(relayCalls).toBe(0);
  });

  it('maps an opaque submodule change to its exact machine-readable path', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'exact-changed-submodule-path');
    const projectRoot = join(runFolderBase, 'exact-changed-submodule-path-project');
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
    const runFolder = join(runFolderBase, 'untracked-only-without-content');
    const projectRoot = join(runFolderBase, 'untracked-only-without-content-project');
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
    const runFolder = join(runFolderBase, 'untracked-invalid-utf8');
    const projectRoot = join(runFolderBase, 'untracked-invalid-utf8-project');
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
    const runFolder = join(runFolderBase, 'untracked-utf8-boundary');
    const projectRoot = join(runFolderBase, 'untracked-utf8-boundary-project');
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
    const runFolder = join(runFolderBase, 'untracked-zero-byte');
    const projectRoot = join(runFolderBase, 'untracked-zero-byte-project');
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

  it('rejects a path exclusion before collecting or relaying the excluded commit content', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'excluded-commit-path');
    const projectRoot = join(runFolderBase, 'excluded-commit-path-project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(
      join(projectRoot, 'src', 'excluded-secret.ts'),
      'export const secret = "base";\n',
    );
    execFileSync('git', ['add', 'src/excluded-secret.ts'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync(
      'git',
      ['-c', 'user.name=Circuit', '-c', 'user.email=circuit@example.test', 'commit', '-m', 'base'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
    const excludedMarker = 'EXCLUDED_COMMIT_CONTENT_MUST_NOT_LEAK';
    writeFileSync(
      join(projectRoot, 'src', 'excluded-secret.ts'),
      `export const secret = "${excludedMarker}";\n`,
    );
    execFileSync('git', ['add', 'src/excluded-secret.ts'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '-m',
        'change excluded content',
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
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('excluded commit content must never reach the reviewer');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/exclusion|path|subset/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
    const trace = readFileSync(join(runFolder, 'trace.ndjson'), 'utf8');
    expect(trace.match(/src\/excluded-secret\.ts/gu)).toHaveLength(1);
    expect(trace).not.toContain(excludedMarker);
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
    'rejects $label exclusions before Git collection or relay',
    async ({ goal, excludedPath, label, runId }) => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, `excluded-target-clause-${label}`);
      const projectRoot = join(runFolderBase, `excluded-target-clause-${label}-project`);
      const excludedMarker = `EXCLUDED_${label.toUpperCase().replaceAll('-', '_')}_MUST_NOT_LEAK`;
      mkdirSync(join(projectRoot, 'migrations'), { recursive: true });
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
      writeFileSync(join(projectRoot, excludedPath), `${excludedMarker}\n`);
      execFileSync('git', ['add', excludedPath], { cwd: projectRoot, stdio: 'pipe' });
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
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            throw new Error('excluded target-clause content must never reach the reviewer');
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/complete|exclusion|path|target/i);
      expect(relayCalls).toBe(0);
      expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
      expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(excludedMarker);
    },
  );

  it('rejects a path subset before collecting commit evidence or calling the relay', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'path-subset-commit');
    const projectRoot = join(runFolderBase, 'path-subset-commit-project');
    const selectedPath = 'src/foo.ts';
    const fileMarker = 'PATH_SUBSET_COMMIT_MUST_NOT_LEAK';
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, selectedPath), `${fileMarker}\n`);
    execFileSync('git', ['add', selectedPath], { cwd: projectRoot, stdio: 'pipe' });
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
        relay: async (): Promise<RelayResult> => {
          relayCalls += 1;
          throw new Error('path subset content must never reach the reviewer');
        },
      },
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/complete|path|subset|target/i);
    expect(relayCalls).toBe(0);
    expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
    expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(fileMarker);
  });

  it.each(['review latest commit only in src/', 'review only src/foo.ts in latest commit'])(
    'rejects the path subset in %j before any Git read or relay',
    async (goal) => {
      const { bytes } = loadFixture();
      const label = goal.includes('only in') ? 'directory-subset' : 'reverse-path-subset';
      const runFolder = join(runFolderBase, label);
      const projectRoot = join(runFolderBase, `${label}-project`);
      mkdirSync(projectRoot, { recursive: true });
      let gitReads = 0;
      let relayCalls = 0;
      const gitReader: RuntimeGitReader = {
        read: async ({ operation }) => {
          gitReads += 1;
          throw new Error(`path subset must not request Git operation ${operation}`);
        },
      };

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId:
          label === 'directory-subset'
            ? '79000000-0000-0000-0000-000000000121'
            : '79000000-0000-0000-0000-000000000122',
        goal,
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 24, 11, 30, 0)),
        projectRoot,
        gitReader,
        relayer: {
          connectorName: 'codex',
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            throw new Error('path subset must not reach the reviewer');
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/complete|path|subset|target/i);
      expect(gitReads).toBe(0);
      expect(relayCalls).toBe(0);
      expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
    },
  );

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
    'rejects a path-only $label request before reading or relaying it',
    async ({ goal, label, runId, selectedPath }) => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, `path-only-${label}`);
      const projectRoot = join(runFolderBase, `path-only-${label}-project`);
      const fileMarker = `PATH_ONLY_${label.toUpperCase().replaceAll('-', '_')}_MUST_NOT_LEAK`;
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      mkdirSync(join(projectRoot, 'docs', 'release'), { recursive: true });
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
      writeFileSync(join(projectRoot, selectedPath), `${fileMarker}\n`);
      execFileSync('git', ['add', selectedPath], { cwd: projectRoot, stdio: 'pipe' });
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
          relay: async (): Promise<RelayResult> => {
            relayCalls += 1;
            throw new Error('path-only content must never reach the reviewer');
          },
        },
      });

      expect(outcome.outcome).toBe('aborted');
      expect(outcome.reason).toMatch(/complete working tree|commit|range|PR|actual text/i);
      expect(relayCalls).toBe(0);
      expect(existsSync(join(runFolder, 'reports', 'review-intake.json'))).toBe(false);
      expect(readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')).not.toContain(fileMarker);
    },
  );
});
