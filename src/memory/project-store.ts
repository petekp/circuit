import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type MemoryInputV0, MemoryInputV0 as MemoryInputV0Schema } from '../schemas/index.js';
import { writeTextAtomic } from '../shared/atomic-io.js';
import { CONTROL_PLANE_MEMORY_DIR, memoryRoot } from '../shared/control-plane-paths.js';

// The local, physically-per-project store for self-auditing project facts
// (Slice 5). It holds line-delimited `MemoryInputV0` records with
// `kind:"project"`, parallel to `.circuit/history/documents.v1.jsonl`. The
// store LOCATION is the project scope (D1): one worktree's `.circuit/memory/`
// is its own store, and `readProjectFacts` filters only by `flow_id` (a real
// per-record property derivable from `source.ref.flow_id`) — never by a
// per-record projectId, which a `.strict()` `MemoryInputV0` has nowhere to
// hold. Cross-worktree sharing is deferred; the resolved projectId is recorded
// once in a sibling manifest as provenance (see project-identity.ts).
//
// Held as local constants (not imported from the history/run-envelope modules)
// so this writer does not couple to the in-flight architecture-hardening file
// layout; the design's rule is "target stable contracts, not current file
// locations". The control-plane spelling itself comes from the shared
// canonical constants.
export const MEMORY_DIR_RELATIVE_PATH = CONTROL_PLANE_MEMORY_DIR;
export const PROJECT_FACTS_FILE = 'project.v1.jsonl';
export const MEMORY_MANIFEST_FILE = 'manifest.json';

export interface ProjectStorePaths {
  readonly repoRoot: string;
  readonly memoryDir: string;
  readonly factsPath: string;
  readonly manifestPath: string;
}

export interface ProjectStoreOptions {
  readonly repoRoot?: string;
  // Override the `.circuit/memory` directory directly (tests, alternate
  // layouts). Wins over repoRoot when present.
  readonly memoryDir?: string;
}

// A store-local warning shape, decoupled from the history warning-code enum so
// the memory module owns its own vocabulary. An unparseable line is REPORTED
// here, never silently dropped (the Slice 1 discipline: surface gaps loudly).
export interface ProjectStoreWarning {
  readonly code: 'project_fact_invalid';
  readonly message: string;
  readonly line: number;
}

export interface ReadProjectFactsOptions extends ProjectStoreOptions {
  // The flow about to run; only facts whose cited source carries this flow_id
  // are returned. Undefined returns every readable fact (the manage/list view).
  readonly flowId?: string;
}

export interface ReadProjectFactsResult {
  readonly facts: readonly MemoryInputV0[];
  readonly warnings: readonly ProjectStoreWarning[];
}

export function resolveProjectStorePaths(options: ProjectStoreOptions = {}): ProjectStorePaths {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const memoryDir =
    options.memoryDir === undefined ? memoryRoot(repoRoot) : resolve(repoRoot, options.memoryDir);
  return {
    repoRoot,
    memoryDir,
    factsPath: join(memoryDir, PROJECT_FACTS_FILE),
    manifestPath: join(memoryDir, MEMORY_MANIFEST_FILE),
  };
}

