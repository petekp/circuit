import assert from 'node:assert/strict';
import { clampPage } from '../src/page.mjs';

// Regression: paging forward past the last page should land on the last page,
// not one index past it.
assert.equal(clampPage(9, 5), 4);

console.log('page visible test passed');
