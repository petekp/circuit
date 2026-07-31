import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import {
  BuildImplementation,
  BuildResult,
  BuildReview,
  BuildVerification,
} from '../../src/flows/build/reports.js';
import { resumeCompiledFlow } from '../../src/runtime/run/checkpoint-resume.js';
import {
  runCompiledFlow,
  runCompiledFlowWithWaiting,
} from '../../src/runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../../src/runtime/run/graph-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
// A hang guard, not a performance assertion: these tests drive real relay
// budget loops, and a loaded machine stretches them well past quiet-run time.
const BUILD_RUNTIME_TIMEOUT_MS = 120_000;
// Printed by a deliberately failing verification command so a test can prove the
// relaunched implementer prompt carries the verification report's real content.
const FAILING_CHECK_MARKER = 'BUILD_VERIFICATION_FAILURE_MARKER: tile owner assertion failed';

function loadFixture(): { flow: CompiledFlow; bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  return { flow: CompiledFlow.parse(raw), bytes };
}

function relayerWith(
  options: {
    implementationBody?: string;
    reviewBody?: string;
    contextBody?: string;
  } = {},
): RelayFn {
  const implementationBody =
    options.implementationBody ??
    JSON.stringify({
      verdict: 'accept',
      summary: 'Implemented the requested change',
      changed_files: ['src/example.ts'],
      evidence: ['Stub implementation relay completed'],
    });
  const reviewBody =
    options.reviewBody ??
    JSON.stringify({
      verdict: 'accept',
      summary: 'No blocking issue found',
      findings: [],
      alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
    });
  const contextBody =
    options.contextBody ??
    JSON.stringify({
      verdict: 'accept',
      sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches' }],
      observations: ['The target module is small and self-contained'],
      open_questions: [],
    });

  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
      const isReview = input.prompt.includes('Step: review-step');
      expect(isAnalyze || isAct || isReview).toBe(true);
      expect(input.prompt).toContain('Context (from reads):');
      expect(input.prompt).toContain('Respond with a single raw JSON object');
      const receipt_id = isAnalyze
        ? 'stub-build-analyze'
        : isAct
          ? 'stub-build-act'
          : 'stub-build-review';
      const result_body = isAnalyze ? contextBody : isAct ? implementationBody : reviewBody;
      return {
        request_payload: input.prompt,
        receipt_id,
        result_body,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

// Records every implementer prompt so a test can assert what the relaunched
// implementer was actually told after a failing verification sent it back.
function relayerRecordingActPrompts(actPrompts: string[]): RelayFn {
  const inner = relayerWith();
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      if (input.prompt.includes('Step: act-step')) actPrompts.push(input.prompt);
      return await inner.relay(input);
    },
  };
}

function traceEntryLabel(trace_entry: { kind: string; step_id?: unknown }): string {
  return typeof trace_entry.step_id === 'string'
    ? `${trace_entry.kind}:${trace_entry.step_id}`
    : trace_entry.kind;
}

function traceEntryByKind<T extends { kind: string }>(
  trace_entries: readonly T[],
  kind: string,
): T | undefined {
  return trace_entries.find((trace_entry) => trace_entry.kind === kind);
}

