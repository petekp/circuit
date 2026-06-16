import assert from 'node:assert/strict';
import { allow } from '../src/limiter.mjs';

// Regression: a request that costs exactly the tokens on hand must be admitted.
// The bucket already holds 3 tokens and the request costs 3, so it should be
// allowed and leave the bucket empty.
const r = allow({ tokens: 3, capacity: 5, last: 100 }, 100, 3);
assert.equal(r.ok, true, 'an exact-fit request should be admitted');
assert.equal(r.bucket.tokens, 0);

console.log('limiter visible test passed');
