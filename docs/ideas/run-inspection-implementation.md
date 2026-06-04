# Run Inspection: Implementation Exploration

> Status: proposal, 2026-06-03. This is source-backed implementation
> exploration only. It is not current behavior, roadmap commitment, or a runtime
> change.

## Short Recommendation

Build run inspection as a read-only app layer over existing run folders.

The first useful slice is not a new runtime, a daemon, or a hosted dashboard. It
is a small set of JSON commands that answer three operator questions:

1. What runs exist here?
2. What happened inside this run?
3. Why is this run in its current state?

Keep the existing `circuit runs show --run-folder <path> --json` command as the
status projection. Add these V1 commands around it:

```bash
circuit runs list --project-root <path> --json
circuit runs events --run-folder <path> --json [--category <name>] [--kind <kind>] [--step <id>] [--limit <n>]
circuit runs why --run-folder <path> --json
```

Do not add liveness claims in V1. A run folder can prove that a trace is open,
closed, waiting at a checkpoint, aborted, or invalid. It cannot prove a process
is still alive.

Do not build a legacy salvage parser in V1. Current-schema folders should become
pleasant to inspect first. Older folders that fail the current trace projector
should still show up as invalid with clear error metadata.

JSON snippets below are illustrative. Where they include a nested `status`
object, that object is abbreviated; the implementation should return the full
`RunStatusProjectionV1`.

## Product Shape

### `runs show`: current truth

This already exists. It should remain the narrow "what is true now?" surface.

Today it:

- requires `--json` and `--run-folder`;
- calls `projectRunStatusFromRunFolder`;
- returns `RunStatusProjectionV1` on valid and invalid existing run folders;
- returns `EngineErrorV1` for bad invocation or missing/unreadable folders;
- exposes `open`, `waiting_checkpoint`, `completed`, `aborted`, or `invalid`.

This is the correct base. Do not broaden `show` into a timeline, report browser,
or diagnosis engine. Stable status is useful because it is small.

### `runs list`: project-level run inventory

Purpose: "What run folders are available, and what state are they in?"

Command:

```bash
circuit runs list --project-root <path> --json
```

Behavior:

- scan `<project-root>/.circuit/runs/*`;
- skip non-directories;
- call the same status projection used by `runs show` for every run folder;
- include invalid projections instead of failing the whole list;
- sort by latest known file timestamp descending;
- never infer "needs attention", "active", "stuck", or "best next run".

Define latest known file timestamp as the newest file mtime under the run folder,
found by a read-only recursive walk. If the folder has no readable files, fall
back to the run folder directory mtime. Record the source path in the output.
Do not read file contents for sorting.

Failure behavior:

- Missing or unreadable `--project-root` should return `EngineErrorV1`, exit 1.
- A readable project root with no `.circuit/runs` directory should return an
  empty `run-list-v1`, exit 0.
- A run directory that becomes unreadable during listing should not fail the
  whole list. Include an item with `status_error: EngineErrorV1` and no status
  projection.

Recommended output shape:

```json
{
  "api_version": "run-list-v1",
  "schema_version": 1,
  "project_root": "/abs/project",
  "runs_base": "/abs/project/.circuit/runs",
  "run_count": 24,
  "states": {
    "completed": 13,
    "aborted": 5,
    "invalid": 6
  },
  "runs": [
    {
      "run_folder": "/abs/project/.circuit/runs/...",
      "sort_timestamp": "2026-06-03T06:00:00.000Z",
      "sort_timestamp_source": "/abs/project/.circuit/runs/.../trace.ndjson",
      "status": {
        "api_version": "run-status-v1",
        "engine_state": "completed"
      }
    }
  ]
}
```

The `status` value should be the full `RunStatusProjectionV1`, not a parallel
shape. That keeps `list` honest and keeps hosts from learning two status models.

### `runs events`: readable trace view

Purpose: "What happened in this run?"

Command:

```bash
circuit runs events --run-folder <path> --json
```

Filters:

- `--category run|step|relay|check|verification|proof|checkpoint|fanout|sub_run|guidance|safe_apply`
- `--kind <trace-entry-kind>`
- `--step <step-id>`
- `--limit <n>`

Recommended output shape:

