import assert from 'node:assert/strict';
import { severityOf } from '../src/alert-severity.mjs';

// Regression: a latency reading past the critical threshold pages the on-call.
assert.equal(severityOf(950, 500, 900), 'critical');
assert.equal(severityOf(620, 500, 900), 'warn');
assert.equal(severityOf(120, 500, 900), 'ok');

console.log('alert-severity visible test passed');
