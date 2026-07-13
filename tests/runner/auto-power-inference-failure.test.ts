// Auto-power inference FAILURE legibility.
//
// The inference seam in the graph-runner is best-effort by design: a crash
// while resolving an `auto` dial must never break the run — the dial stays at
// the documented medium fallback. But best-effort must not mean invisible: an
// operator who launched with `--power auto` has to be able to tell "inference
// failed, the run fell back to medium" apart from "the researcher never
// recommended a tier". These tests pin the durable record of that failure: a
// `run.power-inference-error` trace entry (the sibling of
// `run.skill-hook-error`) naming the step, the cause, and the remedy, while
// the run itself still completes on the medium fallback.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { Config, type LayeredConfig } from '../../src/schemas/config.js';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

// Break the inference machinery itself: extractPowerRecommendation throwing
// stands in for any crash inside the post-step inference block (an unreadable
// result body, a malformed trace write, ...). The rest of the module stays
// real so the runner still builds its channel and dial plumbing.
vi.mock('../../src/selection/power-inference.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/selection/power-inference.js')>();
  return {
    ...actual,
    extractPowerRecommendation: () => {
      throw new Error('simulated inference crash');
    },
  };
});

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

// Same fixture splice as tests/runner/auto-power-inference.test.ts: a
// researcher relay between compose and the implementer relay, so the run
// reaches the inference seam with an accepted researcher result.
function researcherThenImplementerFlowBytes(): Buffer {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const researchStep = {
    id: 'research-step',
    title: 'Research runtime proof',
    protocol: 'runtime-proof-relay@v1',
    reads: ['reports/compose.json'],
    routes: { continue: 'relay-step', pass: 'relay-step' },
    executor: 'worker',
    kind: 'relay',
    role: 'researcher',
    writes: {
      request: 'reports/research.request.json',
      receipt: 'reports/research.receipt.json',
      result: 'reports/research.result.json',
    },
    check: {
      kind: 'result_verdict',
      source: { kind: 'relay_result', ref: 'result' },
      pass: ['ok'],
    },
  };
  for (const step of raw.steps) {
    if (step.id === 'compose-step') {
      step.routes = { continue: 'research-step', pass: 'research-step' };
    }
  }
  raw.steps.splice(1, 0, researchStep);
  for (const stage of raw.stages) {
    if (stage.id === 'act-stage') stage.steps = ['research-step', 'relay-step'];
  }
  CompiledFlow.parse(raw);
  return Buffer.from(`${JSON.stringify(raw)}\n`, 'utf8');
}

function autoPowerLayer(): readonly LayeredConfig[] {
  return [
    {
      layer: 'project',
      config: Config.parse({ schema_version: 1, defaults: { power: 'auto' } }),
    },
  ];
}

function composeExecutor(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const attempt = { attempt: context.activeStepAttempt ?? 1 };
      const report = step.writes?.report;
      if (report !== undefined) {
        const reportPath = context.files.resolve(report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, '{"summary":"runtime proof fixture"}\n', 'utf8');
        await context.trace.append({
          run_id: context.runId,
          kind: 'step.report_written',
          step_id: step.id,
          ...attempt,
          report_path: report.path,
          report_schema: report.schema ?? 'runtime.compose',
        });
      }
      await context.trace.append({
        run_id: context.runId,
        kind: 'check.evaluated',
        step_id: step.id,
        ...attempt,
        check_kind: 'schema_sections',
        outcome: 'pass',
      });
      return { route: 'pass', details: { report: report?.path } };
    },
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-auto-power-failure-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('auto power inference failure is legible, and the run still completes', () => {
  it('records run.power-inference-error naming the step, cause, and remedy', async () => {
    const runFolder = join(runFolderBase, 'inference-crash');
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: researcherThenImplementerFlowBytes(),
      runId: '5a705a70-5a70-45a7-85a7-05a705a705b1',
      goal: 'auto power inference failure legibility',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 12, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: makeStubRelayer(
        JSON.stringify({
          verdict: 'ok',
          recommended_power: { value: 'low', rationale: 'stub recommendation' },
        }),
        { receipt_id: 'stub-receipt' },
      ),
      selectionConfigLayers: autoPowerLayer(),
    });

    // The failure never breaks the run.
    expect(result.outcome).toBe('complete');

    const trace = await new TraceStore(runFolder).load();
    // No resolution landed...
    expect(trace.find((e) => e.kind === 'run.power-inference')).toBeUndefined();
    // ...and that silence is now a durable, legible record.
    const marker = trace.find((e) => e.kind === 'run.power-inference-error');
    expect(marker).toBeDefined();
    expect(marker).toMatchObject({ step_id: 'research-step' });
    const message = (marker as { message?: string }).message ?? '';
    expect(message).toContain('medium fallback');
    expect(message).toContain('defaults.power');
    expect(message).toContain('simulated inference crash');

    // The dial stayed at the documented medium fallback for later relays.
    const relayStarted = trace.find(
      (e) => e.kind === 'relay.started' && e.step_id === 'relay-step',
    );
    expect(relayStarted).toBeDefined();
    expect(
      (relayStarted as { resolved_selection?: { power?: string } }).resolved_selection,
    ).toMatchObject({ power: 'medium', power_source: 'auto' });
  });
});
