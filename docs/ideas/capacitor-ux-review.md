# Review: Capacitor UX Proposals (Second Opinion)

> Note (2026-07-01): the two proposal docs this review evaluates were never
> committed; they lived in a worktree that has since been removed. This review
> survives as the record of the verdict and the boundary analysis.

Reviewer pass, 2026-06-12. Skeptical product + architecture review of:

- `docs/ideas/capacitor-ux-second-opinion-proposal.md`
- `docs/ideas/capacitor-ux-capability-roadmap.md`

Grounded against source in `circuit` and `capacitor` repos. Confirmed facts and
inference are separated at the end of each major finding.

---

## Bottom Line: Endorse With Changes

The core claim is right: Circuit should be the evidence/projection layer and
Capacitor the native control surface. The capability *stack* is well-shaped and
the non-goals are disciplined. Two things must change before this is a safe
roadmap:

1. **The boundary is described as if Capacitor already consumes Circuit run
   folders. It does not.** Capacitor's own live docs build a parallel evidence
   spine (Work Batch / Claim / Checkpoint / Done / Preview Session) and treat
   Circuit as a thin stdin/stdout protocol helper. The proposal's "Risk 6:
   duplicate state" is not a future risk — it is the present state, and it is
   the highest-severity issue here.

2. **The build order front-loads attention projection (slice 2) ahead of the
   evidence it actually needs (slice 3).** The product-central attention state,
   `review_ready`, cannot be derived from run status alone. It needs change and
   proof evidence, which arrives in slice 3. As written, slice 2 ships an
   attention model that can only honestly emit two of its six states.

Fix those two and this is a strong, buildable plan.

---

## Strongest Parts

- **The hard boundary is stated crisply and correctly**: Circuit is not a native
  app, terminal manager, or VCS; Capacitor does not parse raw traces; Git keeps
  commits/branches/diffs/merge mechanics. This is the right carve.
- **"Attention must be deterministic, never model judgment"** (Risk 2). This is
  the single most important design constraint in the document and it is correct.
  A workboard that a model can be wrong about is a workboard users stop trusting.
- **The read-only, no-liveness discipline** carried from
  `run-inspection-implementation.md`. "A run folder cannot prove a process is
  alive" is exactly right and is the kind of honesty that keeps the surface
  trustworthy.
- **Provenance scoped to write boundaries, not keystrokes** (Risk 3). Resisting
  the urge to become a worse VCS is correct and hard to hold.
- **Preview readiness as facts, not a launcher.** Circuit exposing "is there
  something inspectable and of what kind" while Capacitor owns launch is the
  right split, and it matches Capacitor's own preview-work strategy.
- **The non-goals list does real work.** "Do not let report prose approve apply"
  and "do not claim liveness from a run folder" are the two failure modes most
  likely to wreck trust, and both are pre-empted.

---

## Findings By Severity

### CRITICAL

#### C1. The consumer described in the proposal is not the consumer that exists

**Risk.** The entire proposal rests on a model where Capacitor renders Circuit's
projections: Circuit produces run folders, traces, typed reports, attention,
provenance; Capacitor reads them. But Capacitor's *current* docs describe a
different architecture, and the two have not been reconciled.

**Evidence (confirmed).**
- Capacitor's live product loop says: "Circuit is represented here as a headless
  intent/protocol layer: JSON-compatible planning and normalization functions
  under `circuit_protocol/`" and "This is not a runner, flow engine, task DAG,
  retry platform, broad memory store..." (`capacitor/docs/circuit/receipt-first-product-loop.md:8-19`).
  In that loop Capacitor launches a Claude Code CLI session directly and
  captures a `CIRCUIT_RECEIPT` stdout block — it never runs a Circuit flow that
  writes `.circuit/runs/<id>/trace.ndjson` (`receipt-first-product-loop.md:21-37`).
- Capacitor's preview strategy builds an independent trust spine — "Task claim,
  Checkpoint, Done report, internal evidence, and Unresolve" — stored as Swift
  models and `.capacitor/work-batch-claims` artifacts, with Rust owning "runtime
  semantics, identity, ingest, reducer state, and persistence"
  (`capacitor/docs/circuit/preview-work-strategy.md:30, :64-91`). There is no
  reference to Circuit traces, run folders, or typed reports anywhere in that
  document's ground truth.

