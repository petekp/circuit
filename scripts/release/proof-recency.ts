// Proof-recency comparison for the golden-run stub-freshness guard.
//
// The stub-freshness guard (2c397dd6) runs every proof scenario through the
// real runtime into a throwaway folder and fails when a run *aborts* on a
// report-schema mismatch. That closes the abort class. It does not close the
// *drift* class: a scenario that still runs clean but now ends with a different
// terminal outcome, or writes a different set of report files, than the
// committed proof claims. F1 (capture crashing at a stale stub) stayed invisible
// for weeks because the only automated pressure on proofs was the eval cadence
// gate; this is the second half of closing that gap one step earlier.
//
// This function is the drift check, and it is pure so it can be unit-tested
// without the runtime or the filesystem: the caller resolves the fresh run's
// outcome and top-level report-name set and the committed proof's outcome and
// top-level report-name set, and this returns one operator-facing message per
// drift it finds (an empty array means the committed proof still matches
// behavior).
//
// It compares semantic fields only — the terminal outcome and the SET of
// top-level report file names — never bytes or timestamps, because the known
// noise classes (relay duration_ms, tournament child-run UUIDs, the doctor
// transcript) make a byte comparison a flaky gate, which is worse than no gate.

export type ProofRecencyInput = {
  readonly slug: string;
  readonly freshOutcome: string | undefined;
  readonly committedOutcome: string | undefined;
  readonly freshReportNames: readonly string[];
  readonly committedReportNames: readonly string[];
};

export function compareProofRecency(input: ProofRecencyInput): string[] {
  const failures: string[] = [];
  const refresh = `Re-run \`npm run capture-proofs:golden-runs -- --scenario ${input.slug}\`, then review the diff per docs/release/proofs/README.md.`;

  if (input.committedOutcome === undefined) {
    failures.push(
      `scenario '${input.slug}': no committed outcome in docs/release/proofs/runs/${input.slug}/result.json to compare against. ${refresh}`,
    );
  } else if (input.freshOutcome !== input.committedOutcome) {
    failures.push(
      `scenario '${input.slug}': terminal outcome drifted — a fresh run now ends '${input.freshOutcome ?? 'unknown'}' but the committed proof claims '${input.committedOutcome}'. ${refresh}`,
    );
  }

  const freshSet = new Set(input.freshReportNames);
  const committedSet = new Set(input.committedReportNames);
  const added = [...freshSet].filter((name) => !committedSet.has(name)).sort();
  const removed = [...committedSet].filter((name) => !freshSet.has(name)).sort();
  if (added.length > 0 || removed.length > 0) {
    const parts: string[] = [];
    if (added.length > 0) parts.push(`now writes ${added.join(', ')}`);
    if (removed.length > 0) parts.push(`no longer writes ${removed.join(', ')}`);
    failures.push(
      `scenario '${input.slug}': report set drifted — a fresh run ${parts.join(' and ')} under run/reports/ versus the committed proof. ${refresh}`,
    );
  }

  return failures;
}
