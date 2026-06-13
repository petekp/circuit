import assert from 'node:assert/strict';
import test from 'node:test';
import { exifGrade } from '../src/exif-grade.mjs';

// Sensor-gain profile from the culling config: review past 800, reject
// past 2500.
test('low gain shot is kept', () => {
  assert.equal(exifGrade(200, 800, 2500), 'keep');
});

test('mid gain shot goes to review', () => {
  assert.equal(exifGrade(1200, 800, 2500), 'review');
});

test('shot at the review mark goes to review', () => {
  assert.equal(exifGrade(800, 800, 2500), 'review');
});

test('high gain shot is rejected', () => {
  assert.equal(exifGrade(6400, 800, 2500), 'reject');
});

test('shot at the reject mark is rejected', () => {
  assert.equal(exifGrade(2500, 800, 2500), 'reject');
});
