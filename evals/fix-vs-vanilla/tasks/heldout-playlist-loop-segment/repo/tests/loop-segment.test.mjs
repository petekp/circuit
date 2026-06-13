import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrackInSegment } from '../src/loop-segment.mjs';

test('spot in the tail of a seam-crossing segment is inside', () => {
  assert.equal(isTrackInSegment(8, 7, 3, 10), true);
});

test('spot in the head of a seam-crossing segment is inside', () => {
  assert.equal(isTrackInSegment(1, 7, 3, 10), true);
});

test('spot between the ends of a seam-crossing segment is outside', () => {
  assert.equal(isTrackInSegment(5, 7, 3, 10), false);
});

test('forward segment keeps its usual reading', () => {
  assert.equal(isTrackInSegment(4, 2, 6, 10), true);
  assert.equal(isTrackInSegment(8, 2, 6, 10), false);
});
