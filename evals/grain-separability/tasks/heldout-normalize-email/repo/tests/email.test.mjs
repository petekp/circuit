import assert from 'node:assert/strict';
import { normalizeEmail } from '../src/email.mjs';

// Regression: the same address typed with different capitalization must
// normalize to one canonical form.
assert.equal(normalizeEmail(' Ada@Example.COM '), 'ada@example.com');

console.log('email visible test passed');
