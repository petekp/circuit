// Naive fix: canonicalizes only the memo-table path (memoKey), the one the
// visible `npm test` exercises. The prewarmer's snapshot key builder still
// walks the params in call-site order, so the visible regression goes green
// while the snapshot objective check stays red. This is the trap.

// Cache keys for the response cache. A key serializes the route plus its
// params; logically-equal param sets share one key however the call site
// ordered them.

// Memo-table key for the in-process response memoizer.
export function memoKey(route, params) {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return `${route}?${query}`;
}

// Key for the on-disk response snapshot the prewarmer writes.
export function snapshotKey(route, params) {
  let out = route;
  for (const k in params) {
    out += `|${k}:${params[k]}`;
  }
  return out;
}
