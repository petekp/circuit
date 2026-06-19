import assert from 'node:assert/strict';
import { validateForm } from '../src/form.mjs';

// A missing required field must be rejected and reported.
const result = validateForm({ name: 'Ada', email: '' });
assert.equal(result.ok, false);
assert.ok(result.errors.includes('email'));

console.log('form visible test passed');
