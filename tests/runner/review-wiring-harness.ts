// Shared harness for the Review runtime wiring suites. It owns the compiled
// flow fixture, the stub reviewer relays, and the temporary run folders that
// review-runtime-wiring, review-target-selection, review-evidence-honesty, and
// review-hostile-git all stage repositories under.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';

import type {
  ReviewFinding,
  ReviewRelayResult,
  ReviewResultVerdict,
} from '../../src/flows/review/reports.js';
import { runCompiledFlow as runCompiledFlowRaw } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import type {
  RuntimeGitPinnedTarget,
  RuntimeGitTarget,
} from '../../src/shared/runtime-git-reader.js';

export const FIXTURE_PATH = resolve('generated/flows/review/circuit.json');
export const TEST_COMMIT_A = 'a'.repeat(40);
export const TEST_COMMIT_B = 'b'.repeat(40);

export function pinnedTargetFor(target: RuntimeGitTarget): RuntimeGitPinnedTarget {
  if (target.kind === 'commit') {
    const commit =
      /^[0-9a-f]{4,40}$/u.test(target.ref) && target.ref.length < 40
        ? target.ref.padEnd(40, '0')
        : TEST_COMMIT_A;
    return { kind: 'commit', commit };
  }
  return {
    kind: 'range',
    base_commit: TEST_COMMIT_A,
    head_commit: TEST_COMMIT_B,
    dots: target.dots,
  };
}

export function loadFixture(): { bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  CompiledFlow.parse(raw);
  return { bytes };
}

export function loadFixtureWithRenamedAnalyzeResultPath(resultPath: string): {
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
export function stubProse(): {
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

export function cleanRelayResult(): ReviewRelayResult {
  return { verdict: 'NO_ISSUES_FOUND', findings: [], ...stubProse() };
}

export function relayerWith(result: ReviewRelayResult): RelayFn {
  return relayerWithBody(JSON.stringify(result));
}

export function relayerWithBody(body: string): RelayFn {
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

// The unsealed-connector case has to reach the runner without the wrapper
// below forcing `promptOnlyContext`, so the raw entrypoint is exported too.
export { runCompiledFlowRaw };

export async function runCompiledFlow(
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

export function traceEntryLabel(trace_entry: {
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

export async function readTraceEntries(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

let runFolderBase: string;

// Every wiring suite stages its repositories under one temporary folder per
// test. The folder is shared state, so the registrar and the accessor travel
// together: a suite that forgets `useReviewRunFolders()` gets an explicit
// error instead of a path built from `undefined`.
export function useReviewRunFolders(): void {
  beforeEach(() => {
    runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-review-runtime-'));
  });

  afterEach(() => {
    rmSync(runFolderBase, { recursive: true, force: true });
  });
}

export function reviewRunFolderBase(): string {
  if (runFolderBase === undefined) {
    throw new Error('Call useReviewRunFolders() at the top of the suite.');
  }
  return runFolderBase;
}

export function stagedReviewProject(label: string): string {
  const projectRoot = join(reviewRunFolderBase(), label);
  mkdirSync(projectRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
  writeFileSync(join(projectRoot, 'review-target.ts'), 'export const reviewTarget = true;\n');
  execFileSync('git', ['add', 'review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });
  return projectRoot;
}

export const CASES: Array<{
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
