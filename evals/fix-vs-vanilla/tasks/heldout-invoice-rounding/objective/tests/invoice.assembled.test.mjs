import assert from 'node:assert/strict';
import { invoiceTotal } from '../src/invoice.mjs';
import { lineTotal } from '../src/price.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
//
// The total is exact only under the coherent rounding contract: each line rounds
// to whole cents and the invoice sums those rounded lines without any further
// rounding. Three 100-cent lines at a 0.3% discount round to 100 each (300), plus
// a 41-cent line, gives 341 cents. That total is not a multiple of five, so a
// stray nickel-rounding step on the grand total would report 340. Rounding only
// the lines, or only the total, leaves one of the two steps inconsistent.
const lines = [
  { priceCents: 100, discount: 0.003 },
  { priceCents: 100, discount: 0.003 },
  { priceCents: 100, discount: 0.003 },
  { priceCents: 41, discount: 0 },
];
assert.equal(invoiceTotal(lines, lineTotal), 341, 'multi-line total is exact only under coherent rounding');

console.log('invoice assembled check passed');
