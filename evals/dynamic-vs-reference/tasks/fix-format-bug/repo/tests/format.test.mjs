import assert from 'node:assert/strict';
import { formatDate } from '../src/format.mjs';

// Regression: a single-digit month must keep its leading zero.
assert.equal(formatDate(2026, 3, 15), '2026-03-15');

console.log('format visible test passed');
