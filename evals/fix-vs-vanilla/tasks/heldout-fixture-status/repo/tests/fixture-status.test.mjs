import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureCountsForTable } from '../src/fixture-status.mjs';

// Completed-play codes ("FT", "AET", "PEN") count toward the table, and a
// code the table has no opinion on follows the caller's countWhenUnlisted
// answer.

test('full-time fixtures count toward the table', () => {
  assert.equal(fixtureCountsForTable('FT', false), true);
});

test('extra-time fixtures count toward the table', () => {
  assert.equal(fixtureCountsForTable('AET', false), true);
});

test('shoot-out fixtures count toward the table', () => {
  assert.equal(fixtureCountsForTable('PEN', false), true);
});

test('an unlisted code follows the caller when the caller says leave it out', () => {
  assert.equal(fixtureCountsForTable('HT', false), false);
});

test('a near-miss code follows the caller when the caller says count it', () => {
  assert.equal(fixtureCountsForTable('PENS', true), true);
});

test('an empty code follows the caller when the caller says count it', () => {
  assert.equal(fixtureCountsForTable('', true), true);
});
