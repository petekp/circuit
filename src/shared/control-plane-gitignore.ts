// Machine-write privacy for the project-local `.circuit/` control plane.
//
// Circuit auto-writes into `<repo>/.circuit` constantly: run folders, traces,
// reports, evidence, history, project memory, prototype artifacts, and ambient
// continuity records. A continuity record can restate secrets from a compaction
// summary, and nothing else seeds an ignore file, so without one every machine
// write is a `git add .` away from being committed silently. Seeding a single
// `.circuit/.gitignore` keeps the whole subtree out of git while still letting a
// user intentionally commit a project `config.yaml`.
//
// One source of truth: every `.circuit/` auto-write seam (a run opening, an
// ambient harvest) calls ensureCircuitGitignore so the ignore rules are spelled
// exactly once and can never drift between seams.

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { writeTextAtomic } from './atomic-io.js';
import { CONTROL_PLANE_DIR } from './control-plane-paths.js';

const CIRCUIT_GITIGNORE_CONTENTS = [
  '# Circuit machine-written records — do not commit',
  '*',
  '!.gitignore',
  '!config.yaml',
  '',
].join('\n');

/**
 * Seed `<circuitDir>/.gitignore` so machine-written control-plane files never
 * get committed by accident. Idempotent: it only writes when the file is
 * absent, so a user who has customized their own `.circuit/.gitignore` is never
 * clobbered. Best-effort — a failure to seed must never break the write that
 * triggered it.
 */
export function ensureCircuitGitignore(circuitDir: string): void {
  const gitignorePath = join(circuitDir, '.gitignore');
  if (existsSync(gitignorePath)) return;
  try {
    writeTextAtomic(gitignorePath, CIRCUIT_GITIGNORE_CONTENTS);
  } catch {
    // Privacy seeding is best-effort; never let it abort the triggering write.
  }
}

/**
 * The nearest ancestor directory named `.circuit`, or undefined when
 * `descendant` is not under a control plane (for example a test's temp run
 * directory). This lets a run seed its control-plane `.gitignore` straight from
 * its run folder without threading the project root through the runtime
 * boundary, and makes the seed a safe no-op for any run directory that does not
 * live under `.circuit`.
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
