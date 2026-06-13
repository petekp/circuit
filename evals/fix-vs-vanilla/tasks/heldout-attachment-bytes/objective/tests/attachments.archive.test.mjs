import test from 'node:test';
import assert from 'node:assert/strict';
import { withinArchiveBudget } from '../src/attachments.mjs';

// Builds base64 attachment data with a known decoded byte count.
const encode = (bytes) => Buffer.from('x'.repeat(bytes)).toString('base64');

test('two 30-byte attachments stay inside a 70-byte archive budget', () => {
  const attachments = [
    { label: 'survey', data: encode(30) },
    { label: 'appendix', data: encode(30) },
  ];
  assert.equal(withinArchiveBudget(attachments, 70), true);
});

test('three 30-byte attachments exceed a 70-byte archive budget', () => {
  const attachments = [
    { label: 'survey', data: encode(30) },
    { label: 'appendix', data: encode(30) },
    { label: 'photos', data: encode(30) },
  ];
  assert.equal(withinArchiveBudget(attachments, 70), false);
});

test('padding characters do not count toward the budget', () => {
  // 5 decoded bytes encode to 8 base64 characters (with '=' padding).
  const attachments = [{ label: 'stamp', data: encode(5) }];
  assert.equal(withinArchiveBudget(attachments, 5), true);
});

test('an empty attachment list stays inside any budget', () => {
  assert.equal(withinArchiveBudget([], 1), true);
});
