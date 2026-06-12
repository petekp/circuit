// Naive fix: always cut to max-1 and append an ellipsis. This passes the visible
// long-string regression, but it also rewrites strings that already fit — so the
// short-string guard (hidden) regresses. This is the trap.
export function truncate(str, max) {
  return str.slice(0, max - 1) + '…';
}
