import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureCountsForTable } from '../src/fixture-status.mjs';

// A code the table recognizes decides the outcome on its own, in either
// direction. The caller's countWhenUnlisted answer applies only to codes
// outside the recognized lists.

test('an abandoned fixture stays out of the table even when the caller leans toward counting unlisted codes', () => {
  assert.equal(fixtureCountsForTable('ABD', true), false);
});

test('a postponed fixture stays out of the table even when the caller leans toward counting unlisted codes', () => {
  assert.equal(fixtureCountsForTable('PST', true), false);
});

test('a cancelled fixture stays out of the table even when the caller leans toward counting unlisted codes', () => {
  assert.equal(fixtureCountsForTable('CANC', true), false);
});

test('extra-time fixtures still count toward the table', () => {
  assert.equal(fixtureCountsForTable('AET', false), true);
});

test('an unlisted code still follows the caller', () => {
  assert.equal(fixtureCountsForTable('TBD', true), true);
});
