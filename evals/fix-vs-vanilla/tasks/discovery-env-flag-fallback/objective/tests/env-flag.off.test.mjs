import assert from 'node:assert/strict';
import { flagValue } from '../src/env-flag.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
// The contract: a recognized spelling decides the flag on its own, on or off;
// only an unrecognizable value defers to the caller's fallback. The tempting
// fix routes everything outside the on set to the fallback, which quietly turns
// explicit off spellings back on whenever the caller's fallback is true.
assert.equal(flagValue('false', true), false);
assert.equal(flagValue('0', true), false);
assert.equal(flagValue('no', true), false);
assert.equal(flagValue('yes', false), true);
assert.equal(flagValue('maybe', true), true);

console.log('env-flag off-spelling check passed');
