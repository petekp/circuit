// Engine provenance: the engine identity stamped on every run record.
//
// Why this exists: run history could not be cohorted by engine build, so
// mining it for live bugs produced confident false positives at roughly four
// in five — a run that failed against an engine from six weeks ago reads
// identically to one that failed against HEAD. A version alone is not enough
// during development, where every run on a branch reports the same released
// version; the SHA plus a dirty-tree flag is what separates two runs.
//
// The honesty rule the schema enforces: a field is present only when it was
// actually observed. A bundled install has no working tree, so it cannot claim
// clean or dirty, and no commit, so it identifies itself by the hash of the
// bytes that ran instead. An engine that cannot identify itself says so rather
// than guessing.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { EngineProvenance } from '../../src/schemas/engine-provenance.js';
import { RunResult } from '../../src/schemas/result.js';
import { RunBootstrappedTraceEntry } from '../../src/schemas/trace-entry.js';
import {
  resetEngineProvenanceForTest,
  resolveEngineProvenance,
} from '../../src/shared/engine-provenance.js';

const SHA = 'a'.repeat(40);
const DIGEST = 'c'.repeat(64);

describe('EngineProvenance schema — a stamp cannot claim more than it observed', () => {
  it('accepts a git-sourced stamp carrying both a sha and a dirty flag', () => {
    const parsed = EngineProvenance.safeParse({
      version: '0.1.1',
      source: 'git',
      sha: SHA,
      dirty: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a git-sourced stamp with no sha (git was probed, so a sha exists)', () => {
    const parsed = EngineProvenance.safeParse({ version: '0.1.1', source: 'git', dirty: false });
    expect(parsed.success).toBe(false);
  });

  it('rejects a git-sourced stamp with no dirty flag', () => {
    const parsed = EngineProvenance.safeParse({ version: '0.1.1', source: 'git', sha: SHA });
    expect(parsed.success).toBe(false);
  });

  it('rejects a dirty flag on a build-stamped engine (a bundle has no working tree)', () => {
    const parsed = EngineProvenance.safeParse({
      version: '0.1.1',
      source: 'build-stamp',
      build_digest: DIGEST,
      dirty: false,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a build-stamped engine identified by the digest of the bundle that ran', () => {
    const parsed = EngineProvenance.safeParse({
      version: '0.1.1',
      source: 'build-stamp',
      build_digest: DIGEST,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a build-stamped engine claiming a commit (a bundle has no checkout)', () => {
    const parsed = EngineProvenance.safeParse({
      version: '0.1.1',
      source: 'build-stamp',
      sha: SHA,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a digest on a git-sourced engine (source runs many files, not one bundle)', () => {
    const parsed = EngineProvenance.safeParse({
      version: '0.1.1',
      source: 'git',
      sha: SHA,
      dirty: false,
      build_digest: DIGEST,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a digest that is not a sha-256', () => {
    const parsed = EngineProvenance.safeParse({
      version: '0.1.1',
      source: 'build-stamp',
      build_digest: SHA,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a build-stamped engine that could not read its own bundle', () => {
    // Degrading to version-only is coarse but true. Inventing a digest is not.
    const parsed = EngineProvenance.safeParse({ version: '0.1.1', source: 'build-stamp' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown-source stamp that still claims a sha', () => {
    const parsed = EngineProvenance.safeParse({ version: '0.1.1', source: 'unknown', sha: SHA });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown-source stamp that still claims a digest', () => {
    const parsed = EngineProvenance.safeParse({
      version: '0.1.1',
      source: 'unknown',
      build_digest: DIGEST,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an unknown-source stamp that claims only a version', () => {
    const parsed = EngineProvenance.safeParse({ version: '0.0.0-dev', source: 'unknown' });
    expect(parsed.success).toBe(true);
  });

  it('rejects a short or non-hex sha', () => {
    expect(
      EngineProvenance.safeParse({ version: '0.1.1', source: 'git', sha: 'abc123', dirty: false })
        .success,
    ).toBe(false);
    expect(
      EngineProvenance.safeParse({
        version: '0.1.1',
        source: 'git',
        sha: 'z'.repeat(40),
        dirty: false,
      }).success,
    ).toBe(false);
  });

  it('rejects surplus keys', () => {
    const parsed = EngineProvenance.safeParse({
      version: '0.1.1',
      source: 'unknown',
      branch: 'main',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('resolveEngineProvenance — probing this checkout', () => {
  it('identifies this source checkout by git sha and dirty flag', () => {
    const provenance = resolveEngineProvenance();
    // The test suite runs from the circuit checkout, which is a git repo, so
    // the probe must reach the git branch rather than degrading to unknown.
    expect(provenance.source).toBe('git');
    expect(provenance.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof provenance.dirty).toBe('boolean');
    expect(EngineProvenance.safeParse(provenance).success).toBe(true);
  });

  it('returns the identical memoized value rather than re-probing git per run record', () => {
    // Every run record write would otherwise shell out to git twice. The stamp
    // is a property of the process, not of the record, so it is resolved once.
    expect(resolveEngineProvenance()).toBe(resolveEngineProvenance());
  });

  it('reports a version', () => {
    expect(resolveEngineProvenance().version.length).toBeGreaterThan(0);
  });

  it('identifies a bundled engine by hashing the single file it is running from', () => {
    // CIRCUIT_VERSION is injected only when bundling, so setting it puts the
    // probe on the branch every plugin-driven run takes. This is the branch that
    // matters: launcher-core prefers the bundled runtime over the dev fallback,
    // so a version-only stamp there would leave real run history as uncohortable
    // as it was before — every run between two releases reporting '0.1.1'.
    const previous = process.env.CIRCUIT_VERSION;
    process.env.CIRCUIT_VERSION = '9.9.9-bundled';
    resetEngineProvenanceForTest();
    try {
      const provenance = resolveEngineProvenance();
      expect(provenance.source).toBe('build-stamp');
      expect(provenance.version).toBe('9.9.9-bundled');
      expect(provenance.sha).toBeUndefined();
      expect(provenance.dirty).toBeUndefined();
      // Bundled, the module IS the whole CLI, so the digest names exactly the
      // bytes that ran. Computed independently here so this cannot pass on a
      // digest of something else.
      const selfPath = fileURLToPath(
        new URL('../../src/shared/engine-provenance.ts', import.meta.url),
      );
      const expected = createHash('sha256').update(readFileSync(selfPath)).digest('hex');
      expect(provenance.build_digest).toBe(expected);
      expect(EngineProvenance.safeParse(provenance).success).toBe(true);
    } finally {
      // Not `= undefined`: process.env coerces that to the string 'undefined',
      // which would leave every later test on the bundled branch.
      if (previous === undefined) Reflect.deleteProperty(process.env, 'CIRCUIT_VERSION');
      else process.env.CIRCUIT_VERSION = previous;
      resetEngineProvenanceForTest();
    }
  });
});

describe('The stamp rides the run record', () => {
  const baseResult = {
    schema_version: 1 as const,
    run_id: '44444444-4444-4444-4444-444444444407',
    flow_id: 'fix',
    goal: 'fix the thing',
    outcome: 'complete' as const,
    summary: 'done',
    closed_at: '2026-04-29T20:30:01.000Z',
    trace_entries_observed: 68,
    manifest_hash: 'abc123',
  };

  it('accepts a RunResult carrying an engine stamp', () => {
    const parsed = RunResult.safeParse({
      ...baseResult,
      engine: { version: '0.1.1', source: 'git', sha: SHA, dirty: false },
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts a RunResult with no engine stamp (the 54 existing runs stay readable)', () => {
    expect(RunResult.safeParse(baseResult).success).toBe(true);
  });

  it('rejects a RunResult whose engine stamp is itself dishonest', () => {
    const parsed = RunResult.safeParse({
      ...baseResult,
      engine: { version: '0.1.1', source: 'unknown', sha: SHA },
    });
    expect(parsed.success).toBe(false);
  });

  const baseBootstrap = {
    schema_version: 1 as const,
    sequence: 1,
    run_id: '44444444-4444-4444-4444-444444444407',
    kind: 'run.bootstrapped' as const,
    recorded_at: '2026-04-29T20:30:01.000Z',
    flow_id: 'fix',
    depth: 'medium' as const,
    goal: 'fix the thing',
    change_kind: {
      change_kind: 'ratchet-advance' as const,
      failure_mode: 'x',
      acceptance_evidence: 'y',
      alternate_framing: 'z',
    },
    manifest_hash: 'abc123',
  };

  it('accepts a run.bootstrapped entry carrying an engine stamp', () => {
    const parsed = RunBootstrappedTraceEntry.safeParse({
      ...baseBootstrap,
      engine: { version: '0.1.1', source: 'git', sha: SHA, dirty: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts a run.bootstrapped entry with no engine stamp (prior fixtures stay valid)', () => {
    expect(RunBootstrappedTraceEntry.safeParse(baseBootstrap).success).toBe(true);
  });
});
