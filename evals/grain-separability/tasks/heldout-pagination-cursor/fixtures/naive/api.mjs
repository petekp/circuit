// Naive fix: clamps the lower bound of the page size, the symptom the visible
// `npm test` checks. But store.mjs is left UNCHANGED, so an empty/initial cursor
// still decodes to NaN and the first page comes back empty. The visible test goes
// green while the assembled hidden check stays red. This is the trap.
//
// Companion module under this fix: src/store.mjs is left UNCHANGED (an empty
// cursor still decodes to NaN).
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
