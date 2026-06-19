import assert from 'node:assert/strict';
import { checkoutTotal } from '../src/checkout.mjs';

// With the flag on, an order over $50 ships free.
assert.equal(checkoutTotal(60, { freeShipOver50: true }), 60);

console.log('checkout visible test passed');
