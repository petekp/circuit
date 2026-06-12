import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.mjs';

// Regression: a string longer than the limit must be cut and end with an ellipsis
// so the reader can tell it was shortened.
assert.equal(truncate('hello world', 5), 'hell…');

console.log('truncate visible test passed');
