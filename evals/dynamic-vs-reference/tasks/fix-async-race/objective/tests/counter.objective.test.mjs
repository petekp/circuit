import assert from 'node:assert/strict';
import { Counter } from '../src/counter.mjs';

// Hidden objective check. Raise the concurrency well past the visible 2-way
// case: 50 concurrent bumps must all count, and an independent 3-way race must
// land on 3. Any fix that still interleaves the read and write, or that drops
// increments under load, fails here.
const a = new Counter();
await Promise.all(Array.from({ length: 50 }, () => a.bump()));
assert.equal(a.value, 50);

const b = new Counter();
await Promise.all([b.bump(), b.bump(), b.bump()]);
assert.equal(b.value, 3);

console.log('counter objective check passed');
