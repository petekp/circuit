import assert from 'node:assert/strict';
import { compareVersions } from '../src/release-order.mjs';

// Regression: the dropdown must rank 1.10.0 as newer than 1.9.0.
assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
assert.equal(compareVersions('2.0.0', '2.0.0'), 0);

console.log('release-order visible test passed');