**Why this is critical.** If Capacitor's runtime authority is its own Rust
reducer over Work Batch claims, then Circuit's run folders are not the substrate
Capacitor renders — they are a second, parallel record. Every projection this
proposal asks Circuit to build (`run-list-v1`, attention, `change.provenance@v1`,
walkthrough, preview readiness) assumes Capacitor consumes Circuit run folders as
the source of truth. The proposal's own Risk 6 names this ("both systems model
the same thing with different names") but treats it as a mitigable future risk.
It is the present architecture, and it determines whether *any* of these slices
get consumed.

**Concrete correction.** Before slice 1, write a one-page integration contract
answering: *Does Capacitor run Circuit flows (producing run folders), or does it
run bare Claude Code CLI and treat Circuit as a planner/normalizer?* The two
proposals only make sense under the first answer. If the real answer is the
second (which the live docs describe), then the first deliverable is not `runs
list` — it is making Capacitor's session-launch path actually invoke Circuit so
that run folders exist to inspect. Pick one of:
  - **(a)** Capacitor launches `circuit run` flows; run folders are the spine;
    the Work Batch Done/Claim model becomes a *view* over run status. This is
    the architecture the proposal assumes.
  - **(b)** Capacitor keeps its native spine; Circuit projections are an optional
    enrichment for sessions that happen to be Circuit runs. Then this roadmap is
    a *secondary* surface and should be scoped and sequenced as such.

This decision gates everything. It is the one question that, answered wrong,
turns the whole stack into a dead end (and is the honest answer to review
question 10 — see D1).

---

### HIGH

#### H1. Attention projection (slice 2) is sequenced ahead of the evidence it needs

**Risk.** Slice 2 promises six attention states — `none | review_ready |
decision_needed | proof_failed | risk | invalid`. But slice 1 deliberately does
*not* surface the data three of those states require.

**Evidence (confirmed).**
- `run-inspection-implementation.md` V1 explicitly defers report-body parsing:
  "V1 should not parse all report bodies"; `runs events`/`why` surface
  *deterministic refs and outcomes* but not parsed change or proof contents
  (`run-inspection-implementation.md:425-445`, `:550`).
- The current status projection exposes only `open | waiting_checkpoint |
  completed | aborted | invalid` plus checkpoint fields and next-action
  (`inspect | resume | none`) (`run-inspection-implementation.md:51`, `:283`).
  It carries no notion of "write-capable," "has change evidence," or "proof
  passed."

**Inference.** From status alone, slice 2 can honestly emit only
`decision_needed` (from `waiting_checkpoint`) and `invalid`. `proof_failed` and
`risk` need the deterministic failure events from `runs why` (failed
`check.evaluated`, `verification.command_evaluated`, `proof.assessed`,
`relay.failed`) — so attention depends on the *why* projection, not just *list*.
And `review_ready` ("completed write-capable run with change evidence") cannot be
derived until **slice 3** (change provenance) exists, because "has change
evidence" is precisely what provenance computes.

**Why it matters.** As sequenced, slice 2 either ships a crippled attention model
(two of six states) and gets re-opened after slice 3, or it quietly pulls slice
3's work forward and the "build provenance third" ordering is fiction.
`review_ready` is the most product-central state — it is the whole "Ready to
inspect" workboard promise — and it is gated on slice 3.

**Concrete correction.** Either (a) fold the `runs why` failure-event derivation
into the slice-2 definition explicitly (attention reads *why*, not *list*), and
move `review_ready` to land *with* slice 3 rather than slice 2; or (b) reorder so
change provenance for Fix/Build comes second and attention third. Option (b) is
cleaner — see the revised build order.

#### H2. `change.provenance@v1` is too broad for a first version

**Risk.** The proposed `change.provenance@v1` binds ~13 field groups: run/flow/
step/attempt, connector/role/resolved-selection, loaded skills, request+result
hashes, baseline+post-step heads, runtime touched files, worker-declared files,
proof refs, verification refs, review refs, risk/missing-evidence refs, and
reason text. That is a wide v1 surface to freeze with a `@v1` version stamp,
across two flows (Fix and Build) that do not have identical evidence shapes.

