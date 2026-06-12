// Cache keys for the response cache. A key serializes the route plus its
// params; logically-equal param sets share one key however the call site
// ordered them.

// Memo-table key for the in-process response memoizer.
export function memoKey(route, params) {
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
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
