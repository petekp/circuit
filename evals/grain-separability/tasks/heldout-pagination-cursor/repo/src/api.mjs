// Pagination API. `clampPageSize` keeps a requested page size within bounds, and
// `nextPage` cuts the next page of items using the clamped size and the resume
// cursor decoded from store.mjs.
//
// Bug: only the upper bound is clamped, so a zero or negative requested size
// slips through and yields an empty page that never advances. The page size
// bounds the cursor window, so the assembled page only comes out right when both
// the clamp here and the cursor decode in store.mjs are correct.
import { decodeCursor } from './store.mjs';

const MAX_PAGE_SIZE = 5;

export function clampPageSize(requested) {
  return Math.min(requested, MAX_PAGE_SIZE);
}

export function nextPage(items, requested, cursor) {
  const size = clampPageSize(requested);
  const offset = decodeCursor(cursor);
  return items.slice(offset, offset + size);
}
