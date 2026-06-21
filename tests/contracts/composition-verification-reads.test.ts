// Flow-shape composition (experimental, default-OFF): the VERIFICATION-reads wall.
//
// A verification step sources its command list from an upstream typed report, a
// coupling the runtime enforces imperatively inside the writer's loadCommands:
// fix.verification reads fix.brief@v1, build.verification reads build.plan@v1.
// The block's declared input_contracts do NOT capture that read — run-verification
// declares verification.plan@v1 (ambient) + change.evidence@v1, never the brief.
// The hand-authored fix flow wires the brief in by hand (fix-verify's
// input: { proof, brief: 'fix.brief@v1', change }). A GENUINELY composed fix arc
// had no such hand-wiring, so its run-verification step omitted the brief read and
// ABORTED the instant the writer ran — the exact failure the live composed-arm run
// surfaced.
//
// This is the verification analog of the compose/close writer-coupling wall that
// composition-runnability.test.ts locks. Two changes close it, and this file pins
// both: (1) the composer injects each verification writer's REQUIRED reads into the
// step input (or walls if a required source is unproduced), and (2)
// evaluateRunnability now resolves verification reads too, so the offline floor
// would have caught the abort before any spend.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  type CompositionRoleSet,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import { reportPathForSchemaInRuntimeFlow } from '../../src/flows/registries/runtime-index.js';
import {
  findVerificationWriter,
  listVerificationWriters,
} from '../../src/flows/registries/verification-writers/registry.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import { buildRuntimePackageIndex } from '../../src/runtime/manifest/runtime-package-index.js';

