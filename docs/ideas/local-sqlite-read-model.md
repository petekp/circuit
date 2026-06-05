# Local SQLite Read Model For Circuit

Status: current proposal. This is architecture exploration only. It is not
current behavior, roadmap commitment, or a runtime change.

Date: 2026-06-05

## Short Recommendation

Use SQLite first as a derived local read model over existing Circuit artifacts.

Do not make SQLite the source of truth for runs, traces, reports, checkpoints,
or proof in the first slice. Keep `.circuit/runs/<id>/trace.ndjson`, run
reports, manifest snapshots, and cited refs as the authority. Let SQLite rebuild
from those files, answer local queries faster, and power better inspection and
memory tools.

The useful v1 shape is:

```text
.circuit/runs/                 authoritative run artifacts
.circuit/history/              current JSONL history index
.circuit/index/circuit.v1.db   optional derived SQLite database
```

If the database is missing, stale, corrupt, or unsupported, Circuit should be
able to rebuild it or fall back to the file-backed path.

## Decision Frame

Goal: decide how a local SQLite database could help Circuit without weakening
the existing evidence model.

Problem: Circuit already records valuable run, trace, report, checkpoint, memory,
and proof data, but the operator and host surfaces still need better ways to ask
questions across that corpus.

Invariants:

- A run remains the aggregate of manifest snapshot, append-only trace, and
  derived snapshot.
- History and memory stay hint-only unless a later proposal explicitly changes
  that authority boundary.
- Run artifacts stay portable and inspectable without a database.
- A database row never satisfies current proof, checkpoint, policy, route,
  recovery, verification, or write authority by itself.
- Any database answer must cite the source artifact path, ref, and hash or
  staleness state.

Non-goals:

- No runtime migration in this proposal.
- No hosted sync.
- No vector store or embedding dependency in v1.
- No replacement for `trace.ndjson`.
- No silent memory promotion from repeated rows.

Constraints:

- Current production dependencies are small: `commander`, `yaml`, and `zod`.
  A local check found `node:sqlite` available in the bundled Node 24 runtime, so
  SQLite may not require a package dependency. It still needs a host-runtime and
  bundling proof before product use.
- `.circuit/` is ignored and local-only.
- Generated host packages should not hand-edit database behavior into mirrors.
- Existing `history` commands require JSON output and already have stale-index
  behavior.

## Current System

| Area | Current Owner | Inputs | Outputs | Dependencies | Pain |
| --- | --- | --- | --- | --- | --- |
| Run authority | runtime trace and run-file stores | manifest snapshot, step events, reports | `trace.ndjson`, JSON reports | filesystem, schemas | Strong portability, but cross-run questions require scans or indexes. |
| History index | `src/app/history/indexer.ts` and `query.ts` | `.circuit/runs` | `.circuit/history/manifest.v1.json`, `documents.v1.jsonl` | filesystem, lexical ranking | Good first index, but query and filtering will get awkward as the corpus grows. |
| Run-start recall | `src/app/history/run-start-recall.ts` | history query hits, project facts | recall reports, prompt hints | history query, memory preview | Useful, but only a small push surface and intentionally hint-only. |
| Pull memory | `circuit history pull` | explicit agent query | `MemoryInputV0` preview plus pull log | query, suppression, optional write to active run | Good audit path, but no richer analytics over pull use yet. |
| Project facts | `src/memory/project-store.ts` | operator-filed notes | `.circuit/memory/project.v1.jsonl` | filesystem, `MemoryInputV0` | Local and simple, but hard to slice by many dimensions later. |
| Run inspection | proposed `runs list/events/why` | run folders | status and event projections | run-status projector, trace parser | Current proposals still rely on recursive file reads and per-command projection. |
| Evals and proofs | reports and tests | flow outputs, checks, proof runs | JSON files and test output | scripts, tests | Useful data exists, but not yet easy to query as a local dataset. |

Live local evidence on 2026-06-05:

