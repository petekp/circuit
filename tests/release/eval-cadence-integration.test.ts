import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  currentPluginVersion,
  evalCadenceBlockers,
  lastReleaseTagDate,
  readLedgerEntries,
  readRegistryEvals,
  readWaivers,
} from '../../scripts/release/eval-cadence.ts';

// These exercise the real readers against the committed repo (registry,
// seeded ledger, plugin.json) so the wiring in check-release-ready.ts is
// covered, not just the pure gate. The probe dates derive from the committed
// ledger so appending a fresh entry (which every release requires) cannot
// break them.
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const BEFORE_SEEDS = '2026-06-10T00:00:00.000Z';

function afterEveryLedgerEntry(): string {
  const newest = Math.max(...readLedgerEntries(REPO_ROOT).map((entry) => Date.parse(entry.ran_at)));
  return new Date(newest + 1).toISOString();
}

describe('eval cadence readers', () => {
  it('reads both release-or-milestone evals from the registry', () => {
    const evals = readRegistryEvals(REPO_ROOT);
    const release = evals.filter((e) => e.cadence === 'release-or-milestone').map((e) => e.id);
    expect(release).toContain('fix-vs-vanilla');
    expect(release).toContain('verdict-correctness');
  });

  it('reads seeded ledger entries for both release evals', () => {
    const entries = readLedgerEntries(REPO_ROOT);
    const ids = new Set(entries.map((e) => e.eval_id));
    expect(ids.has('fix-vs-vanilla')).toBe(true);
    expect(ids.has('verdict-correctness')).toBe(true);
    // every entry carries a parseable ran_at
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
  it('passes: the seeded ledger entries are newer than a pre-seed release', () => {
    const blockers = evalCadenceBlockers({
      evals: readRegistryEvals(REPO_ROOT),
      ledgerEntries: readLedgerEntries(REPO_ROOT),
      lastReleaseDate: BEFORE_SEEDS,
      currentVersion: currentPluginVersion(REPO_ROOT),
      waivers: readWaivers(REPO_ROOT),
    });
    expect(blockers).toEqual([]);
  });

  it('blocks both release evals when the release tag is newer than every entry', () => {
    const blockers = evalCadenceBlockers({
      evals: readRegistryEvals(REPO_ROOT),
      ledgerEntries: readLedgerEntries(REPO_ROOT),
      lastReleaseDate: afterEveryLedgerEntry(),
      currentVersion: currentPluginVersion(REPO_ROOT),
      waivers: new Set(),
    });
    expect(blockers).toHaveLength(2);
    expect(blockers.join('\n')).toContain('fix-vs-vanilla');
    expect(blockers.join('\n')).toContain('verdict-correctness');
  });

  it('a current-version waiver clears an otherwise-stale eval', () => {
    const version = currentPluginVersion(REPO_ROOT);
    const blockers = evalCadenceBlockers({
      evals: readRegistryEvals(REPO_ROOT),
      ledgerEntries: readLedgerEntries(REPO_ROOT),
      lastReleaseDate: afterEveryLedgerEntry(),
      currentVersion: version,
      waivers: new Set([`fix-vs-vanilla-${version}`, `verdict-correctness-${version}`]),
    });
    expect(blockers).toEqual([]);
  });
});
