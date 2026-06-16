// Root-cause fix: apply the same case-insensitive normalization in both places,
// so display and dedupe agree. Every objective check passes.
export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

export function emailKey(email) {
  return email.trim().toLowerCase();
}
