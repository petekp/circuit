import test from "node:test";
import assert from "node:assert/strict";
import { shouldRushTicket } from "../src/ticket-rush.mjs";

// shouldRushTicket(note, expoLean): a note on the recognized rush list
// ("rush", "asap", "fire", "expedite") rushes the ticket on its own, and a
// note outside the recognized notes defers to expoLean, the expediter's
// standing answer for unmarked tickets.

test("recognized rush notes jump the queue even when the expo leans toward staying put", () => {
  assert.equal(shouldRushTicket("rush", false), true);
  assert.equal(shouldRushTicket("asap", false), true);
  assert.equal(shouldRushTicket("fire", false), true);
  assert.equal(shouldRushTicket("expedite", false), true);
});

test("an unrecognized note follows a stay-put expo lean", () => {
  assert.equal(shouldRushTicket("extra napkins", false), false);
});

test("near-miss notes are unrecognized and follow a jump-ahead expo lean", () => {
  assert.equal(shouldRushTicket("rushed", true), true);
  assert.equal(shouldRushTicket("", true), true);
});
