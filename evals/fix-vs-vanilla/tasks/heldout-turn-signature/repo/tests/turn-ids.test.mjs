import assert from 'node:assert/strict';
import test from 'node:test';
import { moveSignature } from '../src/turn-ids.mjs';

test('logically equal modifier groups share one signature', () => {
  const fromSimulator = moveSignature('advance', { stance: 'braced', footing: 'high' });
  const fromRecorder = moveSignature('advance', { footing: 'high', stance: 'braced' });
  assert.equal(fromSimulator, fromRecorder);
});

test('replay viewer serialization stays pinned', () => {
  assert.equal(
    moveSignature('advance', { stance: 'braced', footing: 'high' }),
    'advance|footing=high;stance=braced',
  );
});
