import { test } from "node:test";
import assert from "node:assert/strict";
import { deskOf } from "../src/roster-desk.mjs";

test("reads the desk code from an assigned cell", () => {
  assert.equal(deskOf("Nguyen, Bao #B12"), "B12");
});

test("a locker remark does not hide the real assignment", () => {
  assert.equal(deskOf("Diaz, Ana (locker #214) #A3"), "A3");
});

test("a cell with no assignment comes back empty", () => {
  assert.equal(deskOf("Okafor, Chidi"), "");
});
