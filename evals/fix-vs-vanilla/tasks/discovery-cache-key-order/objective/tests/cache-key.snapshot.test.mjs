import assert from 'node:assert/strict';
import { snapshotKey } from '../src/cache-key.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
// The prewarmer's snapshot key builder serializes the same (route, params) pair
// on its own, so it carries the same order-sensitivity bug. A symptom patch that
// only canonicalizes the memo path leaves this failing.
assert.equal(
  snapshotKey('/products', { color: 'red', size: 'm' }),
  snapshotKey('/products', { size: 'm', color: 'red' })
);
assert.equal(snapshotKey('/products', { b: '2', a: '1' }), '/products|a:1|b:2');

console.log('cache-key snapshot check passed');
