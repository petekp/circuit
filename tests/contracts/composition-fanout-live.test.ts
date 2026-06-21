// Flow-shape composition (experimental, default-OFF): a composed FANOUT flow runs
// LIVE to @complete — the genuine-fanout-LIVE unlock for the TERMINAL close.
//
// The fanout #126 unlock proved the fanout STEP runs live: both children spawn and
// the aggregate-survivors join admits the survivors. But it ran the step in
// ISOLATION (`isolatedFanoutFlow`) — it never exercised the full flow's terminal
// close. The full FANOUT_PARALLEL_BUILD flow was NOT end-to-end runnable: selectActual
// binds the terminal close to the prototype family result (prototype.result@v1),
// whose close builder REQUIRES reading prototype.plan@v1. In the composed flow the
// plan output is CONSUMED by the intermediate fanout step, so the terminal
// evidence-soak (which folds only UNCONSUMED orphans) never lists the plan read, and
// the run ABORTS at close time — the runtime close-read resolver throws
// (`prototype.result@v1 requires close step '…' to read reports/…/plan.json`).
//
// The #130 terminal-close rebind was supposed to catch exactly this, but its
// producibility predicate was too lenient: it asked "is the required read's SCHEMA
// produced upstream" (true — plan IS produced), not "will the terminal close actually
// READ it" (false — plan was consumed mid-flow, so it is not in the close's input).
// The fix sharpens the predicate to the close's RESOLVED INPUT, so the rebind fires
// whenever the family close would abort at runtime, and the terminal falls back to the
// reads-agnostic generic flow.result@v1 — exactly as the linear triage shape does.
//
// This file locks both halves:
//   - OFFLINE: the composed fanout terminal binds flow.result@v1, not the prototype
//     family result, and evaluateRunnability (the shipped detector pinned to the real
//     runtime close-read resolver) reports the full flow RUNNABLE.
//   - LIVE: the compiled FANOUT_PARALLEL_BUILD flow RUNS end-to-end through the real
//     engine — frame, plan, the two-branch fanout, and the generic close — and closes
//     @complete, writing a flow.result@v1 body.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { planCompiledFlowFiles } from '../../src/flows/compiled-flow-file-plan.js';
import {
  FANOUT_PARALLEL_BUILD,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import type { ChildFlowRef, CompiledFlowRunOptions } from '../../src/runtime/run/child-runner.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { GraphRunResult } from '../../src/runtime/run/run-close.js';
import { RunResult } from '../../src/schemas/result.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const composed = composeFlow(FANOUT_PARALLEL_BUILD, { definitions: flowDefinitions });

// A minimal compiled child flow whose id matches the branch's flow_ref (the executor
// refuses a child whose resolved id does not equal the branch's flow_ref).
function childFlowBytes(flowId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '3',
      id: flowId,
      version: '0.1.0',
      purpose: `sub-run child stand-in for ${flowId}`,
      axes: { allowed_depths: ['medium'], supports_tournament: false, supports_autonomous: false },
      starts_at: 'close',
      stages: [{ id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close'] }],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'act', 'verify', 'review'],
        rationale: 'narrow sub-run child fixture',
      },
      steps: [
        {
          id: 'close',
          title: 'Close',
          protocol: 'child-close@v1',
          reads: [],
          routes: { pass: '@complete' },
          executor: 'orchestrator',
          kind: 'compose',
          writes: { report: { path: 'reports/child.json', schema: 'child.result@v1' } },
          check: {
            kind: 'schema_sections',
            source: { kind: 'report', ref: 'report' },
            required: ['summary'],
          },
        },
      ],
    }),
  );
}

// A stub child runner: returns a complete RunResult with an in-policy verdict so both
// fanout branches SURVIVE and the aggregate-survivors join admits them.
function stubChildRunner(verdict: string) {
  return async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
    const resultPath = join(options.runDir, 'reports', 'result.json');
    await mkdir(dirname(resultPath), { recursive: true });
    const body = RunResult.parse({
      schema_version: 1,
      run_id: options.runId ?? 'child-run',
      flow_id: options.goal.includes('repairing') ? 'fix' : 'build',
      goal: options.goal,
      outcome: 'complete',
      summary: 'child summary',
      closed_at: new Date(0).toISOString(),
      trace_entries_observed: 1,
      manifest_hash: 'child-hash',
      verdict,
    });
    await writeFile(resultPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    return {
      schema_version: 1,
      run_id: body.run_id,
      flow_id: body.flow_id,
      goal: body.goal,
      outcome: body.outcome,
      summary: body.summary,
      closed_at: body.closed_at,
      trace_entries_observed: body.trace_entries_observed,
      manifest_hash: body.manifest_hash,
      verdict,
      resultPath,
    };
  };
}

