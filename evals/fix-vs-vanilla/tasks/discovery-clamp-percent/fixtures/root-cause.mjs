// Root-cause fix: clamps both bounds, so every objective check passes too.
export function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}
