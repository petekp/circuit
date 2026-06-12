import assert from 'node:assert/strict';
import { bundlePrice } from '../src/pricing.mjs';

// Hidden objective check. The bundle path subtracts a coupon the same way, so it
// has the same go-negative bug. A fix that only floors finalPrice leaves this
// one able to charge a negative amount.
assert.equal(bundlePrice(50, 70), 0);

console.log('pricing bundle check passed');