```json
{
  "api_version": "run-events-v1",
  "schema_version": 1,
  "run_folder": "/abs/run",
  "integrity": "validated_run",
  "status": {
    "api_version": "run-status-v1",
    "engine_state": "aborted"
  },
  "filters": {
    "category": "check"
  },
  "events": [
    {
      "sequence": 17,
      "recorded_at": "2026-05-26T18:42:51.901Z",
      "kind": "check.evaluated",
      "category": "check",
      "step_id": "goal-run-build",
      "attempt": 1,
      "outcome": "fail",
      "summary": "result_verdict failed: child result body lacks a non-empty string 'verdict' field",
      "refs": []
    }
  ]
}
```

The event summary must be deterministic. It can use fields already in the trace:
`reason`, `outcome`, `check_kind`, `command_id`, `status`, `report_path`,
`request_path` for checkpoints, `receipt_path` and `result_path` for completed
relays, hashes, step id, and attempt. It must not ask a model to explain the
run.

The command should not expose raw trace entries by default. Raw trace stays an
internal contract. `runs events` is the operator-facing projection of it.

Failure behavior:

- Missing or unreadable folders should mirror `runs show`: `EngineErrorV1`,
  non-zero exit.
- Existing folders whose current-schema trace cannot be read should return
  `run-events-v1` with `integrity: "uninspectable"`, `events: []`, the status
  projection when available, and a structured error. Exit 0.
- Existing folders with a parseable current-schema trace but an invalid manifest
  may return events with `integrity: "trace_only"`. In that mode, do not enrich
  with saved-flow labels, stage names, or checkpoint choice presentation.
- Do not parse raw JSON that fails `TraceEntry`. That is legacy salvage, not V1
  inspection.

### `runs why`: deterministic explanation

Purpose: "Why is the run in this state?"

Command:

```bash
circuit runs why --run-folder <path> --json
```

Recommended output shape:

```json
{
  "api_version": "run-why-v1",
  "schema_version": 1,
  "run_folder": "/abs/run",
  "integrity": "validated_run",
  "status": {
    "api_version": "run-status-v1",
    "engine_state": "aborted"
  },
  "answer": "The run aborted because step goal-run-build failed its result_verdict check.",
  "reasons": [
    {
      "sequence": 17,
      "kind": "check.evaluated",
      "summary": "result_verdict failed: sub-run step 'goal-run-build': child result body lacks a non-empty string 'verdict' field"
    },
    {
      "sequence": 18,
      "kind": "step.aborted",
      "summary": "goal-run-build aborted for the same reason."
    }
  ],
  "unsupported": []
}
```

Rules:

- For `completed`, say the terminal outcome and point to `run.closed`,
  `reports/result.json`, and the operator summary paths when present.
- For `aborted`, prioritize `step.aborted`, failed `check.evaluated`, failed
  `verification.command_evaluated`, non-proven `proof.assessed`, and
  `relay.failed`.
- For `waiting_checkpoint`, use the existing status projection's checkpoint
  fields and point to the `checkpoint.requested` event when the trace is valid.
- For `open`, say only the last event and current step. Do not call it running.
- For `invalid`, report the status projector's error and stop unless a future
  legacy salvage mode is explicitly requested.

Invalid output should still use `run-why-v1`, with
`integrity: "uninspectable"`, the invalid status projection, a short answer
such as "This run folder is not inspectable because the trace is invalid.", an
empty `reasons` array, and an `unsupported` entry that names the failed data
source.

This command gives Circuit the "obvious run inspection" benefit without creating
a second source of truth.

## Data Sources

| Source | Current value | V1 use |
| --- | --- | --- |
| Run folder | Physical boundary for manifest, trace, and reports. | Required input to `show`, `events`, and `why`; discovered by `list`. |
| `manifest.snapshot.json` | Validated by `verifyManifestSnapshotBytes` before status projection. | Identity check, saved flow lookup, checkpoint validation, manifest hash. |
| `trace.ndjson` | Append-only trace. Entries are schema-validated, sequence-checked, and closed traces reject post-close entries. | Event timeline, deterministic reasons, report references, checkpoint references. |
| Derived Snapshot | Contract-level pure projection of trace plus manifest. | Do not build a second general snapshot reducer for inspection; use status projection plus event index. |
| Saved compiled flow bytes | Available through the manifest snapshot when current. | Step labels, stage ids, checkpoint declarations, allowed checkpoint choices. |
| `reports/result.json` | Universal runtime result path for closed runs. | Link from status and why; optional summary source later. |
| Operator summary files | `reports/operator-summary.json`, `.md`, and sometimes `.html`. | Link from status and why; possible future human summary default. |
| Flow reports | Flow-specific JSON under `reports/<flow>/...`. | List or link only in V1 unless the report schema is already owned by the command. |
| Relay artifacts | Relay trace entries carry request and result hashes; `relay.completed` carries receipt and result paths. | Event refs and later artifact inventory. |
| Checkpoint request report | Structural pause data tied to trace, saved flow, request hash, and allowed choices. | Already exposed by `show` when valid; referenced by `events` and `why`. |
| Process evidence and run envelope | Written after runs when post-run artifact emission succeeds. Older local folders may not have them. | Optional artifact refs only. Absence must not make inspection fail. |

