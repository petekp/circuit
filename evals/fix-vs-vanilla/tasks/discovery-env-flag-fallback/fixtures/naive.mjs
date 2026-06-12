// Naive fix: treat the on spellings as true and route everything else to the
// caller's fallback. It reads as complete -- the on set answers the bug report
// and the fallback branch covers the rest, so no parameter is left dead and
// the visible regression goes green. But an explicit off spelling like
// "false" or "0" is not an unrecognizable value: the contract says a
// recognized spelling decides the flag on its own. Whenever the caller's
// fallback is true, this version quietly turns an explicit off back on, so
// the hidden off-spelling check stays red. This is the trap.
export function flagValue(raw, fallback) {
  if (['1', 'true', 'yes'].includes(raw)) return true;
  return fallback;
}
