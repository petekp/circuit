import assert from 'node:assert/strict';
import { finalPrice } from '../src/pricing.mjs';

// Regression: a coupon worth more than the item must not make the price go
// negative. It should floor at zero.
assert.equal(finalPrice(50, 70), 0);

console.log('pricing visible test passed');
