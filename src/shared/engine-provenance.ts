import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EngineProvenance } from '../schemas/engine-provenance.js';

// Resolve which Circuit engine is running, so every run record can say so.
//
// See src/schemas/engine-provenance.ts for the honesty rule this satisfies.
// The short version: run history could not be cohorted by engine build, which
// is the direct cause of a four-in-five false-positive rate when reading the
// corpus for live bugs.

const DEFAULT_DEV_VERSION = '0.0.0-dev';
const GIT_PROBE_TIMEOUT_MS = 2_000;

// The engine's own file and directory, never the project under test. A run
// happens inside someone else's repository, so probing the working directory
// would stamp their commit onto our record.
//
// Marketplace-safe by build-pipeline emission: this resolves the module's own
// location and nothing around it, so it needs no assumption about the
// surrounding layout. The build pipeline emits the whole CLI as one file, which
// makes this path the bundle itself in a marketplace install and this source
// file in a checkout — and both consumers below want exactly that. The digest
// hashes it only on the bundled branch, where it is the single artifact that
// ran; the directory is used only to ask git about a checkout, on a branch a
// bundled install never reaches, and to find the repo's own version manifest,
// which is looked up only after CIRCUIT_VERSION has been ruled out.
const engineModulePath = fileURLToPath(import.meta.url);
const engineModuleDir = dirname(engineModulePath);

export function readSourceVersion(): string {
  // Marketplace-safe by build-time replacement: scripts/plugins/runtime-bundle.ts
  // emits the bundled CLI with CIRCUIT_VERSION inlined as a literal, so this
  // returns the build-time version in every marketplace install and never
  // reaches the path-resolution branches below. The fileURLToPath candidate is
  // only ever exercised in a source-tree checkout where the env var is unset.
  if (process.env.CIRCUIT_VERSION !== undefined) return process.env.CIRCUIT_VERSION;
  const candidates = [
    resolve(engineModuleDir, '../../plugins/version.json'),
    resolve(process.cwd(), 'plugins/version.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.length > 0) return raw.version;
    } catch {
      // Keep version reporting useful when the repo manifest is unavailable.
    }
  }
  return DEFAULT_DEV_VERSION;
}

// Soft-fail git probe in the house style (see src/app/continuity/brief.ts):
// stderr is discarded, any throw means "git could not answer", and the timeout
// keeps a wedged git from stalling a run.
function git(args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', engineModuleDir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_PROBE_TIMEOUT_MS,
    }).trim();
  } catch {
    return undefined;
  }
}

// Hash the single-file CLI that is executing. Roughly four milliseconds for the
// seven-megabyte bundle, paid once per process, which is nothing against a run
// measured in minutes. Unreadable means no digest rather than a wrong one.
function bundleDigest(): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(engineModulePath)).digest('hex');
  } catch {
    return undefined;
  }
}

function probe(): EngineProvenance {
  const version = readSourceVersion();

  // A bundled install has no checkout of its own. Probing git from inside one
  // would walk up into whatever repository the plugin happens to be installed
  // under and report a stranger's commit as the engine's. CIRCUIT_VERSION is
  // injected exactly when bundling, so its presence is the reliable signal that
  // we are not in a source tree.
  //
  // The version alone is too coarse to cohort by: every run between two
  // releases reports the same string, and the bundled runtime is the path
  // essentially every real run takes (launcher-core prefers it over the dev
  // fallback). The digest is what makes those runs separable, and unlike a
  // baked-in commit it survives the byte-for-byte drift gate on the committed
  // bundle, because it is a function of the bundle rather than of when it was
  // built.
  if (process.env.CIRCUIT_VERSION !== undefined) {
    const digest = bundleDigest();
    return digest === undefined
      ? { version, source: 'build-stamp' }
      : { version, source: 'build-stamp', build_digest: digest };
  }

  const sha = git(['rev-parse', 'HEAD']);
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
    return { version, source: 'unknown' };
  }

  // Untracked files count as dirty. The question this flag answers is "does the
  // engine that ran match this commit", and an uncommitted new source file
  // makes the answer no. Erring toward dirty is the honest direction: it says
  // do not fully trust the sha, which is exactly right.
  const status = git(['status', '--porcelain']);
  if (status === undefined) {
    // The commit is known but the tree state is not, and a git-sourced stamp
    // may not report half an observation.
    return { version, source: 'unknown' };
  }

  return { version, source: 'git', sha, dirty: status.length > 0 };
}

let memoized: EngineProvenance | undefined;

// The engine identity is a property of the process, not of the record, so it is
// probed once. Without this, every run record write would shell out to git
// twice.
export function resolveEngineProvenance(): EngineProvenance {
  memoized ??= probe();
  return memoized;
}

// Test seam: forget the probe so a test can exercise a different environment.
export function resetEngineProvenanceForTest(): void {
  memoized = undefined;
}
