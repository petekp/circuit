// End-to-end auto-power inference through `runCompiledFlow`.
//
// The loop under test: a run whose dial setting is `auto` asks its researcher
// relay for a `recommended_power`, resolves the recommendation once at the
// post-step seam (clamped to the operator's `power_auto` bounds), records a
// durable `run.power-inference` trace entry, and materializes every later
// relay against the resolved tier with `power_source: 'auto'` provenance.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { Config, type LayeredConfig } from '../../src/schemas/config.js';
import type { Power } from '../../src/schemas/power.js';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

// The runtime-proof fixture has one compose step and one implementer relay.
// Splice a researcher relay between them so the run exercises the full
// inference loop: researcher recommends, the next relay materializes.
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

function powerLayer(input: {
  readonly power: 'auto' | Power;
  readonly bounds?: { readonly floor?: Power; readonly ceiling?: Power };
}): readonly LayeredConfig[] {
  return [
    {
      layer: 'project',
      config: Config.parse({
        schema_version: 1,
        defaults: { power: input.power },
        ...(input.bounds === undefined ? {} : { power_auto: input.bounds }),
      }),
    },
  ];
}

// Researcher relays answer with a recommendation; every other relay answers
// with a bare verdict, mirroring real workers (only the researcher is asked).
function recommendingRelayer(recommended: Power) {
  return makeStubRelayer(
    (input) =>
      input.prompt.includes('Role: researcher')
        ? JSON.stringify({
            verdict: 'ok',
            recommended_power: { value: recommended, rationale: 'stub recommendation' },
          })
        : '{"verdict":"ok"}',
    { receipt_id: 'stub-receipt' },
  );
}

// Same compose stub the relay-provenance tests use: write the fixture's
// declared report and record the report + check trace entries the runner's
// post-step machinery expects from a compose step.
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

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

function relaySelectionFor(
  trace: Awaited<ReturnType<typeof readTrace>>,
  stepId: string,
): Record<string, unknown> {
  const entry = trace.find((e) => e.kind === 'relay.started' && e.step_id === stepId);
  if (entry === undefined || entry.kind !== 'relay.started') {
    throw new Error(`expected relay.started for ${stepId}`);
  }
  return entry.resolved_selection as unknown as Record<string, unknown>;
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-auto-power-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('auto power dial resolves from the researcher recommendation', () => {
  it('records run.power-inference and materializes later relays at the inferred tier', async () => {
    const runFolder = join(runFolderBase, 'inferred-low');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: researcherThenImplementerFlowBytes(),
      runId: '5a705a70-5a70-45a7-85a7-05a705a705a7',
      goal: 'auto power end to end',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 5, 11, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: recommendingRelayer('low'),
      selectionConfigLayers: powerLayer({ power: 'auto' }),
    });

    const trace = await readTrace(runFolder);
    const inference = trace.find((e) => e.kind === 'run.power-inference');
    expect(inference).toMatchObject({
      step_id: 'research-step',
      recommended: 'low',
      rationale: 'stub recommendation',
      floor: 'low',
      ceiling: 'high',
      resolved: 'low',
      clamped: false,
    });

    // The researcher relay ran before any inference existed: medium fallback
    // dial, researcher role allocated the high tier.
    expect(relaySelectionFor(trace, 'research-step')).toMatchObject({
      model: { provider: 'anthropic', model: 'opus' },
      power: 'medium',
      power_source: 'auto',
    });
    // The implementer relay ran after the inference: low dial, low-tier model.
    expect(relaySelectionFor(trace, 'relay-step')).toMatchObject({
      model: { provider: 'anthropic', model: 'haiku' },
      power: 'low',
      power_source: 'auto',
    });

    // Only the researcher prompt carries the auto-dial notice.
    const researchPrompt = readFileSync(
      join(runFolder, 'reports', 'research.request.json'),
      'utf8',
    );
    const implementerPrompt = readFileSync(
      join(runFolder, 'reports', 'relay.request.json'),
      'utf8',
    );
    expect(researchPrompt).toContain('Power dial: auto.');
    expect(implementerPrompt).not.toContain('Power dial: auto.');
  });

  it('clamps a recommendation outside the operator bounds to the nearest bound', async () => {
    const runFolder = join(runFolderBase, 'clamped');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: researcherThenImplementerFlowBytes(),
      runId: '5a705a70-5a70-45a7-85a7-05a705a705a8',
      goal: 'auto power clamps to bounds',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 5, 11, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: recommendingRelayer('low'),
      selectionConfigLayers: powerLayer({ power: 'auto', bounds: { floor: 'medium' } }),
    });

    const trace = await readTrace(runFolder);
    expect(trace.find((e) => e.kind === 'run.power-inference')).toMatchObject({
      recommended: 'low',
      floor: 'medium',
      ceiling: 'high',
      resolved: 'medium',
      clamped: true,
    });
    expect(relaySelectionFor(trace, 'relay-step')).toMatchObject({
      model: { provider: 'anthropic', model: 'sonnet' },
      power: 'medium',
      power_source: 'auto',
    });
  });

  it('a fixed dial ignores a stray recommendation and asks for none', async () => {
    const runFolder = join(runFolderBase, 'fixed-dial');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: researcherThenImplementerFlowBytes(),
      runId: '5a705a70-5a70-45a7-85a7-05a705a705a9',
      goal: 'fixed dial ignores recommendation',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 5, 11, 14, 0, 0)),
      executors: composeExecutor(),
      // The stub still answers with a recommendation, simulating a worker that
      // includes the key unprompted; a fixed dial must not consume it.
      relayer: recommendingRelayer('low'),
      selectionConfigLayers: powerLayer({ power: 'high' }),
    });

    const trace = await readTrace(runFolder);
    expect(trace.find((e) => e.kind === 'run.power-inference')).toBeUndefined();
    expect(relaySelectionFor(trace, 'relay-step')).toMatchObject({
      model: { provider: 'anthropic', model: 'opus' },
      power: 'high',
    });
    expect(relaySelectionFor(trace, 'relay-step')).not.toHaveProperty('power_source');
    const researchPrompt = readFileSync(
      join(runFolder, 'reports', 'research.request.json'),
      'utf8',
    );
    expect(researchPrompt).not.toContain('Power dial: auto.');
    expect(existsSync(join(runFolder, 'reports', 'relay.request.json'))).toBe(true);
  });
});
