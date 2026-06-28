// The frozen-eval guard.
//
// An autonomous until-loop ("Converge") re-enters an act step that runs with full
// default tools. Nothing structurally stops that act from editing the very EVAL
// SURFACE the loop's evidence floor trusts — the test files, the verify command's
// own definition, a spec or expected-output file — so the next pass "passes" on a
// check it just weakened. The evidence floor would then clean-stop on a gamed
// metric (autoresearch blocks the analog by making its eval read-only).
//
// This guard is the detective half of the latch. The flow DECLARES a set of
// read-only frozen paths; the engine fingerprints each at loop entry (before the
// first act runs) and, at each iteration's tail seam, asks `changedFrozenPaths()`
// which of them drifted. Any drift opens a dedicated honesty-ledger latch the
// evidence floor refuses to honor, so a tampered run can only ever end
// needs-attention, never complete.
//
// Deliberately pure of engine types: just fs + crypto + path over an injected
// project root, so it stays trivially testable and never reaches for ambient cwd.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The fingerprint for a path that does not exist or cannot be read at the moment
// it is sampled. A real file always hashes to 64 hex chars, so this sentinel can
// never collide with one — which is what lets a created-after-baseline or a
// deleted-after-baseline path read as a drift just like a content change.
const ABSENT = '<absent>';

export class FrozenEvalGuard {
  // Keyed by the ORIGINAL declared path string (not the resolved absolute path)
  // so latch reasons name the surface in the operator's own terms.
  private readonly baseline: Map<string, string>;

  constructor(
    private readonly projectRoot: string,
    frozenPaths: readonly string[],
  ) {
    this.baseline = new Map(frozenPaths.map((p) => [p, this.fingerprint(p)]));
  }

  // Sha256 hex of the file's bytes, or the ABSENT sentinel if the file is missing
  // or unreadable. Resolved against the injected project root; never cwd.
  private fingerprint(declaredPath: string): string {
    try {
      const bytes = readFileSync(resolve(this.projectRoot, declaredPath));
      return createHash('sha256').update(bytes).digest('hex');
    } catch {
      return ABSENT;
    }
  }

  // Re-fingerprint each declared path and return the sorted declared paths whose
  // current fingerprint differs from the loop-entry baseline. Covers all three
  // tamper shapes — modified, created-after-baseline, deleted-after-baseline —
  // because each flips the path's fingerprint relative to its baseline.
  changedFrozenPaths(): string[] {
    const changed: string[] = [];
    for (const [declaredPath, baseline] of this.baseline) {
      if (this.fingerprint(declaredPath) !== baseline) changed.push(declaredPath);
    }
    return changed.sort();
  }
}
