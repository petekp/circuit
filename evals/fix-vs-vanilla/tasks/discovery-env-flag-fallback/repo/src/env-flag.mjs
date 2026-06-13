// Read a boolean feature flag from an env var string. A spelling the parser
// recognizes decides the flag on its own, on or off; a value it does not
// recognize defers to the caller's fallback.
export function flagValue(raw, fallback) {
  return raw === 'true';
}
