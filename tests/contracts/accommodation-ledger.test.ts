// M1 (first-class composition): the accommodation-ledger gate.
//
// The catalog-check ratchet proves the eight schematics sit at or below their
// recorded issue ceilings. This gate proves the OTHER half of honesty: that the
// ceilings were lowered by correction, not by aliasing a generic onto a contract
// nothing produces. Every contract_alias must cite a real producer. The M5
// fail-closed compile-gate flip is forbidden while any accommodation stands, so
// the load-bearing assertion here is: zero accommodations.
//
// See src/flows/accommodation-ledger.ts for the alias-vs-widening scope split
// and why multi-actual generics are reported (not gated) until M8.
import { describe, expect, it } from 'vitest';

import {
  collectAccommodationLedger,
  collectBodyDivergence,
  collectConsumedDivergenceIssues,
} from '../../src/flows/accommodation-ledger.js';
import { resolveFieldSignature } from '../../src/flows/contract-body-signature.js';
import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import {
  schematicForFlow,
  shippedFlowIds,
  shippedFlowSchematics,
} from '../helpers/in-memory-schematics.js';

describe('accommodation ledger', () => {
  it('analyzes the in-memory schematics it is given, not files on disk (M6)', () => {
    // M6: the ledger is a pure analyzer over the in-memory definitions. Feed it a
    // schematic that aliases a consumer generic onto a contract nothing in the
    // flow produces, and it must surface that accommodation — proving it reads the
    // passed schematic, not src/flows/<id>/schematic.json. A clean flow gains an
    // accommodation purely from the alias we add here.
    const clean = schematicForFlow('fix');
    const phantom = {
      ...clean,
      contract_aliases: [
        ...clean.contract_aliases,
        { generic: 'verification.result@v1', actual: 'phantom.nothing@v1' },
      ],
    };
    const ledger = collectAccommodationLedger([phantom]);
    expect(ledger.accommodations).toHaveLength(1);
    expect(ledger.accommodations[0]?.actual).toBe('phantom.nothing@v1');
    expect(ledger.accommodations[0]?.citation).toBeNull();
  });

  it('every shipped alias is a MODEL-CORRECTION that cites a real producer', () => {
    const ledger = collectAccommodationLedger(shippedFlowSchematics());
    // The load-bearing invariant. An alias whose `actual` is produced by no
    // in-flow item and no initial contract is remapping a consumer's generic
    // onto a phantom contract -- the dishonest collapse M5 must never freeze in.
    // toEqual([]) so a failure prints exactly which aliases are unjustified.
    expect(ledger.accommodations).toEqual([]);
  });

  it('cites a producer for every model-correction entry', () => {
    const ledger = collectAccommodationLedger(shippedFlowSchematics());
    for (const entry of ledger.entries) {
      if (entry.classification === 'model-correction') {
        expect(
          entry.citation,
          `${entry.flow}: ${entry.generic} -> ${entry.actual} is a model-correction with no citation`,
        ).not.toBeNull();
      }
    }
  });

  it('covers every shipped flow that declares aliases', () => {
    const schematics = shippedFlowSchematics();
    const ledger = collectAccommodationLedger(schematics);
    const flowsInLedger = new Set(ledger.entries.map((entry) => entry.flow));
    for (const schematic of schematics) {
      if (schematic.contract_aliases.length > 0) {
        expect(
          flowsInLedger.has(schematic.id),
          `${schematic.id} declares aliases but is missing from the ledger`,
        ).toBe(true);
      }
    }
  });

  it('reports the alias surface and the multi-actual body-divergence probe targets', () => {
    const ledger = collectAccommodationLedger(shippedFlowSchematics());
    expect(ledger.entries.length).toBeGreaterThan(0);
    const probeLines = ledger.multiActualGenerics.map(
      (multi) =>
        `  ${multi.flow}: ${multi.generic} -> ${multi.actuals.length} actuals (M8 body-divergence probe)`,
    );
    console.log(
      `\naccommodation ledger: ${ledger.entries.length} aliases, ` +
        `${ledger.accommodations.length} accommodations, ` +
        `${ledger.multiActualGenerics.length} multi-actual generics\n${probeLines.join('\n')}\n`,
    );
  });
});

