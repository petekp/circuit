---
contract: explore
status: draft
version: 0.7
schema_source: generated/flows/explore/circuit.json (compiled flow) + src/flows/explore/reports.ts (explore.brief / explore.analysis / explore.compose / explore.review-verdict / explore.result)
last_updated: 2026-04-28
depends_on: [flow, stage, step, selection, depth, change_kind, skill, connector]
report_ids:
  - explore.brief
  - explore.analysis
  - explore.compose
  - explore.review-verdict
  - explore.result
invariant_ids: [EXPLORE-I1]
property_ids:
  - explore.prop.canonical_stage_set_is_correct
  - explore.prop.report_emission_ordered
  - explore.prop.review_after_compose
  - explore.prop.no_skip_to_close
  - explore.prop.reachable_close_only_via_review
---

# Explore Flow Contract

The **Explore** flow is the first-parity flow target. It walks a five-stage
investigation: frame the investigation, analyze the subject, synthesize
findings, review those findings adversarially, and close with a final report.

Unlike the base domain contracts (`flow.md`, `step.md`, `stage.md`, etc.)
which govern the shape of any flow, this contract governs a specific flow:
`explore`. It binds the flow's canonical stage set, declares the report ids
it emits, and names the runtime-enforced invariant (EXPLORE-I1) plus four
deferred properties.

## Scope note

The compiled `explore` flow at `generated/flows/explore/circuit.json`
is validated by the base `CompiledFlow` schema (`src/schemas/compiled-flow.ts`). This
contract is the flow-specific discipline layer over that base schema — it
names one invariant (EXPLORE-I1) the base schema cannot express, plus five
report ids the flow's stages emit, plus four property ids for deferred
semantic guarantees.

The base `CompiledFlow` schema has no `kind` field today. Until it does,
`src/shared/flow-kind-policy-core.ts` carries the `{id → canonical set}` map
used by contract tests and generated flow loading. Reopen triggers for this seam:
duplicate `id` across flow packages; an `explore-mini` or `research` flow with
no explicit policy entry; or landing of the `CompiledFlow.kind` field.

## Axis Support

Explore declares `axes.allowed_depths = [lite, standard, deep]`, supports
tournament and autonomous runs, and declares `decision-stage` as the
tournament fan-out stage. The default axis tuple is standard, non-tournament,
and interactive with `tournament_n = 3`.

## Result-path split

`explore.result` and `run.result` originally both registered their
`backing_path` at `<run-folder>/reports/result.json`. To preserve the
single-writer invariant on `result.json` (engine-authored), `explore.result`
moves to `<run-folder>/reports/explore-result.json`. `run.result` retains
`<run-folder>/reports/result.json`. The two reports now live at distinct
paths; the engine still owns `result.json`, the flow owns
`explore-result.json`. The same `<kind>-result.json` sibling pattern
generalizes to `build-result.json`, `fix-result.json`, etc.

## Ubiquitous language

See `UBIQUITOUS_LANGUAGE.md#core-flow-language` for canonical definitions of **CompiledFlow**,
**Stage**, **Step**. This contract adds five report ids:

- **Explore brief** (`explore.brief`): the framing report emitted by the
  Frame stage. Names the subject, the operator's task statement, and the
  success condition for the investigation.
- **Explore analysis** (`explore.analysis`): the report emitted by the
  Analyze stage. Decomposes the subject into named aspects with evidence
  citations.
- **Explore findings** (`explore.compose`): the report emitted by the
  Synthesize stage. Produces the investigation's primary output — a
  recommendation, decision candidate set, or conclusion — with explicit
  mapping back to the brief's success condition. (The schema id is
  `explore.compose`; in prose we call it the findings report.)
- **Explore review verdict** (`explore.review-verdict`): the report
  emitted by the Review stage. Adversarial pass over `explore.compose`;
  reports objections, missed angles, and overall result.
- **Explore result** (`explore.result`): the aggregate report emitted by
  the Close stage. A summary plus result snapshot plus pointers to the
  four prior reports. The flow-specific "what the explore run produced."
  Persisted at `<run-folder>/reports/explore-result.json`. This is
  distinct from the universal `run.result` report (at
  `<run-folder>/reports/result.json`, authored by the engine at
  run.closed).

## Canonical stage set and title-to-canonical translation

The default investigation path uses flow-specific titles `{Frame, Analyze,
Synthesize, Review, Close}`. The tournament decision path uses `{Frame,
Analyze, Decision, Close}`. These titles are human-readable and match the
reference Circuit explore behavior. They are not all canonical stage ids —
`Synthesize` in particular is not in the CanonicalStage enum at
`src/schemas/stage.ts` (which is the seven-stage path `frame, analyze, plan,
act, verify, review, close`).

