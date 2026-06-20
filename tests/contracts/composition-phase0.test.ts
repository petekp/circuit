// Phase 0 make-or-break: can the experimental composer INVENT one genuinely
// novel, valid, sensible flow offline, reusing only registered actuals?
//
// The decision rule is pre-registered in
// docs/ideas/flow-composition-preregistration.md §5.1: produce >= 1 flow that is
// Novel AND Valid AND Sensible for the research-then-build task, offline,
// deterministically, with no invented contract bodies. This test is that gate.
// "Valid" is measured by the REAL engine gates only — assemble + compile +
// catalog gate — never by the test's own judgment.

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateNovelty,
  evaluateSensibility,
  evaluateValidity,
} from '../../src/flows/composition/index.js';

describe('Phase 0 — flow-shape composition make-or-break', () => {
  const outcome = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });

  it('composes a flow without hitting a wall', () => {
    if (!outcome.ok) {
      throw new Error(
        `composer hit walls: ${outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`,
      );
    }
    expect(outcome.ok).toBe(true);
  });

  it('binds only registered actuals (no invented contract bodies)', () => {
    if (!outcome.ok) throw new Error('compose failed');
    // Every selected actual must differ from its block generic (it is a real
    // specialization) — the composer never emits a block output raw — with ONE
    // documented exception: the terminal close may bind the generic
    // flow.result@v1 raw (the genuine-linear-LIVE rebind). When no family
    // result's required upstream reads are produced (a short-tail topology, or a
    // multi-family flow whose terminal family demands evidence it never makes),
    // the composer leaves the close at its registered generic flow.result@v1
    // instead of an un-runnable family bind. That generic carries a registered
    // body and a reads-agnostic engine close builder, so it is NOT an invented
    // contract — the "no invented bodies" intent holds.
    for (const selection of outcome.selections) {
      if (selection.actual === 'flow.result@v1') continue;
      expect(selection.actual).not.toEqual(selection.generic);
    }
    // The aliases map generics to actuals; none introduces an unregistered body
    // (the catalog gate below would catch one, but assert the intent here too).
    expect(outcome.spec.contract_aliases?.length).toBeGreaterThan(0);
  });

  it('is VALID by the real engine gates (assemble + compile + catalog gate)', () => {
    if (!outcome.ok) throw new Error('compose failed');
    const validity = evaluateValidity(outcome.spec);
    // Surface the precise blocker if this regresses.
    if (!validity.valid) {
      throw new Error(
        `not valid: compiles=${validity.compiles} catalogIssues=${validity.catalogIssueCount} primary=${validity.boundPrimaryResult} error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
      );
    }
    expect(validity.catalogIssueCount).toBe(0);
    expect(validity.compiles).toBe(true);
    expect(validity.boundPrimaryResult).toBe(true);
  });

  it('is NOVEL — its block sequence equals no built-in', () => {
    if (!outcome.ok) throw new Error('compose failed');
    const validity = evaluateValidity(outcome.spec);
    const { schematic } = validity;
    if (!schematic) throw new Error('valid spec produced no schematic');
    const novelty = evaluateNovelty(schematic, flowDefinitions);
    if (!novelty.novel) {
      throw new Error(`not novel: matches built-in '${novelty.matches}' (${novelty.sequence})`);
    }
    expect(novelty.novel).toBe(true);
  });

  it('is SENSIBLE — contract + intent closure, no orphan, goal-reaching', () => {
    if (!outcome.ok) throw new Error('compose failed');
    const validity = evaluateValidity(outcome.spec);
    if (!validity.schematic) throw new Error('valid spec produced no schematic');
    const sensibility = evaluateSensibility(validity.schematic, {
      boundPrimaryResult: validity.boundPrimaryResult,
    });
    if (!sensibility.sensible) {
      throw new Error(`not sensible: ${sensibility.failures.join(' | ')}`);
    }
    expect(sensibility.contractClosure).toBe(true);
    expect(sensibility.intentClosure).toBe(true);
    expect(sensibility.noOrphan).toBe(true);
    expect(sensibility.goalReaching).toBe(true);
  });

  it('binds a POST-CHANGE verification, not a pre-change baseline', () => {
    if (!outcome.ok) throw new Error('compose failed');
    // The run-verification BLOCK is reused for several sub-purposes across flows
    // (pre-change baseline capture, post-change verification, touch-area proof).
    // They share a generic and an intent state, so the locked rubric cannot tell
    // them apart — but a flow that runs a *baseline* where it means to *verify*
    // is wrong. The composer must pick the donor flow's PRIMARY (first
    // post-change) use of the block. Assert the structural invariant, not a name:
    // the selected actual's donor step runs AFTER its donor flow's `act` step.
    const verifySelection = outcome.selections.find((s) => s.block === 'run-verification');
    if (!verifySelection) throw new Error('no run-verification selection');
    const selectedActual = verifySelection.actual;

    // Locate the donor step that produces this actual and its flow's act step.
    let proven = false;
    for (const def of flowDefinitions) {
      const items = def.schematic.items;
      const donorIndex = items.findIndex((it) => String(it.output) === selectedActual);
      if (donorIndex === -1) continue;
      const actIndex = items.map((it) => String(it.block)).lastIndexOf('act');
      // A donor flow with no act step cannot disprove the invariant; skip it.
      if (actIndex === -1) continue;
      expect(donorIndex).toBeGreaterThan(actIndex);
      proven = true;
    }
    expect(proven).toBe(true);
  });

  it('is CONSISTENT — K=10 composes collapse to one spec', () => {
    const draws = Array.from({ length: 10 }, () =>
      composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions }),
    );
    const serialized = draws.map((draw) =>
      draw.ok ? JSON.stringify(draw.spec) : `wall:${JSON.stringify(draw.walls)}`,
    );
    const distinct = new Set(serialized);
    expect(distinct.size).toBe(1);
  });
});
