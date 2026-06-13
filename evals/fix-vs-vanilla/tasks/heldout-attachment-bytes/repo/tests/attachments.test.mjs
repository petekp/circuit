import test from 'node:test';
import assert from 'node:assert/strict';
import { oversizedAttachments } from '../src/attachments.mjs';

// Builds base64 attachment data with a known decoded byte count.
const encode = (bytes) => Buffer.from('x'.repeat(bytes)).toString('base64');

test('a 30-byte scan stays under a 32-byte cap', () => {
  const scan = { label: 'site-survey', data: encode(30) };
  assert.deepEqual(oversizedAttachments([scan], 32), []);
});

test('only the attachment over the cap is flagged', () => {
  const small = { label: 'cover-sheet', data: encode(30) };
  const big = { label: 'blueprint', data: encode(40) };
  const flagged = oversizedAttachments([small, big], 32).map((record) => record.label);
  assert.deepEqual(flagged, ['blueprint']);
});

test('nothing is flagged when the cap is generous', () => {
  const memo = { label: 'memo', data: encode(10) };
  const photo = { label: 'photo', data: encode(20) };
  assert.deepEqual(oversizedAttachments([memo, photo], 500), []);
});
