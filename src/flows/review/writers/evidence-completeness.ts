export function containsOpaqueSubmoduleChange(
  diff: { readonly text: string } | undefined,
): boolean {
  if (diff === undefined) return false;
  return /^(?:index [0-9a-f]+\.\.[0-9a-f]+ 160000|(?:old|new|new file|deleted file) mode 160000)\r?$/imu.test(
    diff.text,
  );
}

function normalizeBinaryDiffPath(path: string): string | undefined {
  const trimmed = path.trim().replace(/^"|"$/gu, '');
  if (trimmed === '/dev/null') return undefined;
  return trimmed.replace(/^[ab]\//u, '');
}

export function opaqueBinaryChangePaths(
  diff: { readonly text: string } | undefined,
): readonly string[] {
  if (diff === undefined) return [];
  const paths = new Set<string>();
  for (const match of diff.text.matchAll(
    /^Binary files (?<left>.+) and (?<right>.+) differ\r?$/gmu,
  )) {
    for (const candidate of [match.groups?.right, match.groups?.left]) {
      if (candidate === undefined) continue;
      const path = normalizeBinaryDiffPath(candidate);
      if (path !== undefined) paths.add(path);
    }
  }
  return [...paths];
}

export function containsOpaqueBinaryChange(diff: { readonly text: string } | undefined): boolean {
  return opaqueBinaryChangePaths(diff).length > 0;
}
