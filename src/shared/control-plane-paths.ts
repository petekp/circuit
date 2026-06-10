// Canonical spellings for the project-local control plane (`.circuit/`).
// Every layer that touches the control plane derives its paths from these
// constants so the directory layout is spelled exactly once. Call sites keep
// their own join/resolve discipline (relative vs absolute) — these are the
// relative path fragments only.

export const CONTROL_PLANE_DIR = '.circuit';

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
