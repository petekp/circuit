// M9 truth test (first-class composition): run ONE built-in through the shared
// composed path — assemble → compile → RUN — and prove it is first-class.
//
// M7 proved (by equivalence) that build's shipped schematic can be
// reconstructed from its block sequence and COMPILES to the same CompiledFlow.
// That is a compile-time claim. M9's truth test extends it to RUNTIME: the
// flow produced from build's block spec (`buildAssemblySpec`) by the assembler,
// compiled, and handed to the real graph runner reaches the same terminal
// outcome — through the SAME runtime path a built-in uses. There is no second
// execution model for a composed/assembled flow.
//
// Two halves:
//   1. Compile parity. The assembled-then-compiled flow deep-equals both the
//      shipped build CompiledFlow (re-proving M7 from the production source in
//      src/) and the on-disk generated/flows/build/circuit.json the runtime
//      actually loads. So the assembled artifact IS the bytes the runtime runs.
//   2. Run validity. Those bytes drive a full Build run — checkpoint, analyze
//      relay, plan, baseline, act relay, verify, touch-area, review relay,
//      close — to @complete on the real runner. Not tautological with M7: it
//      exercises the end-to-end pipeline (spec → assemble → compile → run →
//      terminal), so an assembled flow that compiled but could not run would
//      fail loudly here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { buildFlowDefinition } from '../../src/flows/build/flow.js';
import { BuildResult } from '../../src/flows/build/reports.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { schematicForFlowDefinition } from '../../src/flows/flow-definition.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const ON_DISK_FIXTURE = resolve('generated/flows/build/circuit.json');
const BUILD_RUNTIME_TIMEOUT_MS = 15_000;

function compileSingle(schematic: ReturnType<typeof assembleFlowSchematic>): CompiledFlow {
  const result = compileSchematicToCompiledFlow(schematic);
  if (result.kind !== 'single') {
    throw new Error(`expected a single compiled flow, got '${result.kind}'`);
  }
  return result.flow;
}

// Stub relayer for build's three relay roles, keyed off the step marker the
// prompt carries. Mirrors tests/runner/build-runtime-wiring.ts so the truth
// test drives the assembled flow with the same inputs a built-in run uses.
function relayerWith(): RelayFn {
  const implementationBody = JSON.stringify({
    verdict: 'accept',
    summary: 'Implemented the requested change',
    changed_files: ['src/example.ts'],
    evidence: ['Stub implementation relay completed'],
  });
  const reviewBody = JSON.stringify({
    verdict: 'accept',
    summary: 'No blocking issue found',
    findings: [],
    alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
  });
  const contextBody = JSON.stringify({
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

function traceEntryLabel(trace_entry: { kind: string; step_id?: unknown }): string {
  return typeof trace_entry.step_id === 'string'
    ? `${trace_entry.kind}:${trace_entry.step_id}`
    : trace_entry.kind;
}

let runFolderBase: string;

function makeVerificationProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'verification-project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-m9-truth-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('M9 truth test — one built-in through the shared composed path', () => {
  it('assembles the build spec to the same FlowSchematic as the shipped definition', () => {
    // Schematic-level parity. The compiled-parity tests below can miss
    // schematic fields the compiler drops (e.g. stage_path_policy mode); this
    // deep-equal proves the assembled schematic IS the shipped schematic, so
    // flipping data.ts to consume the assembler keeps src/flows/build/
    // schematic.json byte-identical (both serialize the same FlowSchematic.parse
    // output, which Zod emits in schema-declaration order).
    const assembled = assembleFlowSchematic(buildAssemblySpec);
    const shipped = schematicForFlowDefinition(buildFlowDefinition);
    expect(assembled).toEqual(shipped);
  });

  it('compiles the assembled build to the same CompiledFlow as the shipped definition', () => {
    const assembled = compileSingle(assembleFlowSchematic(buildAssemblySpec));
    const shipped = compileSingle(schematicForFlowDefinition(buildFlowDefinition));
    expect(assembled).toEqual(shipped);
  });

  it('compiles the assembled build to the on-disk circuit.json the runtime loads', () => {
    const assembled = compileSingle(assembleFlowSchematic(buildAssemblySpec));
    const onDisk = CompiledFlow.parse(JSON.parse(readFileSync(ON_DISK_FIXTURE, 'utf8')));
    expect(CompiledFlow.parse(assembled)).toEqual(onDisk);
  });

  it(
    'runs the assembled build through the real runner to @complete',
    async () => {
      const assembled = compileSingle(assembleFlowSchematic(buildAssemblySpec));
      const bytes = Buffer.from(`${JSON.stringify(assembled)}\n`);
      const runFolder = join(runFolderBase, 'assembled-run');

      // The goal text avoids proof words ("run", "verify", …) next to "build"
      // so the verification resolver requests the `general` script (check),
      // which the verification project provides. See `goalAsksForNeed`.
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: 'b9000000-0000-0000-0000-000000000000',
        goal: 'Add a tiny feature to the example module',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 14, 8, 0, 0)),
        relayer: relayerWith(),
        projectRoot: makeVerificationProjectRoot(),
      });

      expect(outcome.outcome).toBe('complete');

      const trace = await new TraceStore(runFolder).load();
      const labels = trace.map(traceEntryLabel);
      // The full canonical Build path executed on the shared runner.
      expect(labels).toContain('checkpoint.resolved:frame-step');
      expect(labels).toContain('relay.completed:analyze-step');
      expect(labels).toContain('relay.completed:act-step');
      expect(labels).toContain('step.completed:verify-step');
      expect(labels).toContain('step.completed:build-touch-area');
      expect(labels).toContain('relay.completed:review-step');
      expect(labels).toContain('step.completed:close-step');

      const result = BuildResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build-result.json'), 'utf8')),
      );
      expect(result.outcome).toBe('complete');
      expect(result.review_verdict).toBe('accept');
    },
    BUILD_RUNTIME_TIMEOUT_MS,
  );
});
