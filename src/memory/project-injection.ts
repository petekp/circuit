import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MemoryInputV0 } from '../schemas/index.js';
import { MemoryInputV0 as MemoryInputV0Schema } from '../schemas/index.js';
import { sha256Hex } from '../shared/connector-relay.js';
import { CONTROL_PLANE_RUNS_DIR } from '../shared/control-plane-paths.js';
import { type ReadProjectFactsOptions, readProjectFacts } from './project-store.js';

// Load stored project facts for (project, flow) and re-verify each fact's
// staleness against its cited source at injection time (Slice 5, D6/section 3).
// The producer's value does not depend on the earned-precision gate: these
// facts become candidates that the run-start path feeds through
// applyEarnedPrecision exactly like prior-run recall, so staleness SINKS a
// fact rather than dropping it, and only measured negative effect suppresses.
//
// Re-verification reuses the BEHAVIOR of the query layer's sourceStaleness (not
// its private symbol): cited file present and hash matches -> fresh /
// source_hash_verified; deleted or changed -> stale / memory_stale; unreadable
// or no hash -> unknown / memory_unverified. The cited source is resolved
// relative to its run folder (`<runsBase>/<run_id>/<source_path>`) when the ref
// carries a run_id (trace refs always do); a report ref without a run_id cannot
// be located here and degrades to `unknown` rather than a false `fresh`.

export interface LoadProjectFactCandidatesOptions extends ReadProjectFactsOptions {
  readonly repoRoot: string;
  // Defaults to `<repoRoot>/.circuit/runs`.
  readonly runsBase?: string;
  readonly now?: () => Date;
}

export interface LoadProjectFactCandidatesResult {
  readonly candidates: readonly MemoryInputV0[];
}

function reverifyStaleness(
  fact: MemoryInputV0,
  runsBase: string,
  checkedAt: string,
): MemoryInputV0['staleness'] {
  const sourceSha = fact.source.sha256 ?? fact.source.ref.sha256;
  const runId = fact.source.ref.run_id as unknown as string | undefined;
  if (sourceSha === undefined || runId === undefined) {
    return { status: 'unknown', checked_at: checkedAt, reason_codes: ['memory_unverified'] };
  }
  try {
    // The ref path is run-folder-relative (e.g. trace.ndjson#sequence=N or
    // reports/result.json); strip a trace fragment to the file path.
    const relPath = fact.source.ref.ref.split('#')[0] ?? fact.source.ref.ref;
    const abs = join(runsBase, runId, relPath);
    if (!existsSync(abs)) {
      return { status: 'stale', checked_at: checkedAt, reason_codes: ['memory_stale'] };
    }
    const currentHash = sha256Hex(readFileSync(abs, 'utf8'));
    return currentHash === sourceSha
      ? { status: 'fresh', checked_at: checkedAt, reason_codes: ['source_hash_verified'] }
      : { status: 'stale', checked_at: checkedAt, reason_codes: ['memory_stale'] };
  } catch {
    return { status: 'unknown', checked_at: checkedAt, reason_codes: ['memory_unverified'] };
  }
}

export function loadProjectFactCandidates(
  options: LoadProjectFactCandidatesOptions,
): LoadProjectFactCandidatesResult {
  // Project-fact injection is (project, flow_id)-scoped (D6): a review run sees
  // only review facts. With no flow there is no scope, so inject nothing rather
  // than leak facts across flows. (readProjectFacts stays unfiltered for the
  // `circuit memory list` surface, which legitimately shows every flow's facts.)
  if (options.flowId === undefined) {
    return { candidates: [] };
  }
  const runsBase = resolve(
    options.runsBase ?? join(resolve(options.repoRoot), CONTROL_PLANE_RUNS_DIR),
  );
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const { facts } = readProjectFacts({
    ...(options.memoryDir === undefined
      ? { repoRoot: options.repoRoot }
      : { memoryDir: options.memoryDir }),
    ...(options.flowId === undefined ? {} : { flowId: options.flowId }),
  });
  const candidates = facts.map((fact) =>
    // Re-parse with the freshly-verified staleness so the candidate carries the
    // injection-time freshness (the stored staleness was capture-time).
    MemoryInputV0Schema.parse({
      ...fact,
      staleness: reverifyStaleness(fact, runsBase, checkedAt),
    }),
  );
  return { candidates };
}
