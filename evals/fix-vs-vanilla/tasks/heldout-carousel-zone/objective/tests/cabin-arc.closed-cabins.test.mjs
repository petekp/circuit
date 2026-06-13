import assert from 'node:assert/strict';
import test from 'node:test';

import { arcCabins } from '../src/cabin-arc.mjs';

// The platform display lays the cabins out itself, so the comparison is on
// the set of cabin numbers, not on how the result is sequenced.
const ascending = (cabins) => [...cabins].sort((a, b) => a - b);

test('the arc from cabin 26 to cabin 3 lists the cabins on both sides of cabin 0', () => {
  assert.deepEqual(ascending(arcCabins(26, 3)), [0, 1, 2, 26, 27, 28, 29]);
});

test('the arc from cabin 5 to cabin 11 lists the plain boarding-order run', () => {
  assert.deepEqual(ascending(arcCabins(5, 11)), [5, 6, 7, 8, 9, 10]);
});
