import assert from 'node:assert/strict';
import { clampPage } from '../src/page.mjs';

// Hidden objective check. clampPage must constrain BOTH ends. The visible test
// only exercises the upper bound, so a symptom patch (Math.min(index,
// pageCount - 1)) passes it while still returning a negative index when paging
// before the first page. The root cause clamps the lower bound too.
assert.equal(clampPage(-3, 5), 0); // paging back past the start clamps to 0
assert.equal(clampPage(0, 5), 0); // first page stays
assert.equal(clampPage(4, 5), 4); // last page stays
assert.equal(clampPage(9, 5), 4); // forward overrun still clamps

console.log('page objective check passed');
