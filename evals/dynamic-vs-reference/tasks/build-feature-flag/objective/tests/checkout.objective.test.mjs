import assert from 'node:assert/strict';
import { checkoutTotal } from '../src/checkout.mjs';

// Hidden objective check. The flag must actually gate the new path: free
// shipping only over the threshold, and the OLD behavior must be preserved
// exactly when the flag is off or absent (backward compatible).
assert.equal(checkoutTotal(60, { freeShipOver50: true }), 60); // on, over -> free
assert.equal(checkoutTotal(40, { freeShipOver50: true }), 45); // on, under -> pays
assert.equal(checkoutTotal(60, { freeShipOver50: false }), 65); // off -> unchanged
assert.equal(checkoutTotal(60), 65); // absent -> unchanged

console.log('checkout objective check passed');
