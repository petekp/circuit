import { describe, expect, it } from 'vitest';

import { evalCadenceBlockers, waiverKeyFromFilename } from '../../scripts/release/eval-cadence.ts';

const EVALS = [
  { id: 'fix-vs-vanilla', cadence: 'release-or-milestone' },
  { id: 'verdict-correctness', cadence: 'release-or-milestone' },
  { id: 'false-done-fix', cadence: 'pr' },
  { id: 'circuit-vs-vanilla', cadence: 'ad-hoc' },
];

const LAST_RELEASE = '2026-06-09T11:43:57-07:00';
const VERSION = '0.1.0-alpha.8';

describe('evalCadenceBlockers', () => {
  it('passes when every release-or-milestone eval has a ledger entry newer than the last release', () => {
    const blockers = evalCadenceBlockers({
      evals: EVALS,
      ledgerEntries: [
        { eval_id: 'fix-vs-vanilla', ran_at: '2026-06-11T05:00:35.157Z' },
        { eval_id: 'verdict-correctness', ran_at: '2026-06-11T05:00:50.196Z' },
      ],
      lastReleaseDate: LAST_RELEASE,
      currentVersion: VERSION,
      waivers: new Set(),
    });
    expect(blockers).toEqual([]);
  });

  it('blocks a release-or-milestone eval with no ledger entry at all', () => {
    const blockers = evalCadenceBlockers({
      evals: EVALS,
      ledgerEntries: [{ eval_id: 'fix-vs-vanilla', ran_at: '2026-06-11T05:00:35.157Z' }],
      lastReleaseDate: LAST_RELEASE,
      currentVersion: VERSION,
      waivers: new Set(),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('verdict-correctness');
  });

  it('blocks when the only ledger entry predates the last release', () => {
    const blockers = evalCadenceBlockers({
      evals: EVALS,
      ledgerEntries: [
        { eval_id: 'fix-vs-vanilla', ran_at: '2026-06-11T05:00:35.157Z' },
        // ran before the last release tag -> stale
        { eval_id: 'verdict-correctness', ran_at: '2026-05-01T00:00:00.000Z' },
      ],
      lastReleaseDate: LAST_RELEASE,
      currentVersion: VERSION,
      waivers: new Set(),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('verdict-correctness');
  });

  it('passes a stale eval when a waiver for the current version exists', () => {
    const blockers = evalCadenceBlockers({
      evals: EVALS,
      ledgerEntries: [{ eval_id: 'fix-vs-vanilla', ran_at: '2026-06-11T05:00:35.157Z' }],
      lastReleaseDate: LAST_RELEASE,
      currentVersion: VERSION,
      waivers: new Set([`verdict-correctness-${VERSION}`]),
    });
    expect(blockers).toEqual([]);
  });

  it('ignores a waiver written for a different version', () => {
    const blockers = evalCadenceBlockers({
      evals: EVALS,
      ledgerEntries: [{ eval_id: 'fix-vs-vanilla', ran_at: '2026-06-11T05:00:35.157Z' }],
      lastReleaseDate: LAST_RELEASE,
      currentVersion: VERSION,
      waivers: new Set(['verdict-correctness-0.1.0-alpha.7']),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('verdict-correctness');
  });

  it('does not gate evals whose cadence is not release-or-milestone', () => {
    const blockers = evalCadenceBlockers({
      evals: [
        { id: 'false-done-fix', cadence: 'pr' },
        { id: 'circuit-vs-vanilla', cadence: 'ad-hoc' },
      ],
      ledgerEntries: [],
      lastReleaseDate: LAST_RELEASE,
      currentVersion: VERSION,
      waivers: new Set(),
    });
    expect(blockers).toEqual([]);
  });

  it('honors a waiver file whether or not it carries a doc extension', () => {
    // The version ends in ".7"; a naive extension strip would mis-key it.
    expect(waiverKeyFromFilename('verdict-correctness-0.1.0-alpha.7.md')).toBe(
      'verdict-correctness-0.1.0-alpha.7',
    );
    expect(waiverKeyFromFilename('verdict-correctness-0.1.0-alpha.7')).toBe(
      'verdict-correctness-0.1.0-alpha.7',
    );
    expect(waiverKeyFromFilename('fix-vs-vanilla-1.2.3.yaml')).toBe('fix-vs-vanilla-1.2.3');

    const version = '0.1.0-alpha.7';
    const blockers = evalCadenceBlockers({
      evals: [{ id: 'verdict-correctness', cadence: 'release-or-milestone' }],
      ledgerEntries: [],
      lastReleaseDate: LAST_RELEASE,
      currentVersion: version,
      waivers: new Set([waiverKeyFromFilename(`verdict-correctness-${version}`)]),
    });
    expect(blockers).toEqual([]);
  });

  it('treats any ledger entry as fresh when there is no prior release', () => {
    const blockers = evalCadenceBlockers({
      evals: [{ id: 'verdict-correctness', cadence: 'release-or-milestone' }],
      ledgerEntries: [{ eval_id: 'verdict-correctness', ran_at: '2020-01-01T00:00:00.000Z' }],
      lastReleaseDate: null,
      currentVersion: VERSION,
      waivers: new Set(),
    });
    expect(blockers).toEqual([]);
  });
});
