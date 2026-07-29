// Per-branch evidence in a dynamic fanout.
//
// A fanout's branches used to share one evidence set: every branch read exactly
// the step's `reads`, so branch k saw the whole corpus while being asked to work
// on slice k. That makes a genuine split impossible — the read is quadratic in
// the number of branches, and each worker is back inside the context bound the
// split exists to break.
//
// A branch may now name its own reads, `$item`-substituted like the rest of the
// template. This runs the real engine and proves the split at the only place it
// matters: the prompt each worker is actually handed.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

const SWEEP_FIXTURE_PATH = resolve('generated/flows/sweep/circuit.json');
const UNITS_PATH = 'reports/units.json';

// A run folder must be fresh, so the evidence the branches read is written by
// the run itself: three seed relays, one per file. Their schema is incidental —
// `pursuit.batch@v1` is simply a relay report that carries both a verdict and a
// list of items, which is what the fanout needs to expand over.
const SEED_SCHEMA = 'pursuit.batch@v1';
const UNIT_IDS = ['unit-a', 'unit-b'] as const;

function seedRelayStep(id: string, reportPath: string, next: string): Record<string, unknown> {
  return {
    id,
    title: `Seed ${reportPath}`,
    protocol: `${id}@v1`,
    reads: [],
    routes: { pass: next, continue: next, stop: '@stop' },
    executor: 'worker',
    kind: 'relay',
    role: 'researcher',
    writes: {
      report: { path: reportPath, schema: SEED_SCHEMA },
      request: `reports/seed/${id}.request.txt`,
      receipt: `reports/seed/${id}.receipt.txt`,
      result: `reports/seed/${id}.result.json`,
    },
    check: {
      kind: 'result_verdict',
      source: { kind: 'relay_result', ref: 'result' },
      pass: ['accept'],
    },
  };
}

interface FanoutShape {
  readonly stepReads?: readonly string[];
  readonly branchReads?: readonly string[];
  readonly itemEvidenceField?: string;
}

// The shipped sweep fanout, re-pointed at the seeded unit list and given
// per-unit branch reads. Its concurrency, failure policy, aggregate write and
// join are the compiled step's own.
function fanoutStep(shape: FanoutShape): Record<string, unknown> {
  const compiled = JSON.parse(readFileSync(SWEEP_FIXTURE_PATH, 'utf8')) as {
    steps: Record<string, unknown>[];
  };
  const step = compiled.steps.find((entry) => entry.kind === 'fanout');
  if (step === undefined) throw new Error('no fanout step in the compiled sweep flow');
  step.reads = [...(shape.stepReads ?? [])];
  step.routes = { pass: '@complete', continue: '@complete', stop: '@stop' };
  step.branches = {
    kind: 'dynamic',
    source_report: UNITS_PATH,
    items_path: 'completed',
    template: {
      branch_id: '$item.pursuit_id',
      execution: {
        kind: 'relay',
        role: 'implementer',
        goal: 'Fix the findings in $item.pursuit_id.',
        report_schema: 'sweep.unit-fix@v1',
        provenance_field: 'unit_id',
        ...(shape.branchReads === undefined ? {} : { reads: [...shape.branchReads] }),
        ...(shape.itemEvidenceField === undefined
          ? {}
          : { item_evidence_field: shape.itemEvidenceField }),
      },
    },
    max_branches: 16,
  };
  return step;
}

function probeFlow(shape: FanoutShape): ExecutableFlow {
  const fanout = fanoutStep(shape);
  const steps = [
    seedRelayStep('seed-units', UNITS_PATH, 'seed-unit-a'),
    seedRelayStep('seed-unit-a', 'reports/units/unit-a.json', 'seed-unit-b'),
    seedRelayStep('seed-unit-b', 'reports/units/unit-b.json', fanout.id as string),
    fanout,
  ];
  const flow = CompiledFlow.parse({
    schema_version: '3',
    id: 'fanout-branch-reads-probe',
    version: '0.1.0',
    purpose: 'Probe: a dynamic fanout whose branches each read their own slice.',
    axes: { allowed_depths: ['medium'], supports_tournament: false, supports_autonomous: false },
    starts_at: 'seed-units',
    stages: [
      { id: 'act-stage', title: 'Act', canonical: 'act', steps: steps.map((step) => step.id) },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'fanout probe: the seeds and the fanout step are the whole flow',
    },
    steps,
  });
  return fromCompiledFlow(flow);
}

