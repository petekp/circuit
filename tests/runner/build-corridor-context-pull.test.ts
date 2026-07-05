import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { resumeCompiledFlow } from '../../src/runtime/run/checkpoint-resume.js';
import {
  runCompiledFlow,
  runCompiledFlowWithWaiting,
} from '../../src/runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../../src/runtime/run/graph-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// Change B (the corridor-skip lift), proved end to end through the real Build flow.
//
// Build's slice loop (iterates_slice_loop, head_step: act-step) activates at depth
// 'high', running one implement+verify pass per plan slice. So at high depth the
// implementer — where a `context_request` surfaces — IS the corridor head step.
// Before this change, the post-step resolve-and-record context-pull seam was
// guarded on `!sliceCorridor.isActive()`, so a pull raised inside the corridor was
// dropped WITHOUT a trace finding — the one refusal path not made legible. The lift
// rewrote the guard to fire resolve-and-record when (delivery off) OR (inside a
// corridor), so a corridor head-step pull is now RECORDED.
//
// This test pins exactly that: a deep-depth run with the slice loop active and a
// context_request from the head step records a `run.context-pull` entry. Under the
// OLD guard the corridor skip dropped it, so this assertion went red — it is the
// failing-test-first for the lift. Delivery stays OFF here (the default), so this
// is the resolve-and-record path; delivery-in-corridor stays deferred and is not
// exercised. Resolve-and-record never mutates the run, so the run still completes.

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
const TIMEOUT_MS = 120_000;

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-corridor-pull-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

function fixtureBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

// A passing project root (npm run check exits 0) so a Build run flows all the way
// through act → verify → review → close at every slice iteration.
function passingProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

// A TWO-slice analyze report. Two slices make the slice loop genuinely iterate at
// high depth, so the corridor is unambiguously active when the head step's pull is
// resolved. observations is a real pullable slice of build.context@v1.
const DEEP_ANALYZE_CONTEXT = JSON.stringify({
  verdict: 'accept',
  sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'the file the change touches' }],
  observations: ['the change is small and self-contained', 'no schema migration needed'],
  open_questions: [],
  anticipated_file_extensions: ['.ts'],
  slices: [
    { id: 'slice-1', intent: 'implement the first unit', anticipated_file_extensions: ['.ts'] },
    { id: 'slice-2', intent: 'add the regression guard', anticipated_file_extensions: ['.ts'] },
  ],
  // Left empty so the touch-area gate stays inert across the iterations — this
  // probe is about the corridor context-pull skip, not the touch-area gate.
  allowed_touch_area: [],
});

const REVIEW = JSON.stringify({
  verdict: 'accept',
  summary: 'ok',
  findings: [],
  alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
});

function implementationBody(contextRequest?: unknown): string {
  return JSON.stringify({
    verdict: 'accept',
    summary: 'Implemented the requested change',
    changed_files: ['src/example.ts'],
    evidence: ['stub'],
    ...(contextRequest === undefined ? {} : { context_request: contextRequest }),
  });
}

