import assert from 'node:assert/strict';
import { inQuietHours } from '../src/quiet-hours.mjs';

// Regression: a quiet-hours window that runs past midnight must hold a
// late-night send.
assert.equal(inQuietHours(23, 22, 7), true);
assert.equal(inQuietHours(3, 22, 7), true);
assert.equal(inQuietHours(12, 22, 7), false);
assert.equal(inQuietHours(13, 12, 14), true);

console.log('quiet hours visible test passed');
