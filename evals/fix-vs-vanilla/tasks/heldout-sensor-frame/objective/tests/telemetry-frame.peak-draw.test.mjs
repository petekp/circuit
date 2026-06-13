import test from "node:test";
import assert from "node:assert/strict";
import { peakDraw } from "../src/telemetry-frame.mjs";

test("peak draw decodes digit-only draw fields per the frame contract", () => {
  const capture = [{ draw: "21" }, { draw: "150" }, { draw: "9f" }];
  assert.equal(peakDraw(capture), 336);
});

test("peak draw decodes letter-bearing draw fields", () => {
  const capture = [{ draw: "1e" }, { draw: "a0" }];
  assert.equal(peakDraw(capture), 160);
});

test("peak draw skips frames with no draw field", () => {
  const capture = [{}, { draw: "33" }];
  assert.equal(peakDraw(capture), 51);
});
