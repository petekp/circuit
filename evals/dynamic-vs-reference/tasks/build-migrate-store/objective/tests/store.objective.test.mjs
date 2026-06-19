import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { recordVisit } from '../src/app.mjs';

// Hidden objective check. The migrated store must behave correctly across the
// module: missing keys resolve to undefined, set resolves to the stored value,
// and recordVisit increments across successive awaited calls.
const store = createStore();
assert.equal(await store.get('missing'), undefined);
assert.equal(await store.set('x', 42), 42);
assert.equal(await store.get('x'), 42);
assert.equal(await recordVisit(store, 'u'), 1);
assert.equal(await recordVisit(store, 'u'), 2);
assert.equal(await store.get('u'), 2);

console.log('store objective check passed');
