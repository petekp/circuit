import assert from 'node:assert/strict';
import { nextPage } from '../src/api.mjs';
import { encodeCursor } from '../src/store.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
//
// This exercises the assembled clamp + cursor interaction. The first page is
// requested with an empty cursor, which must mean "start at the first item", and
// with an oversized page size, which must clamp to the maximum. Fixing only the
// clamp leaves the empty cursor decoding to NaN, so the first page comes back
// empty; fixing only the cursor leaves the size unbounded. Only both together cut
// the right page.
const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

const first = nextPage(items, 99, '');
assert.deepEqual(first, ['a', 'b', 'c', 'd', 'e'], 'the first page starts at item 0 with the clamped size');

const resume = nextPage(items, 0, encodeCursor(5));
assert.deepEqual(resume, ['f'], 'a resumed page honors the clamped size from a real cursor');

console.log('pagination assembled check passed');
