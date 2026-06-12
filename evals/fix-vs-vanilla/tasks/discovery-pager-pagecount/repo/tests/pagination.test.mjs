import assert from 'node:assert/strict';
import { pageCount } from '../src/pagination.mjs';

// Regression: the pager must count a partial last page.
assert.equal(pageCount(25, 10), 3);
assert.equal(pageCount(20, 10), 2);
assert.equal(pageCount(0, 10), 0);

console.log('pagination visible test passed');