async function readTraceEntries(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

function makeVerificationProjectRoot(checkScript = 'node -e "process.exit(0)"'): string {
  const projectRoot = join(runFolderBase, 'verification-project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        scripts: {
          check: checkScript,
        },
      },
      null,
      2,
    )}\n`,
  );
  return projectRoot;
}

// A project the Node-script resolver cannot read at all — no package.json —
// that declares its own proof command in `.circuit/config.yaml`.
function makeDeclaredVerificationProjectRoot(argv: readonly string[]): string {
  const projectRoot = join(runFolderBase, 'declared-verification-project');
  mkdirSync(join(projectRoot, '.circuit'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.circuit', 'config.yaml'),
    [
      'schema_version: 1',
      'verification:',
      '  general:',
      `    argv: ${JSON.stringify(argv)}`,
      '',
    ].join('\n'),
  );
  return projectRoot;
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-build-runtime-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('Build runtime wiring', () => {
  it('exposes only checkpoint choices the current runner can honor', () => {
    const { flow } = loadFixture();
    const frame = flow.steps.find((step) => step.id === 'frame-step');
    expect(frame?.kind).toBe('checkpoint');
    if (frame?.kind !== 'checkpoint') throw new Error('frame-step is not a checkpoint');

    expect(frame.policy.choices?.map((choice) => choice.id)).toEqual(['continue']);
    expect(frame.check.allow).toEqual(['continue']);
  });

  it(
    'runs the live Build fixture through checkpoint, implementation relay, verification, review relay, and close',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'complete');

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000000',
        goal: 'Add a tiny Build feature',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 0, 0)),
        relayer: relayerWith(),
        projectRoot: makeVerificationProjectRoot(),
      });

      expect(outcome.outcome).toBe('complete');
      const trace_entries = await readTraceEntries(runFolder);
      expect(trace_entries.map(traceEntryLabel)).toContain('checkpoint.resolved:frame-step');
      expect(trace_entries.map(traceEntryLabel)).toContain('relay.completed:act-step');
      expect(trace_entries.map(traceEntryLabel)).toContain('relay.completed:review-step');

      const implementation = BuildImplementation.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build/implementation.json'), 'utf8')),
      );
      expect(implementation.verdict).toBe('accept');

      const verification = BuildVerification.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build/verification.json'), 'utf8')),
      );
      expect(verification.overall_status).toBe('passed');
      expect(verification.commands[0]?.argv).toEqual(['npm', 'run', 'check']);

      const review = BuildReview.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build/review.json'), 'utf8')),
      );
      expect(review.verdict).toBe('accept');

      const result = BuildResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build-result.json'), 'utf8')),
      );
      expect(result.outcome).toBe('complete');
      expect(result.review_verdict).toBe('accept');
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'proves a change in a project with no package.json using the declared verification command',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'declared-verification');
      const argv = ['node', '-e', 'process.exit(0)'];

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000020',
        goal: 'Add a tiny Build feature',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 10, 0)),
        relayer: relayerWith(),
        projectRoot: makeDeclaredVerificationProjectRoot(argv),
      });

      // Before the config hatch this run could not start: the brief writer
      // blocked on the missing package.json, so Build and Fix were unusable in
      // every non-Node project.
      expect(outcome.outcome).toBe('complete');

      const verification = BuildVerification.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build/verification.json'), 'utf8')),
      );
      expect(verification.overall_status).toBe('passed');
      expect(verification.commands).toHaveLength(1);
      expect(verification.commands[0]?.argv).toEqual(argv);
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'reruns Build verification after a retry repair instead of aborting as a route cycle',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'verify-retry-complete');
      const checkScript = [
        'node',
        '-e',
        [
          "const fs = require('node:fs')",
          "const path = 'check-count.txt'",
          "const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0",
          'fs.writeFileSync(path, String(count + 1))',
          'process.exit(count === 0 ? 1 : 0)',
        ].join('; '),
      ]
        .map((part) => JSON.stringify(part))
        .join(' ');

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000010',
        goal: 'Retry implementation after first verification failure',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 5, 0)),
        relayer: relayerWith(),
        projectRoot: makeVerificationProjectRoot(checkScript),
      });

      expect(outcome.outcome).toBe('complete');
      const trace_entries = await readTraceEntries(runFolder);
      const actCompletions = trace_entries.filter(
        (
          trace_entry,
        ): trace_entry is Extract<(typeof trace_entries)[number], { kind: 'step.completed' }> =>
          trace_entry.kind === 'step.completed' && trace_entry.step_id === 'act-step',
      );
      const verifyCompletions = trace_entries.filter(
        (
          trace_entry,
        ): trace_entry is Extract<(typeof trace_entries)[number], { kind: 'step.completed' }> =>
          trace_entry.kind === 'step.completed' && trace_entry.step_id === 'verify-step',
      );
      expect(actCompletions.map((entry) => entry.attempt)).toEqual([1, 2]);
      expect(verifyCompletions.map((entry) => entry.attempt)).toEqual([1, 2]);
      expect(verifyCompletions.map((entry) => entry.route_taken)).toEqual(['retry', 'pass']);

      const verification = BuildVerification.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build/verification.json'), 'utf8')),
      );
      expect(verification.overall_status).toBe('passed');
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'implements and verifies each plan slice in turn under deep-depth (autonomous) slicing',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'sliced');

      const sliceContextBody = JSON.stringify({
        verdict: 'accept',
        sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches' }],
        observations: ['The change decomposes into three ordered units'],
        open_questions: [],
        anticipated_file_extensions: ['.ts'],
        slices: [
          { id: 'slice-1', intent: 'scaffold the module', anticipated_file_extensions: ['.ts'] },
          {
            id: 'slice-2',
            intent: 'wire it into the router',
            anticipated_file_extensions: ['.ts'],
          },
          {
            id: 'slice-3',
            intent: 'add tests for the module',
            anticipated_file_extensions: ['.test.ts'],
          },
        ],
      });

      const actPrompts: string[] = [];
      const baseRelayer = relayerWith({ contextBody: sliceContextBody });
      const relayer: RelayFn = {
        connectorName: baseRelayer.connectorName,
        relay: async (input) => {
          if (input.prompt.includes('Step: act-step')) actPrompts.push(input.prompt);
          return baseRelayer.relay(input);
        },
      };

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-00000000005c',
        goal: 'Add a feature that decomposes into slices',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 7, 0)),
        relayer,
        projectRoot: makeVerificationProjectRoot(),
      });

      expect(outcome.outcome).toBe('complete');
      const trace_entries = await readTraceEntries(runFolder);

      const actCompletions = trace_entries.filter(
        (entry): entry is Extract<(typeof trace_entries)[number], { kind: 'step.completed' }> =>
          entry.kind === 'step.completed' && entry.step_id === 'act-step',
      );
      const verifyCompletions = trace_entries.filter(
        (entry): entry is Extract<(typeof trace_entries)[number], { kind: 'step.completed' }> =>
          entry.kind === 'step.completed' && entry.step_id === 'verify-step',
      );

      // Three slices => three implement+verify passes on the shared tree.
      expect(actCompletions).toHaveLength(3);
      expect(verifyCompletions).toHaveLength(3);
      // Each slice gets a fresh per-slice attempt budget (no retries here).
      expect(actCompletions.map((entry) => entry.attempt)).toEqual([1, 1, 1]);
      expect(verifyCompletions.map((entry) => entry.attempt)).toEqual([1, 1, 1]);
      // Loop-body entries are slice-tagged in order.
      expect(actCompletions.map((entry) => entry.slice_index)).toEqual([0, 1, 2]);
      expect(verifyCompletions.map((entry) => entry.slice_index)).toEqual([0, 1, 2]);
      // The first two slices advance; the last proceeds to review.
      expect(verifyCompletions.map((entry) => entry.route_taken)).toEqual([
        'advance',
        'advance',
        'pass',
      ]);

      // Review and close run once, after the loop.
      const reviewCompletions = trace_entries.filter(
        (entry) => entry.kind === 'step.completed' && entry.step_id === 'review-step',
      );
      expect(reviewCompletions).toHaveLength(1);

      // The implementer is told which slice it is on, in order.
      expect(actPrompts).toHaveLength(3);
      expect(actPrompts[0]).toContain('scaffold the module');
      expect(actPrompts[1]).toContain('wire it into the router');
      expect(actPrompts[2]).toContain('add tests for the module');
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  const threeSliceContextBody = JSON.stringify({
    verdict: 'accept',
    sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches' }],
    observations: ['The change decomposes into three ordered units'],
    open_questions: [],
    anticipated_file_extensions: ['.ts'],
    slices: [
      { id: 'slice-1', intent: 'first unit', anticipated_file_extensions: ['.ts'] },
      { id: 'slice-2', intent: 'second unit', anticipated_file_extensions: ['.ts'] },
      { id: 'slice-3', intent: 'third unit', anticipated_file_extensions: ['.ts'] },
    ],
  });

  it(
    'stops at the first slice that cannot pass verification instead of advancing to later slices',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'slice-unfixable');
      // A check that always fails: the first slice can never reach a passing
      // verify, so the run exhausts the slice's retry budget and takes the
      // declared exhaustion route to close — WITHOUT advancing to slice 2,
      // and WITHOUT reading as success.
      const failingCheck = 'node -e "process.exit(1)"';

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-00000000005d',
        goal: 'A change whose first slice never verifies',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 8, 0)),
        relayer: relayerWith({ contextBody: threeSliceContextBody }),
        projectRoot: makeVerificationProjectRoot(failingCheck),
      });

      // The run closes stopped, not complete: the failing verification is on
      // record and the primary-result binding refuses to call the run a success.
      expect(outcome.outcome).toBe('stopped');
      const trace_entries = await readTraceEntries(runFolder);
      const completions = trace_entries.filter((entry) => entry.kind === 'step.completed');
      // Every loop-body completion stayed on slice 0; none advanced.
      const loopBody = completions.filter(
        (entry) => entry.step_id === 'act-step' || entry.step_id === 'verify-step',
      );
      for (const entry of loopBody) {
        expect((entry as { slice_index?: number }).slice_index).toBe(0);
      }
      // No verify ever took the advance route to a later slice.
      expect(
        completions.some(
          (entry) => entry.step_id === 'verify-step' && entry.route_taken === 'advance',
        ),
      ).toBe(false);
      // Exhaustion took verify-step's declared route instead of aborting, so
      // the close corridor (touch-area, review, close) still ran and the work
      // was preserved rather than discarded.
      const reroute = trace_entries.find((entry) => entry.kind === 'step.exhaustion_rerouted') as
        | { step_id?: string; from_route?: string; to_route?: string }
        | undefined;
      expect(reroute).toMatchObject({
        step_id: 'verify-step',
        from_route: 'retry',
        to_route: 'continue',
      });
      expect(completions.some((entry) => entry.step_id === 'review-step')).toBe(true);
      expect(completions.some((entry) => entry.step_id === 'close-step')).toBe(true);
      expect(trace_entries.some((entry) => entry.kind === 'step.aborted')).toBe(false);
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'retries a failing slice in place under its own budget, then advances once it passes',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'slice-retry-then-advance');
      // Fail the very first verify once, then pass every subsequent run. Only
      // slice 0 should retry; slices 1 and 2 pass on their first attempt.
      const checkScript = [
        'node',
        '-e',
        [
          "const fs = require('node:fs')",
          "const p = 'slice-check-count.txt'",
          "const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0",
          'fs.writeFileSync(p, String(n + 1))',
          'process.exit(n === 0 ? 1 : 0)',
        ].join('; '),
      ]
        .map((part) => JSON.stringify(part))
        .join(' ');

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-00000000005e',
        goal: 'A change whose first slice needs one retry',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 9, 0)),
        relayer: relayerWith({ contextBody: threeSliceContextBody }),
        projectRoot: makeVerificationProjectRoot(checkScript),
      });

      expect(outcome.outcome).toBe('complete');
      const trace_entries = await readTraceEntries(runFolder);
      const actCompletions = trace_entries.filter(
        (entry): entry is Extract<(typeof trace_entries)[number], { kind: 'step.completed' }> =>
          entry.kind === 'step.completed' && entry.step_id === 'act-step',
      );
      // slice 0 ran twice (retry after the failed verify); slices 1 and 2 once.
      expect(actCompletions.map((entry) => entry.slice_index)).toEqual([0, 0, 1, 2]);
      // Per-slice attempt budgets: slice 0 reaches attempt 2; later slices reset to 1.
      expect(actCompletions.map((entry) => entry.attempt)).toEqual([1, 2, 1, 1]);
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'passes the failed verification into the relaunched implementer prompt',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'verify-retry-carries-evidence');
      // Fail the first check, pass every later one, and print a marker the
      // verification report must carry so we can prove the retry prompt shows
      // the implementer WHAT failed rather than just that something did.
      const checkScript = [
        'node',
        '-e',
        [
          "const fs = require('node:fs')",
          "const p = 'verify-check-count.txt'",
          "const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0",
          'fs.writeFileSync(p, String(n + 1))',
          `if (n === 0) { console.log(${JSON.stringify(FAILING_CHECK_MARKER)}); process.exit(1) }`,
          'process.exit(0)',
        ].join('; '),
      ]
        .map((part) => JSON.stringify(part))
        .join(' ');

      const actPrompts: string[] = [];
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-00000000005f',
        goal: 'A change whose first verification fails',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 10, 0)),
        relayer: relayerRecordingActPrompts(actPrompts),
        projectRoot: makeVerificationProjectRoot(checkScript),
      });

      expect(outcome.outcome).toBe('complete');
      expect(actPrompts).toHaveLength(2);
      // First attempt: no verification exists yet, and the prompt says so.
      expect(actPrompts[0]).toContain('[reads unavailable: reports/build/verification.json]');
      // The relaunch after the failing verify must carry the report itself.
      expect(actPrompts[1]).toContain('<read path="reports/build/verification.json">');
      expect(actPrompts[1]).toContain(FAILING_CHECK_MARKER);
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'emits no slice_index on a standard (non-deep) single-pass run',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'no-slice-tag');

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-00000000005f',
        goal: 'Add a tiny Build feature',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 10, 0)),
        relayer: relayerWith({ contextBody: threeSliceContextBody }),
        projectRoot: makeVerificationProjectRoot(),
      });

      expect(outcome.outcome).toBe('complete');
      const trace_entries = await readTraceEntries(runFolder);
      // The corridor is inert below deep depth: even though the researcher
      // emitted slices, the run is single-pass and no entry carries slice_index.
      // Guards against an executor regression that always-emits the field
      // (which would fail RunTrace's .strict() parse for standard runs).
      const tagged = trace_entries.filter((entry) => 'slice_index' in entry);
      expect(tagged).toHaveLength(0);
      const actCompletions = trace_entries.filter(
        (entry) => entry.kind === 'step.completed' && entry.step_id === 'act-step',
      );
      expect(actCompletions).toHaveLength(1);
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'closes evidence_invalid when implementation relay passes the verdict check but fails build.implementation@v1 parsing',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'bad-implementation');

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000001',
        goal: 'Reject malformed implementation report',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 10, 0)),
        relayer: relayerWith({
          implementationBody: JSON.stringify({
            verdict: 'accept',
            summary: 'Missing evidence',
            changed_files: ['src/example.ts'],
          }),
        }),
        projectRoot: makeVerificationProjectRoot(),
      });

      expect(outcome.outcome).toBe('evidence_invalid');
      expect(outcome.reason).toMatch(/build\.implementation@v1/);
      expect(outcome.reason).toMatch(/evidence/);
      expect(existsSync(join(runFolder, 'reports/build/implementation.json'))).toBe(false);
      expect(existsSync(join(runFolder, 'reports/relay/build-act.result.json'))).toBe(true);
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'stops (needs attention) on a review reject over a green build, writing the review report and result',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'review-reject');

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000002',
        goal: 'Reject a blocking Build review',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 20, 0)),
        relayer: relayerWith({
          reviewBody: JSON.stringify({
            verdict: 'reject',
            summary: 'Blocking issue found',
            findings: [
              {
                severity: 'high',
                text: 'The implementation does not satisfy the requested goal',
                file_refs: ['src/example.ts:1'],
              },
            ],
            alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
          }),
        }),
        projectRoot: makeVerificationProjectRoot(),
      });

      // A reviewer's honest 'reject' on a green, verified build is a
      // needs-attention outcome, not a contract violation: the run STOPS
      // (operator-visible) rather than aborting. 'reject' flows forward to
      // close, the Build result records outcome 'failed', and the terminal
      // outcome binds to that honest result ('stopped').
      expect(outcome.outcome).toBe('stopped');
      expect(existsSync(join(runFolder, 'reports/build/review.json'))).toBe(true);
      expect(existsSync(join(runFolder, 'reports/relay/build-review.result.json'))).toBe(true);
      const result = BuildResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build-result.json'), 'utf8')),
      );
      expect(result.outcome).toBe('failed');
      expect(result.review_verdict).toBe('reject');
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'stops (needs attention) at depth high when the reviewer rejects a green build, without re-implementing to exhaustion',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'review-reject-high');
      // Depth-high verification exercises more scripts than `check`; give it a
      // full no-op script set so the run reaches the review step (green build).
      const noop = 'node -e "process.exit(0)"';
      const projectRoot = join(runFolderBase, 'reject-high-project');
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(
        join(projectRoot, 'package.json'),
        `${JSON.stringify(
          {
            private: true,
            scripts: { check: noop, build: noop, test: noop, lint: noop, typecheck: noop },
          },
          null,
          2,
        )}\n`,
      );

      const rejectReview = JSON.stringify({
        verdict: 'reject',
        summary: 'Reviewer will not accept',
        findings: [
          {
            severity: 'high',
            text: 'Subjective objection on a green build',
            file_refs: ['src/example.ts:1'],
          },
        ],
        alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
      });

      // Depth 'high' parks at the operator frame checkpoint before the corridor,
      // so a single-shot run pauses. Drive past it with the waiting+resume pattern.
      const waiting = await runCompiledFlowWithWaiting({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-00000000000d',
        goal: 'Green build the reviewer keeps rejecting',
        depth: 'high',
        now: deterministicNow(Date.UTC(2026, 3, 25, 9, 0, 0)),
        relayer: relayerWith({ reviewBody: rejectReview }),
        projectRoot,
      });
      if (!isGraphCheckpointWaitingResult(waiting)) {
        throw new Error('expected the depth-high run to park at the frame checkpoint');
      }
      const outcome = await resumeCompiledFlow({
        runDir: runFolder,
        selection: 'continue',
        now: deterministicNow(Date.UTC(2026, 3, 25, 9, 30, 0)),
        relayer: relayerWith({ reviewBody: rejectReview }),
      });

      // A subjective reject on a green, verified build is a needs-attention
      // outcome, not a contract violation. The run STOPS honestly instead of
      // re-entering act-step to re-implement the whole change and aborting on
      // max_attempts exhaustion. 'reject' flows forward to close; the Build
      // result records outcome 'failed'; the terminal binds to that.
      expect(outcome.outcome).toBe('stopped');
      const trace_entries = await readTraceEntries(runFolder);
      const reviewCompletions = trace_entries.filter(
        (e) => traceEntryLabel(e) === 'relay.completed:review-step',
      ).length;
      const actCompletions = trace_entries.filter(
        (e) => traceEntryLabel(e) === 'relay.completed:act-step',
      ).length;
      // No rework churn: the reviewer runs once and the implementer is not
      // re-driven by the reject. (A single slice, so one act pass.)
      expect(reviewCompletions).toBe(1);
      expect(actCompletions).toBe(1);
      expect(existsSync(join(runFolder, 'reports/build/review.json'))).toBe(true);
      const result = BuildResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build-result.json'), 'utf8')),
      );
      expect(result.outcome).toBe('failed');
      expect(result.review_verdict).toBe('reject');
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'closes evidence_invalid on accept-with-fixes without findings, before writing the canonical Build review report',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'review-empty-fixes');

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000003',
        goal: 'Reject a non-actionable Build review',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 30, 0)),
        relayer: relayerWith({
          reviewBody: JSON.stringify({
            verdict: 'accept-with-fixes',
            summary: 'Fixes needed but omitted',
            findings: [],
            alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
          }),
        }),
        projectRoot: makeVerificationProjectRoot(),
      });

      // A malformed review (accept-with-fixes with no findings) is an invalid
      // relay OUTPUT, a genuine contract violation: the relay completed but
      // its report failed validation, so the run closes evidence_invalid with
      // the schema-tied reason. This is distinct from an honest 'reject'
      // verdict, which flows forward to an operator-visible 'stopped'.
      expect(outcome.outcome).toBe('evidence_invalid');
      expect(outcome.reason).toMatch(/build\.review@v1/);
      expect(outcome.reason).toMatch(/findings/);
      expect(existsSync(join(runFolder, 'reports/build/review.json'))).toBe(false);
      expect(existsSync(join(runFolder, 'reports/relay/build-review.result.json'))).toBe(true);
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'stops (needs attention) when review accepts with required fixes',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'review-followups');

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000004',
        goal: 'Accept Build with follow-up fixes',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 35, 0)),
        relayer: relayerWith({
          reviewBody: JSON.stringify({
            verdict: 'accept-with-fixes',
            summary: 'Usable, but a follow-up is required',
            findings: [
              {
                severity: 'medium',
                text: 'Add coverage for the boundary case before treating this as done',
                file_refs: ['tests/example.test.ts:1'],
              },
            ],
            alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
          }),
        }),
        projectRoot: makeVerificationProjectRoot(),
      });

      // A required follow-up is a needs-attention outcome, not a clean success:
      // the Build result records 'needs_attention' and the run terminal binds to
      // that honest result ('stopped'), never a green 'complete'.
      expect(outcome.outcome).toBe('stopped');
      const result = BuildResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build-result.json'), 'utf8')),
      );
      expect(result.outcome).toBe('needs_attention');
      expect(result.review_verdict).toBe('accept-with-fixes');
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it('declares Build axes and reaches Review by the pass route', () => {
    const { flow } = loadFixture();
    expect(flow.axes).toMatchObject({
      allowed_depths: ['low', 'medium', 'high'],
      supports_tournament: false,
      supports_autonomous: true,
    });
    expect(flow.starts_at).toBe('frame-step');

    const stepsById = new Map(flow.steps.map((step) => [step.id as unknown as string, step]));
    const visited: string[] = [];
    let current: string | undefined = flow.starts_at as unknown as string;
    while (current !== undefined && !current.startsWith('@')) {
      visited.push(current);
      current = stepsById.get(current)?.routes.pass;
    }
    expect(visited).toEqual([
      'frame-step',
      'analyze-step',
      'plan-step',
      'build-baseline',
      'act-step',
      'verify-step',
      'build-touch-area',
      'review-step',
      'close-step',
    ]);
  });

  it(
    'uses the selected lite axis as the run depth when no explicit depth is supplied',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'lite-axis-selection');
      const relayInputs: ClaudeCodeRelayInput[] = [];
      const relayer = relayerWith();

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000004',
        goal: 'Add a tiny Build feature in lite mode',
        entryModeName: 'low',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 40, 0)),
        relayer: {
          connectorName: relayer.connectorName,
          relay: async (input) => {
            relayInputs.push(input);
            return relayer.relay(input);
          },
        },
        projectRoot: makeVerificationProjectRoot(),
      });

      const trace_entries = await readTraceEntries(runFolder);
      const bootstrap = traceEntryByKind(trace_entries, 'run.bootstrapped');
      const checkpoint = trace_entries.find(
        (trace_entry) =>
          trace_entry.kind === 'checkpoint.resolved' &&
          traceEntryLabel(trace_entry) === 'checkpoint.resolved:frame-step',
      );
      expect(outcome.outcome).toBe('complete');
      expect(bootstrap).toMatchObject({ depth: 'low' });
      expect(checkpoint).toMatchObject({
        selection: 'continue',
        resolution_source: 'declared-default',
      });
      expect(relayInputs[0]?.resolvedSelection).toMatchObject({ depth: 'low' });
      expect(trace_entries.map(traceEntryLabel)).toContain('relay.completed:review-step');
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'uses deep axis selection to pause at the operator checkpoint when no explicit depth is supplied',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'deep-axis-selection');

      const outcome = await runCompiledFlowWithWaiting({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000005',
        goal: 'Add a tiny Build feature in deep mode',
        entryModeName: 'high',
        now: deterministicNow(Date.UTC(2026, 3, 25, 8, 50, 0)),
        relayer: relayerWith(),
        projectRoot: makeVerificationProjectRoot(),
      });

      const trace_entries = await readTraceEntries(runFolder);
      const bootstrap = traceEntryByKind(trace_entries, 'run.bootstrapped');
      expect(outcome.outcome).toBe('checkpoint_waiting');
      expect(bootstrap).toMatchObject({ depth: 'high' });
      expect(trace_entries.map(traceEntryLabel)).not.toContain('run.closed');
      expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(false);
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'lets an explicit depth override the selected axis default',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'axis-depth-override');
      const relayInputs: ClaudeCodeRelayInput[] = [];
      const relayer = relayerWith();

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000006',
        goal: 'Add a tiny Build feature with an explicit standard override',
        entryModeName: 'high',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 25, 9, 0, 0)),
        relayer: {
          connectorName: relayer.connectorName,
          relay: async (input) => {
            relayInputs.push(input);
            return relayer.relay(input);
          },
        },
        projectRoot: makeVerificationProjectRoot(),
      });

      const trace_entries = await readTraceEntries(runFolder);
      const bootstrap = traceEntryByKind(trace_entries, 'run.bootstrapped');
      expect(outcome.outcome).toBe('complete');
      expect(bootstrap).toMatchObject({ depth: 'medium' });
      expect(relayInputs[0]?.resolvedSelection).toMatchObject({ depth: 'medium' });
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'uses explicit autonomous depth over the default axis for checkpoint policy',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'default-entry-autonomous-override');
      const relayInputs: ClaudeCodeRelayInput[] = [];
      const relayer = relayerWith();

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000009',
        goal: 'Add a tiny Build feature with explicit autonomous depth',
        entryModeName: 'default',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 3, 25, 9, 5, 0)),
        relayer: {
          connectorName: relayer.connectorName,
          relay: async (input) => {
            relayInputs.push(input);
            return relayer.relay(input);
          },
        },
        projectRoot: makeVerificationProjectRoot(),
      });

      const trace_entries = await readTraceEntries(runFolder);
      const bootstrap = traceEntryByKind(trace_entries, 'run.bootstrapped');
      const checkpoint = trace_entries.find(
        (trace_entry) =>
          trace_entry.kind === 'checkpoint.resolved' &&
          traceEntryLabel(trace_entry) === 'checkpoint.resolved:frame-step',
      );
      const checkpointGuidance = trace_entries.find(
        (trace_entry) =>
          trace_entry.kind === 'guidance.decision' &&
          trace_entry.subject === 'checkpoint_resolution' &&
          trace_entry.scope?.step_id === 'frame-step',
      );
      expect(outcome.outcome).toBe('complete');
      expect(bootstrap).toMatchObject({ depth: 'autonomous' });
      expect(checkpointGuidance).toMatchObject({
        source: 'deterministic',
        input_refs: [
          expect.objectContaining({
            kind: 'request',
            ref: 'reports/checkpoints/frame-step-request.json',
            step_id: 'frame-step',
          }),
        ],
        selected: {
          choice_id: 'continue',
          resolution_source: 'declared-default',
        },
        reason_codes: ['declared_default_allowed'],
      });
      expect(checkpoint).toMatchObject({
        selection: 'continue',
        resolution_source: 'declared-default',
      });
      expect(relayInputs[0]?.resolvedSelection).toMatchObject({ depth: 'autonomous' });
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );

  it(
    'uses autonomous axis selection to take the declared default checkpoint choice',
    async () => {
      const { bytes } = loadFixture();
      const runFolder = join(runFolderBase, 'autonomous-axis-selection');

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b2000000-0000-0000-0000-000000000007',
        goal: 'Add a tiny Build feature in autonomous mode',
        entryModeName: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 3, 25, 9, 10, 0)),
        relayer: relayerWith(),
        projectRoot: makeVerificationProjectRoot(),
      });

      const trace_entries = await readTraceEntries(runFolder);
      const bootstrap = traceEntryByKind(trace_entries, 'run.bootstrapped');
      const checkpoint = trace_entries.find(
        (trace_entry) =>
          trace_entry.kind === 'checkpoint.resolved' &&
          traceEntryLabel(trace_entry) === 'checkpoint.resolved:frame-step',
      );
      expect(outcome.outcome).toBe('complete');
      expect(bootstrap).toMatchObject({ depth: 'autonomous' });
      expect(checkpoint).toMatchObject({
        selection: 'continue',
        resolution_source: 'declared-default',
      });
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );
});
