import assert from 'node:assert/strict';
import { newestVersion } from '../src/release-order.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
// The update banner picks its release through newestVersion, which never calls
// compareVersions -- it leans on Array.prototype.sort's default comparator,
// which orders strings, not numeric version parts. A symptom patch that
// rewrites only compareVersions leaves this path ranking 1.9.0 above 1.10.0,
// so the banner advertises the wrong release.
assert.equal(newestVersion(['1.9.0', '1.10.0', '1.2.3']), '1.10.0');
assert.equal(newestVersion(['0.9.9', '0.10.0']), '0.10.0');

console.log('release-order newest check passed');
