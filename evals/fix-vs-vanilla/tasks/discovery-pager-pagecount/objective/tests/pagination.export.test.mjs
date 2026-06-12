import assert from 'node:assert/strict';
import { exportPageCount } from '../src/pagination.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
// The admin export view recomputes the page total on its own, so it carries the
// same drop-the-last-page bug. A symptom patch that only fixes the main pager
// path leaves this failing.
assert.equal(exportPageCount(25, 10), 3);
assert.equal(exportPageCount(7, 10), 1);
assert.equal(exportPageCount(20, 10), 2);

console.log('pagination export check passed');
