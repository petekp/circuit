import assert from 'node:assert/strict';
import { average } from '../src/stats.mjs';

// Hidden objective check. A missing list (null/undefined) must also return 0,
// not crash. A symptom patch that guards only `nums.length === 0` still throws
// here because it reads `.length` before checking the value. The root cause
// guards non-arrays too.
assert.equal(average(null), 0);
assert.equal(average(undefined), 0);
assert.equal(average([]), 0);
assert.equal(average([5]), 5);
assert.equal(average([2, 4, 6]), 4);

console.log('stats objective check passed');
