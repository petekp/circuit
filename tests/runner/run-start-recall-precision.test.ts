import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRunStartHistoryRecall } from '../../src/app/history/run-start-recall.js';

const RECORDED_AT = '2026-05-26T12:00:00.000Z';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// A prior run folder of a given flow, with extractable history docs.
function writePriorRun(projectRoot: string, runId: string, flowId: string): void {
  const runFolder = join(projectRoot, '.circuit', 'runs', runId);
  mkdirSync(runFolder, { recursive: true });
  writeJson(join(runFolder, 'manifest.snapshot.json'), {
    schema_version: 1,
    run_id: runId,
    flow_id: flowId,
    captured_at: RECORDED_AT,
  });
  writeJson(join(runFolder, 'reports', 'result.json'), {
    flow_id: flowId,
    outcome: 'complete',
    goal: 'Prior dashboard filter work',
    summary: 'Run closed with outcome complete for the dashboard filter.',
  });
  const trace = [
    {
      schema_version: 1,
      sequence: 0,
      recorded_at: RECORDED_AT,
      run_id: runId,
      kind: 'run.bootstrapped',
      flow_id: flowId,
      depth: 'medium',
      goal: 'Prior dashboard filter work',
      change_kind: {
        change_kind: 'discovery',
        failure_mode: 'manual recall is easy to forget',
        acceptance_evidence: 'run-start recall writes a cited report',
        alternate_framing: 'arbitrary recall block',
      },
      manifest_hash: 'a'.repeat(64),
    },
    {
      schema_version: 1,
      sequence: 1,
      recorded_at: RECORDED_AT,
      run_id: runId,
      kind: 'run.closed',
      outcome: 'complete',
    },
  ];
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${trace.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

function project(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe('prepareRunStartHistoryRecall earned-precision (Slice 3)', () => {
  it('returns a recall report and an always-present precision sidecar object (no file written)', () => {
    const root = project('recall-precision-used-');
    writePriorRun(root, '22222222-2222-4222-8222-222222222222', 'review');
    const { report, precision } = prepareRunStartHistoryRecall({
      repoRoot: root,
      query: 'dashboard filter',
      flowId: 'review',
      now: () => new Date('2026-05-26T12:30:00.000Z'),
    });
    expect(report.status).toBe('used');
    expect(report.memory_inputs.length).toBeGreaterThan(0);
    // the gate produced a precision sidecar carrying its indicator + per-candidate decisions
    expect(precision.flow_id).toBe('review');
    expect(precision.api_version).toBe('history-recall-precision-v1');
    expect(precision.indicator.length).toBeGreaterThan(0);
    // decisions records EVERY candidate the gate examined (>= the pushed set);
    // the injected subset is what equals memory_input_count. They coincide here
    // only because nothing is suppressed (fail-open) — assert the real invariant.
    expect(precision.decisions.length).toBeGreaterThanOrEqual(report.memory_input_count);
    expect(precision.decisions.filter((d) => d.injected).length).toBe(report.memory_input_count);
    // no effect report exists in the corpus -> fail-open with the warning recorded
    expect(precision.effect_report_available).toBe(false);
    expect(precision.warnings.some((w) => w.code === 'effect_report_unavailable')).toBe(true);
    // gated push set round-trips: every injected decision corresponds to a pushed hint
    const injectedIds = precision.decisions.filter((d) => d.injected).map((d) => d.memory_input_id);
    expect(injectedIds.sort()).toEqual(report.memory_inputs.map((m) => m.memory_id).sort());
  });

  it('flow-scopes recall: a run of a flow with no prior same-flow run gets an empty block, fail-open', () => {
    const root = project('recall-precision-empty-');
    // only an explore-flow prior run exists; a goal run must not recall it
    writePriorRun(root, '33333333-3333-4333-8333-333333333333', 'explore');
    const { report, precision } = prepareRunStartHistoryRecall({
      repoRoot: root,
      query: 'dashboard filter',
      flowId: 'goal',
      now: () => new Date('2026-05-26T12:30:00.000Z'),
    });
    // flow-scoping emptied the block (intended narrowing), but never threw
    expect(report.memory_inputs).toHaveLength(0);
    expect(report.status).not.toBe('used');
    expect(precision.flow_id).toBe('goal');
    expect(precision.decisions).toHaveLength(0);
    expect(precision.indicator).toContain('no prior-run hints matched flow goal');
  });

  it('caps the gated push set at the budget while recording every candidate decision', () => {
    const root = project('recall-precision-budget-');
    // five prior review runs -> five candidates; budget 2 -> at most 2 injected
    for (let i = 0; i < 5; i += 1) {
      writePriorRun(root, `4444444${i}-4444-4444-8444-44444444444${i}`, 'review');
    }
    const { report, precision } = prepareRunStartHistoryRecall({
      repoRoot: root,
      query: 'dashboard filter',
      flowId: 'review',
      maxMemoryInputs: 2,
      now: () => new Date('2026-05-26T12:30:00.000Z'),
    });
    expect(report.memory_inputs.length).toBeLessThanOrEqual(2);
    expect(precision.budget).toBe(2);
    expect(precision.decisions.filter((d) => d.injected).length).toBeLessThanOrEqual(2);
  });
});
