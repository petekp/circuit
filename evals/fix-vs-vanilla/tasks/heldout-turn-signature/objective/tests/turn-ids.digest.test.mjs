import assert from 'node:assert/strict';
import test from 'node:test';
import { eventDigest } from '../src/turn-ids.mjs';

test('logically equal detail groups share one digest', () => {
  const first = eventDigest('clash', { alpha: 'one', beta: 'two' });
  const second = eventDigest('clash', { beta: 'two', alpha: 'one' });
  assert.equal(first, second);
});

test('spectator deduper serialization stays pinned', () => {
  assert.equal(
    eventDigest('clash', { beta: 'two', alpha: 'one' }),
    'clash::alpha:one,beta:two',
  );
});
