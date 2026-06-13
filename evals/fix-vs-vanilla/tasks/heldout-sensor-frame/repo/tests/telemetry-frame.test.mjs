import test from "node:test";
import assert from "node:assert/strict";
import { chargeLevel } from "../src/telemetry-frame.mjs";

test("decodes a digit-only batt field per the frame contract", () => {
  assert.equal(chargeLevel({ batt: "20" }), 32);
});

test("decodes a letter-bearing batt field", () => {
  assert.equal(chargeLevel({ batt: "4b" }), 75);
});

test("returns null for a frame with no batt field", () => {
  assert.equal(chargeLevel({}), null);
});