function seedBody(marker: string): string {
  return JSON.stringify({
    verdict: 'accept',
    summary: marker,
    serialized_execution: true,
    completed: UNIT_IDS.map((unitId) => ({
      pursuit_id: unitId,
      status: 'completed',
      summary: `SLICE-${unitId}: the only source this branch should see.`,
      evidence: [UNITS_PATH],
    })),
    skipped: [],
    blocked: [],
    failed: [],
    actual_touch_set: { paths: [], symbols: [], commands: [], generated_outputs: [] },
    proof_evidence: [UNITS_PATH],
  });
}

function unitFixBody(unitId: string): string {
  return JSON.stringify({
    unit_id: unitId,
    verdict: 'fixed',
    changed_files: [`src/${unitId}.ts`],
    rule_fixed: 'no-unused-vars',
    evidence: `the ${unitId} unit is clean after the fix`,
  });
}

// Records the prompt every branch worker was handed, keyed by branch.
function recordingRelayer(prompts: Map<string, string>): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayResult> => {
      const branch = /Step: fanout-step-(\S+)/.exec(input.prompt)?.[1];
      const seed = /Step: (seed-\S+)/.exec(input.prompt)?.[1];
      if (branch !== undefined) prompts.set(branch, input.prompt);
      const marker =
        seed === 'seed-unit-a'
          ? 'ALPHA-ONLY-EVIDENCE'
          : seed === 'seed-unit-b'
            ? 'BRAVO-ONLY-EVIDENCE'
            : 'the unit list';
      return {
        request_payload: input.prompt,
        receipt_id: `receipt-${branch ?? seed ?? 'unknown'}`,
        result_body: branch === undefined ? seedBody(marker) : unitFixBody(branch),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

describe('dynamic fanout per-branch reads', () => {
  let baseDir: string;

  async function run(
    name: string,
    shape: FanoutShape,
  ): Promise<{ prompts: Map<string, string>; outcome: string }> {
    const prompts = new Map<string, string>();
    const result = await executeExecutableFlow(probeFlow(shape), {
      runDir: join(baseDir, name),
      runId: randomUUID(),
      goal: 'fix each unit',
      projectRoot: join(baseDir, 'project'),
      relayer: recordingRelayer(prompts),
      now: () => new Date('2026-07-28T00:00:00.000Z'),
    });
    return { prompts, outcome: result.outcome };
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'fanout-branch-reads-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('hands each branch its own slice and no other', async () => {
    const { prompts, outcome } = await run('split', {
      branchReads: ['reports/units/$item.pursuit_id.json'],
    });

    expect(outcome).toBe('complete');
    expect([...prompts.keys()].sort()).toEqual(['unit-a', 'unit-b']);

    const alpha = prompts.get('unit-a') as string;
    const bravo = prompts.get('unit-b') as string;
    expect(alpha).toContain('path="reports/units/unit-a.json"');
    expect(alpha).toContain('ALPHA-ONLY-EVIDENCE');
    expect(alpha).not.toContain('BRAVO-ONLY-EVIDENCE');
    expect(bravo).toContain('path="reports/units/unit-b.json"');
    expect(bravo).toContain('BRAVO-ONLY-EVIDENCE');
    expect(bravo).not.toContain('ALPHA-ONLY-EVIDENCE');
  });

  it('puts the shared step evidence ahead of the branch evidence', async () => {
    const { prompts } = await run('shared', {
      stepReads: [UNITS_PATH],
      branchReads: ['reports/units/$item.pursuit_id.json'],
    });

    const alpha = prompts.get('unit-a') as string;
    const shared = alpha.indexOf(`path="${UNITS_PATH}"`);
    expect(shared).toBeGreaterThan(-1);
    expect(shared).toBeLessThan(alpha.indexOf('path="reports/units/unit-a.json"'));
  });

  // The slice a branch reviews does not have to exist as a file before the run:
  // when the source item carries the text itself, the engine writes that item's
  // own field into the branch folder and reads it there. This is what lets a
  // sealed reviewer — one with no repository access at all — still be handed one
  // unit of a codebase and nothing else.
  it('writes the branch its own item text and reads it back', async () => {
    const { prompts, outcome } = await run('item-evidence', {
      itemEvidenceField: 'summary',
    });

    expect(outcome).toBe('complete');
    const alpha = prompts.get('unit-a') as string;
    const bravo = prompts.get('unit-b') as string;
    expect(alpha).toContain('path="reports/sweep/wave-branches/unit-a/evidence.md"');
    expect(alpha).toContain('SLICE-unit-a');
    expect(alpha).not.toContain('SLICE-unit-b');
    expect(bravo).toContain('SLICE-unit-b');
    expect(bravo).not.toContain('SLICE-unit-a');
  });
});