- `circuit history status --json` reported a fresh index with 24 runs and 222
  indexed documents.
- A read-only corpus scan found 24 run folders, 806 trace entries, 276 JSON
  report files, and 222 indexed history documents.
- Indexed document kinds were 24 run, 166 report, 14 checkpoint, and 18 trace
  documents.
- `circuit memory list --json` returned zero project facts in this checkout.
- `rg "sqlite|better-sqlite3|sql.js|libsql|duckdb"` found no current SQLite or
  adjacent package dependency.
- `node:sqlite` was available in the local bundled Node runtime, backed by
  SQLite 3.53.0.

## Option 1: Keep The Current File Index And Add Projections

Architecture shape: keep `.circuit/history/documents.v1.jsonl` as the only
cross-run index. Add better command projections on top: history evidence packets,
run list/events/why, and compact host rendering.

Why it might work:

- Lowest migration cost.
- Keeps the current file discipline.
- No native dependency or plugin packaging risk.
- Good enough while the local corpus is hundreds or low thousands of documents.

Tradeoffs:

- Query features stay hand-built.
- Repeated filters by flow, kind, step, outcome, schema, and staleness will add
  more in-memory scan code.
- Run inspection and memory-effect work may duplicate indexing logic.

Failure modes:

- Circuit slowly builds a half-database in TypeScript.
- Query behavior becomes harder to test because ranking and filtering logic
  grows around arrays of full documents.
- Larger local corpora make every command pay scan costs.

Disqualifier: choose this if the corpus stays small and only two or three
queries matter.

## Option 2: SQLite As A Derived Local Read Model

Architecture shape: build `.circuit/index/circuit.v1.db` from existing run
folders and history artifacts. Tables mirror durable artifacts and carry source
refs, source hashes, schema versions, freshness, and extraction metadata.
SQLite is rebuilt or incrementally refreshed. It is never the only copy of a
run fact.

Candidate tables:

```text
runs(run_id, flow_id, goal, outcome, status, run_folder, manifest_hash, closed_at)
trace_entries(run_id, sequence, kind, step_id, attempt, recorded_at, outcome, reason, raw_json)
reports(run_id, path, schema, step_id, attempt, sha256, summary, text)
history_documents(doc_id, run_id, doc_kind, flow_id, source_path, source_sha256, facets, memory_safe)
memory_inputs(memory_id, kind, flow_id, source_ref_json, summary, staleness, authority)
pulls(run_id, pull_id, decision_point, query, result_count, suppressed_count)
checks(run_id, step_id, attempt, check_kind, status, report_path)
```

Leveraged well, this can power:

- `history query` with stronger filtering and SQLite FTS over report text.
- `runs list`, `runs events`, and `runs why` without a fresh recursive file walk
  each time.
- "show me unresolved checkpoints" as an inspection query, while resume still
  validates against the saved run folder and trace.
- "what failed in prototype variant verification across prior runs?"
- local proof and eval datasets for flow comparisons.
- model and effort analytics, if selection data is normalized from trace entries.
- memory pull analytics: which hints were pulled, suppressed, repeated, later
  correlated with outcomes, or never cited again.

What stays:

- `trace.ndjson` remains the sequence authority.
- JSON reports remain the cited evidence payloads.
- `MemoryInputV0` remains the hint shape.
- Existing JSONL history index can remain as v1 fallback or be generated from
  the same extraction pass during migration.

What changes:

- Query code reads a prepared local database when available.
- Rebuild/refresh gets a schema version and corruption handling story.
- Tests need fixtures for fresh, stale, corrupt, and unsupported database files.
- Packaging must prove the selected SQLite runtime works inside Claude and Codex
  plugin runtimes. That may be `node:sqlite` if the bundled host runtimes support
  it.

Failure modes:

- The database starts looking authoritative because it is convenient.
- DB schema drift creates a second migration system.
- SQLite runtime support differs between the repo runtime and host plugin
  runtimes.
