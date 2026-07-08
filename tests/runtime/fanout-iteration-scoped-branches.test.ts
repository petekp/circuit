import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractRunHistoryDocuments } from '../../src/app/history/extract.js';
import type { RelayConnector } from '../../src/runtime/executors/relay.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import { RunRelativePath } from '../../src/schemas/scalars.js';
import type { RelayRole } from '../../src/schemas/step.js';

// A fanout used as an until-loop body head re-runs each wave. The fanout
// executor writes every branch to `${branches_dir}/${branch_id}` with no wave
// component, so a branch produced on wave 0 but not on wave 1 leaves a stale
// directory behind. The in-memory aggregate is correct (built from this wave's
// outcomes), but a downstream run-history extractor that walks the branch dir
// on disk would ingest the stale branch. Engine change 1 clears the branch dir
// root at the start of every wave after the first (activeSliceIndex > 0).

const PASSING_RUBRIC_MODEL_JUDGMENTS = {
  evidence_rigor: 'pass',
  actionability: 'pass',
  coverage_adequacy: 'pass',
  scope_discipline: 'pass',
  honest_calibration: 'pass',
  project_specificity: 'pass',
  insight_density: 'pass',
  branch_distinctness: 'pass',
} as const;

// A count-driven until loop over [seed -> fanout]. `seed` writes the branch
// item list; `fanout` expands one relay branch per item. The tail (fanout)
// declares a reenter route, so the corridor swaps forward-exit for reenter
// until the iteration cap. No stopJudge, so no honesty ledger is involved:
// this exercises the activeSliceIndex path alone.
function loopedFanoutFlow(): ExecutableFlow {
  return {
    id: 'fanout-iteration-scoped-test',
    version: '0.1.0',
    entry: 'seed',
    stages: [{ id: 'act', stepIds: ['seed', 'fanout'] }],
    engineFlags: {
      iteratesUntilCondition: {
        headStep: 'seed',
        tailStep: 'fanout',
        bodySteps: ['seed', 'fanout'],
        reenterRoute: 'reenter',
        maxIterations: 2,
        activateWhenDepthAtLeast: 'autonomous',
      },
    },
    steps: [
      {
        id: 'seed',
        kind: 'compose',
        title: 'Seed',
        protocol: 'options@v1',
        writer: 'options',
        writes: { report: { path: 'reports/options.json', schema: 'options@v1' } },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['options'],
        },
        routes: { pass: { kind: 'step', stepId: 'fanout' } },
      },
      {
        id: 'fanout',
        kind: 'fanout',
        title: 'Fanout',
        protocol: 'fanout@v1',
        writes: {
          branches_dir: { path: 'reports/branches' },
          aggregate: { path: 'reports/aggregate.json' },
        },
        branches: {
          kind: 'dynamic',
          source_report: RunRelativePath.parse('reports/options.json'),
          items_path: 'options',
          template: {
            branch_id: '$item.id',
            execution: {
              kind: 'relay',
              role: 'researcher' as RelayRole,
              goal: '$item.prompt',
              report_schema: 'explore.tournament-proposal@v1',
              provenance_field: 'option_id',
            },
          },
          max_branches: 4,
        },
        concurrency: { kind: 'bounded', max: 2 },
        onChildFailure: 'abort-all',
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
          reenter: { kind: 'step', stepId: 'seed' },
        },
        check: {
          kind: 'fanout_aggregate',
          source: { kind: 'fanout_results', ref: 'aggregate' },
          join: { policy: 'aggregate-only' },
          verdicts: { admit: ['accept'] },
        },
      },
    ],
  };
}

// A single-pass fanout (no until flag). Used to prove the branch-dir clear is a
// strict no-op when the fanout is not a loop body (activeSliceIndex absent).
function singlePassFanoutFlow(): ExecutableFlow {
  const looped = loopedFanoutFlow();
  const { engineFlags: _drop, ...rest } = looped;
  return {
    ...rest,
    id: 'fanout-single-pass-test',
    steps: looped.steps.map((step) =>
      step.id === 'fanout'
        ? { ...step, routes: { pass: { kind: 'terminal', target: '@complete' } } }
        : step,
    ),
  };
}

function acceptProposalFor(optionId: string) {
  return {
    verdict: 'accept',
    option_id: optionId,
    option_label: `Option ${optionId}`,
    case_summary: `Case for ${optionId}`,
    assumptions: [],
    evidence_refs: ['reports/options.json'],
    risks: [],
    next_action: 'Continue.',
    rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
  };
}