**Evidence (confirmed).** The raw materials exist and are individually solid:
relay request/result content hashes bound to `(step_id, attempt)`
(`trace-entry.ts:336-413`); runtime touched files with baseline/current head,
declared-vs-observed deltas, protected/generated flags, and rename `from`
(`runtime-evidence.ts:39-153`). But "the fields exist" is not "the join is
trivial": several fields (review refs, risk refs, reason text) come from
flow-specific typed reports whose shapes differ between Fix and Build.

**Why it matters.** A `@v1` stamp is a compatibility promise. If half the fields
are present-for-Fix / absent-for-Build, every consumer learns to treat the schema
as mostly-optional, which defeats the point of a typed contract. The broad schema
also invites the dead-end abstraction risk (D1): a generic provenance record that
neither flow populates fully.

**Concrete correction.** Ship the smallest provenance that answers "why did this
file change?" deterministically and is *fully populated by both Fix and Build*:
  - `run_id`, `flow_id`, `step_id`, `attempt`
  - `baseline_head`, `post_step_head`
  - `runtime_touched_files` (already a typed, refinement-checked projection)
  - `relay_request_hash`, `relay_result_hash`
  - `proof_refs` / `verification_command_refs` (refs only, present-or-explicitly-empty)
  - one `reason` string sourced from the typed result report

Defer connector/role/selection, loaded skills, review refs, risk refs, and
missing-evidence refs to `@v2` once both flows demonstrably populate them. Make
absence *explicit* (the roadmap already says "missing runtime diff evidence is
explicit, not silently ignored" — `capacitor-ux-capability-roadmap.md:272`);
apply that same rule to every deferred field rather than carrying empty optionals
in v1.

#### H3. A local read model (SQLite) is an unacknowledged dependency, not just a "later" option

**Risk.** Both proposals defer the read-model question (proposal question 3 asks
whether the need is understated). It is understated. `runs list` as specified
does a **recursive file walk per invocation** to compute sort timestamps and call
the status projector on every folder (`run-inspection-implementation.md:73-79`).
A Capacitor workboard polling many projects re-walks the filesystem on every
refresh.

**Evidence (confirmed).** The SQLite proposal already exists, recommends "Option
2: derived local read model," and flags the exact consumers that converge here:
"run inspection needs fast list/events/why views; memory effect needs cross-run
analytics" (`local-sqlite-read-model.md:289-297`). `node:sqlite` is confirmed
available in the bundled runtime (`local-sqlite-read-model.md:284`,
SQLite 3.53.0). The current corpus is already 24 runs / 806 trace entries / 276
report files (`local-sqlite-read-model.md:285`).

**Inference.** A workboard is a *polling, multi-run, multi-project* consumer.
That is precisely the access pattern file-walks handle worst and a derived index
handles best. The proposal's slices 1–2 are survivable on file walks at 24 runs;
they are not the access pattern at 200 runs across 10 projects, which is the
parallel-builder target user.

**Concrete correction.** Do not make SQLite a slice-1 *requirement* (that adds
packaging risk before value is proven). But do (a) make the slice-1 read-model
boundary explicit: every projection function takes a source-of-truth interface
that today walks files and can later be backed by the derived DB without
contract change; and (b) add a named trigger — "when `runs list` p95 latency on
a real multi-project corpus exceeds ~Xms, the derived read model becomes
required, not optional." Right now the dependency is invisible until it bites.

---

### MEDIUM

#### M1. `review_ready` is defined by a fact Circuit cannot currently compute

**Risk.** The attention spec defines `review_ready` as "completed write-capable
run with change evidence" (`capacitor-ux-second-opinion-proposal.md:235`). Two
sub-facts in that definition do not exist yet as deterministic projections:
"write-capable" and "has change evidence."

**Evidence (confirmed).** The status projection has no write-capability concept
(`run-inspection-implementation.md:51`). "Change evidence" is what
`change.provenance@v1` produces — i.e. slice 3.

**Inference.** This is the data-level restatement of H1. The safest deterministic
definition of `review_ready` is: *engine_state == completed* AND *the run emitted
a runtime touched-files projection with a non-empty `files` array and
`worker_claim_matches_runtime == true`*. That is computable from runtime evidence
(`runtime-evidence.ts:59-72`) without model judgment — but it requires the
inspection layer to read that evidence, which V1 defers.

**Concrete correction.** Define `review_ready` against the runtime touched-files
report specifically (it is already typed and refinement-checked), and state that
this is why change provenance for Fix/Build must precede a complete attention
model. This also answers review question 6 ("which facts define `review_ready`
without model judgment"): non-empty runtime-observed `files` + passing
worker-claim match + completed state.

#### M2. The attention state set is missing a "stale/superseded" state and conflates two failure kinds

**Risk.** The six states are mostly right, but two gaps will surface in real use:
  - There is no state for "this run is completed and was real, but the branch it
    changed has since moved / been merged / been superseded." A parallel builder
    running many pieces will constantly have completed runs whose evidence is now
    stale relative to HEAD. Showing those as `review_ready` is misleading.
  - `proof_failed` and `risk` are listed as alternatives for the same triggers
    (failed check / verification / proof / relay) (`...proposal.md:233-236`),
    but they are different products: `proof_failed` means "the work claims done
    but objective checks failed"; `risk` should mean "the work may have touched
    something it should not have" (protected-file touch, undeclared extras,
    hidden index flags — all already in `runtime-evidence.ts`).

**Evidence (confirmed).** Runtime evidence already distinguishes these:
`worker_claim_matches_runtime`, `undeclared_worker_extras`, `hidden_index_flags`,
and `protected` per file (`runtime-evidence.ts:39-72`). The staleness machinery
also already exists conceptually in Circuit's continuity work (branch-gone /
head-reachable facts).

