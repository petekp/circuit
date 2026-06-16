// Root-cause fix (2 of 2): an empty or unparseable cursor decodes to offset 0, so
// the first page starts at the first item. Paired with the clamp fix, both the
// visible test and the assembled hidden check pass.
export function encodeCursor(offset) {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

export function decodeCursor(token) {
  if (!token) return 0;
  const parsed = Number.parseInt(Buffer.from(token, 'base64').toString('utf8'), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}
