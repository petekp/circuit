import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { recordVisit } from '../src/app.mjs';

// After the migration get/set are awaitable and recordVisit returns the count.
const store = createStore();
await store.set('a', 1);
assert.equal(await store.get('a'), 1);
assert.equal(await recordVisit(store, 'u'), 1);

console.log('store visible test passed');
