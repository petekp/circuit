/**
 * Owns the shipped-root policy, repo-only roots, manifest path, and path allowlist rules.
 * It does not project public commands, manifest entries, or installed-file hashes.
 */

export type InstalledSurfaceMode = "repo" | "installed";

export const INSTALLED_SURFACE_ROOTS = [
  ".claude-plugin",
  "commands",
  "hooks",
  "schemas",
  "scripts",
  "skills",
  "circuit.config.example.yaml",
] as const;

export const REPO_ONLY_SURFACE_ROOTS = [
  "README.md",
  "ARCHITECTURE.md",
  "CIRCUITS.md",
  "CUSTOM-CIRCUITS.md",
  "docs",
  "assets",
] as const;

export const SURFACE_MANIFEST_PATH = "scripts/runtime/generated/surface-manifest.json";

const TOP_LEVEL_FILE_ROOTS = new Set<string>(["circuit.config.example.yaml"]);

const REPO_INSTALLED_SCRIPT_PATHS = [
  "scripts/sync-to-cache.sh",
  "scripts/verify-install.sh",
  "scripts/relay",
  "scripts/runtime/bin",
  "scripts/runtime/generated",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shouldIgnoreInstalledPath(relativePath: string): boolean {
  return relativePath.split("/").includes(".vite");
}

export function isInstalledSurfaceRoot(root: string): boolean {
  return INSTALLED_SURFACE_ROOTS.includes(
    root as (typeof INSTALLED_SURFACE_ROOTS)[number],
  );
}

export function listInstalledSurfaceRoots(): readonly string[] {
  return [...INSTALLED_SURFACE_ROOTS];
}

export function listInstalledSurfaceSeedPaths(mode: InstalledSurfaceMode): readonly string[] {
  if (mode === "installed") {
    return listInstalledSurfaceRoots();
  }

  return [
    ...INSTALLED_SURFACE_ROOTS.filter((root) => root !== "scripts"),
    ...REPO_INSTALLED_SCRIPT_PATHS,
  ];
}

export function getInstalledSurfacePathPattern(): string {
  const directoryRoots = INSTALLED_SURFACE_ROOTS.filter(
    (root) => !TOP_LEVEL_FILE_ROOTS.has(root),
  ).map(escapeRegExp);
  const topLevelFiles = INSTALLED_SURFACE_ROOTS.filter((root) =>
    TOP_LEVEL_FILE_ROOTS.has(root),
  ).map(escapeRegExp);

  const patterns = [
    directoryRoots.length > 0
      ? `^(${directoryRoots.join("|")})(?:/[^/].*)?$`
      : "",
    ...topLevelFiles.map((file) => `^${file}$`),
  ].filter(Boolean);

  return patterns.join("|");
}
