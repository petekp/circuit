import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  RELEASE_CADENCE,
  currentPluginVersion,
  evalCadenceBlockers,
  lastReleaseTagDate,
  readLedgerEntries,
  readRegistryEvals,
} from '../../scripts/release/eval-cadence.ts';

// These exercise the real readers against the committed repo (registry,
// seeded ledger, plugin.json) so the wiring in check-release-ready.ts is
// covered, not just the pure gate. The gate's own blocking logic is unit-tested
// exhaustively in eval-cadence.test.ts; here we only assert how the readers and
// gate behave against the committed state. The probe dates derive from the
// committed ledger so appending a fresh entry cannot break them.
const REPO_ROOT = resolve(import.meta.dirname, '../..');

function afterEveryLedgerEntry(): string {
  const newest = Math.max(...readLedgerEntries(REPO_ROOT).map((entry) => Date.parse(entry.ran_at)));
  return new Date(newest + 1).toISOString();
}

describe('eval cadence readers', () => {
  it('has no release-or-milestone evals today, so the cadence gate stays quiet', () => {
    // As of 0.1.1 Circuit publishes no eval number, so no eval carries the
    // release cadence. This is the policy invariant: if it ever fails, someone
    // re-added a release-gated eval and must wire the ledger/waiver flow for it.
    const release = readRegistryEvals(REPO_ROOT).filter((e) => e.cadence === RELEASE_CADENCE);
    expect(release).toEqual([]);
  });

  it('reads the seeded ledger entries with parseable timestamps', () => {
    const entries = readLedgerEntries(REPO_ROOT);
    const ids = new Set(entries.map((e) => e.eval_id));
    expect(ids.has('fix-vs-vanilla')).toBe(true);
    expect(ids.has('verdict-correctness')).toBe(true);
    for (const entry of entries) {
      expect(Number.isNaN(Date.parse(entry.ran_at))).toBe(false);
    }
  });

  it('exposes a non-empty plugin version', () => {
    expect(currentPluginVersion(REPO_ROOT).length).toBeGreaterThan(0);
  });

  it('returns a parseable date or null for the last release tag', () => {
    const date = lastReleaseTagDate(REPO_ROOT);
    if (date !== null) expect(Number.isNaN(Date.parse(date))).toBe(false);
  });
});

describe('eval cadence gate against the committed repo', () => {
  it('produces no blockers even when the release tag postdates every ledger entry', () => {
    // With no release-cadence eval in the registry, the gate cannot block a
    // routine release regardless of how stale the ledger is or whether any
    // waiver exists. This is the whole point of the cadence retirement.
    const blockers = evalCadenceBlockers({
      evals: readRegistryEvals(REPO_ROOT),
      ledgerEntries: readLedgerEntries(REPO_ROOT),
      lastReleaseDate: afterEveryLedgerEntry(),
      currentVersion: currentPluginVersion(REPO_ROOT),
      waivers: new Set(),
    });
    expect(blockers).toEqual([]);
  });
});
