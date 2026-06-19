import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// Pull-then-retry context-delivery — the value half of the typed-lookup channel,
// end to end through the real Build flow. Where the resolve-and-record cut merely
// recorded the answer, delivery FOLDS the answered slices into the starving step's
// envelope and RE-RUNS the step ONCE on the enriched context. Bounded (one delivery
// per step, a per-step query budget), additive (only context is added), and
// fail-safe (a retry whose connector fails leaves the starved result untouched and
// the run keeps it). Opt-in: a run without `enableContextDelivery` is byte-identical
// to today's resolve-and-record run — no retry, no run.context-delivery entry.

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
const TIMEOUT_MS = 15_000;

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-context-delivery-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

function fixtureBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

function passingProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

// The analyze (researcher) report: known fields a downstream step can name in a
// typed query.
const ANALYZE_CONTEXT = JSON.stringify({
  verdict: 'accept',
  sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'the file the change touches' }],
  observations: ['the change is small and self-contained', 'no schema migration needed'],
  open_questions: [],
  anticipated_file_extensions: ['.ts'],
  slices: [{ id: 'slice-1', intent: 'implement the change', anticipated_file_extensions: ['.ts'] }],
});

const REVIEW = JSON.stringify({
  verdict: 'accept',
  summary: 'ok',
  findings: [],
  alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
});

// The two named slices the starving implementer asks for.
const CONTEXT_REQUEST = {
  queries: [
    { from_step: 'analyze-step', field_path: 'observations' },
    { from_step: 'analyze-step', field_path: 'verdict' },
  ],
};

// The starved implementation: routes 'accept' (so the run can proceed either way),
// but carries a context_request asking for more of the parent's report.
const STARVED_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'STARVED',
  changed_files: ['src/example.ts'],
  evidence: ['stub'],
  context_request: CONTEXT_REQUEST,
});

// The enriched implementation the worker returns once the delivered context is in
// its prompt. No context_request — the need was met. A distinct summary marker so
// the test can prove the run kept THIS body, not the starved one.
const ENRICHED_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'ENRICHED',
  changed_files: ['src/example.ts'],
  evidence: ['used the delivered analyze-step.observations'],
});

// A Build relayer whose implementer (act-step) answers differently before and
// after delivery: the first (starved) attempt emits a context_request; once the
// prompt carries the Delivered Context block, it returns the enriched body. When
// `failOnRetry` is set, the post-delivery attempt throws — a simulated connector
// failure — so the fail-safe path (keep the starved result) is exercised.
function buildRelayer(failOnRetry = false): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
      const hasDeliveredContext = input.prompt.includes('Delivered Context');
      if (isAct && hasDeliveredContext) {
        if (failOnRetry) {
          throw new Error('simulated connector failure on the enriched retry');
        }
        return {
          request_payload: input.prompt,
          receipt_id: 'stub',
          result_body: ENRICHED_BODY,
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      }
      return {
        request_payload: input.prompt,
        receipt_id: 'stub',
        result_body: isAnalyze ? ANALYZE_CONTEXT : isAct ? STARVED_BODY : REVIEW,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

function deliveryEntries(entries: Awaited<ReturnType<typeof readTrace>>) {
  return entries.filter(
    (entry): entry is Extract<(typeof entries)[number], { kind: 'run.context-delivery' }> =>
      entry.kind === 'run.context-delivery',
  );
}

// The body the run actually kept for act-step: read the file the LAST act-step
// relay.completed points at.
function keptActStepSummary(runFolder: string, entries: Awaited<ReturnType<typeof readTrace>>) {
  const completed = [...entries]
    .reverse()
    .find((entry) => entry.kind === 'relay.completed' && entry.step_id === 'act-step') as
    | { result_path: string }
    | undefined;
  if (completed === undefined) return undefined;
  const body = JSON.parse(readFileSync(join(runFolder, completed.result_path), 'utf8')) as {
    summary?: string;
  };
  return body.summary;
}

// The plan report the run actually wrote: find the build.plan@v1 compose report by
// its step.report_written trace entry and read its `approach`. This is what proves
// the THINNING threaded all the way through — graph-runner sets contextDeliveryActive,
// compose.ts forwards it into the ComposeBuildContext, and plan.ts keys the envelope
// on it — rather than just unit-testing plan.ts in isolation.
function planApproach(runFolder: string, entries: Awaited<ReturnType<typeof readTrace>>) {
  const written = entries.find(
    (entry) =>
      entry.kind === 'step.report_written' &&
      (entry as { report_schema?: string }).report_schema === 'build.plan@v1',
  ) as { report_path: string } | undefined;
  if (written === undefined) return undefined;
  const body = JSON.parse(readFileSync(join(runFolder, written.report_path), 'utf8')) as {
    approach?: string;
  };
  return body.approach;
}

describe('Context-delivery (Build, act-step pulls then re-runs on the enriched context)', () => {
  it(
    'folds the answered slices into the envelope, re-runs the step once, and keeps the enriched result',
    async () => {
      const runFolder = join(runFolderBase, 'delivering');
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'd0000000-0000-0000-0000-000000000001',
        goal: 'Make a small change',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 6, 0, 0)),
        relayer: buildRelayer(),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });

      const entries = await readTrace(runFolder);
      const deliveries = deliveryEntries(entries).filter((entry) => entry.step_id === 'act-step');

      // Exactly one delivery for the starving step, and it kept the retry.
      expect(deliveries.length).toBe(1);
      expect(deliveries[0]?.kept).toBe('retry');
      expect(deliveries[0]?.retried).toBe(true);
      expect(deliveries[0]?.delivered_slices).toBe(2);
      expect(deliveries[0]?.delivered_bytes ?? 0).toBeGreaterThan(0);

      // The run kept the ENRICHED body, not the starved one.
      expect(keptActStepSummary(runFolder, entries)).toBe('ENRICHED');
      expect(result.outcome).not.toBe('aborted');
    },
    TIMEOUT_MS,
  );

  it(
    'falls back to the starved result when the enriched retry connector fails',
    async () => {
      const runFolder = join(runFolderBase, 'failsafe');
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'd0000000-0000-0000-0000-000000000002',
        goal: 'Make a small change',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 6, 30, 0)),
        relayer: buildRelayer(true),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });

      const entries = await readTrace(runFolder);
      const deliveries = deliveryEntries(entries).filter((entry) => entry.step_id === 'act-step');

      // The delivery was attempted but fell back: the connector blip on the retry
      // must not discard the work the starved attempt already produced.
      expect(deliveries.length).toBe(1);
      expect(deliveries[0]?.kept).toBe('original');
      expect(keptActStepSummary(runFolder, entries)).toBe('STARVED');
      // The run still reaches a clean (non-aborted) close on the starved result.
      expect(result.outcome).not.toBe('aborted');
    },
    TIMEOUT_MS,
  );

  it(
    'is opt-in: without enableContextDelivery the run resolves-and-records but never re-runs',
    async () => {
      const runFolder = join(runFolderBase, 'off');
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'd0000000-0000-0000-0000-000000000003',
        goal: 'Make a small change',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 7, 0, 0)),
        relayer: buildRelayer(),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
        // enableContextDelivery omitted — delivery is off by default.
      });

      const entries = await readTrace(runFolder);

      // No delivery happened: no re-run, no run.context-delivery entry, and the
      // starved body is what the run kept.
      expect(deliveryEntries(entries).length).toBe(0);
      expect(keptActStepSummary(runFolder, entries)).toBe('STARVED');
      // But the resolve-and-record channel still ran (it is on by default), so the
      // pull was recorded even though it was not delivered.
      const pulls = entries.filter((entry) => entry.kind === 'run.context-pull');
      expect(pulls.length).toBeGreaterThan(0);
      expect(result.outcome).not.toBe('aborted');
    },
    TIMEOUT_MS,
  );
});

