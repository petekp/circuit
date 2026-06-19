import assert from 'node:assert/strict';
import { Counter } from '../src/counter.mjs';

// Regression: two concurrent bumps must both count. The buggy version loses
// one update and lands on 1.
const c = new Counter();
await Promise.all([c.bump(), c.bump()]);
assert.equal(c.value, 2);

console.log('counter visible test passed');
