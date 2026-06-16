// Normalize an email for display.
export function normalizeEmail(email) {
  return email.trim();
}

// Build the lookup key used to dedupe accounts.
export function emailKey(email) {
  return email.trim();
}