**Concrete correction.** (a) Add a `stale` (or reuse `needs_recovery` semantics)
attention state derived from a git-reachability check between the run's
`post_step_head` and current HEAD — deterministic, no model. (b) Define
`proof_failed` strictly from failed objective checks/verification/proof, and
`risk` strictly from runtime-evidence integrity violations (protected touch,
undeclared extras, hidden index, head divergence). They should never be
or-alternatives for the same trigger. This directly answers review question 9.

#### M3. Decision Request Contract risks re-deriving a view Capacitor already has

**Risk.** Slice 5 proposes a Circuit decision-request projection (title, summary,
choices, safe default, artifacts, risks, post-choice outcomes, response shape).
Capacitor *already* has review windows with "a manifest with summary, artifacts,
decision hints, and media artifact support"
(`capacitor-ux-second-opinion-proposal.md:147-149`, citing
`capacitor/docs/orchestrator/review-surfaces.md`).

**Inference.** If Capacitor's review-window manifest already covers
summary/artifacts/decision-hints, then a new Circuit decision projection must be
defined as *the source feed for that existing manifest*, not a parallel shape.
Otherwise this is duplicate-state Risk 6 again, at the decision layer. The
proposal says "Circuit should feed them" — good — but does not specify mapping
Circuit's projection onto Capacitor's existing manifest fields.

**Concrete correction.** Before building slice 5, map the proposed decision
fields onto Capacitor's existing review-window manifest fields one-to-one. If a
Circuit field has no home in the existing manifest, either the manifest grows or
the field is unnecessary. Answer review question 8 concretely: this should be a
*checkpoint-time report written into the run folder* (so it is durable and
inspectable like everything else), surfaced through `runs show`/`why`, **not** a
new top-level command — Capacitor reads it the same way it reads status.

#### M4. "History by code surface" (slice 8 / `--path`) is the weakest-grounded capability

**Risk.** The `--path` history lookup and `circuit why <file>:<line>` are
presented as natural extensions. But the current history index is lexical over
document text with flow/kind filters — it has no path-keyed index
(`history.ts:159-215`, confirmed: options are `--flow`, `--kind`, `--limit`,
`--per-run-limit`; no `--path`). A path lookup is not a filter tweak; it needs an
inverted index from code surface → runs that touched it.

**Evidence (confirmed).** `history pull` is `authority: 'hint_only'`
(`history.ts:418`) and cannot satisfy proof/route/recovery. So the path-keyed
answer is a *hint*, never authority — which is correct, but means it cannot back
any decision, only orient one.

