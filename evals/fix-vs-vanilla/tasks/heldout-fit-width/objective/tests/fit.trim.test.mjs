import assert from 'node:assert/strict';
import { fitWidth } from '../src/fit.mjs';

// Hidden objective check. A label longer than the column has to be trimmed to
// the width, not left to overflow the cell. `padEnd` alone never shortens a
// string, so a pad-only fix lets long labels spill past the column.
assert.equal(fitWidth('toolong', 4), 'tool');
assert.equal(fitWidth('overflow', 5), 'overf');

console.log('fit trim check passed');