// The full fix arc as a genuine block-level composition — frame the defect, gather
// context, diagnose, act, run verification, close with evidence. Mirrors the eval
// module's FIX_LINEAR_FULL, declared inline so this engine test does not depend on
// the evals/ tree. Its run-verification step is the case under test.
const FIX_FULL_ARC: CompositionRoleSet = {
  id: 'fix-full-arc',
  title: 'Genuine fix arc (block-level)',
  purpose:
    'Frame the defect, gather context, diagnose the cause, make the change, verify it, and close with evidence — assembled block by block.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// A verification step with NO upstream brief producer. run-verification's
// alternative input set is [verification.plan@v1], which is ambient, so this
// composes structurally — but the fix/build verification writer still needs its
// brief/plan source, which nothing produces. The composer must wall it.
const VERIFY_NO_SOURCE: CompositionRoleSet = {
  id: 'verify-no-source',
  title: 'Verify with no brief producer',
  purpose: 'A verification step with no upstream brief or plan — the writer has no command source.',
  roles: [
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// writes.report is `string | RuntimeIndexedReportRef` across the step union; the
// schema lives on the object form. Narrow before reading it.
function reportSchemaOf(step: { writes: { report?: unknown } }): string | undefined {
  const report = step.writes.report;
  if (typeof report !== 'object' || report === null) return undefined;
  return (report as { schema?: string }).schema;
}

function runtimeIndexOf(roleSet: CompositionRoleSet) {
  const outcome = composeFlow(roleSet, { definitions: flowDefinitions });
  if (!outcome.ok) {
    throw new Error(`compose failed: ${outcome.walls.map((w) => w.reason).join('; ')}`);
  }
  const validity = evaluateValidity(outcome.spec);
  if (validity.schematic === undefined) throw new Error('no schematic');
  const compiled = compileSchematicToCompiledFlow(validity.schematic);
  const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
  if (flow === undefined) throw new Error('no compiled flow');
  return buildRuntimePackageIndex(fromCompiledFlow(flow)).flow;
}

describe('composition verification-reads — the writer-coupling wall the floor missed', () => {
  it('the composed run-verification step READS its brief source (the live-failure regression)', () => {
    const flow = runtimeIndexOf(FIX_FULL_ARC);
    const verifyStep = flow.steps.find((step) => reportSchemaOf(step) === 'fix.verification@v1');
    if (verifyStep === undefined) throw new Error('no fix.verification@v1 step');

    // The brief report path the runtime writer demands. Before the fix the
    // composed step's reads did NOT include it (the abort); after, it must.
    const briefPath = reportPathForSchemaInRuntimeFlow(flow, 'fix.brief@v1');
    expect(verifyStep.reads).toContain(briefPath);
  });

  it('FIDELITY: the real runtime writer guard now passes (gets past the read check)', () => {
    const flow = runtimeIndexOf(FIX_FULL_ARC);
    const verifyStep = flow.steps.find((step) => reportSchemaOf(step) === 'fix.verification@v1');
    if (verifyStep === undefined) throw new Error('no fix.verification@v1 step');

    // Drive the ACTUAL runtime writer, not a reimplementation. Resolve it through
    // the registry (the engine's own catalog-derived access path) rather than
    // reaching into the flow package's writer internals. Its loadCommands throws
    // "requires step '<id>' to read <path>" if the brief read is missing, BEFORE
    // it reads the file. Post-fix it must clear that guard and instead die trying
    // to read the (nonexistent) brief file in an empty run folder — proof the
    // composer wired the exact read the runtime demands.
    const fixVerificationWriter = findVerificationWriter('fix.verification@v1');
    if (fixVerificationWriter === undefined) throw new Error('no fix verification writer');
    const runFolder = mkdtempSync(join(tmpdir(), 'verify-reads-'));
    try {
      expect(() =>
        fixVerificationWriter.loadCommands({ runFolder, flow, step: verifyStep as never }),
      ).toThrow(/ENOENT|no such file/i);
    } finally {
      rmSync(runFolder, { recursive: true, force: true });
    }
  });

  it('evaluateRunnability now EXERCISES the verification writer, not just compose/close', () => {
    const outcome = composeFlow(FIX_FULL_ARC, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('compose failed');

    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(true);
    expect(runnability.aborts).toEqual([]);
    // Three writers are now resolved: frame (compose), run-verification
    // (verification — the newly-covered arm), and close. Before the fix only the
    // two compose/close writers were checked, so this would be 2.
    expect(runnability.checkedSteps).toBeGreaterThanOrEqual(3);
  });

  it('the composer WALLS a verification step whose command source is unproduced', () => {
    // Structurally satisfiable (proof is ambient), but the verification writer has
    // no brief/plan to source commands from. The composer must refuse it rather
    // than emit a flow that aborts the instant the writer runs.
    const outcome = composeFlow(VERIFY_NO_SOURCE, { definitions: flowDefinitions });
    if (outcome.ok) {
      throw new Error('expected a verification-reads wall, got an ok composition');
    }
    const wallText = outcome.walls.map((wall) => `${wall.block}: ${wall.reason}`).join(' | ');
    expect(wallText).toContain('run-verification');
    expect(wallText).toContain('requires reading');
  });
});

// Source-coverage guard. The composer's verification-reads wiring and the offline
// floor only act on writers that declare a static `reads` descriptor. A writer
// whose loadCommands sources its command list from an upstream report but declares
// NO reads is silently skipped by both — exactly the gap that let the live
// composed-arm run abort (just relocated to whichever family the composer selects).
//
// We cover EVERY registered verification writer, not just the per-family "primary"
// one: deriveActualMenu surfaces all of them (including the auxiliary snapshot /
// touch-area / regression / change-set writers) as composer-reachable verification
// entries, so any of them could be the actual a verify role binds to. The invariant
// is therefore universal: a writer whose loadCommands guards on step.reads MUST
// declare those reads; only a writer with a guards=0 loadCommands is allow-listed.
// A new writer added without classifying it fails here, not at run time.
describe('verification-writer source coverage — no silent unwired-source gap', () => {
  // Writers whose loadCommands does NOT guard on step.reads (their commands are
  // intrinsic, sourced from nothing upstream). Keep this MINIMAL: only a writer
  // proven to have a guards=0 loadCommands belongs here. Everything else must
  // declare its reads. explainer.verification builds its command from intrinsic
  // flow state; fix.baseline-snapshot snapshots git state unconditionally and reads
  // nothing typed upstream.
  const UNCOUPLED = new Set(['explainer.verification@v1', 'fix.baseline-snapshot@v1']);
  const writers = listVerificationWriters();

  it('enumerates every registered verification writer (catches silent additions)', () => {
    // 12 registered verification writers today across fix / build / prototype /
    // pursuit / explainer — the per-family primary verification writers plus the
    // auxiliary baseline-snapshot / touch-area / regression / change-set writers,
    // all of which deriveActualMenu surfaces as composer-reachable. A new writer
    // raises this; classify it below (declare reads, or add to UNCOUPLED only if its
    // loadCommands is genuinely guards=0), do not lower it.
    expect(writers.length).toBeGreaterThanOrEqual(12);
  });

  for (const [schema, builder] of writers) {
    it(`${schema} declares its source reads (or is explicitly uncoupled)`, () => {
      const declaresRequiredRead = (builder.reads ?? []).some((read) => read.required);
      if (UNCOUPLED.has(schema)) {
        expect(
          declaresRequiredRead,
          `${schema} is allow-listed as uncoupled but declares required reads — remove it from UNCOUPLED`,
        ).toBe(false);
      } else {
        expect(
          declaresRequiredRead,
          `${schema} sources commands from an upstream report but declares no required reads — the composer will not wire it and the floor will skip it (silent runtime abort). Declare its reads or, only if genuinely source-free, add it to UNCOUPLED.`,
        ).toBe(true);
      }
    });
  }
});
