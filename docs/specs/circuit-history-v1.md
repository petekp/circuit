# Circuit History V1 Implementation Spec

Status: implementation spec, not current behavior.

Date: 2026-05-26

## Summary

Circuit History V1 adds an explicit local recall surface over `.circuit/runs`.
It does three things:

1. Builds a local index from prior Circuit run reports and selected trace
   entries.
2. Queries that index through a JSON-only CLI.
3. Previews query results as valid `MemoryInputV0` objects without injecting
   them into any run.

This is the first slice only. It does not change `circuit run`, `circuit
resume`, checkpoint resolution, route selection, proof policy, recovery, or
model context loading.

The product rule is simple: history can help the next model notice relevant
prior context, but it cannot grant authority. A prior run can suggest what to
inspect, what failed before, or which check to rerun. It cannot satisfy current
verification, authorize a route, approve a checkpoint, override policy, prove
work, recover a run, or write files.

## Source-Backed Boundaries

### Current Capability Gap

- Circuit already writes per-run reports and schema-versioned JSON. Cross-run
  query/recall and agent-side consumption are still gaps. See
  [docs/ideas/positioning-and-strategy.md:167-175](../ideas/positioning-and-strategy.md#L167-L175).
- The CLI currently lists `run`, `resume`, `runs show`, `handoff`, `create`,
  and `version`, but no `history` command. See `src/cli/circuit.ts`.
- Release notes explicitly did not ship cross-run project-memory query and
  recall in alpha.6. See
  [docs/release/0.1.0-alpha.6-notes.md:64-71](../release/0.1.0-alpha.6-notes.md#L64-L71)
  and
  [docs/release/initial-public-release-list.md:85-91](../release/initial-public-release-list.md#L85-L91).

### Memory Authority Boundary

- `MemoryInputV0` supports `kind: "prior_run"`, hint categories, explicit
  staleness, and `authority: "hint_only"`. See `src/schemas/memory-input.ts`.
- `MemoryInputV0` tests reject memory as authority, reject hint categories
  that would become route/checkpoint/proof/safe-apply/policy authority, keep
  stale or unknown memory visibly weak, and reject surplus fields that could
  smuggle authority. See `tests/contracts/memory-input-schema.test.ts`.
- Guidance decisions allow memory refs only as memory/input hints. Memory refs
  cannot become evidence refs, constraint refs, contract refs, policy refs, or
  blockers for guidance options. See `src/schemas/guidance-decision.ts` and
  `tests/contracts/guidance-decision-schema.test.ts`.
- Checkpoint planning must keep recalled facts explicit and auditable in the
  current run. Recall must not silently mutate checkpoint or resume authority.

### Run And Source Boundaries

- A run is the aggregate of a manifest snapshot, an append-only trace, and a
  derived snapshot. See [docs/contracts/run.md:21-30](../contracts/run.md#L21-L30).
- Trace entries are the sequence authority and must be contiguous. See
  `src/runtime/trace/trace-store.ts`.
- Report paths and run-owned paths must stay inside the run folder and reject
  absolute, parent, drive-letter, backslash, and symlink-escaping forms. See
  `src/shared/run-relative-path.ts` and `src/runtime/run-files/paths.ts`.
- Existing `Ref` supports `report`, `trace`, and `memory` refs. Content refs
  require SHA-256. Trace refs require `run_id`, `sequence`, and
  `ref: "trace.ndjson#sequence=<n>"`. See `src/schemas/ref.ts`.

## Local Evidence Used For This Spec

The current checkout's `.circuit/runs` corpus contained:

- 18 run folders;
- 215 JSON report files;
- 668 trace entries;
- flows: `explore`, `review`, `prototype`, `goal`, and `build`;
- terminal outcomes including `complete` and `aborted`;
- edge cases for noisy review intake, aborted Goal/Build runs, Explore
  tournament decisions, checkpoint request/response files, and `relay.failed`
  trace entries.

Important observed cases:

- `0dc32a58-2318-4698-bd6d-7eb2222bc9dc` - Explore run about Circuit memory and
  queryable reports.
- `b58fadc6-4d9a-4121-8952-86f9e8f32fa4` - Explore tournament run about recall
  approaches, including checkpoint response `selection: "option-3"`.
- `81b8e94c-deba-4b3a-94c1-d1986f4c07a9` - aborted Goal run whose result
  preserves a child-result schema failure.
- `adca685e-2b3f-419c-bc61-229632ef4e08` - aborted Build child run whose trace
  preserves `relay.failed`, `step.aborted`, and `run.closed` reasons.
- `317b918f-9954-400c-ae67-977cbc1ce887` - Review run with a
  `review-intake.json` containing a 120k-character raw diff field. This is the
  main pruning test case.

## Product Contract

V1 answers five questions:

1. What prior Circuit runs look relevant to this query?
2. Which exact report or trace entry did each hit come from?
3. Is the cited source still byte-identical to what the index saw?
4. Why did the index rank this hit?
5. What would the same hit look like as a hint-only `MemoryInputV0` preview?

V1 intentionally does not answer:

- Should this memory be loaded automatically?
- Should a route or checkpoint choice change because of this memory?
- Does this past verification prove anything about the current run?
- Should repeated memory be promoted into repo conventions?
- Should history sync across machines or repos?

## CLI Surface

Add a top-level `history` forwarding command in `src/cli/circuit.ts`, parallel
to `runs`, implemented by `src/cli/history.ts`.

All commands require `--json`. If `--json` is omitted, exit 2 and return a
`history-error-v1` JSON object.

### Rebuild

```bash
circuit history rebuild --json \
  [--runs-base <path>] \
  [--index-dir <path>]
```

Default `--runs-base`: `.circuit/runs`.

Default `--index-dir`: `.circuit/history`.

Behavior:

- scan all direct child directories under `runs-base`;
- rebuild the index from scratch;
- write atomically through temporary files in `index-dir`;
- never mutate run folders;
- continue past individual corrupt or unreadable runs with warnings;
- fail only when `runs-base` is missing/unreadable or `index-dir` cannot be
  written.

### Query

```bash
circuit history query "<query>" --json \
  [--format json|memory-input] \
  [--limit <n>] \
  [--per-run-limit <n>] \
  [--runs-base <path>] \
  [--index-dir <path>] \
  [--flow <flow-id>] \
  [--kind run|report|trace|checkpoint] \
  [--rebuild-if-stale]
```

Defaults:

- `--format json`;
- `--limit 8`;
- `--per-run-limit 1`;
- same `runs-base` and `index-dir` defaults as `rebuild`.

Behavior:

- no implicit rebuild;
- if the index is missing, fail with `index_missing`;
- if the index looks stale, return a warning and continue;
- if `--rebuild-if-stale` is present, rebuild first and state that in response
  metadata;
- empty result sets are successful: exit 0 with `results: []`.

### Status

```bash
circuit history status --json \
  [--runs-base <path>] \
  [--index-dir <path>]
```

Behavior:

- report whether the index exists;
- report schema version, document count, run count, created time, and freshness
  state;
- never rebuild.

## Storage

Use local generated state under:

```text
.circuit/history/
```

The root `.gitignore` already ignores `.circuit/`, so this state remains local.

Files:

```text
.circuit/history/manifest.v1.json
.circuit/history/documents.v1.jsonl
```

Do not store query caches in V1. Query should read the manifest and JSONL file.

Writes:

1. create `index-dir` if needed;
2. write `manifest.v1.json.tmp-<pid>` and `documents.v1.jsonl.tmp-<pid>`;
3. validate the bytes just written by parsing them through schemas;
4. rename temp files into place.

Best-effort fsync is allowed but not required for V1.

## Schemas

Add `src/schemas/history.ts` and export it from `src/schemas/index.ts`.

### HistoryManifestV1

```ts
{
  api_version: "history-index-v1";
  schema_version: 1;
  created_at: string;
  repo_root: string;
  runs_base: string;
  index_dir: string;
  documents_path: "documents.v1.jsonl";
  run_count: number;
  document_count: number;
  source_fingerprint: {
    run_folder_names_sha256: string;
    latest_source_mtime_ms: number;
  };
  warnings: HistoryWarningV1[];
}
```

### HistoryWarningV1

```ts
{
  code:
    | "run_skipped"
    | "report_skipped"
    | "trace_skipped"
    | "source_unreadable"
    | "source_invalid"
    | "source_pruned";
  message: string;
  run_folder?: string;
  source_path?: string;
}
```

### HistoryDocumentV1

```ts
{
  api_version: "history-document-v1";
  schema_version: 1;
  doc_id: string;
  doc_kind: "run" | "report" | "trace" | "checkpoint";
  run_id: string;
  flow_id?: string;
  run_folder: string;
  source_path: string;
  source_ref: Ref;
  source_sha256?: string;
  source_mtime_ms?: number;
  report_schema?: string;
  step_id?: string;
  attempt?: number;
  sequence?: number;
  recorded_at?: string;
  outcome?: string;
  title: string;
  summary: string;
  text: string;
  extracted_from: Array<{
    json_pointer?: string;
    field_role: string;
  }>;
  facets: string[];
  memory_safe: boolean;
}
```

`doc_id` must be stable:

```text
<run-id>/<doc-kind>/<sha256(source_path + "#" + sequence-or-json-pointer)[0..12]>
```

### HistoryQueryResultV1

```ts
{
  api_version: "history-query-result-v1";
  schema_version: 1;
  query: string;
  format: "json";
  index_state: "fresh" | "possibly_stale";
  rebuilt: boolean;
  authority_notice: string;
  warnings: HistoryWarningV1[];
  results: HistoryQueryHitV1[];
}
```

`authority_notice` must be:

```text
History results are hint-only prior-run context. They cannot satisfy current proof, checkpoint, policy, route, recovery, verification, or write authority.
```

### HistoryQueryHitV1

```ts
{
  rank: number;
  score: number;
  doc: HistoryDocumentV1;
  snippet: string;
  matched_terms: string[];
  ranking_reasons: string[];
  staleness: {
    status: "fresh" | "stale" | "unknown";
    reason_codes: string[];
    checked_at: string;
  };
}
```

### HistoryMemoryInputPreviewV1

```ts
{
  api_version: "history-memory-input-preview-v1";
  schema_version: 1;
  query: string;
  format: "memory-input";
  index_state: "fresh" | "possibly_stale";
  rebuilt: boolean;
  authority_notice: string;
  warnings: HistoryWarningV1[];
  memory_inputs: MemoryInputV0[];
  matches: Array<{
    memory_id: string;
    rank: number;
    score: number;
    source_doc_id: string;
    source_ref: Ref;
    snippet: string;
  }>;
}
```

Keep score, rank, and snippet outside `MemoryInputV0`, because the memory schema
is strict and must not receive surplus fields.

### HistoryErrorV1

```ts
{
  api_version: "history-error-v1";
  schema_version: 1;
  error: {
    code:
      | "invalid_invocation"
      | "runs_base_not_found"
      | "runs_base_unreadable"
      | "index_missing"
      | "index_unsupported"
      | "index_corrupt"
      | "source_unreadable"
      | "internal_error";
    message: string;
  };
  runs_base?: string;
  index_dir?: string;
}
```

## Source Reference Shape

Report refs use existing `Ref`:

```json
{
  "kind": "report",
  "ref": "reports/decision.json",
  "sha256": "<report file sha256>",
  "run_id": "<run id>",
  "flow_id": "explore",
  "step_id": "decision-step",
  "attempt": 1
}
```

Trace refs use existing `Ref` trace rules:

```json
{
  "kind": "trace",
  "ref": "trace.ndjson#sequence=16",
  "run_id": "<run id>",
  "flow_id": "build",
  "step_id": "act-step",
  "attempt": 1,
  "sequence": 16
}
```

For trace documents, store the whole `trace.ndjson` SHA-256 in
`source_sha256`, not inside the trace `Ref`, because trace refs are not content
refs today.

Memory refs are not emitted by the index. They are only relevant to future
runtime consumption, where a generated `MemoryInputV0` artifact could be cited
as kind `memory`.

## Run Discovery

Treat a direct child of `runs-base` as a candidate run folder if it contains at
least one of:

- `manifest.snapshot.json`;
- `trace.ndjson`;
- `reports/result.json`.

Skip non-direct descendants. Skip files like `.DS_Store`.

For each candidate:

1. parse `manifest.snapshot.json` when present;
2. parse `trace.ndjson` line by line when present;
3. parse `reports/result.json` when present;
4. derive `run_id`, `flow_id`, `goal`, `recorded_at`, and terminal outcome from
   the strongest available source.

Preferred source order:

1. trace `run.bootstrapped` for `run_id`, `flow_id`, and goal;
2. result report for terminal outcome and reason;
3. manifest snapshot for fallback identity fields;
4. folder name only as fallback `run_id` when no parseable source exists.

If trace entries parse individually but the log is inconsistent, index any
source reports that are readable, but add a `trace_skipped` warning and do not
index trace documents for that run.

## Report Extraction

Index JSON reports under `reports/**/*.json`.

Skip by default:

- `reports/relay/**`;
- `reports/operator-summary.json`;
- `reports/operator-summary.md`;
- `reports/operator-summary.html`;
- branch request/receipt/result payloads where a sibling typed report exists.

Rationale: relay payloads and operator summaries duplicate better typed sources
or include raw request/result material that performs poorly in recall.

Use `step.report_written` trace entries as the authoritative map from
`report_path` to `report_schema`, `step_id`, and `attempt`. If no trace mapping
exists, infer only from file path and report body fields.

Important path classes:

- `reports/result.json` becomes a report document and also feeds the run
  document.
- `reports/checkpoints/*-request.json` becomes a checkpoint document with
  `memory_safe: false`.
- `reports/checkpoints/*-response.json` becomes a checkpoint document with
  `memory_safe: true` and maps to `operator_note` in memory preview.
- `reports/goal/child-results/*.json` is indexable because it can preserve
  useful failure context.

## Trace Extraction

Index only selected trace kinds:

- `relay.failed`;
- `step.aborted`;
- failed `check.evaluated`;
- `run.closed` when outcome is not `complete`;
- `checkpoint.resolved`;
- `proof.assessed`;
- `safe_apply.result`.

Do not index:

- `relay.request`;
- `relay.result`;
- `relay.receipt`;
- `relay.started`;
- `relay.completed`;
- ordinary `step.entered`;
- ordinary `step.completed`;
- fanout bookkeeping unless it contains an explicit failure or selected option
  not otherwise captured in a typed report.

Trace documents should be short and structured. For example, `relay.failed`
text should include flow, step, attempt, connector, role, and reason. It should
not include full stdout/stderr dumps beyond pruning limits.

## Noisy Field Pruning

The extractor must recursively prune noisy fields before building document
text.

Drop any field whose path segment matches:

```text
unstaged_diff
staged_diff
diff
patch
stdout
stderr
transcript
payload
request
response
raw
body
```

Exception: small checkpoint response documents can keep `selection`,
`route_id`, and `resolution_source`.

Keep these high-value fields up to 2,000 characters each:

```text
goal
objective
summary
verdict
decision
rationale
recommendation
findings
reason
outcome
status
acceptance_criteria
```

Cap each final document `text` at 8,000 characters.

Cap returned snippets at 420 characters.

If pruning removes more than 10,000 characters from a single source, attach a
`source_pruned` warning for that source.

## Facets

Emit deterministic facets for filtering and ranking.

Required facets:

- `flow:<flow-id>` when known;
- `outcome:<outcome>` when known;
- `kind:<doc-kind>`;
- `schema:<report-schema>` when known;
- `step:<step-id>` when known;
- `failure` for aborted results, `relay.failed`, `step.aborted`, and failed
  checks;
- `checkpoint` for checkpoint request/response/resolution sources;
- `decision` for decision reports;
- `verification` for verification/proof/check reports;
- `operator-note` for operator checkpoint selections.

## Ranking

Use deterministic lexical ranking only. Embeddings are future work.

Tokenization:

- lowercase;
- split on non-alphanumeric boundaries;
- drop common stopwords;
- keep terms of length 2 or more;
- compute IDF across `documents.v1.jsonl`.

Score:

```text
score =
  sum(idf(term) * min(weighted_tf(term), 3))
  + phrase_boost
  + facet_boost
  + freshness_boost
  - noisy_source_penalty
```

Field weights:

- title: 5;
- goal, summary, decision, reason: 4;
- report schema and facets: 2;
- normal text: 1.

Boosts:

- exact query phrase in title/text: +2;
- each matched query bigram: +0.5;
- failure query terms against `failure` facet: +3;
- checkpoint query terms against `checkpoint` facet: +2;
- verification query terms against `verification` facet: +2;
- source hash verified at query time: +0.25.

Penalties:

- `memory_safe: false`: -3;
- pruned source warning: -1;
- index staleness unknown: -0.5.

Sort:

1. score descending;
2. fresher `recorded_at` descending;
3. `doc_id` ascending.

## Dedupe

Defaults:

- `--limit 8`;
- `--per-run-limit 1`.

Algorithm:

1. rank all candidate docs;
2. remove exact duplicate normalized text hashes;
3. walk the ranked list and keep at most `per-run-limit` docs per run;
4. stop at `limit`.

`--per-run-limit` may be raised to at most 5. `--limit` may be raised to at
most 50.

## Staleness And Hash Handling

`rebuild` stores:

- source file SHA-256 for every report document;
- whole `trace.ndjson` SHA-256 for every trace document;
- source mtime in milliseconds;
- a manifest fingerprint containing sorted run folder names and latest source
  mtime.

`query` behavior:

- compare the current run folder fingerprint and latest source mtime to the
  manifest;
- set `index_state: "possibly_stale"` if either differs;
- rehash only returned hit sources;
- report per-hit staleness.

Per-hit staleness:

```json
{ "status": "fresh", "reason_codes": ["source_hash_verified"] }
{ "status": "stale", "reason_codes": ["memory_stale"] }
{ "status": "unknown", "reason_codes": ["memory_unverified"] }
```

`MemoryInputV0` requires `memory_unverified` for unknown staleness and
`memory_stale` for stale memory. Preserve those exact reason codes.

## MemoryInputV0 Preview

`--format memory-input` returns `HistoryMemoryInputPreviewV1`.

It never writes memory artifacts and never injects memory into a run.

Emit at most one `MemoryInputV0` per query hit. Skip any hit with
`memory_safe: false`.

Mapping:

```text
MemoryInputV0.schema_version = 1
MemoryInputV0.kind = "prior_run"
MemoryInputV0.authority = "hint_only"
MemoryInputV0.source.ref = hit.doc.source_ref
MemoryInputV0.source.captured_at = hit.doc.recorded_at ?? manifest.created_at
MemoryInputV0.source.source_updated_at = ISO(source_mtime_ms) when available
MemoryInputV0.source.sha256 = hit.doc.source_sha256 when source ref has same sha
MemoryInputV0.summary = hit.doc.summary
MemoryInputV0.staleness = hit.staleness
```

`memory_id`:

```text
prior-run-<run-id-prefix>-<doc-hash-12>
```

`hint.id`:

```text
hint-<doc-hash-12>
```

Both ids must satisfy `ControlPlaneFileStem`.

Hint `applies_to` mapping:

```text
relay.failed, step.aborted, aborted run result, failed check -> prior_failure
verification/proof/check documents -> verification
checkpoint response or checkpoint.resolved trace -> operator_note
everything else -> context
```

Do not emit `preference` or `repo_convention` in V1. Those require stronger
promotion rules than one query result can provide.

Hint text:

- begin with the ranked snippet or summary;
- include `Source: <run-id> <source_path>`;
- for checkpoint and verification-like hits, append:

```text
This is prior-run context only; rerun current checks before relying on it.
```

The preview response must include the same top-level authority notice as normal
query results.

## Error Behavior

Exit codes:

- 0: successful rebuild, status, query, or empty result set;
- 1: operational error;
- 2: invalid invocation.

All errors are JSON objects with `api_version: "history-error-v1"`.

Invalid invocation examples:

- missing `--json`;
- unknown subcommand;
- missing query string;
- invalid `--limit`;
- invalid `--per-run-limit`;
- invalid `--format`;
- invalid `--kind`.

Operational error examples:

- `runs-base` missing;
- index missing;
- index schema unsupported;
- index corrupt;
- source unreadable during query rehash.

## Migration And Backfill

There is no migration from current state. `.circuit/history` is absent in the
observed checkout.

First `rebuild` backfills all current `.circuit/runs`.

Future unsupported manifest schema versions must fail with `index_unsupported`.
The repair path is:

```bash
circuit history rebuild --json
```

Do not mutate old run folders. Do not rewrite reports. Do not write memory
files.

## Implementation Files

New files:

- `src/cli/history.ts`;
- `src/history/indexer.ts`;
- `src/history/query.ts`;
- `src/history/extract.ts`;
- `src/history/memory-preview.ts`;
- `src/schemas/history.ts`;
- `tests/runner/history-cli.test.ts`;
- `tests/unit/history-indexer.test.ts`;
- `tests/contracts/history-schema.test.ts`.

Changed files:

- `src/cli/circuit.ts` to register and dispatch `history`;
- `src/schemas/index.ts` to export history schemas;
- `docs/specs/README.md` to list this spec.

Do not edit generated plugin runtime files until the CLI behavior is actually
implemented and the generated surfaces need to change.

## Tests

### Contract Tests

Add schema tests for:

- manifest accepts valid values and rejects unknown schema versions;
- document accepts report and trace source refs;
- query result includes authority notice;
- memory preview contains strict `MemoryInputV0` values only;
- error output uses `history-error-v1`;
- memory preview rejects surplus fields through existing `MemoryInputV0`.

### Indexer Tests

Use temp fixtures, not the developer's live `.circuit/runs`.

Cover:

- valid reports are indexed;
- relay reports are skipped;
- operator summaries are skipped;
- large diff/status fields are pruned;
- `step.report_written` enriches reports with schema, step, and attempt;
- `relay.failed`, `step.aborted`, failed checks, and aborted `run.closed` are
  indexed;
- checkpoint request is `memory_safe: false`;
- checkpoint response is `memory_safe: true` and maps to `operator_note`;
- symlink escapes are rejected;
- corrupt individual runs produce warnings and do not abort the whole rebuild.

### Query Tests

Cover:

- ranking finds the intended report;
- per-run dedupe defaults to one hit;
- `--per-run-limit` can include multiple docs from the same run;
- flow and kind filters work;
- stale index warning appears when run folders change;
- returned hit source hash is checked;
- empty results return exit 0.

### Memory Preview Tests

Cover:

- every previewed object parses with `MemoryInputV0`;
- authority is always `hint_only`;
- forbidden categories are never emitted;
- stale and unknown staleness reason codes match `MemoryInputV0` rules;
- checkpoint request docs are excluded;
- checkpoint responses map to `operator_note`;
- failures map to `prior_failure`;
- verification-like docs map to `verification`.

### CLI Tests

Cover:

- `history rebuild --json`;
- `history status --json`;
- `history query "..." --json`;
- `history query "..." --json --format memory-input`;
- missing `--json` exits 2;
- missing index fails unless `--rebuild-if-stale` is supplied;
- unsupported index schema fails with `index_unsupported`.

Run focused tests while developing. Run `npm run verify` before claiming the
implementation done.

## Rollout Boundaries

V1 ships only:

- explicit local indexing;
- explicit local querying;
- explicit non-injected `MemoryInputV0` preview.

V1 does not ship:

- automatic session-start loading;
- Frame recall reports;
- runtime consumption of memory;
- checkpoint salience from history;
- adaptive defaults;
- embeddings;
- cross-repo history;
- remote sync;
- analytics;
- promotion of repeated history into repo conventions.

## Future Work

Future work can add:

- opt-in Frame recall reports under `reports/history/recall.json`;
- model-facing runtime consumption through frozen `MemoryInputV0[]`;
- embeddings or hybrid lexical/vector ranking;
- repeated-failure clustering;
- repo-convention promotion flow;
- UI for browsing history;
- cross-machine sync.

Any future runtime consumption must keep recall explicit, cited, and
non-silent. Memory remains hint-only and must never satisfy current authority.