This contract records the title-to-canonical translation as follows:

| Flow-specific title | Canonical stage id | Role |
|---|---|---|
| Frame                  | `frame`    | State the subject and success condition. |
| Analyze                | `analyze`  | Decompose the subject into aspects with evidence. |
| Synthesize             | `act`      | Produce the investigation's primary output. |
| Decision               | `plan`     | Run option drafting, proposal fanout, stress review, tradeoff checkpoint, and final decision composition. |
| Review                 | `review`   | Adversarial pass over `explore.compose`. |
| Close                  | `close`    | Final aggregate report and closure. |

**Default canonical set:** `{frame, analyze, act, review, close}`.
**Default omits:** `{plan, verify}` (partial path).

**Tournament canonical set:** `{frame, analyze, plan, close}`.
**Tournament omits:** `{act, verify, review}` (partial path).

Tournament does not add a canonical Review stage. Its adversarial stress pass is
inside the canonical `plan` stage titled `Decision`, because original Explore
parity treats this as `Plan or Decision` with embedded critique.

### Executor and kind per stage

The runtime locks the executor + kind for each stage:

| Stage (title / canonical) | executor       | kind        | role          | writes shape                               | check              |
|---------------------------|----------------|-------------|---------------|--------------------------------------------|--------------------|
| Frame / `frame`           | `orchestrator` | `compose` | —             | `{report}`                               | `schema_sections`  |
| Analyze / `analyze`       | `orchestrator` | `compose` | —             | `{report}`                               | `schema_sections`  |
| Synthesize / `act`        | `worker`       | `relay`  | `implementer` | `{report, request, receipt, result}`     | `result_verdict`   |
| Review / `review`         | `worker`       | `relay`  | `reviewer`    | `{report, request, receipt, result}`     | `result_verdict`   |
| Close / `close`           | `orchestrator` | `compose` | —             | `{report}`                               | `schema_sections`  |

**Why Synthesize and Review relay to workers.** The Synthesize stage IS
the investigation output (the model doing the work); Review IS the
adversarial pass (the model doing the checking). If the orchestrator does
both, explore produces same-model self-review — the methodology rejects
that.

Flipping these two stages to worker relays makes the relay routing a
contract-visible surface: the step schema carries a `role` tag, a
request/receipt/result transcript, and a `ResultVerdictCheck` that every
Circuit-written step lacks. The schema layer does not enforce that the
implementer-role connector and the reviewer-role connector are distinct;
distinct-connector enforcement is an evidential guarantee delivered by the
end-to-end parity test.

**Why Frame, Analyze, Close stay Circuit-written.** Framing (stating the
subject and success condition), decomposition (producing aspects with
evidence), and aggregation (composing prior reports into a run result) are
bookkeeping the orchestrator does. They do not benefit from crossing a
model boundary; their output is deterministic given the inputs.

**Why `Synthesize → act`.** Synthesize is the primary work-producing stage.
It consumes the brief + analysis and emits the `explore.compose` report —
the investigation's output. In the canonical seven-stage path, `act` is the
"do the work" stage, where the flow's primary deliverable is produced.
This matches.

**Why `plan` is present.** Explore is an investigation and decision flow.
Synthesize, critique, and tournament decisions live inside the canonical
Plan/Decision stage. This keeps default exploration and tournament exploration
on the same parity path: Frame, Analyze, Plan or Decision, Close.

**Why `verify` is omitted.** Explore produces investigation output (not
executable reports), so there is no mechanical verification step
analogous to `build`'s test-run check. Critique is an adversarial pass inside
Plan/Decision — usually a worker relay step with `role: "reviewer"` — but it is
peer critique, not a mechanical check. A future variant of explore that emits
executable reports (e.g., a generated migration script) would need
`verify` to hold a mechanical check; that would be a different flow kind.

## Invariant — EXPLORE-I1

The runtime MUST reject any `explore`-kinded flow that violates EXPLORE-I1.
Other semantic guarantees are recorded as deferred properties (see below).

