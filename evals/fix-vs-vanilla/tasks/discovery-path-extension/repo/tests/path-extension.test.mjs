import assert from 'node:assert/strict';
import { fileExtension } from '../src/path-extension.mjs';

// Regression: a filename with no dot has no extension.
assert.equal(fileExtension('photo.jpeg'), 'jpeg');
assert.equal(fileExtension('archive.tar.gz'), 'gz');
assert.equal(fileExtension('README'), '');

console.log('path-extension visible test passed');