// Deterministic stub relayer for the compose frame/plan/close steps. Each step's
// prompt names the contract it validates against; we forge a minimal body, falling
// back to an accept verdict so the step clears its own check and the run advances.
const RELAY_BODIES: Record<string, unknown> = {};
function stubRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const contract = input.prompt.match(/against ([a-z0-9.]+@v\d+)/i)?.[1] ?? '';
      const forged = RELAY_BODIES[contract];
      const body =
        forged ??
        ((): unknown => {
          const verdict = input.prompt.match(/Accepted verdicts:\s*([^\n,]+)/i)?.[1]?.trim();
          return { verdict: verdict ?? 'accept' };
        })();
      return {
        request_payload: input.prompt,
        receipt_id: 'stub',
        result_body: JSON.stringify(body),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

function stubWorktreeRunner() {
  return {
    add() {},
    remove() {},
    changedFiles(worktreePath: string) {
      return [worktreePath.endsWith('/fix-path') ? 'fix.ts' : 'build.ts'];
    },
  };
}

function fanoutFlowBytes(): Uint8Array {
  if (!composed.ok) {
    throw new Error(`compose walled: ${composed.walls.map((w) => w.reason).join(' | ')}`);
  }
  const schematic = assembleFlowSchematic(composed.spec);
  const compiled = compileSchematicToCompiledFlow(schematic);
  const main = planCompiledFlowFiles(compiled).find((f) => f.filename === 'circuit.json');
  if (!main) throw new Error('no circuit.json in compiled file plan');
  return Buffer.from(JSON.stringify(main.flow));
}

let baseDir: string;
beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'circuit-fanout-live-'));
});
afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('flow-shape composition — composed fanout flow runs LIVE (terminal close)', () => {
  it('binds the terminal to the generic flow.result@v1, not the un-runnable prototype family result', () => {
    if (!composed.ok) throw new Error('compose failed');
    const closeStep = composed.spec.items[composed.spec.items.length - 1];
    if (!closeStep) throw new Error('no close step');
    // The close defaults to flow.result@v1; the rebind keeps it there (a family
    // result would be emitted as an explicit `output` override, and a contract_alias
    // would rewrite the generic to the family).
    expect(closeStep.output).toBeUndefined();
    const aliasesGenericAway = (composed.spec.contract_aliases ?? []).some(
      (a) => a.generic === 'flow.result@v1',
    );
    expect(aliasesGenericAway).toBe(false);
  });

  it('the composed fanout spec is VALID and RUNNABLE by the real engine gates', () => {
    if (!composed.ok) throw new Error('compose failed');
    const validity = evaluateValidity(composed.spec);
    if (!validity.valid) {
      throw new Error(
        `not valid: compiles=${validity.compiles} error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
      );
    }
    expect(validity.valid).toBe(true);
    const runnability = evaluateRunnability(composed.spec);
    if (!runnability.runnable) {
      throw new Error(
        `not runnable: ${runnability.aborts.map((a) => `${a.stepId}(${a.schema}): ${a.reason}`).join(' | ')}`,
      );
    }
    expect(runnability.runnable).toBe(true);
  });

  it('LIVE: the compiled fanout flow runs end-to-end through the real engine and closes @complete', async () => {
    const runDir = join(baseDir, 'run');
    await writeFile(
      join(baseDir, 'package.json'),
      JSON.stringify({ name: 'fanout-live-fixture', scripts: { test: 'true' } }),
    );
    let childRunnerCalls = 0;
    const childIds = new Set<string>();
    const result = await runCompiledFlow({
      runDir,
      flowBytes: fanoutFlowBytes(),
      runId: '00000000-0000-0000-0000-0000000fa007',
      goal: 'Compare two build approaches in parallel and keep the surviving evidence',
      depth: 'medium',
      relayer: stubRelayer(),
      worktreeRunner: stubWorktreeRunner(),
      projectRoot: baseDir,
      selectionConfigLayers: [],
      childCompiledFlowResolver: (ref: ChildFlowRef) => ({ flowBytes: childFlowBytes(ref.flowId) }),
      childRunner: async (options) => {
        childRunnerCalls += 1;
        const r = await stubChildRunner('accept')(options);
        childIds.add(r.flow_id);
        return r;
      },
    });

    if (result.outcome !== 'complete') {
      throw new Error(
        `composed fanout did not complete: outcome=${result.outcome} reason=${result.reason ?? ''}`,
      );
    }
    expect(result.outcome).toBe('complete');
    // Both children REALLY ran end-to-end inside the full flow (not in isolation).
    expect(childRunnerCalls).toBe(2);
    expect([...childIds].sort()).toEqual(['build', 'fix']);

    // The terminal wrote the generic flow.result@v1 body, not a prototype family result.
    const closeReport = JSON.parse(
      await readFile(
        join(runDir, 'reports/fanout-parallel-build/close-with-evidence.json'),
        'utf8',
      ),
    ) as { schema_version: number; outcome: string };
    expect(closeReport.schema_version).toBe(1);
    expect(closeReport.outcome).toBe('complete');
  });
});
