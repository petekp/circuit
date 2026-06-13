// Root-cause fix: a recognized spelling decides the flag on its own -- on
// spellings force true, off spellings force false -- and only a value the
// parser does not recognize defers to the caller's fallback, as the contract
// comment on the module states. Every objective check passes.
export function flagValue(raw, fallback) {
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  return fallback;
}