describe('body-divergence reporter (M8.0)', () => {
  it('resolves a body signature for every actual behind a multi-actual generic', () => {
    // No shipped multi-actual generic may classify `unresolved`: every actual is
    // a real producer (the accommodation ledger already proves that) and so must
    // resolve to a registered body. An unresolved here means a body the reporter
    // cannot see — exactly the blind spot M8 closes.
    const ledger = collectAccommodationLedger(shippedFlowSchematics());
    const divergence = collectBodyDivergence(ledger.multiActualGenerics, resolveFieldSignature);
    for (const entry of divergence) {
      expect(
        entry.classification,
        `${entry.flow}::${entry.generic} has an actual with no resolvable body`,
      ).not.toBe('unresolved');
    }
  });

  it('classifies the unify candidates uniform and the split candidates divergent', () => {
    const ledger = collectAccommodationLedger(shippedFlowSchematics());
    const divergence = collectBodyDivergence(ledger.multiActualGenerics, resolveFieldSignature);
    const byKey = new Map(divergence.map((entry) => [`${entry.flow}::${entry.generic}`, entry]));

    // Uniform: the bodies are byte-identical shapes, safe to unify (M8.2).
    // goal.child-run = five RunResult bodies told apart only by flow_id;
    // goal.gate-review = gate-pass and gate, identical shapes told apart by schema.
    expect(byKey.get('goal::goal.child-run@v1')?.classification).toBe('uniform');
    expect(byKey.get('goal::goal.gate-review@v1')?.classification).toBe('uniform');

    // Divergent: one generic name spans structurally different bodies. These
    // survive as write-only block-reuse umbrellas — no item consumes the generic,
    // every consumer reads a distinct flow-scoped actual — so they are honest, not
    // catch-alls. The M8.4 gate forbids only a CONSUMED divergent generic.
    expect(byKey.get('build::verification.result@v1')?.classification).toBe('divergent');
    expect(byKey.get('fix::verification.result@v1')?.classification).toBe('divergent');
    expect(byKey.get('prototype::verification.result@v1')?.classification).toBe('divergent');

    // M8.3 resolved goal.contract@v1 — the one genuinely CONSUMED catch-all (six
    // goal items read it). Its 11 legacy masking aliases (onto every other goal
    // report) were removed, so it is single-actual (the real contract) and is no
    // longer a multi-actual generic at all.
    expect(byKey.has('goal::goal.contract@v1')).toBe(false);
  });

  it('logs the divergence classification for every multi-actual generic', () => {
    const ledger = collectAccommodationLedger(shippedFlowSchematics());
    const divergence = collectBodyDivergence(ledger.multiActualGenerics, resolveFieldSignature);
    const lines = divergence.map(
      (entry) =>
        `  [${entry.classification}] ${entry.flow}::${entry.generic} (${entry.actuals.length} actuals)`,
    );
    console.log(`\nbody-divergence report (M8.0):\n${lines.join('\n')}\n`);
  });
});

describe('uniform producer generics (M8.2)', () => {
  // goal.child-run@v1 and goal.gate-review@v1 are block output_contracts (the
  // goal-child-run / goal-gate-review blocks) realized by several actuals that
  // all share one body — five RunResult child results, two GoalGate passes. The
  // actuals were already typed (they are flow reports); the generic NAME they
  // collapse under was not. M8.2 gives each uniform generic its single canonical
  // body, so the seam is typed end to end and the M8.4 gate has a body to check
  // each actual against. The divergent generics (goal.contract@v1, the
  // verification families) deliberately get NO canonical body here — they cannot
  // have one, which is exactly what forces their split in M8.3.
  const UNIFORM_PRODUCER_GENERICS = [
    { flow: 'goal', generic: 'goal.child-run@v1' },
    { flow: 'goal', generic: 'goal.gate-review@v1' },
  ] as const;

  it('resolves a canonical body signature for each uniform producer generic', () => {
    for (const { generic } of UNIFORM_PRODUCER_GENERICS) {
      expect(
        resolveFieldSignature(generic),
        `${generic} is a block output_contract realized by uniform actuals; it must resolve to a single canonical body`,
      ).not.toBeNull();
    }
  });

  it("each uniform generic's canonical body matches every actual aliased to it", () => {
    // "Safe to unify" is now a machine fact, not a comment: the canonical body
    // must equal every actual's body. If a future actual switches body, the
    // generic stops matching it and this fails — forcing an explicit split or
    // re-unify rather than a silent catch-all.
    const ledger = collectAccommodationLedger(shippedFlowSchematics());
    const byKey = new Map(
      ledger.multiActualGenerics.map((multi) => [`${multi.flow}::${multi.generic}`, multi]),
    );
    for (const { flow, generic } of UNIFORM_PRODUCER_GENERICS) {
      const multi = byKey.get(`${flow}::${generic}`);
      expect(multi, `${flow}::${generic} must be a shipped multi-actual generic`).toBeDefined();
      const canonical = resolveFieldSignature(generic);
      expect(canonical, `${generic} must resolve to a canonical body`).not.toBeNull();
      for (const actual of multi?.actuals ?? []) {
        expect(
          resolveFieldSignature(actual),
          `${generic} canonical body must equal its actual ${actual} (uniform)`,
        ).toBe(canonical);
      }
    }
  });
});

