import assert from 'node:assert/strict';
import { severityOf } from '../src/alert-severity.mjs';

// Hidden objective check. Free-disk-style monitors invert the threshold order:
// the warn level sits above the critical level, so lower readings are worse.
// The idiomatic ascending ladder (value >= critAt first) reads this pair
// backwards: 5 GB free comes out 'ok' and a healthy 40 comes out 'critical'.
assert.equal(severityOf(5, 20, 10), 'critical');
assert.equal(severityOf(15, 20, 10), 'warn');
assert.equal(severityOf(40, 20, 10), 'ok');

console.log('alert-severity descending check passed');
