import assert from 'node:assert/strict';
import { wrapIndex } from '../src/wrap.mjs';

// Regression: paging past the last slide wraps back to the start.
assert.equal(wrapIndex(7, 5), 2);

console.log('wrap visible test passed');
