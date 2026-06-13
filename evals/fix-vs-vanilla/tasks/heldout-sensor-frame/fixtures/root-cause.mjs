// Frame field decoding for the sensor fleet dashboard.
//
// Frame contract: a node transmits its telemetry as a frame, a flat
// object of named fields. The value of a frame field is a base-16
// digit string as the radio firmware emits it: case-insensitive, with
// no 0x marker. A reader of a frame field recovers the quantity it
// carries by decoding the string as base-16: a field holding "20"
// carries 32, and a field holding "ff" carries 255. This contract
// applies to each function in this module that reads frame fields.

// The one decoder for the frame contract. Each reader below goes
// through it, so the contract lives in a single place.
function frameQuantity(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    return null;
  }
  return parseInt(raw, 16);
}

// Battery gauge for the node detail screen. Returns the charge
// reading carried by the frame's batt field, or null when the field
// is absent or unreadable.
export function chargeLevel(frame) {
  return frameQuantity(frame.batt);
}

// Peak current draw for the fleet power report. Scans a capture (a
// list of frames) and returns the highest draw reading found, or null
// when no frame carries a readable draw field.
export function peakDraw(capture) {
  let peak = null;
  for (const frame of capture) {
    const reading = frameQuantity(frame.draw);
    if (reading === null) {
      continue;
    }
    if (peak === null || reading > peak) {
      peak = reading;
    }
  }
  return peak;
}
