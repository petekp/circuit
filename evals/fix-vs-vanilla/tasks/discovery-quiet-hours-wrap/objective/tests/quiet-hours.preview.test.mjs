import assert from 'node:assert/strict';
import { mutedHours } from '../src/quiet-hours.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
// The settings-page mute preview builds its hour list with its own ascending
// loop, so it carries the same no-wrap assumption as the membership check. A
// symptom patch that only branches the boolean leaves the preview returning an
// empty list for any window that wraps past midnight.
//
// Ordering of the preview list is NOT part of the contract: a start-anchored
// walk ([22, 23, 0, ...]), an ascending filter ([0, ..., 6, 22, 23]), and a
// modulo-span loop are all complete fixes. Compare sorted copies so any of
// them passes and only a preview that still drops wrapped hours fails.
const sorted = (hours) => [...hours].sort((a, b) => a - b);

assert.deepEqual(sorted(mutedHours(22, 7)), [0, 1, 2, 3, 4, 5, 6, 22, 23]);
assert.deepEqual(sorted(mutedHours(9, 11)), [9, 10]);

console.log('quiet hours preview check passed');