// The thin-envelope unlock, proved end to end through the real Build flow: when
// delivery is active the plan writer THINS the act-step's envelope (a pullable
// pointer instead of the inlined synthesis), and when delivery is off it stays FAT
// (byte-identical to before this channel). This is the threading proof — the
// signal originates in the graph-runner, rides RunContext → compose.ts →
// ComposeBuildContext, and lands in plan.ts — not a unit test of plan.ts alone.
describe('Thin-envelope unlock (Build plan thins only when delivery is active)', () => {
  it(
    'thins the plan approach to a pullable pointer when delivery is opted in',
    async () => {
      const runFolder = join(runFolderBase, 'thin');
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'd0000000-0000-0000-0000-00000000000a',
        goal: 'Make a small change',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 8, 0, 0)),
        relayer: buildRelayer(),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });

      const approach = planApproach(runFolder, await readTrace(runFolder));
      // The withheld synthesis is NOT inlined…
      expect(approach).not.toContain('the change is small and self-contained');
      expect(approach).not.toContain('no schema migration needed');
      // …it is replaced by a pointer at the pullable analyze-step report.
      expect(approach).toContain('Grounded in a codebase read');
      expect(approach).toMatch(/analyze-step/);
      expect(approach).toContain('available to pull on demand');
      // The pointer names the LITERAL pull path so the worker never has to infer
      // it from prose — the pull stays deterministic, not inference-dependent.
      expect(approach).toContain(
        'context_request from_step "analyze-step", field_path "observations"',
      );
      // The base instruction the implementer always gets survives the thinning.
      expect(approach).toContain('Make the smallest safe change inside scope');
    },
    TIMEOUT_MS,
  );

  it(
    'keeps the plan approach fat (synthesis inlined) when delivery is off',
    async () => {
      const runFolder = join(runFolderBase, 'fat');
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'd0000000-0000-0000-0000-00000000000b',
        goal: 'Make a small change',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 8, 30, 0)),
        relayer: buildRelayer(),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
        // enableContextDelivery omitted — delivery off, so the plan stays fat.
      });

      const approach = planApproach(runFolder, await readTrace(runFolder));
      // The full synthesis is inlined exactly as before this channel existed.
      expect(approach).toContain('the change is small and self-contained');
      expect(approach).toContain('no schema migration needed');
      // …and none of the thin-pointer language appears.
      expect(approach).not.toContain('available to pull on demand');
    },
    TIMEOUT_MS,
  );
});
