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
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  collectAccommodationLedger,
  shippedSchematicIds,
} from '../../src/flows/accommodation-ledger.js';

describe('accommodation ledger', () => {
  it('every shipped alias is a MODEL-CORRECTION that cites a real producer', () => {
    const ledger = collectAccommodationLedger();
    // The load-bearing invariant. An alias whose `actual` is produced by no
    // in-flow item and no initial contract is remapping a consumer's generic
    // onto a phantom contract -- the dishonest collapse M5 must never freeze in.
    // toEqual([]) so a failure prints exactly which aliases are unjustified.
    expect(ledger.accommodations).toEqual([]);
  });

  it('cites a producer for every model-correction entry', () => {
    const ledger = collectAccommodationLedger();
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
    const ledger = collectAccommodationLedger();
    const flowsInLedger = new Set(ledger.entries.map((entry) => entry.flow));
    for (const id of shippedSchematicIds()) {
      const schematic = JSON.parse(readFileSync(`src/flows/${id}/schematic.json`, 'utf8'));
      const aliasCount = (schematic.contract_aliases ?? []).length;
      if (aliasCount > 0) {
        expect(flowsInLedger.has(id), `${id} declares aliases but is missing from the ledger`).toBe(
          true,
        );
      }
    }
  });

  it('reports the alias surface and the multi-actual body-divergence probe targets', () => {
    const ledger = collectAccommodationLedger();
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
