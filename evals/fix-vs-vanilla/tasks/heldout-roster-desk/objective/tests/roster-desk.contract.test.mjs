import { test } from "node:test";
import assert from "node:assert/strict";
import { deskOf } from "../src/roster-desk.mjs";

// Guarantee 1: a "#" inside a remark belongs to the remark, not to an
// assignment.
test("a locker remark on its own is not an assignment", () => {
  assert.equal(deskOf("Diaz, Ana (locker #214)"), "");
});

test("an old desk code parked in a remark stays a remark", () => {
  assert.equal(deskOf("Reyes, Sam (was #C4)"), "");
});

// Guarantee 2: a cell that begins with the marker, once remarks and
// surrounding spaces are set aside, is a spare-desk placeholder.
test("a bare placeholder cell has no occupant to assign", () => {
  assert.equal(deskOf("#B12"), "");
});

test("a placeholder cell with a remark still has no occupant", () => {
  assert.equal(deskOf("(seat back repair) #B12"), "");
});

// Guarantee 3: canonical chart form - padded desk numbers read back
// unpadded, and padding spaces are stripped.
test("a padded desk number reads back in chart form", () => {
  assert.equal(deskOf("Nguyen, Bao #B07"), "B7");
});

test("export padding around the code is stripped", () => {
  assert.equal(deskOf("Adeyemi, Tola (locker #008) #C04  "), "C4");
});