- **EXPLORE-I1 — Canonical stage set matches kind, stage_path_policy is partial
  with omits that match the selected Explore graph.** Any compiled flow whose
  top-level `id` equals the string `'explore'` MUST:
  1. Match the approved Explore canonical set:
     `{frame, analyze, plan, close}` with `omits = [act, verify, review]`.
     Extra canonicals are rejected; missing canonicals are rejected.
  2. Declare `stage_path_policy.mode = 'partial'` with an `omits` set matching
     the selected variant.

  **Scope of EXPLORE-I1 enforcement.** `checkCompiledFlowKindCanonicalPolicy`
  enforces (1) and (2). It does not currently enforce:
  - Rationale length or rationale-content (a base-schema check).
  - The `id`-vs-directory-name convention.
  - Full `CompiledFlow.safeParse` validation (Check 24 hand-parses the
    canonical stage set without running the base schema; malformed flows
    pass Check 24 if their stage canonicals match).

  **Executor/kind shape is enforced by `CompiledFlow.safeParse`, not by
  Check 24 or EXPLORE-I1.** Synthesize and critique steps must be `RelayStep`-
  shaped (`executor: "worker"`, `kind: "relay"`, `role` present,
  `writes: {report?, request, receipt, result}`,
  `check: ResultVerdictCheck`). Failures hit the base schema before
  Check 24 runs.

  Enforced by `src/shared/flow-kind-policy-core.ts` and
  `tests/contracts/flow-kind-policy.test.ts`.

## Deferred properties

These describe semantic guarantees the contract intends the `explore` flow
to satisfy but that are not runtime-enforced today.

- **`explore.prop.canonical_stage_set_is_correct`** — test-enforced via
  `tests/contracts/stage path-coverage.test.ts`.
- **`explore.prop.report_emission_ordered`** — five stages emit reports
  in order: Frame → `explore.brief`, Analyze → `explore.analysis`,
  Synthesize → `explore.compose`, Review → `explore.review-verdict`,
  Close → `explore.result`. Deferred.
- **`explore.prop.review_after_compose`** — Review MUST execute after
  Synthesize on every viable execution path. Deferred.
- **`explore.prop.no_skip_to_close`** — no execution path from any
  `EntryMode.start_at` reaches `@complete` without passing through the
  Review stage. Deferred.
- **`explore.prop.reachable_close_only_via_review`** — symmetric to
  `no_skip_to_close`; stated for emphasis. Deferred.

## Pre-conditions

- The compiled flow at `generated/flows/explore/circuit.json` parses
  under the base `CompiledFlow.safeParse`.
- The flow's top-level `id` equals the string literal `'explore'`.
- All five report ids under `report_ids` are registered by the Explore flow
  package and declared by generated steps through `writes.report`.

## Post-conditions

After an `explore` compiled flow is accepted:

- The flow's stage set covers `{frame, analyze, plan, close}` with
  `stage_path_policy.mode = 'partial'` and `omits = [act, verify, review]`.
- The flow emits five named reports in stage order (deferred enforcement).
- The flow starts at the Frame stage's step and declares its supported axes.
- No execution path reaches `@complete` without passing through the configured
  critique or decision path inside Plan/Decision (deferred enforcement).

## Report reader/writer graph

The following table is the authoritative reader/writer graph.
`generated/flows/explore/circuit.json` step `reads` arrays MUST match this
table exactly.

| Report                   | Writer (stage/step) | Readers (stage/step)                                                                 |
|--------------------------|---------------------|--------------------------------------------------------------------------------------|
| `explore.brief`          | Frame / frame-step  | Analyze / analyze-step; Plan or Decision / synthesize-step; Plan or Decision / review-step |
| `explore.analysis`       | Analyze / analyze-step | Plan or Decision / synthesize-step; Plan or Decision / review-step                |
| `explore.compose`      | Plan or Decision / synthesize-step | Plan or Decision / review-step; Close / close-step                         |
| `explore.review-verdict` | Plan or Decision / review-step | Close / close-step                                                          |
| `explore.result`         | Close / close-step  | *(none — terminal report at `<run-folder>/reports/explore-result.json`; consumed by the run-result consumer only)* |

**Close reads `explore.compose` + `explore.review-verdict` only** (not
brief or analysis). The `explore.compose` report encapsulates the
investigation output; the review verdict encapsulates the adversarial
pass. The brief + analysis are upstream inputs already composed into
`explore.compose`; re-reading them at Close would duplicate input
rather than add value.

## Relay report materialization

After the relay-kind flip, `explore.compose` and
`explore.review-verdict` are relay-step outputs, not Circuit-written
outputs. Their content shape is unchanged; their provenance is now
model-authored via connector relay (implementer-role connector at
Synthesize, reviewer-role connector at Review). The five-trace_entry relay
transcript (`relay.started` → `relay.request` → `relay.receipt` →
`relay.result` → `relay.completed`) is recorded for every relay step.