// Read every readable fact, filtering by flow_id when requested. An empty or
// absent store reads as zero facts (fail-open). A line that fails to parse is
// reported as a warning (with its 1-based line number) rather than aborting the
// read or being silently dropped — a single corrupt line never blinds the
// store to the rest of the corpus.
export function readProjectFacts(options: ReadProjectFactsOptions = {}): ReadProjectFactsResult {
  const paths = resolveProjectStorePaths(options);
  if (!existsSync(paths.factsPath)) {
    return { facts: [], warnings: [] };
  }
  let raw = '';
  try {
    raw = readFileSync(paths.factsPath, 'utf8');
  } catch (error) {
    return {
      facts: [],
      warnings: [
        {
          code: 'project_fact_invalid',
          message: `project fact store unreadable: ${error instanceof Error ? error.message : String(error)}`,
          line: 0,
        },
      ],
    };
  }

  const facts: MemoryInputV0[] = [];
  const warnings: ProjectStoreWarning[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      warnings.push({
        code: 'project_fact_invalid',
        message: `project fact line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        line: index + 1,
      });
      continue;
    }
    const parsed = MemoryInputV0Schema.safeParse(value);
    if (!parsed.success) {
      warnings.push({
        code: 'project_fact_invalid',
        message: `project fact line ${index + 1} failed validation: ${parsed.error.message}`,
        line: index + 1,
      });
      continue;
    }
    if (options.flowId !== undefined && parsed.data.source.ref.flow_id !== options.flowId) {
      continue;
    }
    facts.push(parsed.data);
  }
  // Collapse duplicate memory_ids defensively (last write wins, first-seen
  // position). The write path upserts, so a freshly-written store never holds
  // duplicates; this heals a legacy store written before the upsert fix (or one
  // hand-edited) so `circuit memory list` counts and run-start recall injection
  // never double-count the same id. A Map keyed by memory_id keeps the original
  // position of the first occurrence while taking the latest record's value.
  const byId = new Map<string, MemoryInputV0>();
  for (const fact of facts) byId.set(fact.memory_id, fact);
  return { facts: [...byId.values()], warnings };
}

// Atomically rewrite the full fact set (eviction/forget is a rewrite). Stages a
// tmp file, re-parses every line through the schema before the rename commits,
// then renames into place — the Slice 1 write discipline. A record that is not
// a valid `kind:"project"` fact throws before any file is touched.
export function rewriteProjectFacts(
  records: readonly MemoryInputV0[],
  options: ProjectStoreOptions = {},
): string {
  const paths = resolveProjectStorePaths(options);
  const validated = records.map((record) => {
    const parsed = MemoryInputV0Schema.parse(record);
    if (parsed.kind !== 'project') {
      throw new Error(`project store only holds kind:"project" facts (got ${parsed.kind})`);
    }
    return parsed;
  });
  const body = validated.map((record) => JSON.stringify(record)).join('\n');
  const out = body.length === 0 ? '' : `${body}\n`;
  writeTextAtomic(paths.factsPath, out, {
    // Re-parse the bytes that will land, so a serialization defect cannot commit.
    validate: (raw) => {
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue;
        MemoryInputV0Schema.parse(JSON.parse(line) as unknown);
      }
    },
  });
  return paths.factsPath;
}

// Upsert one fact by memory_id. Implemented as a read-then-rewrite so the write
// is atomic and re-parsed (rather than a non-atomic O_APPEND that could tear a
// line). Re-filing a note whose deterministic memory_id already exists REPLACES
// the prior record rather than appending a duplicate — the operation is
// idempotent (a re-file is a no-op on the id set) and the store cannot grow
// unboundedly on repeated identical notes. Existing invalid lines are dropped on
// rewrite ONLY if they cannot be read back — the read path already surfaced them
// as warnings; an upsert never silently resurrects an unparseable line into the
// validated set.
export function appendProjectFact(
  record: MemoryInputV0,
  options: ProjectStoreOptions = {},
): string {
  const existing = readProjectFacts(options).facts.filter(
    (entry) => entry.memory_id !== record.memory_id,
  );
  return rewriteProjectFacts([...existing, record], options);
}

// Remove the fact with the given memory_id, returning whether anything was
// removed (so the CLI can report "no such fact" rather than a silent no-op).
export function forgetProjectFact(
  memoryId: string,
  options: ProjectStoreOptions = {},
): { readonly removed: boolean; readonly path: string } {
  const existing = readProjectFacts(options).facts;
  const remaining = existing.filter((record) => record.memory_id !== memoryId);
  const path = rewriteProjectFacts(remaining, options);
  return { removed: remaining.length !== existing.length, path };
}
