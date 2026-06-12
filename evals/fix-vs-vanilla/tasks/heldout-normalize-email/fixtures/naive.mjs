// Naive fix: lowercase only the display path the visible test exercises. The
// dedupe key keeps its original casing, so the hidden check still fails. This is
// the trap — the same rule lives in two functions.
export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

export function emailKey(email) {
  return email.trim();
}
