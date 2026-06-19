import assert from 'node:assert/strict';
import { validateForm } from '../src/form.mjs';

// Hidden objective check. Valid input passes cleanly; whitespace-only counts as
// empty; and when both required fields are missing, both are reported.
assert.deepEqual(validateForm({ name: 'Ada', email: 'a@b.co' }), {
  ok: true,
  errors: [],
});

const trimmed = validateForm({ name: '   ', email: 'a@b.co' });
assert.equal(trimmed.ok, false);
assert.ok(trimmed.errors.includes('name'));

const empty = validateForm({});
assert.equal(empty.ok, false);
assert.ok(empty.errors.includes('name'));
assert.ok(empty.errors.includes('email'));

console.log('form objective check passed');
