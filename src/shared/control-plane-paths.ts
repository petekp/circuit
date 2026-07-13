// Canonical spellings for the project-local control plane (`.circuit/`).
// Every layer that touches the control plane derives its paths from these
// constants so the directory layout is spelled exactly once.
//
// The helper functions below carry the one canonical joining discipline:
// `resolve(projectRoot, SEGMENT)`. Call sites that anchor the control plane
// to a project root use the helpers; the constants stay exported for the
// sites that need the relative fragment itself (artifact-relative paths,
// URL-style prefix comparisons, display strings, and roots that must stay
// cwd-relative when the caller passes a relative directory).

import { basename, dirname, resolve } from 'node:path';

export const CONTROL_PLANE_DIR = '.circuit';

/**
 * The nearest ancestor directory named `.circuit` (including `descendant`
 * itself), or undefined when the path is not under a control plane.
 */
export function controlPlaneRootFromDescendant(descendant: string): string | undefined {
  let current = resolve(descendant);
  let parent = dirname(current);
  while (parent !== current) {
    if (basename(current) === CONTROL_PLANE_DIR) return current;
    current = parent;
    parent = dirname(current);
  }
  return basename(current) === CONTROL_PLANE_DIR ? current : undefined;
}

/**
 * Resolve a claimed project root, re-anchoring to the control plane's parent
 * when the claim lies inside a `.circuit` directory. A hook or worker whose
 * cwd sits inside the control plane (for example `.circuit/runs/<runId>`) is
 * still working in the enclosing project; accepting the raw claim nested a
 * second `.circuit` store inside the first (observed 2026-06-16/2026-07-12).
 * No legitimate project root lives inside a control plane.
 */
export function normalizeProjectRoot(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  const enclosingControlPlane = controlPlaneRootFromDescendant(resolved);
  return enclosingControlPlane === undefined ? resolved : dirname(enclosingControlPlane);
}

/** Run folders live under `<projectRoot>/.circuit/runs/<runId>/`. */
export const CONTROL_PLANE_RUNS_DIR = `${CONTROL_PLANE_DIR}/runs`;

/** The history index lives under `<projectRoot>/.circuit/history/`. */
export const CONTROL_PLANE_HISTORY_DIR = `${CONTROL_PLANE_DIR}/history`;

/** The project memory store lives under `<projectRoot>/.circuit/memory/`. */
export const CONTROL_PLANE_MEMORY_DIR = `${CONTROL_PLANE_DIR}/memory`;

/** Out-of-run prototype artifacts land under `.circuit/prototypes/<hash>/`. */
export const CONTROL_PLANE_PROTOTYPES_DIR = `${CONTROL_PLANE_DIR}/prototypes`;

/** Project config path segments, relative to the project root. */
export const PROJECT_CONFIG_RELATIVE_SEGMENTS = [CONTROL_PLANE_DIR, 'config.yaml'] as const;

/** `<projectRoot>/.circuit` (absolute when `projectRoot` is absolute or via cwd). */
export function controlPlaneRoot(projectRoot: string): string {
  return resolve(normalizeProjectRoot(projectRoot), CONTROL_PLANE_DIR);
}

/** `<projectRoot>/.circuit/runs`. */
export function runsRoot(projectRoot: string): string {
  return resolve(normalizeProjectRoot(projectRoot), CONTROL_PLANE_RUNS_DIR);
}

/** `<projectRoot>/.circuit/history`. */
export function historyRoot(projectRoot: string): string {
  return resolve(normalizeProjectRoot(projectRoot), CONTROL_PLANE_HISTORY_DIR);
}

/** `<projectRoot>/.circuit/memory`. */
export function memoryRoot(projectRoot: string): string {
  return resolve(normalizeProjectRoot(projectRoot), CONTROL_PLANE_MEMORY_DIR);
}

/** `<projectRoot>/.circuit/config.yaml`. */
export function projectConfigPath(projectRoot: string): string {
  return resolve(normalizeProjectRoot(projectRoot), ...PROJECT_CONFIG_RELATIVE_SEGMENTS);
}
