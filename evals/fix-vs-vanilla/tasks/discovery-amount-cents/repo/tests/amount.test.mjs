import assert from 'node:assert/strict';
import { parseCents } from '../src/amount.mjs';

// Regression: a formatted amount must not come back as NaN. The cart showed
// "NaN" for amounts that include a currency symbol, so the result has to be a
// finite, non-negative number.
const cents = parseCents('$1,234.50');
assert.ok(typeof cents === 'number' && Number.isFinite(cents) && cents >= 0);

console.log('amount visible test passed');
