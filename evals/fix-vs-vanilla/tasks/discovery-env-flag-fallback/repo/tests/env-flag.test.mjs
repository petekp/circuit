import assert from 'node:assert/strict';
import { flagValue } from '../src/env-flag.mjs';

// Regression: the usual on spellings enable a flag, and a value the parser
// does not recognize defers to the caller's fallback.
assert.equal(flagValue('true', false), true);
assert.equal(flagValue('1', false), true);
assert.equal(flagValue('yes', false), true);
assert.equal(flagValue('maybe', false), false);
assert.equal(flagValue('2', true), true);
assert.equal(flagValue('', true), true);

console.log('env-flag visible test passed');
