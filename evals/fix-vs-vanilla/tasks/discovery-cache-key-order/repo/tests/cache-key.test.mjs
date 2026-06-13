import assert from 'node:assert/strict';
import { memoKey } from '../src/cache-key.mjs';

// Regression: the same filter set must land on the same memo entry no matter
// how the call site ordered the params.
assert.equal(
  memoKey('/products', { color: 'red', size: 'm' }),
  memoKey('/products', { size: 'm', color: 'red' })
);
assert.equal(memoKey('/products', { size: 'm', color: 'red' }), '/products?color=red&size=m');

console.log('cache-key visible test passed');
