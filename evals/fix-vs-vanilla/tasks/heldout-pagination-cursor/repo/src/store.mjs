// Cursor codec. A cursor token carries the offset to resume paging from.
// `encodeCursor` turns an offset into an opaque token; `decodeCursor` reads it
// back.
//
// Bug: an empty or missing cursor should mean "start at the first item" (offset
// 0), but decoding an empty token parses to NaN, so the first page never starts
// cleanly. The page-size clamp in api.mjs and this codec are used together to cut
// each page, so the assembled first page only comes out right when both are
// correct.
export function encodeCursor(offset) {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

export function decodeCursor(token) {
  return Number.parseInt(Buffer.from(token, 'base64').toString('utf8'), 10);
}
