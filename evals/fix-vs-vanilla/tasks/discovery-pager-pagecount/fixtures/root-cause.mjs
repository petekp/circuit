// Root-cause fix: the same drop-the-last-page bug lives in both page-count
// paths, so both are corrected. Every objective check passes too.
export function pageCount(total, perPage) {
  return Math.ceil(total / perPage);
}

export function exportPageCount(total, perPage) {
  const remainder = total % perPage;
  const fullPages = (total - remainder) / perPage;
  return remainder === 0 ? fullPages : fullPages + 1;
}