- Incremental refresh misses file changes and returns stale rows without warning.
- Concurrent rebuilds or reads see a half-written database.
- The database concentrates report text into one local file, making accidental
  sharing more costly than sharing one run folder.

Disqualifiers:

- No acceptable SQLite runtime for the bundled plugin runtime.
- Query latency and feature pressure remain small enough that JSONL is simpler.
- The team is not willing to keep source refs and freshness visible in every DB
  answer.

## Option 3: SQLite As A Learning And Eval Warehouse Only

Architecture shape: keep user-facing history commands file-backed, but build a
separate optional database for offline analysis of runs, memory pulls, evals,
proof reports, and flow outcomes.

Why it might work:

- Avoids runtime and host risk.
- Gives product and eval work better local analytics.
- Can start as a developer-only command or script.

Tradeoffs:

- Operators do not get better day-to-day inspection right away.
- A separate warehouse can drift from the product path if it is not used by
  commands.
- It delays pressure-testing database packaging.

Failure modes:

- The warehouse becomes an orphaned research tool.
- Findings cannot be reproduced by normal users because the DB is not part of
  the product path.

Disqualifier: choose this only if the near-term question is eval insight, not
operator-facing history or run inspection.

## Option 4: SQLite As The Runtime Store

Architecture shape: write trace entries, reports, checkpoint state, and memory
updates directly into SQLite, then export file artifacts as projections.

Why it might work:

- One transactional local store could simplify some multi-file consistency
  problems.
- Queries over live runs become natural.
- Long-horizon supervision could read a single database.

Tradeoffs:

- This is a real runtime migration.
- It reverses the current portability model.
- Recovery and resume now depend on DB health.
- Trace append semantics, report validation, and checkpoint resume validation
  all need new contracts.

Failure modes:

- A corrupt DB makes a run harder to inspect than a corrupt report file.
- Exported files become stale projections instead of primary evidence.
- Host plugin packaging has to carry a database engine for every normal run.
- Tests must prove transaction behavior, crash recovery, migrations, and
  deterministic replay.

Disqualifier: reject this for v1 unless a specific runtime bug cannot be solved
with the current file-backed trace and reports.

## Tradeoff Matrix

| Dimension | File index only | Derived SQLite read model | Eval warehouse only | SQLite runtime store |
| --- | --- | --- | --- | --- |
| Simplicity | High - few new concepts | Medium - one new derived artifact | Medium - isolated, but another tool | Low - new runtime storage model |
| Migration difficulty | Low | Medium | Low-medium | High |
| Rollback story | Easy | Easy if DB is fallback-only | Easy | Hard |
| Query power | Medium | High | High for offline work | High |
| Operator value | Medium | High | Low-medium | Medium, after large migration |
| Authority risk | Low | Medium, controllable | Low | High |
| Packaging risk | None | Medium | Low if developer-only | High |
| Testability | High | High with fixture DBs | High | Medium-hard |
| Long-term flexibility | Medium | High | Medium | Medium, but costly |

## Claim Inventory

