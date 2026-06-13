import assert from 'node:assert/strict';
import test from 'node:test';

import { triageTier } from '../src/triage-tier.mjs';

// Flipped trip sequence: priorityAt (40) sits above immediateAt (15), so a
// smaller score is worse, like a requester goodwill balance draining away.

test('a goodwill score of 5 against trips 40/15 is immediate', () => {
  assert.equal(triageTier(5, 40, 15), 'immediate');
});

test('a goodwill score of 25 against trips 40/15 is priority', () => {
  assert.equal(triageTier(25, 40, 15), 'priority');
});

test('a goodwill score of 15, right at the immediate trip, is immediate', () => {
  assert.equal(triageTier(15, 40, 15), 'immediate');
});

test('a goodwill score of 95 against trips 40/15 is routine', () => {
  assert.equal(triageTier(95, 40, 15), 'routine');
});
