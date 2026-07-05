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

// On-demand context-pull — the typed-lookup channel, end to end through the real
// Build flow. The implementer relay (act-step) surfaces a typed `context_request`
// in its report: a set of named-slice lookups against its parent analyze-step's
// typed report. After act-step completes, the runner materializes analyze-step's
// report, resolves each named slice through the per-run channel, and records the
// answer-or-finding in the trace as `run.context-pull`. A targeted typed query
// resolves; an "everything" ask is refused; an unknown parent parks; and the
// per-run budget bounds the answered pulls and degrades the rest to findings.
//
// Resolve-and-record only: the pulled value is not delivered back into the step
// this cut, so the run is never altered — a run where no relay asks is
// byte-identical and carries zero context-pull entries.

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
const TIMEOUT_MS = 120_000;

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-context-pull-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

function fixtureBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

// A passing project root (npm run check exits 0) so a Build run flows all the
// way through act → verify → review → close.
function passingProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

// The analyze (researcher) report: a valid build.context@v1 with known fields a
// downstream step can name in a typed query (observations, verdict, slices,
// sources). No equipment_discovery — this run is about context-pull alone.
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

function implementationBody(contextRequest?: unknown): string {
  return JSON.stringify({
    verdict: 'accept',
    summary: 'Implemented the requested change',
    changed_files: ['src/example.ts'],
    evidence: ['stub'],
    ...(contextRequest === undefined ? {} : { context_request: contextRequest }),
  });
}

// A Build relayer. `actContextRequest`, when provided, is folded into the
// act-step (implementer) report so the post-step channel resolves it.
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
        result_body: isAnalyze ? ANALYZE_CONTEXT : isAct ? implementation : REVIEW,
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

describe('Live context-pull (Build, act-step pulls named slices from analyze-step)', () => {
  it(
    'resolves a targeted typed query, refuses "everything", parks an unknown parent, and bounds by budget — all recorded in the trace',
    async () => {
      const runFolder = join(runFolderBase, 'pulling');
      // Six queries exercise every channel outcome in one run. Refusals are
      // checked before the budget and never spend it, so the three answerable
      // queries that follow draw the budget (3) down to zero, and the last
      // answerable query degrades to a budget finding.
      const queries = [
        { from_step: 'analyze-step', field_path: '*' }, // everything → refused (no spend)
        { from_step: 'no-such-step', field_path: 'x' }, // unknown parent → parked (no spend)
        { from_step: 'analyze-step', field_path: 'observations' }, // answered (3 → 2)
        { from_step: 'analyze-step', field_path: 'verdict' }, // answered (2 → 1)
        { from_step: 'analyze-step', field_path: 'slices' }, // answered (1 → 0)
        { from_step: 'analyze-step', field_path: 'sources' }, // budget exhausted → finding
      ];
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'c0000000-0000-0000-0000-000000000001',
        goal: 'Make a small change',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 5, 0, 0)),
        relayer: buildRelayer({ queries }),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
      });

      const entries = await readTrace(runFolder);
      const pulls = contextPullEntries(entries).filter((entry) => entry.step_id === 'act-step');

      // One trace entry per query, in order, all attributed to the asking step.
      expect(pulls.length).toBe(6);
      expect(pulls.every((entry) => entry.step_id === 'act-step')).toBe(true);

      // The "everything" ask is refused as a finding, never answered.
      const everything = pulls.find((entry) => entry.field_path === '*');
      expect(everything?.answered).toBe(false);
      expect(everything?.reason).toMatch(/everything/i);

      // The unknown parent parks as a finding.
      const unknownParent = pulls.find((entry) => entry.from_step === 'no-such-step');
      expect(unknownParent?.answered).toBe(false);
      expect(unknownParent?.reason).toMatch(/no readable typed report/i);

      // The three targeted typed queries resolve, each with a serialized byte size.
      const answered = pulls.filter((entry) => entry.answered);
      expect(answered.map((entry) => entry.field_path)).toEqual([
        'observations',
        'verdict',
        'slices',
      ]);
      expect(answered.every((entry) => (entry.bytes ?? 0) > 0)).toBe(true);

      // The fourth answerable query degrades to a budget finding (budget = 3).
      const exhausted = pulls.find((entry) => entry.field_path === 'sources');
      expect(exhausted?.answered).toBe(false);
      expect(exhausted?.reason).toMatch(/budget/i);

      // The pull never alters the run: it continued to completion.
      expect(result.outcome).not.toBe('aborted');
    },
    TIMEOUT_MS,
  );
});

describe('Live context-pull (Build, a run where no relay asks)', () => {
  it(
    'is byte-identical: the channel is present but inert, recording zero context-pull entries',
    async () => {
      const runFolder = join(runFolderBase, 'silent');
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'c0000000-0000-0000-0000-000000000002',
        goal: 'Make a small change',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 5, 30, 0)),
        relayer: buildRelayer(), // no context_request anywhere
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
      });

      const entries = await readTrace(runFolder);
      // The seam is the only new trace producer; with no request, it writes
      // nothing, so the trace is byte-identical to a pre-channel run.
      expect(contextPullEntries(entries).length).toBe(0);
      expect(result.outcome).not.toBe('aborted');
    },
    TIMEOUT_MS,
  );
});
