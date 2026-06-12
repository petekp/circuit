import assert from 'node:assert/strict';
import { emailKey } from '../src/email.mjs';

// Hidden objective check. The dedupe key is the second place the same
// case-insensitivity rule has to hold. A fix that only touches normalizeEmail
// leaves duplicate accounts slipping through here.
assert.equal(emailKey(' Ada@Example.COM '), 'ada@example.com');

console.log('email key check passed');
