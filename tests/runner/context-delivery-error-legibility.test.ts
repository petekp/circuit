// Context-delivery FAILURE legibility.
//
// The pull-then-retry delivery seam in the graph-runner is fail-safe by
// design: any failure inside it leaves the run on the starved outcome,
// exactly as if delivery were off. But fail-safe must not mean invisible —
// the outer catch used to swallow a delivery-seam crash with no record at
// all, so "the seam broke" read exactly like "the worker never asked for
// context". These tests pin the durable record of that failure: a
// `run.context-delivery-error` trace entry (the sibling of
// `run.power-inference-error`) naming the step and the cause, while the run
// itself still closes on the starved result.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// Break the delivery seam itself: extractContextRequest throwing stands in
// for any crash inside the outer delivery block (an unreadable starved body,
// a failing pull resolution, ...). With delivery enabled, the seam is this
// function's only live caller, so the crash lands exactly in the outer
// catch under test. The rest of the module stays real.
vi.mock('../../src/runtime/run/context-pull.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/runtime/run/context-pull.js')>();
  return {
    ...actual,
    extractContextRequest: () => {
      throw new Error('simulated delivery-seam crash');
    },
  };
});

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
const TIMEOUT_MS = 120_000;

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-context-delivery-error-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

function passingProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

const ANALYZE_CONTEXT = JSON.stringify({
  verdict: 'accept',
  sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'the file the change touches' }],
  observations: ['the change is small and self-contained'],
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

// The starved implementation carries a context_request, which is what makes
// the run enter the delivery seam where the mocked extraction crashes.
const STARVED_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'STARVED',
  changed_files: ['src/example.ts'],
  evidence: ['stub'],
  context_request: { queries: [{ from_step: 'analyze-step', field_path: 'observations' }] },
});

function buildRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
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

describe('Context-delivery seam crash legibility', () => {
  it(
    'records a run.context-delivery-error marker and still closes on the starved result',
    async () => {
      const runFolder = join(runFolderBase, 'seam-crash');
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: readFileSync(FIXTURE_PATH),
        runId: 'e0000000-0000-0000-0000-000000000001',
        goal: 'Make a small change',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 12, 6, 0, 0)),
        relayer: buildRelayer(),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });

      // Fail-safe held: the crash never broke the run.
      expect(result.outcome).not.toBe('aborted');

      const entries = await new TraceStore(runFolder).load();
      // The seam never got far enough to deliver, so no delivery record...
      expect(entries.some((entry) => entry.kind === 'run.context-delivery')).toBe(false);
      // ...but each crash is durably recorded, naming its step and the cause.
      // The seam runs after every relay whose route continues, so the mocked
      // crash fires per relay step — the starved implementer among them.
      const markers = entries.filter(
        (
          entry,
        ): entry is Extract<(typeof entries)[number], { kind: 'run.context-delivery-error' }> =>
          entry.kind === 'run.context-delivery-error',
      );
      expect(markers.length).toBeGreaterThan(0);
      expect(markers.map((marker) => marker.step_id)).toContain('act-step');
      for (const marker of markers) {
        expect(marker.message).toContain('simulated delivery-seam crash');
        expect(marker.message).toContain('starved');
      }
    },
    TIMEOUT_MS,
  );
});
