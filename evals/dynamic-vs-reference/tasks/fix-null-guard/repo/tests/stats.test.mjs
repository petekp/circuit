import assert from 'node:assert/strict';
import { average } from '../src/stats.mjs';

// Regression: an empty list must not crash; it averages to 0.
assert.equal(average([]), 0);
assert.equal(average([2, 4, 6]), 4);

console.log('stats visible test passed');
