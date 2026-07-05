// Explore review 'reject' verdict: rework loop wiring and its bound.
//
// 'reject' is schema-valid for explore.review-verdict@v1 but absent from
// review-step's check.pass, so a reject is a handled non-pass outcome:
// the engine routes the compose back to synthesize-step (retry/revise
// binding), the rejected review report is still written, and the rework
// attempt reads it. The loop is bounded by the engine's default
// max_attempts: a second reject aborts the run instead of looping.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { RelayInput } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

const EXPLORE_FIXTURE_PATH = resolve('generated/flows/explore/circuit.json');

const COMPOSE_BODY = {
  verdict: 'accept',
  subject: 'explore: reject-rework wiring run',
  recommendation: 'Keep the explore review loop bounded',
  success_condition_alignment: 'The rework pass reads the rejecting review',
  supporting_aspects: [
    {
      aspect: 'report-shape',
      contribution: 'The prior reports give the close step stable inputs',
      evidence_refs: ['reports/analysis.json'],
    },
  ],
};

const REJECT_BODY = {
  verdict: 'reject',
  overall_assessment: 'The compose misses the requested scope',
  objections: ['BLOCKING: the recommendation ignores the stated success condition'],
  missed_angles: [],
};

const ACCEPT_BODY = {
  verdict: 'accept',
  overall_assessment: 'The reworked compose is usable',
  objections: [],
  missed_angles: [],
};

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-explore-reject-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

interface Recorder {
  readonly synthesizePrompts: string[];
  readonly reviewPrompts: string[];
}

function relayer(recorder: Recorder, reviewVerdicts: readonly object[]) {
  return makeStubRelayer((input: RelayInput) => {
    if (input.prompt.includes('Step: synthesize-step')) {
      recorder.synthesizePrompts.push(input.prompt);
      return JSON.stringify(COMPOSE_BODY);
    }
    recorder.reviewPrompts.push(input.prompt);
    const verdict =
      reviewVerdicts[Math.min(recorder.reviewPrompts.length - 1, reviewVerdicts.length - 1)];
    return JSON.stringify(verdict);
  });
}

async function runExplore(recorder: Recorder, reviewVerdicts: readonly object[], runName: string) {
  return runCompiledFlow({
    runDir: join(runFolderBase, runName),
    flowBytes: readFileSync(EXPLORE_FIXTURE_PATH),
    runId: 'e1000000-0000-0000-0000-0000000000aa',
    goal: 'explore: reject-rework wiring run',
    depth: 'medium',
    now: deterministicNow(Date.UTC(2026, 5, 11, 12, 0, 0)),
    relayer: relayer(recorder, reviewVerdicts),
    projectRoot: resolve('.'),
  });
}

describe('explore review reject verdict', () => {
  it('routes a rejected compose back to synthesize, which reads the rejecting review', async () => {
    const recorder: Recorder = { synthesizePrompts: [], reviewPrompts: [] };
    const outcome = await runExplore(recorder, [REJECT_BODY, ACCEPT_BODY], 'reject-then-accept');

    expect(outcome.outcome).toBe('complete');
    expect(recorder.synthesizePrompts).toHaveLength(2);
    expect(recorder.reviewPrompts).toHaveLength(2);

    // The reviewer prompt names reject as a safe, handled rework verdict.
    expect(recorder.reviewPrompts[0]).toContain('Accepted verdicts: accept, accept-with-fold-ins');
    expect(recorder.reviewPrompts[0]).toContain('Rework verdicts');
    expect(recorder.reviewPrompts[0]).toContain('reject');

    // First synthesize pass: the review report does not exist yet.
    expect(recorder.synthesizePrompts[0]).toContain(
      '[reads unavailable: reports/review-verdict.json]',
    );
    // Rework pass: the rejecting review is inlined so the worker knows
    // why the compose came back.
    expect(recorder.synthesizePrompts[1]).toContain(
      'BLOCKING: the recommendation ignores the stated success condition',
    );
  }, 120_000);

  it('aborts instead of looping when the reviewer rejects the rework too', async () => {
    const recorder: Recorder = { synthesizePrompts: [], reviewPrompts: [] };
    const outcome = await runExplore(recorder, [REJECT_BODY], 'reject-always');

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.outcome === 'aborted' && outcome.reason).toMatch(/max_attempts|exhausted/);
    // Bounded: one rework round trip, no runaway loop.
    expect(recorder.synthesizePrompts.length).toBeLessThanOrEqual(2);
    expect(recorder.reviewPrompts.length).toBeLessThanOrEqual(2);
  }, 120_000);
});
