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

import { collectAccommodationLedger } from '../../src/flows/accommodation-ledger.js';
import { schematicForFlow, shippedFlowSchematics } from '../helpers/in-memory-schematics.js';

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
