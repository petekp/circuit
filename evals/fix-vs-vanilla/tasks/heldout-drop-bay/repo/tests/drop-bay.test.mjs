import assert from 'node:assert/strict';
import test from 'node:test';

import { dropBay } from '../src/drop-bay.mjs';

test('reads the drop-off bay from the final stop', () => {
  assert.equal(dropBay('PICK-4>DOCK!B07'), 'B07');
});

test('a relayed plan reads the final stop hand-off', () => {
  assert.equal(dropBay('PACK!C04>QA-2>DOCK!B12'), 'B12');
});

test('a plan with no hand-off marker has no drop-off bay', () => {
  assert.equal(dropBay('PICK-4>QA-2'), '');
});
