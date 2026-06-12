import assert from 'node:assert/strict';
import { clampPercent } from '../src/percent.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
// The lower bound is the half of the range the visible regression never looks at,
// so a fix that only clamps above 100 still fails here.
assert.equal(clampPercent(-10), 0);
assert.equal(clampPercent(0), 0);

console.log('percent lower-bound check passed');
