import assert from 'node:assert/strict';
import { delayFor } from '../src/backoff.mjs';
import { run } from '../src/retry.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
//
// This exercises the assembled retry + backoff under the shared max-attempts
// contract. With four attempts that all fail, the loop must use all four and the
// recorded delays must be the exponential schedule between tries: 10, 20, 40 (one
// gap fewer than the attempt count). Fixing only the loop leaves the schedule one
// step too large; fixing only the schedule leaves the loop giving up early. Only
// both together produce the right attempts and the right delays.
const result = run(() => false, 4, delayFor);
assert.equal(result.attempts, 4, 'all four attempts are used');
assert.deepEqual(result.delays, [10, 20, 40], 'the exponential backoff schedule between tries');

console.log('retry assembled check passed');
