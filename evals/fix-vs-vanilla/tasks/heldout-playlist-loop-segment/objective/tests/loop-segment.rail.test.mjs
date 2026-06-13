import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentTrackRoster } from '../src/loop-segment.mjs';

test('seam-crossing segment lists the tail spots and the head spots', () => {
  const got = [...segmentTrackRoster(7, 3, 10)].sort((a, b) => a - b);
  assert.deepEqual(got, [0, 1, 2, 7, 8, 9]);
});

test('forward segment lists the spots between its ends', () => {
  const got = [...segmentTrackRoster(2, 6, 10)].sort((a, b) => a - b);
  assert.deepEqual(got, [2, 3, 4, 5]);
});
