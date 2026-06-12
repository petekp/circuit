import assert from 'node:assert/strict';
import { fitWidth } from '../src/fit.mjs';

// Regression: a short label is padded out to the column width.
assert.equal(fitWidth('hi', 4), 'hi  ');
assert.equal(fitWidth('ok', 4), 'ok  ');

console.log('fit visible test passed');
