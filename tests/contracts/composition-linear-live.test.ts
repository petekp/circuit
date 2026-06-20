// Flow-shape composition (experimental, default-OFF): a composed LINEAR flow
// runs LIVE to @complete — the genuine-linear-LIVE unlock.
//
// The sub-run and fanout shapes already proved a composed flow can RUN; both
// terminate on a fanout/sub-run aggregate, not on the ordinary close-with-evidence
// terminal a plain linear flow uses. A composed linear short-tail flow could not
// run: the close block's generic output (flow.result@v1) is aliased by every
// shipped flow to a FAMILY result (fix.result@v1, build.result@v1, …), so
// selectActual binds the close to a family result whose close builder declares a
// full origin-family pipeline as REQUIRED reads. A triage flow (frame → gather →
// diagnose → close) cannot produce change/verification/regression evidence, so the
// run ABORTED at close time — the runtime close-read resolver threw on the first
// unproduced required read (`fix.result@v1 requires close step '…' to read …`).
//
// The fix mirrors the fanout #126 move: the close block ALREADY defaults to the
// generic flow.result@v1; we registered a schema + a reads-agnostic engine close
// builder for it, and the composer now leaves the terminal at that generic
// (instead of an un-runnable family bind) whenever the bound family's required
// reads are not all produced upstream. A full fix/build-shaped composition still
// binds its family result, because its required reads ARE produced.
//
// This file locks both halves:
//   - OFFLINE: the composed triage terminal binds flow.result@v1, not a family
//     result, and the spec is VALID by the real engine gates.
//   - LIVE: the compiled triage flow RUNS through the real engine with a stub
//     relayer and closes @complete, writing a valid flow.result@v1 body whose
//     evidence_links carry the soaked upstream reports.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { planCompiledFlowFiles } from '../../src/flows/compiled-flow-file-plan.js';
import {
  type CompositionRoleSet,
  composeFlow,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// A genuinely-novel linear short-tail shape: investigate a defect and report,
// with no act/verify/review back. Its close cannot satisfy fix.result@v1's
// required reads, so it exercises the rebind.
const TRIAGE_ONLY: CompositionRoleSet = {
  id: 'triage-only-live',
  title: 'Triage Only',
  purpose: 'Investigate why a defect happens and report findings without fixing it.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// Deterministic stub relayer. Each relay step's prompt names the contract it will
// validate its body against ("…against <contract>") and its accepted verdicts.
// We forge a minimal valid body per contract so the relay clears its own check and
// the run advances to the close writer — the thing under test.
const RELAY_BODIES: Record<string, unknown> = {
  'fix.context@v1': {
    verdict: 'accept',
    sources: [{ kind: 'file', ref: 'src/checkout.ts', summary: 'the module under investigation' }],
    observations: ['the defect originates in the discount calculation path'],
    open_questions: [],
  },
  'fix.diagnosis@v1': {
    verdict: 'accept',
    reproduction_status: 'reproduced',
    cause_summary: 'off-by-one in the discount loop bound',
    confidence: 'high',
    evidence: ['repro confirmed at src/checkout.ts:42'],
    residual_uncertainty: [],
  },
};

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

// Triage makes no edits and runs no verification, so the worktree is only ever
// set up, never diffed. A no-op worktree runner keeps the test off real git.
function stubWorktreeRunner() {
  return {
    add() {},
    remove() {},
    changedFiles() {
      return [] as string[];
    },
  };
}

function triageFlowBytes(): Uint8Array {
  const composed = composeFlow(TRIAGE_ONLY, { definitions: flowDefinitions });
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
  baseDir = await mkdtemp(join(tmpdir(), 'circuit-linear-live-'));
});
afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('flow-shape composition — composed linear flow runs LIVE', () => {
  const composed = composeFlow(TRIAGE_ONLY, { definitions: flowDefinitions });

  it('binds the terminal to the generic flow.result@v1, not an un-runnable family result', () => {
    if (!composed.ok) throw new Error('compose failed');
    const closeStep = composed.spec.items[composed.spec.items.length - 1];
    if (!closeStep) throw new Error('no close step');
    // The close defaults to flow.result@v1; the rebind keeps it there (the family
    // result would be emitted as an explicit `output` override). So no output
    // override is present, and no contract_alias rewrites the generic to a family.
    expect(closeStep.output).toBeUndefined();
    const aliasesGenericAway = (composed.spec.contract_aliases ?? []).some(
      (a) => a.generic === 'flow.result@v1',
    );
    expect(aliasesGenericAway).toBe(false);
  });

  it('the composed triage spec is VALID by the real engine gates', () => {
    if (!composed.ok) throw new Error('compose failed');
    const validity = evaluateValidity(composed.spec);
    if (!validity.valid) {
      throw new Error(
        `not valid: compiles=${validity.compiles} primary=${validity.boundPrimaryResult} error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
      );
    }
    expect(validity.valid).toBe(true);
    expect(validity.boundPrimaryResult).toBe(true);
  });

  it('LIVE: the compiled triage flow runs through the real engine and closes @complete', async () => {
    const runDir = join(baseDir, 'run');
    // The frame step resolves verification commands up front, which reads the
    // project root's package.json — present even though triage runs no verify.
    await writeFile(
      join(baseDir, 'package.json'),
      JSON.stringify({ name: 'linear-live-fixture', scripts: { test: 'true' } }),
    );
    const result = await runCompiledFlow({
      runDir,
      flowBytes: triageFlowBytes(),
      runId: '00000000-0000-0000-0000-00000000beef',
      goal: 'Investigate why the discount is wrong and report findings',
      depth: 'low',
      relayer: stubRelayer(),
      worktreeRunner: stubWorktreeRunner(),
      projectRoot: baseDir,
      selectionConfigLayers: [],
    });

    if (result.outcome !== 'complete') {
      throw new Error(`composed triage did not complete: outcome=${result.outcome}`);
    }
    expect(result.outcome).toBe('complete');

    // The terminal wrote the generic flow.result@v1 body, not a family result.
    const closeReport = JSON.parse(
      await readFile(join(runDir, 'reports/triage-only-live/close-with-evidence.json'), 'utf8'),
    ) as { schema_version: number; outcome: string; evidence_links: string[]; summary: string };
    expect(closeReport.schema_version).toBe(1);
    expect(closeReport.outcome).toBe('complete');
    // Evidence-soak folds the otherwise-unconsumed upstream reports into the close,
    // and the generic builder reports them — so the diagnosis is carried, not dropped.
    expect(closeReport.evidence_links.length).toBeGreaterThan(0);
    expect(closeReport.evidence_links.some((p) => p.includes('diagnose'))).toBe(true);
  });
});
