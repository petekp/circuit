import assert from 'node:assert/strict';
import { run } from '../src/retry.mjs';

// Regression: the retry loop must honor the full max-attempts budget. A function
// that always fails should be called exactly max-attempts times, and a function
// that succeeds on the last allowed attempt should succeed rather than be cut off.
const failing = run(() => false, 3);
assert.equal(failing.ok, false);
assert.equal(failing.attempts, 3, 'a persistent failure uses the full attempt budget');

const lastChance = run((attempt) => attempt === 3, 3);
assert.equal(lastChance.ok, true, 'a function that succeeds on the last attempt succeeds');
assert.equal(lastChance.attempts, 3);

console.log('retry visible test passed');
