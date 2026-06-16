// Root-cause fix (1 of 2): the page size clamps to both bounds. Paired with the
// cursor fix below, the assembled first page starts at the right item with the
// right size, so the visible test and the assembled hidden check both pass.
import { decodeCursor } from './store.mjs';

const MAX_PAGE_SIZE = 5;

export function clampPageSize(requested) {
  return Math.max(1, Math.min(requested, MAX_PAGE_SIZE));
}

export function nextPage(items, requested, cursor) {
  const size = clampPageSize(requested);
  const offset = decodeCursor(cursor);
  return items.slice(offset, offset + size);
}