## Current Evidence

I checked the current code and local run corpus before writing this proposal.

Source-backed facts:

- `src/cli/runs.ts` currently implements only `runs show`.
- `runs show` requires `--json` and `--run-folder`, then calls
  `projectRunStatusFromRunFolder`.
- `projectRunStatusFromRunFolder` checks the folder, verifies the manifest
  snapshot, and delegates current runtime folders to
  `projectRuntimeRunStatusFromRunFolder`.
- `projectRuntimeRunStatusFromRunFolder` reads `trace.ndjson`, validates every
  trace entry with `TraceEntry`, checks sequence order, rejects entries after
  `run.closed`, validates bootstrap identity against the manifest, and builds
  `open`, `waiting_checkpoint`, `completed`, `aborted`, or `invalid` status.
- `RunStatusProjectionV1` already encodes the legal next actions:
  `inspect`, `resume`, or `none`.
- The run contract says a run is made from the manifest snapshot, append-only
  trace, and derived snapshot. It also says sequence is the authoritative order.
- The run process doc says the graph runner owns the run folder and trace,
  writes `reports/result.json` on close, returns `checkpoint_waiting` when an
  operator choice is required, and writes post-run artifacts after close or
  checkpoint wait.
- The trace schema already carries the event kinds needed for V1 inspection:
  step lifecycle, report writes, checks, verification commands, proofs, safe
  apply, checkpoints, relay lifecycle, sub-runs, fanout, run closure, and
  guidance decisions.
- Existing tests enforce that the CLI imports the app-level run-status facade
  instead of runtime internals, and that invalid existing run folders return JSON
  with exit 0.

Local probes from this repo:

- `.circuit/runs` currently has 24 run folders with 24 `trace.ndjson` files.
- Calling `node bin/circuit runs show --json --run-folder ...` across those
  folders produced 13 completed, 5 aborted, and 6 invalid projections.
- A completed sample,
  `.circuit/runs/38723b57-3094-4c9c-95c2-c2ae7e5a54f8`, projected as
  `completed`, `flow_id: "explore"`, last event `run.closed`, sequence 26, and
  included result and operator summary paths.
- An aborted sample,
  `.circuit/runs/81b8e94c-deba-4b3a-94c1-d1986f4c07a9`, projected as
  `aborted`, `flow_id: "goal"`, last event `run.closed`, sequence 19, and
  included result and operator summary paths.
- The aborted sample's raw trace had 20 entries. Sequence 17 was a failed
  `check.evaluated`; sequence 18 was `step.aborted` with the same reason. This
  is enough to support `runs why` for current aborted runs.
- A stale prototype sample,
  `.circuit/runs/34bce0ec-f19f-477a-9ed4-f586c6fdd5d5`, projected as invalid
  with `trace_bootstrap_invalid`. Its raw JSON trace still had a
  `checkpoint.requested` at sequence 59, but V1 should not depend on raw
  best-effort parsing when the current trace schema rejects the folder.
- Representative older folders had result and operator summary reports but did
  not necessarily have process evidence or run envelope files. V1 must treat
  those as optional.

## Implementation Plan

### 1. Keep the CLI thin

Extend `src/cli/runs.ts`, but keep it as an argument parser and JSON printer.

It should not:

- parse `trace.ndjson`;
- infer explanations;
- read reports directly;
- branch on flow-specific schemas.

It should call app-layer functions:

```ts
listRunsForProject(input)
projectRunEventsFromFolder(input)
projectRunWhyFromFolder(input)
```

Bad invocation should keep returning `EngineErrorV1` with exit 2. Missing or
unreadable folder errors should keep returning `EngineErrorV1` with exit 1.
Existing invalid run files should return command-specific JSON with exit 0.

### 2. Add an app-layer inspection package

Create `src/app/run-inspection/`.

Suggested files:

| File | Responsibility |
| --- | --- |
| `list.ts` | Discover run directories, call status projection, compute state counts, sort. |
| `events.ts` | Project validated trace entries into operator events. |
| `why.ts` | Derive deterministic reasons from status plus event index. |
| `artifacts.ts` | Internal helper that extracts report/request/result refs from status and events. |
| `trace-reader.ts` | Shared read-only current-schema trace reader. |

The key refactor is `trace-reader.ts`.

Today `src/app/run-status/runtime-run-folder.ts` has a private read-only trace
reader. `TraceStore.load()` has similar validation, but it is a runtime store
object with append state. Inspection should not instantiate runtime machinery
just to read a folder.

So the implementation should extract the current read-only parsing rules into
one app-level helper and have both status and inspection use it:

```ts
readCurrentRunTraceFromFolder(runFolder): TraceEntry[]
```

Rules:

- parse `trace.ndjson` as newline-delimited JSON;
- require every entry to be a JSON object;
- validate every entry with `TraceEntry`;
- require `sequence === index`;
- reject entries after `run.closed`;
- return a typed array, or a structured error that callers can put into their
  own projection.

This preserves the existing "no trace parsing in CLI" boundary while avoiding a
second parser.

### 3. Add explicit output schemas

Add `src/schemas/run-inspection.ts` with:

- `RunListProjectionV1`;
- `RunEventsProjectionV1`;
- `RunWhyProjectionV1`;
- shared `RunInspectionEventV1`;
- shared `RunInspectionReasonV1`;
- shared `RunInspectionRefV1`.
- shared `RunInspectionIntegrityV1`:
  `validated_run | trace_only | uninspectable`.

Do not reuse arbitrary `Record<string, unknown>` for the public JSON. The point
of inspection is that hosts can consume it without learning raw trace shapes.

### 4. Define event categories in one place

Category mapping should be simple and stable:

| Category | Trace kinds |
| --- | --- |
| `run` | `run.bootstrapped`, `run.closed` |
| `step` | `step.entered`, `step.report_written`, `step.completed`, `step.aborted` |
| `check` | `check.evaluated` |
| `verification` | `verification.command_evaluated` |
| `proof` | `proof.assessed` |
| `checkpoint` | `checkpoint.requested`, `checkpoint.resolved` |
| `relay` | `relay.started`, `skills.loaded`, `relay.request`, `relay.receipt`, `relay.result`, `relay.failed`, `relay.completed` |
| `sub_run` | `sub_run.started`, `sub_run.completed` |
| `fanout` | `fanout.started`, `fanout.branch_started`, `fanout.branch_completed`, `fanout.joined` |
| `guidance` | `guidance.decision` |
| `safe_apply` | `safe_apply.result` |

If a new trace kind lands later, tests should fail until this mapping is updated
or an explicit `other` category is accepted.

### 5. Keep report parsing conservative

V1 should surface refs, not interpret every report body.

Allowed:

- list paths from `step.report_written`;
- list `reports/result.json` and operator summary paths from status projection;
- list relay receipt/result paths from `relay.completed`;
- list relay request/result hashes from `relay.request` and `relay.result`;
- list checkpoint request path from checkpoint trace/status;
- list process evidence or run envelope paths if a stable writer path is already
  present and the file exists.

Avoid:

- flow-specific report body interpretation;
- model-generated summaries of report contents;
- treating missing optional post-run artifacts as invalid status.

## Why This Is Better Than The Alternatives

### Option A: only add `runs list`

This is cheap and should be part of V1, but it is too thin. It tells the
operator which folders exist, not what happened inside them.

### Option B: expose raw trace

This is tempting and fast, but it makes every host learn Circuit's internal
trace contract. It also leaks raw implementation names into the product surface.
`runs events` gives the useful timeline without forcing hosts to parse trace
entries.

### Option C: replay runtime progress offline

The live progress projector is presentation-oriented. It is useful during a run,
but it is not the right public contract for inspecting saved artifacts. Run
inspection should project from durable trace and reports into stable JSON.

### Option D: build a run database or daemon

This can come later. It would help with fast dashboards, live run tracking, and
cross-project supervision. It is overkill for V1 because the run folder already
has enough data for list, events, and why.

### Option E: add legacy salvage now

The local corpus proves this would be useful. A stale prototype run has a raw
checkpoint request that the current status projector rejects. But a legacy
best-effort parser would become a second trace semantics layer. V1 should mark
these folders invalid and make a later `--best-effort-legacy` design explicit.

