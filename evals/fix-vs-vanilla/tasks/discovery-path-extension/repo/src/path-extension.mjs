// Extension tag for an uploaded path, reported lowercased so tag matching
// stays case-insensitive. Only the final segment of a path can carry an
// extension: directory names may contain dots, and a name whose only dot
// leads it is a dotfile with no extension.
export function fileExtension(path) {
  return path.split('.').pop();
}
