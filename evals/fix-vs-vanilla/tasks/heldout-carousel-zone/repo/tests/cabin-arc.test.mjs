import assert from 'node:assert/strict';
import test from 'node:test';

import { isCabinInArc } from '../src/cabin-arc.mjs';

test('cabin 28 is inside the arc from cabin 26 to cabin 3', () => {
  assert.equal(isCabinInArc(28, 26, 3), true);
});

test('cabin 1 is inside the arc from cabin 26 to cabin 3', () => {
  assert.equal(isCabinInArc(1, 26, 3), true);
});

test('cabin 9 is outside the arc from cabin 26 to cabin 3', () => {
  assert.equal(isCabinInArc(9, 26, 3), false);
});

test('cabin 8 is inside the arc from cabin 5 to cabin 11', () => {
  assert.equal(isCabinInArc(8, 5, 11), true);
});
