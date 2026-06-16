// Under the naive fix this module is left UNCHANGED from the shipped repo: an
// empty/initial cursor still decodes to NaN, so the first page comes back empty
// and the assembled hidden check fails.
export function encodeCursor(offset) {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

export function decodeCursor(token) {
  return Number.parseInt(Buffer.from(token, 'base64').toString('utf8'), 10);
}
