// Shared scanner probe for Sweep's compose writers.
//
// The census and the per-wave partition both need the CURRENT structured
// finding list, so they spawn the project's `scan` script and parse its JSON
// stdout. This is deliberately NOT the oracle: the honesty floor is the pinned
// run-verification rescan (engine change 2), which reads the scanner's EXIT
// CODE. The scanner is dual-channel — it prints `{ "findings": [...] }` to
// stdout for the work-list here and exits non-zero while findings remain for the
// floor there. A worker that tampers with the `scan` script body to hide
// findings from THIS probe cannot launder a green close: the pinned rescan
// re-runs the same script and its fingerprint drift or its still-red exit is
// what the floor reads. The probe only affects which units a wave attempts, not
// whether the run may complete.

import type { VerificationCommand } from '../../../schemas/verification.js';
import { runProofPlanCommand } from '../../../shared/proof-plan.js';
import { SweepFinding } from '../reports.js';

// Run the project's own resolved oracle command and return its stdout. The
// command is passed in rather than built here: the census resolves it once and
// pins it, and every later probe runs that same pinned argv, so the work-list
// and the floor can never be reading two different scanners.
//
// It goes through runProofPlanCommand, the engine's one command executor, and
// not through a local spawnSync. Sweep's oracle is a verification command like
// any other, so it gets the same rules: the proof-plan environment allowlist
// instead of whatever happened to be in the ambient shell, the realpath cwd
// containment check instead of a plain resolve, and the command's own declared
// output budget instead of a number this file picked. A second executor would
// be a second set of rules, and the reason the oracle is resolved rather than
// hardcoded is precisely that it should clear the shared bar.
//
// A non-zero exit is EXPECTED for the scanner (findings remain) and is not an
// error here; a command that could not launch throws out of the executor, and a
// command killed for its budget or its timeout throws below rather than
// reaching the parser as suspiciously empty output.
function runOracle(projectRoot: string, command: VerificationCommand): string {
  const observation = runProofPlanCommand(command, projectRoot);
  if (observation.timed_out) {
    throw new Error(
      `sweep scan: '${command.argv.join(' ')}' did not finish within ${command.timeout_ms}ms`,
    );
  }
  return observation.stdout_summary;
}

// Locate and parse the `{ "findings": [...] }` object in the scanner's stdout.
// Tolerant of a leading/trailing blank line, but not of arbitrary prose: the
// fixture script emits a single JSON object, and a malformed payload is a real
// error worth surfacing rather than silently treating as zero findings (which
// would let a broken scanner masquerade as a clean tree).
export function parseScannerFindings(stdout: string): SweepFinding[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error('sweep scan: scanner produced no output to parse for findings');
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('sweep scan: scanner output did not contain a JSON findings object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`sweep scan: scanner findings JSON was unparseable: ${message}`);
  }
  const rawFindings =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { findings?: unknown }).findings
      : undefined;
  if (!Array.isArray(rawFindings)) {
    throw new Error("sweep scan: scanner output missing a 'findings' array");
  }
  return rawFindings.map((finding) => SweepFinding.parse(finding));
}

// The structured finding list from a fresh scanner run. Used by the census
// (baseline) and by every wave's partition (survivors).
export function runScannerFindings(
  projectRoot: string,
  scanner: VerificationCommand,
): SweepFinding[] {
  return parseScannerFindings(runOracle(projectRoot, scanner));
}

// The suppression baseline: the count of suppression directives already in the
// tree, printed by the `audit` script. The pinned rescan reads the audit's EXIT
// code (non-zero once any suppression exists); the census reads this count so
// the operator sees the starting point. On the fixture the tree is clean, so the
// baseline is zero. A non-integer payload throws rather than defaulting.
export function runSuppressionBaseline(projectRoot: string, audit: VerificationCommand): number {
  const stdout = runOracle(projectRoot, audit).trim();
  const match = stdout.match(/-?\d+/);
  if (match === null) {
    throw new Error('sweep census: audit script did not print a suppression count');
  }
  return Math.max(0, Number.parseInt(match[0], 10));
}
