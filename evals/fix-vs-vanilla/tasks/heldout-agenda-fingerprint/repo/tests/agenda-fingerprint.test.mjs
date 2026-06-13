import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingFingerprint } from '../src/agenda-fingerprint.mjs';

test('a booking matches itself when a calendar supplies the fields in another sequence', () => {
  const fromFirstCalendar = bookingFingerprint('panel', { room: 'A12', host: 'rivera' });
  const fromSecondCalendar = bookingFingerprint('panel', { host: 'rivera', room: 'A12' });
  assert.equal(fromFirstCalendar, fromSecondCalendar);
});

test('a booking identifier serializes in the documented canonical form', () => {
  const got = bookingFingerprint('panel', { track: 'design', host: 'rivera', room: 'A12' });
  assert.equal(got, 'panel|host=rivera;room=A12;track=design');
});
