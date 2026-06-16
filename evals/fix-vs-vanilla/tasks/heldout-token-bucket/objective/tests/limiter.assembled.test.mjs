import assert from 'node:assert/strict';
import { allow } from '../src/limiter.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
//
// Only the coherent two-module fix passes. The limiter threshold and the refill
// math constrain each other: a burst must still be throttled (the limiter side),
// and a steady earned rate must be admitted (the refill side). Fixing only the
// limiter leaves the refill under-crediting the earned rate, so the sustained
// case stays red.

// Burst: a full bucket pays for two same-instant requests, then must throttle.
let b = { tokens: 5, capacity: 5, last: 100 };
const r1 = allow(b, 100, 2);
assert.equal(r1.ok, true);
const r2 = allow(r1.bucket, 100, 2);
assert.equal(r2.ok, true);
const r3 = allow(r2.bucket, 100, 2);
assert.equal(r3.ok, false, 'a burst past the bucket must be throttled');

// Sustained: an empty bucket waits long enough to earn exactly 5 tokens
// (one per 10 units over 50 units), then spends exactly 5. It must be admitted.
const s = allow({ tokens: 0, capacity: 5, last: 0 }, 50, 5);
assert.equal(s.ok, true, 'a sustained earned rate must be admitted');
assert.equal(s.bucket.tokens, 0);

console.log('limiter assembled check passed');
