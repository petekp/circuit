import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.mjs';

// The helper must exist and constrain a value into range.
assert.equal(clamp(0, 10, 5), 5);
assert.equal(clamp(0, 10, 15), 10);

console.log('clamp visible test passed');
