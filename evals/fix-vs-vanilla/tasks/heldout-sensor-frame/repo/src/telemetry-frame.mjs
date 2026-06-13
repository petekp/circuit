// Frame field decoding for the sensor fleet dashboard.
//
// Frame contract: a node transmits its telemetry as a frame, a flat
// object of named fields. The value of a frame field is a base-16
// digit string as the radio firmware emits it: case-insensitive, with
// no 0x marker. A reader of a frame field recovers the quantity it
// carries by decoding the string as base-16: a field holding "20"
// carries 32, and a field holding "ff" carries 255. This contract
// applies to each function in this module that reads frame fields.

// Battery gauge for the node detail screen. Returns the charge
// reading carried by the frame's batt field, or null when the field
// is absent or unreadable.
export function chargeLevel(frame) {
  const raw = frame.batt;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const reading = Number(raw);
  if (!Number.isFinite(reading)) {
    return null;
  }
  return reading;
}

// Peak current draw for the fleet power report. Scans a capture (a
// list of frames) and returns the highest draw reading found, or null
// when no frame carries a readable draw field.
export function peakDraw(capture) {
  let peak = null;
  for (const frame of capture) {
    const reading = parseInt(frame.draw);
    if (!Number.isFinite(reading)) {
      continue;
    }
    if (peak === null || reading > peak) {
      peak = reading;
    }
  }
  return peak;
}
