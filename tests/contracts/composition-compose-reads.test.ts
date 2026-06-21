// Flow-shape composition (experimental, default-OFF): INTERMEDIATE COMPOSE-READS
// WIRING — the goal-family reachability fix (Phase C).
//
// A compose writer can source REQUIRED evidence from an upstream typed report the
// same way a verification writer sources its command list. The goal-contract
// writer (goal.contract@v1) requires reading goal.clarified-task@v1 — the precise
// task an upstream `clarify` relay produces — but the `goal` block's declared
// input_contracts capture only task.intake@v1 / route.decision@v1, never the
// clarified task. So a composed `goal` step omits the read and ABORTS the instant
// the contract writer runs (resolveComposeReadPaths throws "requires step 'goal'
// to read .../clarify.json").
//
// Two facts make this a clean two-part fix, both proven by probe:
//   (1) PRODUCER. Opening GOAL_THEN_FIX on `goal` leaves goal.clarified-task@v1
//       with ZERO producers. Prepending a `clarify` relay binds the goal family's
//       own goal.clarified-task@v1 actual (exact name match) — the producer now
//       exists.
//   (2) WIRING. Even with the producer present, the composer did not wire the
//       contract writer's required read into the goal step's input, so the abort
//       only MOVED ("requires step 'goal' to read .../clarify.json"). The
//       intermediate-compose-reads pass closes that: for a non-terminal compose
//       role, it wires every required compose-writer read that an upstream
//       selection PRODUCES into the step input. An unproduced read is SKIPPED
//       silently (not walled), so research-then-build's build.brief opener stays
//       composable and the runnability gate — not a compose-time wall — reports
//       its abort.
//
// This file locks: (A) GOAL_CLARIFY_THEN_FIX runs end to end (goal reads the
// clarified task, terminal close falls back to the generic flow.result@v1, the
// sub-run targets fix); (B) the bare GOAL_THEN_FIX goal-opener is still NOT
// runnable (the producer, not magic, is what the clarify prepend adds); and (C)
// research-then-build still composes ok with the wiring pass present (the
// unproduced build.brief read is skipped, not walled — its default-ok behavior and
// its existing runnability wall are untouched).

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  GOAL_CLARIFY_THEN_FIX,
  GOAL_THEN_FIX,
  RESEARCH_THEN_BUILD,
  composeFlow,
  deriveActualMenu,
  evaluateRunnability,
  evaluateValidity,
  keyFor,
} from '../../src/flows/composition/index.js';
import { listComposeWriters } from '../../src/flows/registries/compose-writers/registry.js';
import { FLOW_BLOCK_DEFINITIONS } from '../../src/schemas/flow-block-definitions.js';