describe('consumed-divergence gate (M8.4)', () => {
  // The fail-closed anti-widening gate. It forbids exactly one shape: a generic
  // contract that is CONSUMED as an item input (its name appears as a value in
  // some item.input) AND resolves to more than one structurally-distinct body.
  // That is a catch-all — a consumer reading the generic could bind to any of
  // several different shapes. Everything else is allowed: a write-only
  // block-reuse umbrella (a generic only named as a block output_contract,
  // realized by typed actuals, consumed by no item via the generic name) is
  // honest reuse; a uniform generic resolves to one body; a single-actual
  // generic is unambiguous.

  // A stub resolver lets these unit tests control uniform-vs-divergent precisely
  // without depending on the real body registry.
  const stubResolve =
    (shapes: Record<string, string>) =>
    (name: string): string | null =>
      shapes[name] ?? null;

  // Minimal FlowSchematic shaped only with the fields the gate reads: id,
  // contract_aliases, initial_contracts, and items[].{id,input,output}.
  const synthetic = (over: {
    aliases: { generic: string; actual: string }[];
    items: { id: string; output: string; input: Record<string, string> }[];
  }): FlowSchematic =>
    ({
      id: 'synthetic',
      initial_contracts: [],
      contract_aliases: over.aliases,
      items: over.items,
    }) as unknown as FlowSchematic;

  it('fires when a divergent generic is consumed as an item input', () => {
    const schematic = synthetic({
      aliases: [
        { generic: 'g@v1', actual: 'a@v1' },
        { generic: 'g@v1', actual: 'b@v1' },
      ],
      items: [
        { id: 'producer-a', output: 'a@v1', input: {} },
        { id: 'producer-b', output: 'b@v1', input: {} },
        { id: 'consumer', output: 'c@v1', input: { x: 'g@v1' } },
      ],
    });
    const issues = collectConsumedDivergenceIssues(
      schematic,
      stubResolve({ 'a@v1': 'shapeA', 'b@v1': 'shapeB' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.generic).toBe('g@v1');
    expect(issues[0]?.consumingItems).toEqual(['consumer']);
    expect(issues[0]?.signatures).toEqual(['shapeA', 'shapeB']);
  });

  it('allows a divergent generic that is write-only (consumed by no item via the generic)', () => {
    // The shipped pattern: the consumer reads the typed actual, never the
    // generic. This is the write-only block-reuse umbrella that must survive.
    const schematic = synthetic({
      aliases: [
        { generic: 'g@v1', actual: 'a@v1' },
        { generic: 'g@v1', actual: 'b@v1' },
      ],
      items: [
        { id: 'producer-a', output: 'a@v1', input: {} },
        { id: 'producer-b', output: 'b@v1', input: {} },
        { id: 'consumer', output: 'c@v1', input: { x: 'a@v1' } },
      ],
    });
    const issues = collectConsumedDivergenceIssues(
      schematic,
      stubResolve({ 'a@v1': 'shapeA', 'b@v1': 'shapeB' }),
    );
    expect(issues).toEqual([]);
  });

  it('allows a uniform generic even when consumed as an item input', () => {
    const schematic = synthetic({
      aliases: [
        { generic: 'g@v1', actual: 'a@v1' },
        { generic: 'g@v1', actual: 'b@v1' },
      ],
      items: [
        { id: 'producer-a', output: 'a@v1', input: {} },
        { id: 'producer-b', output: 'b@v1', input: {} },
        { id: 'consumer', output: 'c@v1', input: { x: 'g@v1' } },
      ],
    });
    const issues = collectConsumedDivergenceIssues(
      schematic,
      stubResolve({ 'a@v1': 'oneShape', 'b@v1': 'oneShape' }),
    );
    expect(issues).toEqual([]);
  });

  it('allows a single-actual generic consumed as an item input', () => {
    // Single actual = unambiguous; never a catch-all (this is review.verdict@v1
    // inside the review flow, consumed but aliased to one actual).
    const schematic = synthetic({
      aliases: [{ generic: 'g@v1', actual: 'a@v1' }],
      items: [
        { id: 'producer-a', output: 'a@v1', input: {} },
        { id: 'consumer', output: 'c@v1', input: { x: 'g@v1' } },
      ],
    });
    const issues = collectConsumedDivergenceIssues(schematic, stubResolve({ 'a@v1': 'shapeA' }));
    expect(issues).toEqual([]);
  });

  it('produces zero issues for every shipped flow (M8.3 cleared the consumed-divergent set)', () => {
    // The load-bearing invariant for shipped flows: after M8.3 removed
    // goal.contract@v1's masking aliases, no shipped flow consumes a divergent
    // generic. Every remaining divergent generic is a write-only umbrella. If a
    // future edit reintroduces a consumed catch-all, this fails.
    for (const id of shippedFlowIds()) {
      expect(
        collectConsumedDivergenceIssues(schematicForFlow(id), resolveFieldSignature),
        `${id} must not consume any divergent generic`,
      ).toEqual([]);
    }
  });
});
