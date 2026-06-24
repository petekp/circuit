// Flow-shape composition (experimental, default-OFF): the RUNNABILITY wall.
//
// The offline floor (evaluateValidity) judges a composed spec by the engine's
// STRUCTURAL gates — assemble + compile + catalog gate + a bound primary result.
// Those gates do not model one runtime fact: a compose or close step's builder
// declares REQUIRED upstream reads (by family schema), and the runtime aborts the
// step when a required read has no producer in the flow. So the floor can pass a
// spec that ABORTS the instant it runs — a false-negative the floor was blind to.
//
// `evaluateRunnability` closes that blind spot. It runs the SAME read-path
// resolvers the runtime uses (resolveComposeReadPaths / resolveCloseReadPaths)
// against the compiled flow, offline, and reports every step that would abort.
//
// The make-or-break case is RESEARCH_THEN_BUILD itself. It is offline-VALID, but
// its welded `plan` step (a build-family compose writer) requires build.brief@v1,
// and the compose `frame` role can only bind fix.brief@v1 — because build.brief@v1
// is produced by a CHECKPOINT writer, never a compose writer, so no compose step
// in the role set can produce it. The flow therefore aborts at `plan`, and
// selection cannot repair it. This file locks that finding, locks that a genuinely
// runnable composition (TRIAGE_ONLY) passes, and locks the opt-in composer wall.

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  type CompositionRoleSet,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import { deriveActualMenu } from '../../src/flows/composition/index.js';
import {
  findCloseBuilder,
  resolveCloseReadPaths,
} from '../../src/flows/registries/close-writers/registry.js';
import {
  findComposeBuilder,
  resolveComposeReadPaths,
} from '../../src/flows/registries/compose-writers/registry.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import { buildRuntimePackageIndex } from '../../src/runtime/manifest/runtime-package-index.js';

// A genuinely-novel linear short-tail shape that DOES run to @complete (the
// genuine-linear-LIVE rebind): its close binds the generic flow.result@v1, whose
// engine close builder declares no required reads. Used here as the runnable
// control — evaluateRunnability must NOT flag it.
const TRIAGE_ONLY: CompositionRoleSet = {
  id: 'triage-only-runnable',
  title: 'Triage Only',
  purpose: 'Investigate why a defect happens and report findings without fixing it.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

describe('composition runnability — the offline producibility wall', () => {
  it('RESEARCH_THEN_BUILD is offline-VALID but NOT runnable (the false-negative)', () => {
    const outcome = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('compose failed');

    // The floor (structural gates) passes it — exactly the false-negative.
    const validity = evaluateValidity(outcome.spec);
    expect(validity.valid).toBe(true);

    // But runnability detects the runtime abort the floor missed.
    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(false);
    expect(runnability.aborts.length).toBeGreaterThanOrEqual(1);

    // The aborting step is the welded `plan` compose writer, and the precise
    // reason is the unproduced build.brief@v1 required read.
    const planAbort = runnability.aborts.find((abort) => abort.stepId === 'plan');
    if (planAbort === undefined) {
      throw new Error(
        `expected an abort at the 'plan' step; got ${JSON.stringify(runnability.aborts)}`,
      );
    }
    expect(planAbort.schema).toBe('build.plan@v1');
    expect(planAbort.reason).toContain('build.brief@v1');
  });

  it('a genuinely runnable composition (TRIAGE_ONLY) is NOT flagged', () => {
    const outcome = composeFlow(TRIAGE_ONLY, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('compose failed');
    expect(evaluateValidity(outcome.spec).valid).toBe(true);

    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(true);
    expect(runnability.aborts).toEqual([]);
    // It checked real writers (frame compose + close) — not a vacuous pass.
    expect(runnability.checkedSteps).toBeGreaterThanOrEqual(2);
  });

  it('the opt-in composer self-heals an un-runnable composition by promoting frame to checkpoint', () => {
    // Default (flag off): byte-identical historical behavior — composes ok, but not runnable.
    const lenient = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
    if (!lenient.ok) throw new Error('lenient compose failed');
    expect(evaluateRunnability(lenient.spec).runnable).toBe(false);

    // enforceRunnability: the composer promotes the compose frame to checkpoint,
    // making the flow runnable (the build.brief@v1 self-heal).
    const strict = composeFlow(RESEARCH_THEN_BUILD, {
      definitions: flowDefinitions,
      enforceRunnability: true,
    });
    if (!strict.ok)
      throw new Error(
        `expected a self-healed composition, got walls: ${strict.walls.map((w) => w.reason).join(' | ')}`,
      );
    expect(evaluateRunnability(strict.spec).runnable).toBe(true);
  });

  it('FIDELITY: the offline verdict matches the REAL runtime read-path resolvers', () => {
    // evaluateRunnability builds a minimal runtime-index shape from the compiled
    // flow to stay inside the flows/ layer. Prove that shortcut agrees with the
    // engine's own CompiledFlow -> ExecutableFlow -> RuntimePackageIndex path, so
    // the offline check cannot silently drift from runtime truth.
    const outcome = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('compose failed');
    const validity = evaluateValidity(outcome.spec);
    if (!validity.schematic) throw new Error('no schematic');
    const compiled = compileSchematicToCompiledFlow(validity.schematic);
    const flows = compiled.kind === 'single' ? [compiled.flow] : [...compiled.flows.values()];

    const realAborts: string[] = [];
    for (const compiledFlow of flows) {
      const index = buildRuntimePackageIndex(fromCompiledFlow(compiledFlow));
      for (const step of index.flow.steps) {
        const report = (step.writes as Record<string, unknown>).report as
          | { path: string; schema: string }
          | undefined;
        if (report === undefined || typeof report !== 'object') continue;
        const composeBuilder = findComposeBuilder(report.schema);
        const closeBuilder = findCloseBuilder(report.schema);
        try {
          if (composeBuilder !== undefined) {
            resolveComposeReadPaths(composeBuilder, index.flow, step as never);
          } else if (closeBuilder !== undefined) {
            resolveCloseReadPaths(closeBuilder, index.flow, step as never);
          }
        } catch {
          realAborts.push(step.id);
        }
      }
    }

    const offlineAborts = evaluateRunnability(outcome.spec).aborts.map((abort) => abort.stepId);
    expect([...offlineAborts].sort()).toEqual([...realAborts].sort());
  });

  it('ROOT CAUSE: build.brief@v1 has no compose producer (checkpoint-only), so selection cannot repair', () => {
    // The frame role asks for a compose-kind brief. The only registered actual is
    // fix.brief@v1: build.brief@v1 is produced by a checkpoint writer, so it never
    // appears as a compose actual the frame role could bind. This is why the
    // mismatch is structural, not a selection mistake the composer could avoid.
    const menu = deriveActualMenu(flowDefinitions);
    const composeBriefActuals = menu
      .filter((entry) => entry.block === 'frame' && entry.executionKind === 'compose')
      .map((entry) => entry.actual);
    expect(composeBriefActuals).toContain('fix.brief@v1');
    expect(composeBriefActuals).not.toContain('build.brief@v1');
  });
});
