// Root-cause fix: take the final path segment, treat a dot at position zero
// as a dotfile marker rather than an extension, and lowercase the tag so
// matching stays case-insensitive.
export function fileExtension(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}
