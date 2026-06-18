// Phase 2 — drive NOVEL composed topologies through the REAL graph runner.
//
// Phase 0/1 proved the composer emits flows that pass the engine's OFFLINE
// gates (assemble -> compile -> catalog -> primary-result binding). This harness
// closes the last gap: it takes composed flows (topologies no built-in has) and
// runs them through runCompiledFlow — the same runner a built-in uses — with a
// stub relayer (no model spend), to find out whether an offline-valid composed
// flow actually RUNS to a terminal outcome.
//
// It is the runtime parallel of the M9 truth test, but for composed-not-built-in
// shapes. The relay steps are fed schema-valid stub bodies, so the run is
// deterministic; what it exercises is the part NOT covered offline: whether the
// composed flow's compose/verification/close WRITERS can run on the composed
// wiring. A flow that compiled but whose writers cannot run aborts loudly here,
// with the runtime's own reason.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClaudeCodeRelayInput } from '../src/connectors/claude-code.js';
import { assembleFlowSchematic } from '../src/flows/assemble-flow-schematic.js';
import { flowDefinitions } from '../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../src/flows/compile-schematic-to-flow.js';
import {
  type CompositionRoleSet,
  RESEARCH_THEN_BUILD,
  composeFlow,
} from '../src/flows/composition/index.js';
import { runCompiledFlow } from '../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../src/runtime/trace/trace-store.js';
import type { RelayResult } from '../src/shared/connector-relay.js';
import type { RelayFn } from '../src/shared/relay-runtime-types.js';

function deterministicNow(startMs: number): () => Date {
  let tick = 0;
  return () => new Date(startMs + tick++ * 1000);
}

// A single-family novel topology: investigate why a defect happens and report,
// without fixing it. frame -> gather -> diagnose -> close, all served by fix.*.
// No built-in stops after diagnose, so the shape is novel; being all-fix removes
// the cross-family variable, isolating the writer-shape question.
const TRIAGE_ONLY: CompositionRoleSet = {
  id: 'triage-only',
  title: 'Triage Only',
  purpose: 'Investigate why a defect happens and report findings without fixing it.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// Schema-valid stub bodies keyed by the contract the step produces. Covers every
// relay actual the two topologies bind.
const STUB_BODY_BY_CONTRACT: Readonly<Record<string, string>> = {
  'build.context@v1': JSON.stringify({
    verdict: 'accept',
    sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches' }],
    observations: ['The target module is small and self-contained'],
    open_questions: [],
  }),
  'build.implementation@v1': JSON.stringify({
    verdict: 'accept',
    summary: 'Implemented the requested change',
    changed_files: ['src/example.ts'],
    evidence: ['Stub implementation relay completed'],
  }),
  'build.review@v1': JSON.stringify({
    verdict: 'accept',
    summary: 'No blocking issue found',
    findings: [],
    alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
  }),
  'fix.context@v1': JSON.stringify({
    verdict: 'accept',
    sources: [{ kind: 'file', ref: 'src/test.ts:1', summary: 'stub source' }],
    observations: ['Stubbed gather-context observation'],
    open_questions: [],
  }),
  'fix.diagnosis@v1': JSON.stringify({
    verdict: 'accept',
    reproduction_status: 'reproduced',
    cause_summary: 'stub cause',
    confidence: 'high',
    evidence: ['Stubbed diagnose evidence'],
    residual_uncertainty: [],
  }),
};

// Build a relayer that answers each relay step with the stub body for the
// contract that step produces. Keyed off the "Step: <id>" marker in the prompt.
function relayerFor(stepContractByStepId: ReadonlyMap<string, string>): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      let matched: string | undefined;
      for (const [stepId, contract] of stepContractByStepId) {
        if (input.prompt.includes(`Step: ${stepId}`)) {
          matched = contract;
          break;
        }
      }
      const body = matched === undefined ? '{}' : (STUB_BODY_BY_CONTRACT[matched] ?? '{}');
      return {
        request_payload: input.prompt,
        receipt_id: 'stub',
        result_body: body,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

function makeVerificationProjectRoot(base: string): string {
  const projectRoot = join(base, 'verification-project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

async function runComposed(roleSet: CompositionRoleSet, runId: string): Promise<void> {
  console.log(`\n======== ${roleSet.id} ========`);
  const outcome = composeFlow(roleSet, { definitions: flowDefinitions });
  if (!outcome.ok) {
    console.log('compose WALLED:', outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | '));
    return;
  }
  // Map each relay step id to the contract it produces, for the stub relayer.
  const relaySteps = new Map<string, string>();
  for (const item of outcome.spec.items) {
    const exec = (item as { execution?: { kind: string } }).execution;
    const output = item.output as string | undefined;
    if (exec?.kind === 'relay' && output !== undefined) {
      relaySteps.set(String(item.id), output);
    }
  }
  console.log('topology:', outcome.spec.items.map((i) => `${i.block}->${i.output}`).join(' > '));

  const compiled = compileSchematicToCompiledFlow(assembleFlowSchematic(outcome.spec));
  const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
  const bytes = Buffer.from(`${JSON.stringify(flow)}\n`);

  const base = mkdtempSync(join(tmpdir(), 'circuit-phase2-'));
  const runFolder = join(base, 'run');
  try {
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId,
      goal: 'Add a tiny feature to the example module',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 5, 18, 8, 0, 0)),
      relayer: relayerFor(relaySteps),
      projectRoot: makeVerificationProjectRoot(base),
    });
    console.log('OUTCOME:', result.outcome);

    const trace = (await new TraceStore(runFolder).load()) as unknown as Array<
      Record<string, unknown>
    >;
    const completed = trace
      .filter((e) => e.kind === 'step.completed')
      .map((e) => e.step_id)
      .join(', ');
    console.log('steps completed:', completed || '(none)');
    const aborts = trace.filter(
      (e) => typeof e.kind === 'string' && (e.kind as string).includes('abort'),
    );
    for (const a of aborts) console.log(`ABORT at '${a.step_id}': ${a.reason}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await runComposed(RESEARCH_THEN_BUILD, 'c0000000-0000-0000-0000-000000000001');
  await runComposed(TRIAGE_ONLY, 'c0000000-0000-0000-0000-000000000002');
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
