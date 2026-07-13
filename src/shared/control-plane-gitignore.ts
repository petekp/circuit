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
import { join } from 'node:path';
import { writeTextAtomic } from './atomic-io.js';

export { controlPlaneRootFromDescendant } from './control-plane-paths.js';

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

// controlPlaneRootFromDescendant moved to control-plane-paths.ts (the path
// helpers there use it to reject nested control planes) and is re-exported
// above so run-boundary call sites keep their import.
