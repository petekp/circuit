import test from "node:test";
import assert from "node:assert/strict";
import { shouldRushTicket } from "../src/ticket-rush.mjs";

// The recognized hold list settles the decision on its own: a held ticket
// stays in rotation no matter how the expo leans.

test("recognized hold notes keep the ticket in rotation even when the expo leans toward jumping ahead", () => {
  assert.equal(shouldRushTicket("hold", true), false);
  assert.equal(shouldRushTicket("wait", true), false);
  assert.equal(shouldRushTicket("later", true), false);
  assert.equal(shouldRushTicket("delay", true), false);
});

test("recognized rush notes still jump the queue on their own", () => {
  assert.equal(shouldRushTicket("asap", false), true);
});

test("an unrecognized note still follows a jump-ahead expo lean", () => {
  assert.equal(shouldRushTicket("birthday candle", true), true);
});