| ID | Claim | Confidence | Evidence |
| --- | --- | --- | --- |
| C01 | The current run contract makes trace plus manifest plus snapshot the run model. | Confirmed | `docs/contracts/run.md:21-30`. |
| C02 | `TraceStore` appends one JSON object per line, assigns contiguous sequence numbers, and rejects appends after close. | Confirmed | `src/runtime/trace/trace-store.ts:1-6`, `src/runtime/trace/trace-store.ts:78-115`. |
| C03 | Reports are ordinary run-folder files written through `RunFileStore`. | Confirmed | `src/runtime/run-files/run-file-store.ts:17-45`. |
| C04 | History currently writes `manifest.v1.json` and `documents.v1.jsonl` under `.circuit/history`. | Confirmed | `src/app/history/indexer.ts:27-30`, `src/app/history/indexer.ts:203-236`. |
| C05 | History query filters by flow and document kind, scores documents in memory, returns source refs, staleness, and the authority notice. | Confirmed | `src/app/history/query.ts:246-359`. |
| C06 | The history authority notice explicitly forbids proof, checkpoint, policy, route, recovery, verification, and write authority. | Confirmed | `src/schemas/history.ts:6-7`. |
| C07 | History documents include source refs, source hashes, facets, and memory safety. | Confirmed | `src/schemas/history.ts:60-93`. |
| C08 | Extraction indexes run, report, selected trace, and checkpoint-like documents. | Confirmed | `src/app/history/extract.ts:486-566`, `src/app/history/extract.ts:569-657`, `src/app/history/extract.ts:669-751`. |
| C09 | Run-start recall uses query results and project facts, then keeps them in `MemoryInputV0` hint form. | Confirmed | `src/app/history/run-start-recall.ts:79-139`, `src/app/history/memory-preview.ts:47-119`. |
| C10 | `history pull` is explicit, flow-scoped, writes a pull log when possible, and fails soft on log write errors. | Confirmed | `docs/reference/history-pull.md:6-10`, `src/cli/history.ts:360-442`. |
| C11 | Project facts are stored as local JSONL under `.circuit/memory`, not in a DB. | Confirmed | `src/memory/project-store.ts:5-21`, `src/memory/project-store.ts:73-131`. |
| C12 | Checkpoint resume validates the saved run folder, manifest snapshot, unresolved checkpoint request, and request hash. | Confirmed | `src/runtime/run/checkpoint-resume.ts:1-7`, `src/runtime/run/checkpoint-resume.ts:168-195`, `src/runtime/run/checkpoint-resume.ts:223-256`. |
| C13 | `.circuit/` is local-only ignored state. | Confirmed | `.gitignore:22-24`. |
| C14 | Current package dependencies do not include a SQLite package. | Confirmed | `package.json:58-69`; `rg` over package and source files found no SQLite-adjacent package dependency. |
| C15 | The bundled Node runtime available in this workspace exposes `node:sqlite`. | Confirmed | `node -e "require('node:sqlite')"` succeeded on Node 24.16.0, and `process.versions.sqlite` reported 3.53.0. |
| C16 | The current local corpus is large enough to justify an index but not enough to require a runtime store. | Supported | Live status and corpus scan on 2026-06-05: 24 runs, 806 trace entries, 276 report JSON files, 222 indexed documents. |

## Recommendation

Choose Option 2: SQLite as a derived local read model.

It gives Circuit the most leverage without pulling storage authority into the
runtime. It also lines up with the strongest adjacent proposals:

- history ask and pull-query memory need compact, cited answers;
- run inspection needs fast list/events/why views;
- memory effect needs cross-run analytics;
- eval and proof work need queryable local datasets.

The runner-up is Option 1. It wins if we want zero dependency risk and the corpus
stays small. It loses if run inspection, memory analytics, and history query all
grow at once, because the project will keep rebuilding database-like behavior in
plain arrays.

Option 3 is useful as a spike, not the product path. It can prove schema value
cheaply, but it does not help the operator unless the product adopts it.

Option 4 should be rejected for now. It is the highest-risk path and does not
earn its cost from the current evidence.

## Validation Spikes

