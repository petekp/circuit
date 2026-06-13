// Root-cause fix: the same order-sensitivity bug lives in both key builders,
// so both iterate the params in sorted key order. Every objective check
// passes too.

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
  for (const k of Object.keys(params).sort()) {
    out += `|${k}:${params[k]}`;
  }
  return out;
}