**Inference.** The genuinely reliable path→run mapping is not in the history
text index at all; it is in runtime touched-files evidence (`files[].path` per
run). The honest first version of "what happened to this file" is a query over
*change provenance / runtime touched files*, not over history text. The proposal
half-acknowledges this ("the first version can query run folders and change
provenance by file path") but still frames it under `history query --path`.

**Concrete correction.** Re-home slice 8's first version onto change provenance
(slice 3 output) rather than the history text index. `circuit history query
--path` over lexical text will return noisy hints; a provenance-backed
"runs that touched this path" is deterministic. Keep this slice last (it is
correctly sequenced low) and depend it explicitly on slice 3 + the read model
(H3) — a path→run index is the textbook case for the derived DB.

---

### LOW

#### L1. Preview readiness `kind` enum may be too coarse for Capacitor's platform map

Capacitor's preview strategy enumerates web / static-docs / native-macOS / iOS /
Android / Electron / Tauri / CLI / artifact (`preview-work-strategy.md:115-125`),
each with different launch proof. The proposal's `kind: web | native_app | cli |
artifact` collapses several. This is fine for v1 *if* Circuit's job is only "is
there something inspectable and roughly what class," with Capacitor owning the
fine-grained platform launch. Recommend stating explicitly that `kind` is a
coarse hint and Capacitor refines it — otherwise the enum will get re-litigated.

#### L2. "Loaded skills" in provenance has thin grounding

The proposal lists "loaded skills" as a provenance field. Skill hooks are "hook
names only; config or policy maps them to concrete skills"
(`...proposal.md:74-76`). So at provenance time the resolved concrete skill may
or may not be recorded deterministically. Confirm a `skills.loaded` trace entry
actually carries resolved skills before promising this field; otherwise it is an
inferred, not confirmed, capability. (Folds into H2's "defer to @v2.")

#### L3. `runs list` sort-timestamp walk reads every file's mtime

Minor, but at scale the "newest file mtime under the run folder via recursive
walk" (`run-inspection-implementation.md:75-78`) is the per-refresh cost that H3
is about. Worth caching the sort timestamp into the run folder at close time so
`list` need not walk. Cheap now, painful to retrofit.

---

## Confirmed Facts vs Inference

**Confirmed by reading source (not taking the proposal's word):**
- `runs show` is the only implemented `runs` subcommand (`src/cli/runs.ts:40-90`).
- `runs list/events/why` are unbuilt; the implementation proposal is real and
  detailed (`run-inspection-implementation.md`).
- `history query` has no `--path`; options are flow/kind/limit/per-run-limit
  (`src/cli/history.ts:159-215`). `--path` is proposed, not shipped.
- `history pull` carries `authority: 'hint_only'` (`src/cli/history.ts:418`).
- `change-packet.ts` is enums + reason codes only — no runtime ChangePacket
  authority (`src/schemas/change-packet.ts:1-34`).
- Runtime touched-file evidence has all claimed fields and is refinement-checked
  (`src/schemas/runtime-evidence.ts:39-153`).
- Relay transcript binds request/result content hashes to `(step_id, attempt)`
  (`src/schemas/trace-entry.ts:336-413`).
- A derived-SQLite read model is already designed and recommended; `node:sqlite`
  is available in-runtime (`local-sqlite-read-model.md:284-297`).
- Capacitor's live docs treat Circuit as a headless protocol helper and build a
  parallel Work-Batch/Claim/Done/Preview-Session spine
  (`capacitor/docs/circuit/receipt-first-product-loop.md:8-19`,
  `capacitor/docs/circuit/preview-work-strategy.md:30-91`).

**Inference (reasoned, not directly verified):**
- That the parallel Capacitor spine and Circuit run folders will diverge under
  load (C1) — argued from the two docs, not from a running integration.
- That attention's `review_ready`/`proof_failed`/`risk` cannot be honestly
  emitted before slice 3 (H1/M1) — derived from what status vs. provenance carry.
- That `runs list` file-walks will become the latency bottleneck at parallel-
  builder scale (H3/L3) — extrapolated from access pattern, not measured at scale.
- That `--path` over the lexical index returns noisy hints vs. provenance-backed
  determinism (M4) — derived from index design, not benchmarked.

---

## Revised Build Order

The proposed order is *mostly* right. Two changes: resolve the integration
question first, and swap attention and change-provenance.

**Slice 0 (new, gating): Integration contract.** One page answering C1 — does
Capacitor run Circuit flows (run folders are the spine) or run bare CLI (Circuit
is a planner/normalizer)? Everything below assumes the former. If the answer is
the latter, this roadmap is a secondary surface and must be re-scoped. Do not
build slice 1 until this is decided.

**Slice 1: Finish Run Inspection** (`runs list/events/why`). Unchanged. Keep it
read-only, no liveness. Add L3 (cache sort timestamp at close) while you are in
the run-folder writer anyway. Define the projection functions behind a
source-of-truth interface so H3's read model can slot in later without contract
change.

**Slice 2: Change Provenance for Fix and Build** (was slice 3). Build the *narrow*
`change.provenance@v1` from H2 — fully populated by both flows, deferring the
wide fields to @v2. This is the data attention actually needs.

**Slice 3: Attention Projection** (was slice 2). Now it can honestly emit all
states: `decision_needed`/`invalid` from status, `proof_failed`/`risk` from `runs
why` failure events split per M2, `review_ready` from the runtime touched-files
report per M1, and a new `stale` state from git reachability per M2.

**Slice 4: Change Walkthrough.** Unchanged. JSON over provenance + proof + review
targets + risk. This is the first "magical" surface and it now sits on real data.

**Slice 5: Decision Projection.** Unchanged in position, but build it as a
checkpoint-time report in the run folder mapped onto Capacitor's *existing*
review-window manifest (M3), not a new command.

**Slice 6: Preview Readiness.** Unchanged. State `kind` is a coarse hint Capacitor
refines (L1).

**Slice 7: Safe Parallel Apply.** Unchanged, correctly last. This is where the
ChangePacket runtime authority that does not exist today (`change-packet.ts` is
enums only) actually gets built, gated on runtime diff evidence + final
verification, never on prose.

**Cross-cutting, triggered not scheduled: Local read model (H3).** Land the
source-of-truth interface in slice 1; promote the derived SQLite backing the
moment `runs list` latency on a real multi-project corpus crosses the named
threshold. `--path` history (the old slice 8) folds in here, re-homed onto
provenance per M4, as the first query that justifies the index.

---

## Direct Answers To The Review Questions

1. **Boundary right?** Yes in principle; no in practice until C1 is resolved. The
   Circuit/Git split is clean; the Circuit/Capacitor split is currently fiction
   because Capacitor built a parallel spine.
2. **Run inspection first?** Yes — but provenance, not attention, should be
   second (H1).
3. **Local read model understated?** Yes (H3). Make it an explicit triggered
   dependency, not a someday option.
4. **`change.provenance@v1` too broad?** Yes (H2). Ship the 7-field core both
   flows populate; defer the rest to @v2.
5. **Preview before provenance?** No. Preview readiness leaning on attention +
   provenance is exactly why it sits at slice 6; pulling it forward reintroduces
   "looks ready but lies" (proposal Risk 4).
6. **Facts defining `review_ready`?** Completed state + non-empty runtime-observed
   `files` + `worker_claim_matches_runtime == true` (M1). No model judgment.
7. **Safest "why this changed" without line-level?** File-level provenance keyed
   to runtime touched files + relay result hash + one typed-report reason string
   (H2 core). Hunk/line anchors wait for reliable git anchors.
8. **Decision projection — new command, part of show, or checkpoint report?**
   Checkpoint-time report in the run folder, surfaced via `runs show`/`why`,
   mapped to Capacitor's existing review manifest (M3).
9. **Right attention states?** Close. Split `proof_failed` (objective-check
   failure) from `risk` (runtime-evidence integrity violation), and add `stale`
   (M2).
10. **Highest dead-end risk?** The integration assumption (C1). A `change.
    provenance@v1` that no consumer reads — because Capacitor renders its own
    Work-Batch spine instead — is the abstraction most likely to be built, frozen
    with a `@v1` stamp, and then orphaned.
