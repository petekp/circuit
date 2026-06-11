import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import {
  PursuitBatch,
  PursuitContract,
  PursuitResult,
  PursuitReview,
  PursuitVerification,
  PursuitWavePlan,
} from '../../src/flows/pursue/reports.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const FIXTURE_PATH = resolve('generated/flows/pursue/circuit.json');

function loadFixture(): { flow: CompiledFlow; bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  return { flow: CompiledFlow.parse(raw), bytes };
}

const DEFAULT_BATCH_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'Completed the single pursuit serially',
  serialized_execution: true,
  completed: [
    {
      pursuit_id: 'pursuit-1',
      status: 'completed',
      summary: 'Updated src/example.ts',
      evidence: ['serial implementation completed'],
    },
  ],
  skipped: [],
  blocked: [],
  failed: [],
  actual_touch_set: {
    paths: ['src/example.ts'],
    symbols: [],
    commands: ['npm run check'],
    generated_outputs: [],
  },
  proof_evidence: ['npm run check passed'],
});

const DEFAULT_REVIEW_BODY = JSON.stringify({
  verdict: 'clean',
  summary: 'No coordination issues found',
  findings: [],
});

const BLOCKED_REVIEW_BODY = JSON.stringify({
  verdict: 'blocked',
  summary: 'The batch has untrusted touch-set evidence',
  findings: [
    {
      severity: 'medium',
      text: 'actual_touch_set lists paths that were only inspected, not changed',
      file_refs: ['reports/pursuit/batch.json'],
    },
  ],
});

function relayerWith(
  options: {
    batchBody?: string;
    reviewBody?: string;
  } = {},
): RelayFn {
  const batchBody = options.batchBody ?? DEFAULT_BATCH_BODY;
  const reviewBody = options.reviewBody ?? DEFAULT_REVIEW_BODY;

  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isBatch = input.prompt.includes('Step: batch-step');
      const isReview = input.prompt.includes('Step: review-step');
      expect(isBatch || isReview).toBe(true);
      expect(input.prompt).toContain('Respond with a single raw JSON object');
      const result_body = isBatch ? batchBody : reviewBody;
      const receipt_id = isBatch ? 'stub-pursuit-batch' : 'stub-pursuit-review';
      return {
        request_payload: input.prompt,
        receipt_id,
        result_body,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

function makeVerificationProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'verification-project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        scripts: {
          check: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    )}\n`,
  );
  return projectRoot;
}

function traceEntryLabel(trace_entry: { kind: string; step_id?: unknown }): string {
  return typeof trace_entry.step_id === 'string'
    ? `${trace_entry.kind}:${trace_entry.step_id}`
    : trace_entry.kind;
}

async function readTraceEntries(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-pursue-runtime-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('Pursue runtime wiring', () => {
  it('runs the live Pursue fixture through contract, coordination, batch, verification, review, and close', async () => {
    const { bytes, flow } = loadFixture();
    const runFolder = join(runFolderBase, 'complete');

    const closeStep = flow.steps.find((step) => step.id === 'close-step');
    expect(closeStep?.reads).toEqual(
      expect.arrayContaining([
        'reports/pursuit/contract.json',
        'reports/pursuit/graph.json',
        'reports/pursuit/wave-plan.json',
        'reports/pursuit/batch.json',
        'reports/pursuit/verification.json',
        'reports/pursuit/review.json',
      ]),
    );

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '58000000-0000-0000-0000-000000000000',
      goal: 'pursue: Update src/example.ts',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 15, 9, 0, 0)),
      relayer: relayerWith(),
      projectRoot: makeVerificationProjectRoot(),
    });

    expect(outcome.outcome).toBe('complete');
    const labels = (await readTraceEntries(runFolder)).map(traceEntryLabel);
    expect(labels).toContain('step.report_written:contract-step');
    expect(labels).toContain('step.report_written:graph-step');
    expect(labels).toContain('step.report_written:wave-plan-step');
    expect(labels).toContain('relay.completed:batch-step');
    expect(labels).toContain('relay.completed:review-step');
    expect(labels).toContain('step.report_written:close-step');

    const contract = PursuitContract.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/pursuit/contract.json'), 'utf8')),
    );
    expect(contract.pursuits.map((pursuit) => pursuit.id)).toEqual(['pursuit-1']);

    const wavePlan = PursuitWavePlan.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/pursuit/wave-plan.json'), 'utf8')),
    );
    expect(wavePlan.waves.some((wave) => wave.execution === 'parallel')).toBe(true);
    expect(wavePlan.waves.filter((wave) => wave.kind === 'code-change')).toEqual([
      expect.objectContaining({ execution: 'serial' }),
    ]);

    const batch = PursuitBatch.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/pursuit/batch.json'), 'utf8')),
    );
    expect(batch.serialized_execution).toBe(true);
    expect(batch.completed.map((item) => item.pursuit_id)).toEqual(['pursuit-1']);

    const verification = PursuitVerification.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/pursuit/verification.json'), 'utf8')),
    );
    expect(verification.overall_status).toBe('passed');

    const review = PursuitReview.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/pursuit/review.json'), 'utf8')),
    );
    expect(review.verdict).toBe('clean');

    const result = PursuitResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/pursuit-result.json'), 'utf8')),
    );
    expect(result.outcome).toBe('complete');
    expect(result.serial_code_writes).toBe(true);
    expect(result.evidence_links.map((link) => link.report_id)).toEqual([
      'pursuit.contract',
      'pursuit.graph',
      'pursuit.wave-plan',
      'pursuit.batch',
      'pursuit.verification',
      'pursuit.review',
    ]);
  });

  it('surfaces blocked Pursue review findings instead of aborting on retry exhaustion', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'blocked-review');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '58000000-0000-0000-0000-000000000001',
      goal: 'pursue: Update src/example.ts',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 15, 9, 5, 0)),
      relayer: relayerWith({ reviewBody: BLOCKED_REVIEW_BODY }),
      projectRoot: makeVerificationProjectRoot(),
    });

    expect(outcome.outcome).toBe('complete');
    const labels = (await readTraceEntries(runFolder)).map(traceEntryLabel);
    expect(labels).toContain('relay.completed:review-step');
    expect(labels).toContain('step.report_written:close-step');
    expect(labels).not.toContain('run.aborted');

    const review = PursuitReview.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/pursuit/review.json'), 'utf8')),
    );
    expect(review.verdict).toBe('blocked');
    expect(review.findings[0]?.severity).toBe('medium');

    const result = PursuitResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/pursuit-result.json'), 'utf8')),
    );
    expect(result.outcome).toBe('blocked');
    expect(result.review_verdict).toBe('blocked');
    expect(result.verification_status).toBe('passed');
  });
});