The relay step's `writes.result` path (the raw connector output) and the
`writes.report.path` (the canonical downstream-read report) are distinct
on disk but bound by the materialization rule: at relay step completion,
after the `ResultVerdictCheck` passes, the runtime MUST write the report at
`writes.report.path` by schema-parsing the `result` payload against
`writes.report.schema`. Downstream steps reading the report path observe
the validated report, not the raw transcript.

The compiled explore flow satisfies the precondition for this rule: both
relay steps declare `writes.report` alongside `writes.result`. Check 27
asserts this structurally.

## Relay check semantics

The `ResultVerdictCheck` declared on each relay step is evaluated by the
runtime against the connector's `result_body`:

1. `JSON.parse(relayResult.result_body)` — must yield a JSON object
   (not array, not null, not a single value).
2. The parsed object MUST carry a top-level `verdict` field whose value
   is a non-empty string. The membership check is exact string equality —
   no trimming, no case folding. `"OK"` is not `"ok"`. Connector prompts
   include the accepted-verdicts list verbatim so the connector can match
   against the canonical strings.
3. The verdict string MUST appear in `step.check.pass`.

If all three hold, the runtime sets `relay.completed.verdict` to the
parsed verdict, materializes the canonical report at `writes.report.path`
(when declared), emits `check.evaluated` with `outcome: 'pass'`, and follows
`routes.pass`. If ANY fail, the runtime emits `check.evaluated` with
`outcome: 'fail'` and a human-readable `reason` naming the cause (parse
error, missing / non-string verdict field, or verdict-not-in-`check.pass`
with the observed verdict recorded), then emits `step.aborted` with the
same reason, then emits `run.closed` with `outcome: 'aborted'` and the
reason carried on the close trace_entry. The user-visible
`<run-folder>/reports/result.json` mirrors the same outcome and reason
on `RunResult.outcome` and `RunResult.reason`. The relay step does not
advance — `step.completed` is not emitted for the aborted step, and
`routes.pass` is not taken.

**TraceEntry ordering.** When the connector returns a result, the runtime
sequences trace_entries:

1. `step.entered`
2. The five-trace_entry relay transcript via `materializeRelay`:
   `relay.started` → `relay.request` → `relay.receipt` →
   `relay.result` → `relay.completed`. The transcript writes the
   `request`, `receipt`, and `result` files unconditionally (durable
   evidence).
3. THEN, on the runner side: `check.evaluated` (outcome=pass on admission;
   outcome=fail on rejection).
4. On pass: `step.completed` with `route_taken='pass'`. On fail:
   `step.aborted` with the same reason as `check.evaluated.reason`.

**Connector invocation failure ordering.** If the connector invocation
itself throws or fails before returning a receipt/result body, the runtime
records the pre-await relay context instead of stranding the run after
`step.entered`:

1. `step.entered`
2. `relay.started`
3. `relay.request` with the SHA-256 of the request payload
4. `relay.failed` carrying connector identity, role, resolved selection,
   resolved-from provenance, the same request hash, and the failure reason
5. `check.evaluated outcome=fail` with the same reason
6. `step.aborted` with the same reason
7. `run.closed outcome=aborted` with the same reason

`<run-folder>/reports/result.json` mirrors the aborted outcome and
reason. No `relay.receipt`, `relay.result`, `relay.completed`, or
`step.completed` trace_entry is emitted for that failed relay attempt.

**Runtime sentinels on `relay.completed.verdict`.**
`RelayCompletedTraceEntry.verdict` is `z.string().min(1)` so the slot must
always carry a non-empty string. On check fail with no observable verdict
(unparseable JSON or parseable JSON without a string `verdict` field), the
runtime injects the sentinel literal `'<no-verdict>'`. A consumer that
reads `relay.completed.verdict` SHOULD treat the `'<no-verdict>'`
literal as "no verdict was observable from connector output."

## Relay report schema-parse

Complement to the check-evaluation semantics above. When a relay step
declares `writes.report` and the verdict check admits the connector's
declared verdict, the runtime parses `result_body` against a Zod schema
looked up by `writes.report.schema` from the registry at
`src/flows/registries/report-schemas.ts`. The canonical report at
`writes.report.path` is materialized ONLY when BOTH (a) the verdict check
passes and (b) the schema parse succeeds.

