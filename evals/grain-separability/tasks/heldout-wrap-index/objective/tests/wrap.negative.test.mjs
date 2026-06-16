import assert from 'node:assert/strict';
import { wrapIndex } from '../src/wrap.mjs';

// Hidden objective check. Paging backward before the first slide has to wrap
// to the end. JavaScript's % keeps the sign of the dividend, so the obvious
// `index % len` returns a negative index here and lands off the list.
assert.equal(wrapIndex(-1, 5), 4);
assert.equal(wrapIndex(-7, 5), 3);

console.log('wrap negative check passed');
