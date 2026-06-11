// Cadence gate for release-grade evals.
//
// Every registry eval whose cadence is "release-or-milestone" must have a
// ledger entry that was recorded after the last release tag — otherwise the
// public numbers on the page could be stale relative to the code being
// shipped. The decision itself (`evalCadenceBlockers`) is a pure,
// side-effect-free function so it is exhaustively unit-testable. The readers
// below gather the real inputs (registry, ledger files, last tag date, plugin
// version, waiver files); check-release-ready.ts composes them and calls the
// gate.
//
// A waiver named "<evalId>-<currentVersion>" lets a release proceed without a
// fresh run for that one eval — but only for that exact version, so the waiver
// cannot silently carry forward to the next release.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CadenceEval {
  readonly id: string;
  readonly cadence: string;
}

export interface LedgerEntryRef {
  readonly eval_id: string;
  readonly ran_at: string;
}

export interface CadenceInput {
  readonly evals: ReadonlyArray<CadenceEval>;
  readonly ledgerEntries: ReadonlyArray<LedgerEntryRef>;
  // ISO date of the last release tag, or null when there is no prior release
  // (the very first release gates nothing — any entry counts as fresh).
  readonly lastReleaseDate: string | null;
  readonly currentVersion: string;
  readonly waivers: ReadonlySet<string>;
}

export const RELEASE_CADENCE = 'release-or-milestone';

export function evalCadenceBlockers(input: CadenceInput): string[] {
  const cutoff =
    input.lastReleaseDate === null ? Number.NEGATIVE_INFINITY : Date.parse(input.lastReleaseDate);
  const blockers: string[] = [];
  for (const evaluation of input.evals) {
    if (evaluation.cadence !== RELEASE_CADENCE) continue;
    const waiverKey = `${evaluation.id}-${input.currentVersion}`;
    if (input.waivers.has(waiverKey)) continue;
    const fresh = input.ledgerEntries.some(
      (entry) => entry.eval_id === evaluation.id && Date.parse(entry.ran_at) >= cutoff,
    );
    if (!fresh) {
      const since = input.lastReleaseDate ?? 'none';
      blockers.push(
        `eval "${evaluation.id}" (cadence ${RELEASE_CADENCE}) has no ledger entry newer than the last release (${since}); run it for ${input.currentVersion} or add a waiver "${waiverKey}"`,
      );
    }
  }
  return blockers;
}

// --- Input readers (the impure half; check-release-ready.ts wires these up) ---

export function readRegistryEvals(repoRoot: string): CadenceEval[] {
  const registryPath = resolve(repoRoot, 'evals/registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    evals?: Array<{ id?: unknown; cadence?: unknown }>;
  };
  const evals: CadenceEval[] = [];
  for (const entry of registry.evals ?? []) {
    if (typeof entry.id === 'string' && typeof entry.cadence === 'string') {
      evals.push({ id: entry.id, cadence: entry.cadence });
    }
  }
  return evals;
}

export function readLedgerEntries(repoRoot: string): LedgerEntryRef[] {
  const ledgerRoot = resolve(repoRoot, 'evals/ledger');
  if (!existsSync(ledgerRoot)) return [];
  const entries: LedgerEntryRef[] = [];
  for (const dir of readdirSync(ledgerRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    if (dir.name === 'waivers') continue; // waivers live alongside entries, not under an eval id
    const evalDir = resolve(ledgerRoot, dir.name);
    for (const file of readdirSync(evalDir)) {
      if (!file.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(resolve(evalDir, file), 'utf8')) as {
        eval_id?: unknown;
        ran_at?: unknown;
      };
      if (typeof raw.eval_id === 'string' && typeof raw.ran_at === 'string') {
        entries.push({ eval_id: raw.eval_id, ran_at: raw.ran_at });
      }
    }
  }
  return entries;
}

// A waiver key is the filename minus a known doc extension. We strip ONLY
// .md/.txt/.yaml/.yml/.json, never a generic ".<alnum>", because a version
// ends in digits (e.g. "0.1.0-alpha.7") and a greedy extension strip would
// eat the ".7" and mis-key the waiver. A file with no extension is its own key.
export function waiverKeyFromFilename(file: string): string {
  return file.replace(/\.(md|txt|ya?ml|json)$/i, '');
}

// Waivers are files (any extension, .md suggested) under evals/ledger/waivers/,
// named "<evalId>-<version>".
export function readWaivers(repoRoot: string): Set<string> {
  const waiverRoot = resolve(repoRoot, 'evals/ledger/waivers');
  if (!existsSync(waiverRoot)) return new Set();
  const waivers = new Set<string>();
  for (const file of readdirSync(waiverRoot)) {
    waivers.add(waiverKeyFromFilename(file));
  }
  return waivers;
}

// Committer date (strict ISO 8601) of the most recent release tag, or null
// when there is no tag — e.g. a shallow CI clone. Null means "first release",
// which gates nothing.
export function lastReleaseTagDate(repoRoot: string): string | null {
  try {
    const tag = execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', 'circuit--v*'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    if (!tag) return null;
    const date = execFileSync('git', ['log', '-1', '--format=%cI', tag], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    return date || null;
  } catch {
    return null;
  }
}

export function currentPluginVersion(repoRoot: string): string {
  const path = resolve(repoRoot, 'plugins/claude/.claude-plugin/plugin.json');
  const plugin = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
  if (typeof plugin.version !== 'string' || plugin.version.length === 0) {
    throw new Error('plugin.json: version must be a non-empty string');
  }
  return plugin.version;
}
