import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.mjs';
import { setVolume } from '../src/volume.mjs';

// Hidden objective check. clamp must handle both bounds and the in-range case,
// and the volume setter must actually route through it.
assert.equal(clamp(0, 10, -5), 0); // below min
assert.equal(clamp(0, 10, 15), 10); // above max
assert.equal(clamp(0, 10, 7), 7); // in range
assert.equal(setVolume(150), 100); // consumer clamps the ceiling
assert.equal(setVolume(-20), 0); // consumer clamps the floor
assert.equal(setVolume(42), 42); // consumer leaves in-range alone

console.log('clamp objective check passed');