Parse failure leaves `writes.report.path` absent and surfaces the error
through `check.evaluated outcome=fail` + reason → `step.aborted` (same
reason) → `run.closed outcome=aborted` (same reason), with
`RunResult.reason` mirroring the close-trace_entry reason on the user-visible
`result.json`. This does not emit `relay.failed`; that trace_entry is
reserved for connector invocation exceptions.

**Schema absent → fail closed.** If `writes.report.schema` names a
schema that is NOT in the registry, the runtime treats the lookup miss as
a parse failure (reason: "report schema '<name>' is not registered in
the report-schema registry (fail-closed default)"). No report is written;
the step is aborted. Fail-closed is mandatory.

**Registered schemas.** The registry at
`src/flows/registries/report-schemas.ts` carries the strict
`ExploreCompose` schema for `explore.compose@v1`, the strict
`ExploreReviewVerdict` schema for `explore.review-verdict@v1`, the
minimal-shape `{ verdict: z.string().min(1) }.passthrough()` schema for
`runtime-proof-canonical@v1`, and a test-only strict `runtime-proof-strict@v1` schema
used by `tests/runner/materializer-schema-parse.test.ts`. The
`explore.compose@v1` and `explore.review-verdict@v1` relay hints in
`src/flows/explore/relay-hints.ts` name the exact JSON shapes the
connectors must return.

**`relay.completed.verdict` on schema-fail.** When the check admits the
verdict but the report body fails schema parse, `relay.completed.verdict`
carries the observed verdict (durable transcript reflects what the
connector said). The runtime sentinel `'<no-verdict>'` is NOT used on this
path because the connector DID declare a parseable verdict; the body
shape, not the verdict, is what failed.

## `schema_sections` check and schema reconciliation

The compiled flow's `schema_sections` checks declare the top-level field
names the runtime checks for the Circuit-written reports. The check
remains a lightweight top-level section verification, while the registered
composer writers construct and parse the full strict report bodies before
writing them. `tests/contracts/explore-report-composition.test.ts` is
the cross-surface ratchet: compiled-flow schema names, check `required`
arrays, and runtime writer/registry behavior must stay aligned.

## Property ids

See Deferred properties above for semantics.

- `explore.prop.canonical_stage_set_is_correct` — test-enforced via
  `tests/contracts/stage path-coverage.test.ts` describe title.
- `explore.prop.report_emission_ordered` — deferred.
- `explore.prop.review_after_compose` — deferred.
- `explore.prop.no_skip_to_close` — deferred.
- `explore.prop.reachable_close_only_via_review` — deferred.

## Reopen conditions

This contract is reopened if any of:

1. **Target retarget.** If the operator reselects a different first-parity
   target, this contract is deprecated in place (status → `retargeted`).
2. **Canonical stage set change.** If a future change amends the canonical
   stage set for `explore` (e.g., adds `plan` back in, or maps Synthesize
   to `plan` instead of `act`), this contract must be amended. The
   title-to-canonical translation table is the authoritative surface.
3. **Report-schema refactor.** If the five report ids gain different
   concrete Zod schemas, this contract amends the report id section with
   schema file pointers and the report round-trip invariant.
4. **CompiledFlow-kind concept introduced.** If the base CompiledFlow schema
   gains a `kind` field, EXPLORE-I1 and the deferred properties move
   into that layer as kind-specific checks, and this contract becomes a
   pointer to the kind schema.
5. **Deferred properties land enforcement** (Codex flag). If the
   deferred property promotion lands, reopen this contract to amend the
   Deferred properties subsection.
6. **Report reader/writer graph drift.** If the report reader/writer graph
   table diverges from the compiled flow, reopen to resolve the divergence —
   the contract table is authoritative.
7. **Check/schema reconciliation skipped.** If a future change lands
   without reconciling the compiled flow's `schema_sections` `required`
   arrays with concrete report schemas, reopen.
8. **`explore.result` consumer-shape drift.** If downstream consumers
   need fields beyond the current `summary` + `verdict_snapshot` +
   `evidence_links` shape, reopen to amend the result schema and the
   report registry row together.
9. **`<kind>.result` envelope consolidation.** If a second flow's
   close-stage aggregate (e.g., `build.result`, `fix.result`) has a
   shape structurally identical to `explore.result`'s structure (summary
   + result snapshot + prior-report pointers), reopen the result-path
   split rationale to re-evaluate envelope-in-`run.result` against
   per-flow sibling files.

## Authority

- `src/shared/flow-kind-policy-core.ts` (canonical stage policy)
- `src/flows/explore/reports.ts` (report schemas)
- `generated/flows/explore/circuit.json` (compiled flow)
