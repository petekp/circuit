import assert from 'node:assert/strict';
import test from 'node:test';
import { exifGrade } from '../src/exif-grade.mjs';

// Focus-score profile: smaller values are poorer, so the profile places
// reviewAt above rejectAt (review at 60, reject at 25).
test('badly blurred shot is rejected', () => {
  assert.equal(exifGrade(12, 60, 25), 'reject');
});

test('shot at the reject mark is rejected', () => {
  assert.equal(exifGrade(25, 60, 25), 'reject');
});

test('soft shot goes to review', () => {
  assert.equal(exifGrade(40, 60, 25), 'review');
});

test('shot at the review mark goes to review', () => {
  assert.equal(exifGrade(60, 60, 25), 'review');
});

test('tack-sharp shot is kept', () => {
  assert.equal(exifGrade(92, 60, 25), 'keep');
});
