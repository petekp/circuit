import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.mjs';

// Hidden objective check (regression guard). A string that already fits must be
// returned unchanged — no ellipsis. This works before the fix; the trap is a
// naive fix that appends an ellipsis unconditionally and breaks it.
assert.equal(truncate('hi', 5), 'hi');
assert.equal(truncate('exact', 5), 'exact');

console.log('truncate short-string guard passed');
