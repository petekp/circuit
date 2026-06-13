import assert from 'node:assert/strict';
import test from 'node:test';

import { triageTier } from '../src/triage-tier.mjs';

test('a ticket idle 10 minutes against trips 30/60 is routine', () => {
  assert.equal(triageTier(10, 30, 60), 'routine');
});

test('a ticket idle 45 minutes against trips 30/60 is priority', () => {
  assert.equal(triageTier(45, 30, 60), 'priority');
});

test('a ticket idle 90 minutes against trips 30/60 is immediate', () => {
  assert.equal(triageTier(90, 30, 60), 'immediate');
});

test('a ticket idle 60 minutes, right at the immediate trip, is immediate', () => {
  assert.equal(triageTier(60, 30, 60), 'immediate');
});
