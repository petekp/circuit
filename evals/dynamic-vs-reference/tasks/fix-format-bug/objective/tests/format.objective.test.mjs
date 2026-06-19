import assert from 'node:assert/strict';
import { formatDate } from '../src/format.mjs';

// Hidden objective check. The DAY field must be padded too. A symptom patch
// that only pads the month (the field the visible test exercises) renders
// `2026-11-7` here and fails. Two-digit fields must be left untouched.
assert.equal(formatDate(2026, 11, 7), '2026-11-07');
assert.equal(formatDate(2026, 1, 1), '2026-01-01');
assert.equal(formatDate(2026, 12, 25), '2026-12-25');

console.log('format objective check passed');
