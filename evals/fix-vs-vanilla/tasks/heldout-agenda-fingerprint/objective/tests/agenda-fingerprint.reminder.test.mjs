import test from 'node:test';
import assert from 'node:assert/strict';
import { reminderDigest } from '../src/agenda-fingerprint.mjs';

test('a reminder group matches itself when the caller supplies the fields in another sequence', () => {
  const first = reminderDigest('standup', { beta: '2', alpha: '1' });
  const second = reminderDigest('standup', { alpha: '1', beta: '2' });
  assert.equal(first, second);
});

test('a reminder digest serializes in its documented canonical form', () => {
  const got = reminderDigest('standup', { gamma: '3', alpha: '1', beta: '2' });
  assert.equal(got, 'standup::alpha:1,beta:2,gamma:3');
});