// A Build relayer whose implementer (act-step) surfaces a targeted typed
// context_request against analyze-step. At high depth this act-step is the
// corridor head, so the request exercises the lifted resolve-and-record seam.
function buildRelayer(actContextRequest?: unknown): RelayFn {
  const implementation = implementationBody(actContextRequest);
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
      return {
        request_payload: input.prompt,
        receipt_id: 'stub',
        result_body: isAnalyze ? DEEP_ANALYZE_CONTEXT : isAct ? implementation : REVIEW,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

function contextPullEntries(entries: Awaited<ReturnType<typeof readTrace>>) {
  return entries.filter(
    (entry): entry is Extract<(typeof entries)[number], { kind: 'run.context-pull' }> =>
      entry.kind === 'run.context-pull',
  );
}

describe('Corridor context-pull (Build, deep depth — head-step pulls are recorded, not dropped)', () => {
  it(
    'resolves-and-records a head-step pull raised inside an active slice corridor',
    async () => {
      const runFolder = join(runFolderBase, 'corridor-pull');
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b0000000-0000-0000-0000-00000000000c',
        goal: 'Make a small change',
        // 'autonomous' is >= the slice-loop floor of 'high', so Build's slice loop
        // is active (act-step is the corridor head) — but unlike 'high' it
        // auto-resolves the frame checkpoint (which 'high' pauses on for an
        // operator), so the run drives to completion without checkpoint-resume.
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 17, 6, 0, 0)),
        // Delivery OFF (default) — this is the resolve-and-record path. The pull is
        // recorded for legibility; delivery-in-corridor stays deferred.
        relayer: buildRelayer({
          queries: [{ from_step: 'analyze-step', field_path: 'observations' }],
        }),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
      });

      const entries = await readTrace(runFolder);
      const actStepPulls = contextPullEntries(entries).filter(
        (entry) => entry.step_id === 'act-step',
      );

      // The lift: the corridor head-step pull is RECORDED. Under the old guard
      // (`!sliceCorridor.isActive()`) the corridor was active so the seam was
      // skipped and this list was empty — the failing-test-first for Change B.
      expect(actStepPulls.length).toBeGreaterThan(0);

      // It is a real resolve-and-record of the targeted typed query, not a drop.
      const answered = actStepPulls.filter((entry) => entry.answered);
      expect(answered.length).toBeGreaterThan(0);
      expect(answered.every((entry) => entry.from_step === 'analyze-step')).toBe(true);
      expect(answered.every((entry) => entry.field_path === 'observations')).toBe(true);
      expect(answered.every((entry) => (entry.bytes ?? 0) > 0)).toBe(true);

      // Resolve-and-record never mutates the run: it ran to completion, not aborted.
      expect(result.outcome).not.toBe('aborted');
    },
    TIMEOUT_MS,
  );

  it(
    'is byte-identical at deep depth when no head-step asks: zero context-pull entries',
    async () => {
      const runFolder = join(runFolderBase, 'corridor-silent');
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b0000000-0000-0000-0000-00000000000d',
        goal: 'Make a small change',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 17, 6, 30, 0)),
        relayer: buildRelayer(), // no context_request anywhere
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
      });

      const entries = await readTrace(runFolder);
      // With no request, the lifted seam writes nothing — a corridor run that does
      // not ask is byte-identical to before this channel.
      expect(contextPullEntries(entries).length).toBe(0);
      expect(result.outcome).not.toBe('aborted');
    },
    TIMEOUT_MS,
  );

  it(
    'is resume-safe: a corridor head-step pull is recorded after a checkpoint resume, with no double-count',
    async () => {
      // The brief's §4/§5 resume re-thread requirement, proved against the real
      // Build flow. At depth 'high' Build PAUSES at the frame-step checkpoint —
      // which sits BEFORE analyze/plan/act — so a resume drives the whole slice
      // corridor (act-step is the corridor head) entirely post-resume. That makes
      // this a genuine test that the resolve-and-record channel re-wires correctly
      // across a checkpoint boundary (resumeCompiledFlow threads the puller) and the
      // lifted corridor seam still fires on the resumed pass.
      //
      // "No double-count": the context-pull channel has no per-run budget to
      // double-spend — the puller is a fresh per-step factory with a per-step budget
      // (see checkpoint-resume.ts: "The puller is a stateless factory ... so
      // threading it always is safe"), and seedContextDeliveryFromTrace re-claims
      // only run.context-delivery entries, never run.context-pull. The worst case a
      // resume could produce is a duplicate trace line for a step that ran AND
      // recorded BEFORE the pause and re-runs after it — which cannot arise here
      // because the frame checkpoint precedes the corridor, so each slice's act-step
      // runs exactly once (post-resume). We pin that empirically with a differential:
      // the resumed run records EXACTLY the same act-step pulls as an unbroken
      // autonomous run — resume adds no phantom inflation.

      // Baseline: an unbroken autonomous run (no pause) records the corridor pulls.
      const baselineFolder = join(runFolderBase, 'resume-baseline');
      const baseline = await runCompiledFlow({
        runDir: baselineFolder,
        flowBytes: fixtureBytes(),
        runId: 'b0000000-0000-0000-0000-00000000000e',
        goal: 'Make a small change',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 17, 7, 0, 0)),
        relayer: buildRelayer({
          queries: [{ from_step: 'analyze-step', field_path: 'observations' }],
        }),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
      });
      expect(baseline.outcome).not.toBe('aborted');
      const baselineEntries = await readTrace(baselineFolder);
      const baselineActPulls = contextPullEntries(baselineEntries).filter(
        (entry) => entry.step_id === 'act-step' && entry.answered,
      );
      // Sanity: the baseline genuinely exercises the corridor pull.
      expect(baselineActPulls.length).toBeGreaterThan(0);

      // The resume arm: pause the same flow at the frame checkpoint, then resume.
      const resumeFolder = join(runFolderBase, 'resume-corridor');
      const waiting = await runCompiledFlowWithWaiting({
        runDir: resumeFolder,
        flowBytes: fixtureBytes(),
        runId: 'b0000000-0000-0000-0000-00000000000f',
        goal: 'Make a small change',
        depth: 'high',
        now: deterministicNow(Date.UTC(2026, 5, 17, 7, 30, 0)),
        relayer: buildRelayer({
          queries: [{ from_step: 'analyze-step', field_path: 'observations' }],
        }),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
      });
      // Depth 'high' parks at the operator frame checkpoint before the corridor.
      expect(isGraphCheckpointWaitingResult(waiting)).toBe(true);
      if (!isGraphCheckpointWaitingResult(waiting)) throw new Error('expected waiting checkpoint');
      expect(waiting.checkpoint.stepId).toBe('frame-step');

      // Resume the parked run: 'continue' routes frame-step -> analyze-step, so the
      // corridor (act-step) runs entirely on the resumed pass. The puller is rewired
      // by resumeCompiledFlow; projectRoot is restored from the saved checkpoint.
      const resumed = await resumeCompiledFlow({
        runDir: resumeFolder,
        selection: 'continue',
        now: deterministicNow(Date.UTC(2026, 5, 17, 8, 0, 0)),
        relayer: buildRelayer({
          queries: [{ from_step: 'analyze-step', field_path: 'observations' }],
        }),
      });

      // Resume-safe: the run completed (completion keys intact through the slice
      // loop after a checkpoint boundary), not aborted.
      expect(resumed.outcome).not.toBe('aborted');

      const resumedEntries = await readTrace(resumeFolder);
      const resumedActPulls = contextPullEntries(resumedEntries).filter(
        (entry) => entry.step_id === 'act-step' && entry.answered,
      );

      // The lifted corridor seam fired on the RESUMED pass — the head-step pull is
      // recorded post-resume, not lost across the boundary.
      expect(resumedActPulls.length).toBeGreaterThan(0);
      expect(resumedActPulls.every((entry) => entry.from_step === 'analyze-step')).toBe(true);
      expect(resumedActPulls.every((entry) => entry.field_path === 'observations')).toBe(true);
      expect(resumedActPulls.every((entry) => (entry.bytes ?? 0) > 0)).toBe(true);

      // No double-count: the resumed run records EXACTLY the same number of corridor
      // pulls as the unbroken baseline — the checkpoint boundary adds no phantom
      // re-record. (If resume re-threading double-counted, this would be > baseline.)
      expect(resumedActPulls.length).toBe(baselineActPulls.length);
    },
    TIMEOUT_MS,
  );
});