## Build Sequence

1. Extract the shared read-only trace reader from `runtime-run-folder.ts`.
2. Add schemas for list, events, why, events refs, and reasons.
3. Implement `listRunsForProject`.
4. Implement `projectRunEventsFromFolder`.
5. Implement `projectRunWhyFromFolder`.
6. Extend `src/cli/runs.ts` with `list`, `events`, and `why`.
7. Update CLI usage in `src/cli/circuit.ts`.
8. Add runner tests for current, aborted, waiting checkpoint, invalid, corrupt,
   and list-mixed folders.
9. Add facade tests that prove CLI still does not parse trace or read reports.
10. Run `npm run verify`.

Suggested focused tests:

- `runs list` skips non-directories and includes invalid projections.
- `runs list` sorts by latest known timestamp and returns state counts.
- `runs events` returns step, relay, check, checkpoint, fanout, sub-run, and run
  categories from a current-schema trace.
- `runs events --category check` returns only check events.
- `runs events --step <id>` filters by step id and keeps run-level context out
  unless explicitly requested.
- `runs why` explains an aborted run from failed check plus `step.aborted`.
- `runs why` explains a waiting checkpoint from the status checkpoint object.
- `runs why` on invalid current folders returns the status error and does not
  crash.
- Missing folders keep the existing engine-error exit behavior.

## V1 Boundary

Must build:

- `runs list`;
- `runs events`;
- `runs why`;
- one shared current-schema trace reader;
- strict output schemas;
- current-schema fixtures and invalid-folder tests;
- no liveness claims;
- no flow-specific report interpretation.

Should defer:

- rich HTML timeline;
- human-friendly non-JSON output;
- `runs artifacts` as a separate command;
- best-effort legacy trace salvage;
- active process detection;
- attention ranking;
- cross-project run index;
- hosted dashboard;
- eval suites over run quality.

The most useful V1 is boring in the right way. It makes saved runs inspectable
from the command line, gives hosts stable JSON, and stays inside the authority
of existing run artifacts.

## Claim Inventory

| Claim | Confidence | Evidence |
| --- | --- | --- |
| `runs show` already exists and returns a status projection for one run folder. | High | `src/cli/runs.ts`; local command probe. |
| `runs show` should remain the current-status surface, not become a timeline. | High | Existing CLI shape, schema, and tests keep it narrow. |
| V1 `runs list` can be implemented by scanning `.circuit/runs` and calling the existing status projection. | High | Prior host API spec plus local corpus probe of 24 run folders. |
| V1 must include invalid projections instead of failing the whole list. | High | Existing `runs show` behavior and invalid-folder tests. |
| V1 must not claim a process is live. | High | Existing status vocabulary uses `open`, not `running`, for non-terminal current folders. |
| Current trace data supports an event timeline for current-schema runs. | High | Trace schema and local completed/aborted probes. |
| Current trace data supports deterministic abort explanations. | High | Local aborted sample has failed `check.evaluated` and `step.aborted` reasons. |
| Current trace data supports checkpoint explanation only when the status projector accepts the run folder. | High | Valid status path exposes structural checkpoint data; stale raw checkpoint sample projects invalid. |
| V1 should not parse all report bodies. | Medium-high | Reports are flow-specific; status already exposes stable result/operator summary paths. |
| Process evidence and run envelopes should be optional in inspection. | High | Code writes them as post-run artifacts, but representative older local folders do not contain them. |
| A shared app-level trace reader is safer than adding another parser or importing runtime store state. | High | Current app projector has private parse logic; tests enforce no CLI/runtime leakage. |
| Legacy salvage is useful but should be deferred. | Medium-high | Local stale prototype folder has raw useful checkpoint data but fails current trace projection. |

## Open Questions For Implementation

- Should `runs list` require `--project-root`, or default it to `process.cwd()`
  while still printing the resolved root? I recommend requiring the flag in V1
  for scriptability, then adding a default later if it feels annoying.
- Should `runs events` include run-level events when `--step` is supplied? I
  recommend no: filters should be literal and predictable.
- Should `runs why` read `reports/result.json` for the terminal summary? I
  recommend not in the first slice. Link it first; parse it later once the output
  schema has a place for result summaries.
- Should invalid legacy folders get `runs events --best-effort`? Probably yes
  later, but only as an explicitly lossy mode with a separate schema field.
