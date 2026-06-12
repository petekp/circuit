import assert from 'node:assert/strict';
import { clampPercent } from '../src/percent.mjs';

// Regression: a percentage above 100 must cap at 100.
assert.equal(clampPercent(150), 100);
assert.equal(clampPercent(40), 40);

console.log('percent visible test passed');
