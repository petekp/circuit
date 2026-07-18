// Worker-CLI state directories live OUTSIDE the project (codex keeps a
// sqlite state db under ~/.codex). A sandboxed host session that only allows
// writes inside the project breaks such a worker seconds after spawn with a
// readonly-database error, which reads like a task failure and is not one.
// This module owns three things every surface that meets this class shares:
// where codex's state directory is, a real-write probe for it, and the one
// plain sentence describing the failure. `circuit doctor`, run-intake
// preflight, and the mid-run failure interpreter all speak with this voice so
// the operator reads the same diagnosis everywhere.

import { existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Mirrors codex's own resolution: CODEX_HOME overrides the default ~/.codex.
// Kept in step with resolveCodexHome in codex-default-model.ts.
export function codexStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.codex');
}

export type StateDirProbe =
  | { readonly writable: true; readonly dir: string }
  | { readonly writable: false; readonly dir: string; readonly detail: string };

/**
 * Prove the directory is writable by actually writing to it. An access-mode
 * check is not enough: macOS seatbelt and similar sandboxes pass stat-based
 * checks and deny the write itself. The probe creates one temp file and
 * removes it; if the directory did not exist it is created and removed again,
 * so a machine that never ran codex is left exactly as found.
 */
export function probeStateDirWritable(dir: string): StateDirProbe {
  const probeFile = join(dir, `.circuit-write-probe-${process.pid}`);
  let createdDir = false;
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      createdDir = true;
    }
    writeFileSync(probeFile, 'circuit write probe');
    unlinkSync(probeFile);
    if (createdDir) rmdirSync(dir);
    return { writable: true, dir };
  } catch (error) {
    return { writable: false, dir, detail: (error as Error).message };
  }
}

/**
 * The shared diagnosis sentence: what happened, whose fault it is (setup, not
 * the task), and what to do next. `dir` is included when known; callers that
 * parsed it out of stderr may not have one.
 */
export function stateDirUnwritableSummary(cli: string, dir: string | undefined): string {
  const where = dir === undefined ? 'its state directory' : `its state directory (${dir})`;
  return `The ${cli} CLI could not write ${where}. This is a setup problem, not a task failure: Circuit is likely running inside a sandboxed session that blocks writes outside the project. Rerun Circuit outside the sandbox, then retry.`;
}
