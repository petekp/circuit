import assert from 'node:assert/strict';
import { clampPageSize } from '../src/api.mjs';

// Regression: the requested page size must be clamped to a sane range. A zero or
// negative request must clamp up to 1, and an oversized request must clamp down
// to the maximum.
assert.equal(clampPageSize(0), 1, 'a non-positive page size clamps up to 1');
assert.equal(clampPageSize(-3), 1, 'a negative page size clamps up to 1');
assert.equal(clampPageSize(99), 5, 'an oversized page size clamps down to the maximum');
assert.equal(clampPageSize(3), 3, 'an in-range page size is unchanged');

console.log('pagination visible test passed');