describe('composition intermediate compose-reads — the goal-family reachability fix', () => {
  it('A: GOAL_CLARIFY_THEN_FIX runs end to end — goal reads the clarified task, close is generic', () => {
    const outcome = composeFlow(GOAL_CLARIFY_THEN_FIX, { definitions: flowDefinitions });
    if (!outcome.ok) {
      throw new Error(`walls: ${outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`);
    }

    // The clarify relay produces the goal family's clarified-task actual.
    expect(outcome.selections.find((s) => s.block === 'clarify')?.actual).toBe(
      'goal.clarified-task@v1',
    );

    // The goal step now READS that clarified task — the wiring pass added it
    // ALONGSIDE the block's declared task/route inputs, not over them (the no-drop
    // proof: a key collision would have silently overwritten a declared input).
    const goalStep = outcome.spec.items.find((it) => String(it.block) === 'goal');
    if (goalStep === undefined) throw new Error('no goal step');
    const goalInputs = Object.values(goalStep.input ?? {});
    expect(goalInputs).toContain('goal.clarified-task@v1');
    expect(goalInputs).toContain('task.intake@v1');
    expect(goalInputs).toContain('route.decision@v1');

    // The terminal close rebinds to the reads-agnostic generic — the goal family's
    // own close evidence is not produced by this short arc.
    expect(outcome.selections.find((s) => s.block === 'close-with-evidence')?.actual).toBe(
      'flow.result@v1',
    );

    // The sub-run still targets the Fix child flow.
    const act = outcome.spec.items.find((it) => String(it.block) === 'goal-child-run');
    const ref = (act?.execution as Record<string, unknown> | undefined)?.flow_ref as
      | Record<string, unknown>
      | undefined;
    expect(ref?.flow_id).toBe('fix');

    // Structurally sound AND runnable end to end — no abort anywhere.
    expect(evaluateValidity(outcome.spec).valid).toBe(true);
    const runnability = evaluateRunnability(outcome.spec);
    if (!runnability.runnable) {
      throw new Error(`not runnable; aborts: ${JSON.stringify(runnability.aborts)}`);
    }
    expect(runnability.runnable).toBe(true);
    expect(runnability.aborts).toEqual([]);
  });

  it('B: the bare goal-opener GOAL_THEN_FIX is still NOT runnable — the clarify prepend adds the producer', () => {
    const outcome = composeFlow(GOAL_THEN_FIX, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('compose failed');

    // Valid offline, but the goal-contract writer's required clarified-task read
    // has no producer (no clarify upstream), so the run aborts at `goal`.
    expect(evaluateValidity(outcome.spec).valid).toBe(true);
    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(false);
    const goalAbort = runnability.aborts.find((abort) => abort.stepId === 'goal');
    if (goalAbort === undefined) {
      throw new Error(`expected a 'goal' abort; got ${JSON.stringify(runnability.aborts)}`);
    }
    expect(goalAbort.reason).toContain('goal.clarified-task@v1');
  });

  it('C: research-then-build still composes ok — an unproduced compose read is skipped, not walled', () => {
    // The build `plan` writer requires reading build.brief@v1, which no upstream
    // selection produces in this research-front arc. The wiring pass must SKIP it
    // silently (the runnability gate reports the abort) rather than wall at compose
    // time — preserving the default ok=true the runnability test locks.
    const outcome = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(false);
    expect(runnability.aborts.some((abort) => abort.stepId === 'plan')).toBe(true);
  });
});

// Collision guard. The wiring pass keys each wired read by its `read.name`, while a
// step's declared inputs are keyed by `keyFor(contract)`. If a required read name
// equals a declared input key AND the read resolves to a DIFFERENT contract, the
// pass would shadow a real declared input (the no-drop property test A checks for
// the goal builder). This guard enforces the catalog convention that makes the pass
// universally safe: for EVERY registered compose builder, each required read name is
// either distinct from all of the producing block's declared input keys, or collides
// only with an input that holds the SAME contract (benign — the alreadyRead guard
// then makes it a no-op). A future writer that introduces a clashing read name fails
// here, at build time, not at run time.
describe('compose-reads collision guard — no required read name shadows a declared input key', () => {
  const menu = deriveActualMenu(flowDefinitions);
  const blockByComposeActual = new Map<string, string>();
  const genericByActual = new Map<string, string>();
  for (const entry of menu) {
    genericByActual.set(entry.actual, entry.generic);
    if (entry.executionKind === 'compose') blockByComposeActual.set(entry.actual, entry.block);
  }
  const blockById = new Map(FLOW_BLOCK_DEFINITIONS.map((block) => [String(block.id), block]));
  const builders = listComposeWriters();

  it('enumerates every registered compose builder (catches silent additions)', () => {
    // A new compose builder raises this count; the per-builder guard below then
    // forces it to be collision-safe. Do not lower it.
    expect(builders.length).toBeGreaterThanOrEqual(1);
  });

  for (const [schema, builder] of builders) {
    const requiredReads = (builder.reads ?? []).filter((read) => read.required);
    if (requiredReads.length === 0) continue;
    it(`${schema}: required read names do not shadow a different-schema declared input key`, () => {
      const blockId = blockByComposeActual.get(schema);
      // A builder whose schema is not surfaced as a compose menu actual is never
      // bound by the composer, so the wiring pass never runs for it — no collision
      // risk to guard.
      if (blockId === undefined) return;
      const block = blockById.get(blockId);
      if (block === undefined) throw new Error(`no block definition for '${blockId}'`);
      const declared = [
        ...block.input_contracts.map(String),
        ...(block.alternative_input_contracts ?? []).flat().map(String),
      ];
      const contractByKey = new Map<string, string>();
      for (const contract of declared) contractByKey.set(keyFor(contract), contract);

      for (const read of requiredReads) {
        const collidedContract = contractByKey.get(read.name);
        if (collidedContract === undefined) continue; // no key collision — safe
        // A read whose schema is never produced as a menu actual can never be wired
        // (producedActuals.has is false), so its name cannot shadow anything.
        const readGeneric = genericByActual.get(read.schema);
        if (readGeneric === undefined) continue;
        // The collision is benign only if the read resolves to the same contract the
        // declared key already holds.
        expect(
          readGeneric,
          `${schema} read '${read.name}' shadows declared input key '${read.name}' (which holds '${collidedContract}') but resolves to a different contract ('${readGeneric}', from read schema '${read.schema}') — the wiring pass would drop the declared input. Rename the read.`,
        ).toBe(collidedContract);
      }
    });
  }
});