const relayConnector: RelayConnector = {
  async relay(request) {
    // request.stepId ends with the branch id (`...-option-N`); the tournament
    // proposal schema constrains option_id to option-1 through option-4.
    const match = request.stepId.match(/option-\d+$/);
    const optionId = match ? match[0] : request.stepId;
    return acceptProposalFor(optionId);
  },
};

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'circuit-fanout-iter-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('fanout iteration-scoped branch directories', () => {
  it('clears the branch dir root on later waves so a stale branch does not survive', async () => {
    const runDir = join(baseDir, 'looped-run');
    // Wave 0 produces two branches; wave 1 produces only `alpha`. Without the
    // per-wave clear, wave 0's `beta` directory survives into wave 1.
    let wave = 0;
    const result = await executeExecutableFlow(loopedFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'looped fanout must not leak a stale branch directory',
      depth: 'autonomous',
      relayConnector,
      executors: {
        compose: async (_step, context) => {
          const options =
            wave === 0
              ? [
                  { id: 'option-1', prompt: 'argue option one' },
                  { id: 'option-2', prompt: 'argue option two' },
                ]
              : [{ id: 'option-1', prompt: 'argue option one' }];
          wave += 1;
          await context.files.writeJson('reports/options.json', { options });
          return { route: 'pass' };
        },
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    // The loop ran twice (wave 0 then wave 1).
    expect(wave).toBe(2);
    // Core assertion: wave 0's `option-2` branch directory must not survive wave 1.
    expect(existsSync(join(runDir, 'reports', 'branches', 'option-2'))).toBe(false);
    // Wave 1's `option-1` branch is present and current.
    expect(existsSync(join(runDir, 'reports', 'branches', 'option-1'))).toBe(true);
    // The aggregate is built from the final wave's in-memory outcomes, so it
    // reflects only `option-1` regardless of what remained on disk.
    const aggregate = JSON.parse(await readFile(join(runDir, 'reports', 'aggregate.json'), 'utf8'));
    expect(aggregate.branch_count).toBe(1);
    expect(aggregate.branches.map((b: { branch_id: string }) => b.branch_id)).toEqual(['option-1']);
  });

  it('keeps the stale branch out of the run-history extractor', async () => {
    // The real downstream reader: the run-history extractor walks the branch
    // dir on disk. Without the per-wave clear, wave 0's `option-2/report.json`
    // is ingested as if it belonged to this run. Prove the extractor sees the
    // current branch but not the stale one.
    const runDir = join(baseDir, 'history-run');
    let wave = 0;
    const result = await executeExecutableFlow(loopedFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'run-history extractor must not ingest a stale branch',
      depth: 'autonomous',
      relayConnector,
      executors: {
        compose: async (_step, context) => {
          const options =
            wave === 0
              ? [
                  { id: 'option-1', prompt: 'argue option one' },
                  { id: 'option-2', prompt: 'argue option two' },
                ]
              : [{ id: 'option-1', prompt: 'argue option one' }];
          wave += 1;
          await context.files.writeJson('reports/options.json', { options });
          return { route: 'pass' };
        },
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    const extracted = extractRunHistoryDocuments(runDir);
    // The extractor walks the branch dir (option-1 is ingested), which is what
    // makes the absence of option-2 meaningful rather than incidental.
    expect(extracted.sourceFiles.some((file) => file.includes('branches/option-1'))).toBe(true);
    expect(extracted.sourceFiles.some((file) => file.includes('branches/option-2'))).toBe(false);
  });

  it('does not clear the branch dir for a single-pass fanout', async () => {
    const runDir = join(baseDir, 'single-pass-run');
    // The seed step drops a sentinel into the branch dir before the fanout
    // runs. A single-pass fanout (activeSliceIndex absent) must leave it alone.
    const result = await executeExecutableFlow(singlePassFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'single-pass fanout must not clear the branch directory',
      depth: 'medium',
      relayConnector,
      executors: {
        compose: async (_step, context) => {
          await context.files.writeJson('reports/options.json', {
            options: [{ id: 'option-1', prompt: 'argue option one' }],
          });
          await context.files.writeText('reports/branches/_sentinel.txt', 'keep me');
          return { route: 'pass' };
        },
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    // The sentinel written before the single-pass fanout survives.
    expect(existsSync(join(runDir, 'reports', 'branches', '_sentinel.txt'))).toBe(true);
    expect(existsSync(join(runDir, 'reports', 'branches', 'option-1'))).toBe(true);
  });
});