| Spike | Question Answered | Cost | Success Signal | Failure Signal |
| --- | --- | --- | --- | --- |
| Runtime support spike | Can Circuit use `node:sqlite` or another SQLite runtime inside both host plugin runtimes? | 0.5-1 day | Build, plugin runtime bundle, host cache checks, and a tiny open/query smoke pass on macOS. | Runtime import, bundle, or cache sync fails. |
| Read-model prototype | Can a DB rebuild from `.circuit/runs` match the existing history index? | 1-2 days | Row counts match JSONL; every row cites source path and hash; stale source detection works. | Missing rows, uncited rows, or stale rows look fresh. |
| Query spike | Does SQLite FTS improve useful history queries? | 0.5-1 day | Same or better top results for known history queries, plus better filters by flow/kind/schema/step/outcome. | Ranking regresses or explanations become less auditable. |
| Run-inspection spike | Can `runs list/events/why` read from DB while preserving file authority? | 1 day | Commands fall back to direct file projection when DB is missing and cite source rows when DB is used. | DB-only behavior hides invalid or stale run folders. |
| Memory analytics spike | Can pull logs and recall reports support useful suppression/effect queries? | 1 day | A local query can show pulled hints by flow, decision point, staleness, suppression, and later outcome. | Data is too sparse or missing correlation fields. |
| Locking and privacy spike | Can rebuilds stay atomic and keep the DB local-only? | 0.5 day | Concurrent status/query/rebuild tests never expose half-written rows; DB files stay under ignored `.circuit/`. | Reads fail during rebuild or generated DB files look commit-ready. |

## Product Boundary For V1

The first slice should add a command like:

```bash
circuit index rebuild --json [--format sqlite]
circuit index status --json
```

or fold it under history:

```bash
circuit history rebuild --json --backend sqlite
circuit history status --json --backend sqlite
```

I prefer a small `index` namespace only if it will serve both history and run
inspection. If it only serves history, keep it inside `history`.

Every command that reads SQLite should print:

- database schema version;
- source artifact root;
- freshness state;
- warnings;
- whether the answer came from SQLite or the file-backed fallback;
- source refs for user-facing results;
- database path, so accidental sharing and cleanup are obvious.

## Migration Implications

No stored-run migration is needed for the recommended path. Existing run folders
remain valid. Rebuild can delete and recreate the derived DB.

The main new migration surface is database schema versioning. Treat schema
changes like generated indexes:

- unsupported DB version returns a structured error or rebuild hint;
- corrupt DB falls back or asks for rebuild;
- stale DB warns before answering;
- no DB file is acceptable on a fresh checkout.

## Handoff To Audit And Migrate

Chosen architecture: derived local SQLite read model over existing run artifacts.

Invariants:

- Files remain authority.
- DB rows cite files.
- Stale or missing DB cannot block normal run execution.
- History and memory stay hint-only.
- Runtime trace and checkpoint resume do not depend on DB rows.

Expected implementation boundaries:

- Add a tiny index module near `src/app/history` or a new `src/app/index`.
- Keep extraction pure and reusable from the current history indexer.
- Add schema tests for database metadata and row projections.
- Add CLI tests for fresh, stale, missing, corrupt, and unsupported DB states.
- Add a packaging proof before committing to a SQLite runtime.

Expected deletion zones if this ships:

- duplicate in-memory filtering code that exists only to answer SQL-shaped
  questions;
- repeated corpus-walk logic in future run-inspection commands;
- any JSONL-only projection that becomes redundant after a stable fallback
  period.

What still needs proof:

- SQLite runtime choice and plugin bundling.
- Rebuild speed on a larger real corpus.
- Whether FTS ranking is better than the current deterministic lexical ranking.
- Whether the same read model can satisfy both history and run inspection without
  becoming too broad.

## Verification Notes

Read current code and docs for run authority, trace storage, run files, history
indexing/querying, run-start recall, pull logs, project memory, checkpoint
resume, run inspection, package dependencies, and idea catalog rules.

Ran:

```bash
git status --short
./bin/circuit history status --json
./bin/circuit history query sqlite database storage index trace evidence checkpoint --json --limit 2 --per-run-limit 1
./bin/circuit history query verification evidence --json --kind report --limit 3 --per-run-limit 1
./bin/circuit memory list --json
rg "sqlite|better-sqlite3|sql.js|libsql|duckdb" package.json package-lock.json src docs tests
node -e "require('node:sqlite'); console.log(process.versions.sqlite)"
npm run check-ideas
```

`npm run check-ideas` passed after catalog/index edits.
