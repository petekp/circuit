// An Explore whose reviewer keeps rejecting used to throw the work away.
//
// Live run f8a173b0: the synthesize step wrote two full recommendations, the
// reviewer rejected both on one narrow evidence-quality point while writing
// that the practical conclusion still held, the retry budget ran out, and the
// run aborted. `reports/compose.json` held real work the operator was never
// told about, and the surface said "Failed", which is the wrong word: nothing
// failed, the flow ran its whole process and did not reach a clean result.
//
// Explore was the odd flow out. `exhaustion_route` already existed and pursue,
// fix, and cross-tool-build all declare one so a spent retry budget advances
// instead of killing the run. Explore declared none.
//
// The honesty half matters as much as the survival half: reaching close must
// not let a rejected recommendation read as a success. The result carries the
// rejection, and the run closes `stopped` ("needs follow-up"), never
// `complete`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExploreCompose, ExploreDefaultResult } from '../../src/flows/explore/reports.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

const EXPLORE_FIXTURE_PATH = resolve('generated/flows/explore/circuit.json');

const RECOMMENDATION =
  'Adopt the shared worker pool, and keep the per-request path for the two endpoints that need isolation.';

const OBJECTION = 'The throughput claim rests on one benchmark run, so the margin could be noise.';
const MISSED_ANGLE = 'Nothing here considers what the pool does under a cold start.';

const COMPOSE_BODY = JSON.stringify({
  verdict: 'accept',
  subject: 'worker pooling',
  recommendation: RECOMMENDATION,
  success_condition_alignment:
    'The brief asked which pooling strategy to adopt, and this names one with its exception.',
  supporting_aspects: [
    {
      aspect: 'throughput',
      contribution: 'The pooled path served more requests per second in the sampled runs.',
      evidence_refs: ['reports/analysis.json'],
    },
  ],
});

// The reviewer that cost the live run: it rejects, and it says in its own
// assessment that the conclusion still holds. Rejecting every time is what
// spends the retry budget.
const REJECTING_REVIEW_BODY = JSON.stringify({
  verdict: 'reject',
  overall_assessment:
    'I believe the practical conclusion still holds, but the throughput evidence is too thin to accept as written.',
  objections: [OBJECTION],
  missed_angles: [MISSED_ANGLE],
});

function rejectingRelayer(): { relayer: RelayFn; synthesisCount: () => number } {
  let synthesisCount = 0;
  return {
    synthesisCount: () => synthesisCount,
    relayer: {
      connectorName: 'claude-code',
      relay: async (input: RelayInput): Promise<RelayResult> => {
        const isReview = input.prompt.includes('Step: review-step');
        if (!isReview) synthesisCount += 1;
        return {
          request_payload: input.prompt,
          receipt_id: isReview ? 'review-stub' : 'synthesize-stub',
          result_body: isReview ? REJECTING_REVIEW_BODY : COMPOSE_BODY,
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      },
    },
  };
}

function traceEntryLabel(entry: { kind: string; step_id?: unknown }): string {
  return typeof entry.step_id === 'string' ? `${entry.kind}:${entry.step_id}` : entry.kind;
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-explore-rejected-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('an Explore whose reviewer never accepts', () => {
  it('hands over the unaccepted recommendation instead of discarding it', async () => {
    const runFolder = join(runFolderBase, 'rejected');
    const { relayer, synthesisCount } = rejectingRelayer();

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: readFileSync(EXPLORE_FIXTURE_PATH),
      runId: '5e000000-0000-0000-0000-000000000001',
      goal: 'explore: which worker pooling strategy should this service adopt?',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 7, 2, 9, 0, 0)),
      relayer,
    });

    // The retry budget really was spent: synthesize ran more than once.
    expect(synthesisCount()).toBeGreaterThan(1);

    // Survival: the run reached its own close step rather than aborting.
    const labels = (await new TraceStore(runFolder).load()).map(traceEntryLabel);
    expect(labels).toContain('step.exhaustion_rerouted:review-step');
    expect(labels).toContain('step.report_written:close-step');
    expect(labels).not.toContain('run.aborted');

    // Honesty: "ran its whole process, no clean result", not "failed" and not
    // "complete".
    expect(outcome.outcome).toBe('stopped');

    // The work the operator was never shown is on disk and in the result.
    const compose = ExploreCompose.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/compose.json'), 'utf8')),
    );
    expect(compose.recommendation).toBe(RECOMMENDATION);

    const result = ExploreDefaultResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/explore-result.json'), 'utf8')),
    );
    expect(result.outcome).toBe('stopped');
    expect(result.verdict_snapshot.review_verdict).toBe('reject');
    expect(result.summary).toContain(RECOMMENDATION);
    // The summary has to say the recommendation did not pass, or a reader
    // skimming one line takes it as settled.
    expect(result.summary).toMatch(/did not pass review/i);
    // The reviewer's unresolved objections travel with it.
    expect(result.review_fold_ins?.objections).toContain(OBJECTION);
    expect(result.review_fold_ins?.missed_angles).toContain(MISSED_ANGLE);
  });
});

describe('the result schema refuses to let a rejection read as clean', () => {
  const BASE = {
    summary: `Explore 'worker pooling': ${RECOMMENDATION}`,
    verdict_snapshot: {
      compose_verdict: 'accept',
      review_verdict: 'reject' as const,
      objection_count: 1,
      missed_angle_count: 1,
    },
    review_fold_ins: {
      overall_assessment: 'Thin evidence.',
      objections: [OBJECTION],
      missed_angles: [MISSED_ANGLE],
    },
    evidence_links: [
      { report_id: 'explore.brief', path: 'reports/brief.json', schema: 'explore.brief@v1' },
      {
        report_id: 'explore.analysis',
        path: 'reports/analysis.json',
        schema: 'explore.analysis@v1',
      },
      { report_id: 'explore.compose', path: 'reports/compose.json', schema: 'explore.compose@v1' },
      {
        report_id: 'explore.review-verdict',
        path: 'reports/review-verdict.json',
        schema: 'explore.review-verdict@v1',
      },
    ],
  };

  it('rejects a rejected review that omits the stopped outcome', () => {
    const parsed = ExploreDefaultResult.safeParse(BASE);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/outcome/);
  });

  it('accepts the same result once it admits it stopped', () => {
    expect(ExploreDefaultResult.safeParse({ ...BASE, outcome: 'stopped' }).success).toBe(true);
  });

  it('refuses a stopped outcome on a review that accepted', () => {
    const accepted = {
      ...BASE,
      outcome: 'stopped',
      verdict_snapshot: { ...BASE.verdict_snapshot, review_verdict: 'accept-with-fold-ins' },
    };
    expect(ExploreDefaultResult.safeParse(accepted).success).toBe(false);
  });
});
