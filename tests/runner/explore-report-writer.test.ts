import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import {
  ExploreAnalysis,
  ExploreBrief,
  ExploreCompose,
  ExploreResult,
  ExploreReviewVerdict,
} from '../../src/flows/explore/reports.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

const FIXTURE_PATH = resolve('generated/flows/explore/circuit.json');

function loadFixture(mutator?: (raw: { steps: Array<{ id: string; reads: string[] }> }) => void): {
  bytes: Buffer;
} {
  const bytes = readFileSync(FIXTURE_PATH);
  const raw: { steps: Array<{ id: string; reads: string[] }> } = JSON.parse(bytes.toString('utf8'));
  mutator?.(raw);
  const mutated = Buffer.from(JSON.stringify(raw));
  CompiledFlow.parse(raw);
  return { bytes: mutated };
}

function stubRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayResult> => {
      if (input.prompt.includes('Step: synthesize-step')) {
        expect(input.prompt).toContain('"recommendation"');
        expect(input.prompt).toContain('success_condition_alignment');
        expect(input.prompt).toContain('supporting_aspects');
        expect(input.prompt).toContain('evidence_refs');
        expect(input.prompt).toContain('Ground claims in the provided reports');
        expect(input.prompt).toContain('Do not include extra top-level keys');
        expect(input.prompt).toContain('explore.compose@v1 before writing reports/compose.json');
        return {
          request_payload: input.prompt,
          receipt_id: 'stub-compose',
          result_body: JSON.stringify({
            verdict: 'accept',
            subject: 'Map the next typed explore report slice',
            recommendation: 'Continue with the next typed report boundary',
            success_condition_alignment: 'The compose names the next useful action',
            supporting_aspects: [
              {
                aspect: 'task-framing',
                contribution: 'The brief and analysis identify the report boundary',
                evidence_refs: ['reports/analysis.json'],
              },
            ],
          }),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }
      if (input.prompt.includes('Step: review-step')) {
        expect(input.prompt).toContain('"overall_assessment"');
        expect(input.prompt).toContain('objections');
        expect(input.prompt).toContain('missed_angles');
        expect(input.prompt).toContain('Do not include extra top-level keys');
        expect(input.prompt).toContain(
          'explore.review-verdict@v1 before writing reports/review-verdict.json',
        );
        return {
          request_payload: input.prompt,
          receipt_id: 'stub-review-verdict',
          result_body: JSON.stringify({
            verdict: 'accept-with-fold-ins',
            overall_assessment: 'The compose is usable with one follow-up note',
            objections: ['Clarify the next report boundary'],
            missed_angles: ['Name the evidence target for the follow-up'],
          }),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }
      const verdict = input.prompt.includes('Step: review-step')
        ? 'accept-with-fold-ins'
        : 'accept';
      return {
        request_payload: input.prompt,
        receipt_id: `stub-${verdict}`,
        result_body: JSON.stringify({ verdict }),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

async function runExploreCase(input: {
  readonly runFolder: string;
  readonly bytes: Buffer;
  readonly runId: string;
  readonly goal: string;
  readonly now: () => Date;
  readonly relayer: RelayFn;
}) {
  const result = await runCompiledFlow({
    runDir: input.runFolder,
    flowBytes: input.bytes,
    runId: input.runId,
    goal: input.goal,
    depth: 'medium',
    now: input.now,
    relayer: input.relayer,
  });
  const trace_entries = await new TraceStore(input.runFolder).load();
  return { result, trace_entries };
}

function incompleteReviewRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayResult> => {
      if (input.prompt.includes('Step: synthesize-step')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'stub-compose',
          result_body: JSON.stringify({
            verdict: 'accept',
            subject: 'Reject incomplete review payloads',
            recommendation: 'Keep review verdicts typed',
            success_condition_alignment: 'The compose lets review run',
            supporting_aspects: [
              {
                aspect: 'review-boundary',
                contribution: 'The review step receives a valid compose report',
                evidence_refs: ['reports/analysis.json'],
              },
            ],
          }),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }
      return {
        request_payload: input.prompt,
        receipt_id: 'stub-incomplete-review',
        result_body: JSON.stringify({ verdict: 'accept' }),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

function extraKeyReviewRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayResult> => {
      if (input.prompt.includes('Step: synthesize-step')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'stub-compose',
          result_body: JSON.stringify({
            verdict: 'accept',
            subject: 'Reject extra review verdict fields',
            recommendation: 'Keep review verdicts strict',
            success_condition_alignment: 'The compose lets review run',
            supporting_aspects: [
              {
                aspect: 'review-strictness',
                contribution: 'The review step receives a valid compose report',
                evidence_refs: ['reports/analysis.json'],
              },
            ],
          }),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }
      return {
        request_payload: input.prompt,
        receipt_id: 'stub-extra-review',
        result_body: JSON.stringify({
          verdict: 'accept',
          overall_assessment: 'The compose is acceptable',
          objections: [],
          missed_angles: [],
          smuggled: true,
        }),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

function extraKeyComposeRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayResult> => ({
      request_payload: input.prompt,
      receipt_id: 'stub-extra',
      result_body: JSON.stringify({
        verdict: 'accept',
        subject: 'Reject extra compose fields',
        recommendation: 'Keep the compose report strict',
        success_condition_alignment: 'The report shape remains auditable',
        supporting_aspects: [
          {
            aspect: 'strictness',
            contribution: 'Unknown fields must not pass through to downstream readers',
            evidence_refs: ['reports/analysis.json'],
          },
        ],
        smuggled: true,
      }),
      duration_ms: 1,
      cli_version: '0.0.0-stub',
    }),
  };
}

function incompleteComposeRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayResult> => ({
      request_payload: input.prompt,
      receipt_id: 'stub-incomplete',
      result_body: JSON.stringify({ verdict: 'accept' }),
      duration_ms: 1,
      cli_version: '0.0.0-stub',
    }),
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-explore-reports-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('default explore report writer', () => {
  it('writes schema-valid explore.brief and explore.analysis reports', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'typed-explore-reports');
    const goal = 'Map the next typed explore report slice';

    const outcome = await runExploreCase({
      runFolder,
      bytes,
      runId: '89000000-0000-0000-0000-000000000000',
      goal,
      now: deterministicNow(Date.UTC(2026, 3, 24, 16, 0, 0)),
      relayer: stubRelayer(),
    });

    expect(outcome.result.outcome).toBe('complete');

    const brief = ExploreBrief.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'brief.json'), 'utf8')),
    );
    expect(brief.subject).toBe(goal);
    expect(brief.task).toBe(goal);
    expect(brief.success_condition).toContain(goal);
    expect(brief.success_condition).not.toContain('Produce a useful explore result');
    expect(brief.success_condition).toContain('evidence-backed findings');

    const analysis = ExploreAnalysis.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'analysis.json'), 'utf8')),
    );
    expect(analysis.subject).toBe(goal);
    expect(analysis.aspects.length).toBeGreaterThan(1);
    expect(analysis.aspects.map((aspect) => aspect.name)).toContain('evidence-targets');
    expect(JSON.stringify(analysis.aspects)).toContain('Evidence target');
    expect(analysis.aspects[0]?.evidence[0]?.source).toBe('reports/brief.json');

    const compose = ExploreCompose.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'compose.json'), 'utf8')),
    );
    expect(compose.verdict).toBe('accept');
    expect(compose.recommendation).toContain('report');

    const reviewVerdict = ExploreReviewVerdict.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-verdict.json'), 'utf8')),
    );
    expect(reviewVerdict.verdict).toBe('accept-with-fold-ins');
    expect(reviewVerdict.objections).toHaveLength(1);
    expect(reviewVerdict.missed_angles).toContain('Name the evidence target for the follow-up');

    const exploreResult = ExploreResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'explore-result.json'), 'utf8')),
    );
    expect(exploreResult.summary).toContain('Continue with the next typed report boundary');
    expect(exploreResult.verdict_snapshot).toEqual({
      compose_verdict: 'accept',
      review_verdict: 'accept-with-fold-ins',
      objection_count: 1,
      missed_angle_count: 1,
    });
    if (!('review_fold_ins' in exploreResult)) {
      throw new Error('expected default Explore result to carry review fold-ins');
    }
    expect(exploreResult.review_fold_ins).toEqual({
      overall_assessment: 'The compose is usable with one follow-up note',
      objections: ['Clarify the next report boundary'],
      missed_angles: ['Name the evidence target for the follow-up'],
    });
    expect(exploreResult.evidence_links.map((pointer) => pointer.path)).toEqual([
      'reports/brief.json',
      'reports/analysis.json',
      'reports/compose.json',
      'reports/review-verdict.json',
    ]);
  });

  it('locates the explore.brief dependency by path rather than read position', async () => {
    const { bytes } = loadFixture((raw) => {
      const analyze = raw.steps.find((step) => step.id === 'analyze-step');
      if (analyze === undefined) throw new Error('analyze-step not found');
      analyze.reads = ['reports/extra-context.json', ...analyze.reads];
    });
    const runFolder = join(runFolderBase, 'reordered-analysis-reads');
    const goal = 'Keep analysis coupled to the brief dependency';

    const outcome = await runExploreCase({
      runFolder,
      bytes,
      runId: '89000000-0000-0000-0000-000000000001',
      goal,
      now: deterministicNow(Date.UTC(2026, 3, 24, 16, 5, 0)),
      relayer: stubRelayer(),
    });

    expect(outcome.result.outcome).toBe('complete');

    const analysis = ExploreAnalysis.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'analysis.json'), 'utf8')),
    );
    expect(analysis.subject).toBe(goal);
    expect(analysis.aspects[0]?.evidence[0]?.source).toBe('reports/brief.json');
  });

  it('rejects an incomplete explore.compose relay result before writing the report', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'incomplete-compose');

    const outcome = await runExploreCase({
      runFolder,
      bytes,
      runId: '90000000-0000-0000-0000-000000000000',
      goal: 'Reject incomplete compose payloads',
      now: deterministicNow(Date.UTC(2026, 3, 24, 17, 0, 0)),
      relayer: incompleteComposeRelayer(),
    });

    expect(outcome.result.outcome).toBe('aborted');
    expect(
      outcome.trace_entries.find((trace_entry) => trace_entry.kind === 'step.aborted')?.step_id,
    ).toBe('synthesize-step');
    const check = outcome.trace_entries.find(
      (trace_entry) =>
        trace_entry.kind === 'check.evaluated' && trace_entry.step_id === 'synthesize-step',
    );
    if (check?.kind !== 'check.evaluated') throw new Error('expected synthesize check trace_entry');
    expect(check.outcome).toBe('fail');
    expect(check.reason).toMatch(/explore\.compose@v1/);
    expect(check.reason).toMatch(/recommendation/);
    expect(() => readFileSync(join(runFolder, 'reports', 'compose.json'), 'utf8')).toThrow();
  });

  it('rejects an otherwise-valid explore.compose relay result with an extra key', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'extra-key-compose');

    const outcome = await runExploreCase({
      runFolder,
      bytes,
      runId: '90000000-0000-0000-0000-000000000001',
      goal: 'Reject extra compose fields',
      now: deterministicNow(Date.UTC(2026, 3, 24, 17, 5, 0)),
      relayer: extraKeyComposeRelayer(),
    });

    expect(outcome.result.outcome).toBe('aborted');
    const check = outcome.trace_entries.find(
      (trace_entry) =>
        trace_entry.kind === 'check.evaluated' && trace_entry.step_id === 'synthesize-step',
    );
    if (check?.kind !== 'check.evaluated') throw new Error('expected synthesize check trace_entry');
    expect(check.outcome).toBe('fail');
    expect(check.reason).toMatch(/explore\.compose@v1/);
    expect(check.reason).toMatch(/smuggled|Unrecognized key/);
    expect(() => readFileSync(join(runFolder, 'reports', 'compose.json'), 'utf8')).toThrow();
  });

  it('rejects an incomplete explore.review-verdict relay result before writing the report', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'incomplete-review-verdict');

    const outcome = await runExploreCase({
      runFolder,
      bytes,
      runId: '91000000-0000-0000-0000-000000000000',
      goal: 'Reject incomplete review verdict payloads',
      now: deterministicNow(Date.UTC(2026, 3, 24, 18, 0, 0)),
      relayer: incompleteReviewRelayer(),
    });

    expect(outcome.result.outcome).toBe('aborted');
    const check = outcome.trace_entries.find(
      (trace_entry) =>
        trace_entry.kind === 'check.evaluated' && trace_entry.step_id === 'review-step',
    );
    if (check?.kind !== 'check.evaluated') throw new Error('expected review check trace_entry');
    expect(check.outcome).toBe('fail');
    expect(check.reason).toMatch(/explore\.review-verdict@v1/);
    expect(check.reason).toMatch(/overall_assessment/);
    expect(() => readFileSync(join(runFolder, 'reports', 'review-verdict.json'), 'utf8')).toThrow();
  });

  it('rejects an otherwise-valid explore.review-verdict relay result with an extra key', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'extra-key-review-verdict');

    const outcome = await runExploreCase({
      runFolder,
      bytes,
      runId: '91000000-0000-0000-0000-000000000001',
      goal: 'Reject extra review verdict fields',
      now: deterministicNow(Date.UTC(2026, 3, 24, 18, 5, 0)),
      relayer: extraKeyReviewRelayer(),
    });

    expect(outcome.result.outcome).toBe('aborted');
    const check = outcome.trace_entries.find(
      (trace_entry) =>
        trace_entry.kind === 'check.evaluated' && trace_entry.step_id === 'review-step',
    );
    if (check?.kind !== 'check.evaluated') throw new Error('expected review check trace_entry');
    expect(check.outcome).toBe('fail');
    expect(check.reason).toMatch(/explore\.review-verdict@v1/);
    expect(check.reason).toMatch(/smuggled|Unrecognized key/);
    expect(() => readFileSync(join(runFolder, 'reports', 'review-verdict.json'), 'utf8')).toThrow();
  });

  it('rejects close-step result aggregation when review-verdict is not an explicit read', async () => {
    const { bytes } = loadFixture((raw) => {
      const close = raw.steps.find((step) => step.id === 'close-step');
      if (close === undefined) throw new Error('close-step not found');
      close.reads = ['reports/brief.json', 'reports/compose.json'];
    });
    const runFolder = join(runFolderBase, 'missing-close-read');

    const outcome = await runExploreCase({
      runFolder,
      bytes,
      runId: '93000000-0000-0000-0000-000000000000',
      goal: 'Require close-step to read the review verdict',
      now: deterministicNow(Date.UTC(2026, 3, 24, 19, 0, 0)),
      relayer: stubRelayer(),
    });

    expect(outcome.result.outcome).toBe('aborted');
    const aborted = outcome.trace_entries.find(
      (trace_entry) => trace_entry.kind === 'step.aborted' && trace_entry.step_id === 'close-step',
    );
    if (aborted?.kind !== 'step.aborted') throw new Error('expected close abort trace_entry');
    expect(aborted.reason).toMatch(/explore\.result@v1/);
    expect(aborted.reason).toMatch(/reports\/review-verdict\.json/);
    expect(() => readFileSync(join(runFolder, 'reports', 'explore-result.json'), 'utf8')).toThrow();
  });

  it('rejects close-step result aggregation when compose is not an explicit read', async () => {
    const { bytes } = loadFixture((raw) => {
      const close = raw.steps.find((step) => step.id === 'close-step');
      if (close === undefined) throw new Error('close-step not found');
      close.reads = ['reports/brief.json', 'reports/review-verdict.json'];
    });
    const runFolder = join(runFolderBase, 'missing-compose-close-read');

    const outcome = await runExploreCase({
      runFolder,
      bytes,
      runId: '93000000-0000-0000-0000-000000000002',
      goal: 'Require close-step to read the compose',
      now: deterministicNow(Date.UTC(2026, 3, 24, 19, 5, 0)),
      relayer: stubRelayer(),
    });

    expect(outcome.result.outcome).toBe('aborted');
    const aborted = outcome.trace_entries.find(
      (trace_entry) => trace_entry.kind === 'step.aborted' && trace_entry.step_id === 'close-step',
    );
    if (aborted?.kind !== 'step.aborted') throw new Error('expected close abort trace_entry');
    expect(aborted.reason).toMatch(/explore\.result@v1/);
    expect(aborted.reason).toMatch(/reports\/compose\.json/);
    expect(() => readFileSync(join(runFolder, 'reports', 'explore-result.json'), 'utf8')).toThrow();
  });

  it('rejects close-step result aggregation when brief is not an explicit read', async () => {
    const { bytes } = loadFixture((raw) => {
      const close = raw.steps.find((step) => step.id === 'close-step');
      if (close === undefined) throw new Error('close-step not found');
      close.reads = ['reports/compose.json', 'reports/review-verdict.json'];
    });
    const runFolder = join(runFolderBase, 'missing-brief-close-read');

    const outcome = await runExploreCase({
      runFolder,
      bytes,
      runId: '93000000-0000-0000-0000-000000000004',
      goal: 'Require close-step to read the brief',
      now: deterministicNow(Date.UTC(2026, 3, 24, 19, 10, 0)),
      relayer: stubRelayer(),
    });

    expect(outcome.result.outcome).toBe('aborted');
    const aborted = outcome.trace_entries.find(
      (trace_entry) => trace_entry.kind === 'step.aborted' && trace_entry.step_id === 'close-step',
    );
    if (aborted?.kind !== 'step.aborted') throw new Error('expected close abort trace_entry');
    expect(aborted.reason).toMatch(/explore\.result@v1/);
    expect(aborted.reason).toMatch(/reports\/brief\.json/);
    expect(() => readFileSync(join(runFolder, 'reports', 'explore-result.json'), 'utf8')).toThrow();
  });
});
