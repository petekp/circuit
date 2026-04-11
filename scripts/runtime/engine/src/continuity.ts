import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface HandoffLocationOptions {
  handoffHome?: string;
  homeDir?: string;
  projectRoot: string;
}

export interface CurrentRunResolution {
  activeRunPath: string | null;
  mode: "file" | "symlink" | null;
  pointerPath: string;
  pointerTarget: string | null;
  runRoot: string | null;
}

export interface ContinuityInspection {
  activeRunPath: string | null;
  activeRunSource: "fallback" | "pointer" | null;
  hasHandoff: boolean;
  handoffPath: string;
  pointer: CurrentRunResolution;
  projectRoot: string;
  runRoot: string | null;
  slugSource: string;
}

function normalizeProjectPath(projectRoot: string): string {
  return projectRoot.replace(/\\/g, "/");
}

export function projectSlug(projectRoot: string): string {
  return normalizeProjectPath(projectRoot)
    .replace(/\//g, "-")
    .replace(/[:<>"|?*]/g, "")
    .replace(/^-/, "");
}

export function resolveProjectRoot(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
  });

  if (result.status === 0) {
    const gitRoot = result.stdout.trim();
    if (gitRoot) {
      return gitRoot;
    }
  }

  return resolve(cwd);
}

export function resolveSlugSource(projectRoot: string): string {
  return resolveProjectRoot(projectRoot);
}

export function resolveHandoffPath(options: HandoffLocationOptions): string {
  const base = options.handoffHome || options.homeDir || "";
  const rootDir = options.handoffHome ? ".circuit-projects" : ".claude/projects";
  return resolve(base, rootDir, projectSlug(resolveSlugSource(options.projectRoot)), "handoff.md");
}

export function hasValidHandoff(handoffPath: string): boolean {
  if (!existsSync(handoffPath)) {
    return false;
  }

  const firstLine = readFileSync(handoffPath, "utf-8").split(/\r?\n/, 1)[0] ?? "";
  return firstLine === "# Handoff";
}

export function resolveCurrentRun(projectRoot: string): CurrentRunResolution {
  const pointerPath = join(projectRoot, ".circuit", "current-run");
  const circuitRunsDir = join(projectRoot, ".circuit", "circuit-runs");

  if (!existsSync(pointerPath)) {
    return {
      activeRunPath: null,
      mode: null,
      pointerPath,
      pointerTarget: null,
      runRoot: null,
    };
  }

  let runRoot: string | null = null;
  let pointerTarget: string | null = null;
  let mode: "file" | "symlink" | null = null;

  const stat = lstatSync(pointerPath);
  if (stat.isSymbolicLink()) {
    mode = "symlink";
    pointerTarget = readlinkSync(pointerPath);
    runRoot = pointerTarget.startsWith("/")
      ? pointerTarget
      : resolve(projectRoot, ".circuit", pointerTarget);
  } else {
    mode = "file";
    const slug = readFileSync(pointerPath, "utf-8").trim();
    pointerTarget = slug;
    runRoot = slug ? resolve(circuitRunsDir, slug) : null;
  }

  const activeRunPath = runRoot ? join(runRoot, "artifacts", "active-run.md") : null;
  return {
    activeRunPath: activeRunPath && existsSync(activeRunPath) ? activeRunPath : null,
    mode,
    pointerPath,
    pointerTarget,
    runRoot,
  };
}

function walkActiveRuns(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  for (const name of readdirSync(rootDir)) {
    const fullPath = join(rootDir, name);
    const stat = lstatSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walkActiveRuns(fullPath));
      continue;
    }
    if (name === "active-run.md") {
      files.push(fullPath);
    }
  }
  return files;
}

export function findLatestActiveRun(projectRoot: string): string | null {
  const circuitRunsDir = join(projectRoot, ".circuit", "circuit-runs");
  let newestPath: string | null = null;
  let newestMtime = -1;

  for (const candidate of walkActiveRuns(circuitRunsDir)) {
    const mtime = statSync(candidate).mtimeMs;
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newestPath = candidate;
    }
  }

  return newestPath;
}

export function inspectContinuity(options: HandoffLocationOptions): ContinuityInspection {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const handoffPath = resolveHandoffPath({
    handoffHome: options.handoffHome,
    homeDir: options.homeDir,
    projectRoot,
  });
  const pointer = resolveCurrentRun(projectRoot);

  if (pointer.activeRunPath) {
    return {
      activeRunPath: pointer.activeRunPath,
      activeRunSource: "pointer",
      hasHandoff: hasValidHandoff(handoffPath),
      handoffPath,
      pointer,
      projectRoot,
      runRoot: pointer.runRoot,
      slugSource: resolveSlugSource(projectRoot),
    };
  }

  const fallbackActiveRun = findLatestActiveRun(projectRoot);
  return {
    activeRunPath: fallbackActiveRun,
    activeRunSource: fallbackActiveRun ? "fallback" : null,
    hasHandoff: hasValidHandoff(handoffPath),
    handoffPath,
    pointer,
    projectRoot,
    runRoot: fallbackActiveRun ? dirname(dirname(fallbackActiveRun)) : null,
    slugSource: resolveSlugSource(projectRoot),
  };
}
