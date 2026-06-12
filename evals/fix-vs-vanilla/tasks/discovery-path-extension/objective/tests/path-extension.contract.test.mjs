import assert from 'node:assert/strict';
import { fileExtension } from '../src/path-extension.mjs';

// Hidden objective check. This file never ships in the repo the agent edits; the
// harness overlays it onto a throwaway copy of the post-fix repo at scoring time.
// The contract covers more than the reported no-dot symptom: only the final
// segment of a path can carry an extension, a leading dot marks a dotfile, and
// the tag is reported lowercased. node:path's extname satisfies the segment and
// dotfile rules natively but preserves case, so the extname one-liner still
// fails the uppercase rows here; a whole-path lastIndexOf guard fails the
// directory and dotfile rows too.
assert.equal(fileExtension('releases/v1.2/notes'), '');
assert.equal(fileExtension('.npmrc'), '');
assert.equal(fileExtension('src/.gitignore'), '');
assert.equal(fileExtension('scans/IMG_0042.JPG'), 'jpg');
assert.equal(fileExtension('downloads/Report.PDF'), 'pdf');

console.log('path-extension contract check passed');
