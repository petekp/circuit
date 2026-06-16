import assert from 'node:assert/strict';
import { invoiceTotal } from '../src/invoice.mjs';
import { lineTotal } from '../src/price.mjs';

// Regression: a discounted line must round to whole cents, and a single-line
// invoice must report that rounded amount. A 100-cent line at a 0.3% discount is
// 99.7 cents, which should round to 100.
assert.equal(lineTotal({ priceCents: 100, discount: 0.003 }), 100, 'a line rounds to whole cents');
assert.equal(invoiceTotal([{ priceCents: 100, discount: 0.003 }], lineTotal), 100, 'single-line total');

console.log('invoice visible test passed');
