import assert from 'node:assert/strict';
import test from 'node:test';

import { dropBay } from '../src/drop-bay.mjs';

test('a hand-off marker on an earlier stop contributes nothing', () => {
  assert.equal(dropBay('PACK!C04>QA-2>DOCK'), '');
});

test('a bare hold stop yields no drop-off', () => {
  assert.equal(dropBay('!B07'), '');
});

test('a hold as the final stop of a longer plan yields no drop-off', () => {
  assert.equal(dropBay('QA-2>!B07'), '');
});

test('a short stall number comes back in canonical registry form', () => {
  assert.equal(dropBay('PICK-4>DOCK!B7'), 'B07');
});

test('surplus leading "0" comes off in canonical registry form', () => {
  assert.equal(dropBay('LIFT-1!C004'), 'C04');
});
