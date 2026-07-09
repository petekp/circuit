# The Effective Memory Program

Status: active direction, partially implemented. The branch now has the
report-only memory substrate, earned-precision recall, pull logs, failure
legibility fixes, and local project facts. Broader automatic lesson capture and
measured value claims remain unproven.
Date: 2026-05-30
Updated: 2026-05-31 after an independent Codex second opinion
([`effective-memory-program-review-codex.md`](deprioritized-ledger.md))
and an assessment of that review. The review's critiques were verified correct
and are folded in below. The recommended shape is now the Canonical Lesson
Hybrid, and the original "capture relay findings" centerpiece is corrected: the
relay finding is a skipped duplicate, while the canonical review report is
already indexed. Two empirical claims in the original draft were wrong and are
fixed here.

This doc answers a different question than [`recall-to-lesson-gap.md`](deprioritized-ledger.md).
That doc asks "what is the cheapest fix for the recall miss." This one asks
"what is the MOST EFFECTIVE memory work for Circuit, regardless of effort." The
answers differ in kind, not degree. This program demotes the cheap plan's
load-bearing content (the outcome-distiller and the measurement loop) to
optional late refinements, and re-bases memory on a different unit, a different
feeder, and a different retrieval relation.

It extends the thesis in [`self-auditing-memory.md`](./self-auditing-memory.md)
but corrects its sequencing: the measurement ratchet is not the foundation, it
is the last gate, because it is structurally incapable of producing value until
the content path works and may never fire on Circuit's corpus.

Produced by a four-thesis design panel with adversarial scoring on effectiveness
(not cost), then revised against the Codex review. Every load-bearing code claim
below was checked against the repo.

## 1. The bet, in one paragraph

Re-base Circuit's memory on a reasoning-bearing lesson as the unit of capture
(`symptom`, `root_cause`, `fix`, `reasoning`, `scope`, `citations`), fed by the
instrument that actually catches the defects that matter (adversarial review,
whose canonical report Circuit already indexes but never distills into a
lesson), retrieved by `(project, flow, file)` scope rather than goal-lexical
similarity, and surfaced legibly at every reader. Demote the outcome-distiller to
a minor feeder for the genuinely-recurring-abort case it is good at, and demote
the measurement loop to a final scoreboard that either earns the ratchet its
keep or refutes it honestly.

The verdict is split, because the Codex review separated two judgments the
original draft conflated. Codex's critiques are verified correct: the
relay-deletion premise was the wrong target, review schemas vary per flow, the
write-side citation adapter is lossy, and the `score > 0` gate is irrelevant to
the project-fact push path. Adopt those. But the Hybrid's net-new construction
(turning an indexed review report into a reasoning-bearing lesson) is unproven on
today's corpus, so treat it as a hypothesis to validate, not a settled plan. The
unambiguous first work is Phase 0 legibility plus the two-vocabulary
reconciliation, which depend on none of the contested construction.

## 2. Why this is the most effective work, not the cheapest

The cheap plan wires more producers into a verdict engine that had not yet
produced a verdict. Verified state of the ratchet when this note was written:
exactly one `run-envelope.json` in the whole repo, zero
`memory-effect.v1.json` ever written, `distillProjectFacts` with zero non-test
callers, a 2-run cluster threshold thin projects rarely hit, and
`classifyEffect` gated at `DEFAULT_MIN_ARM_SIZE = 2` that nothing had ever fed.
Building on that compounds faith.

The value this session's debugging delivered came from reasoning written down
where the next reader looks (design notes, code comments, legible diagnostics).
That is corpus-independent, it helps the first run, and it is the only thing that
touches the blind class. The effective program invests there.

Two different bugs, which the cheap plan conflates, get separated here:

- The recurring-outcome miss was a RETRIEVAL failure. The fix text was present in
  typed fields and is retrievable by a symptom-worded query; run-start just
  queries the goal, so the goal-echo envelope wins the single slot. Phase 1
  fixes the retrieval relation.
- The silent and architectural defects are a CURATION failure. The instrument
  that sees them (adversarial review) runs already and its canonical report is
  indexed, but nothing distills that report into a reusable lesson. Phase 2 fixes
  curation.

## 3. The sharpest finding: Circuit indexes the review report but never turns it into a lesson

Circuit's execution memory is keyed on typed run outcomes, so it is blind to
silent quality defects (which pass every gate) and architectural mismatches
(which are not events in any run). The two defects that mattered this session
were exactly that class, found by code reading.

But Circuit already runs the instrument that does see that class: an adversarial
review pass. The original draft of this doc claimed the review findings are
written to `reports/relay/` and deleted at `extract.ts:410`. That is wrong, and
the correction reshapes Phase 2. The real picture, verified per flow:

- Build writes a canonical review report to `reports/build/review.json` (a
  `BuildReview` with a `findings[]` array) AND a relay duplicate to
  `reports/relay/build-review.result.json`. The indexer skips `reports/relay/`
  (`extract.ts:410`), so only the relay duplicate is dropped; the canonical
  `reports/build/review.json` IS indexed. The circuit-land corpus confirms it: a
  `reports/build/review.json` report doc is present in `documents.v1.jsonl`.
- The exact `ReviewFinding{severity, id, text, file_refs}` shape exists only in
  the Review flow (`review/reports.ts`), whose relay result is written to
  `stages/analyze/review-raw-findings.json`, not `reports/relay/`. Build, Fix,
  and Pursue findings carry `severity`, `text`, `file_refs` but no `id`. Explore
  and Prototype do not use finding lists at all.

So the signal is not deleted. It is captured-but-not-distilled: the canonical
review report is indexed and searchable, but nothing turns it into a
reasoning-bearing lesson keyed to a file or flow, and the only distiller that
exists (`project-distill.ts`) mines recurring `step.aborted` reasons, not review
findings.

This makes canonical-report capture net-new and, on today's corpus, unproven. The
only canonical review indexed in circuit-land is a findings-free `accept` (its
facets are `flow:build`, `kind:report`, `outcome:complete`, with no findings), so
the capture path has never been shown to produce a useful lesson unit. Capturing
it is still the right direction (it is the instrument that catches the blind
class), but it is a hypothesis to validate, not a free win. Phase 2 is gated on
that validation.

## 4. The program, sequenced by dependency

Ordering law: nothing can be ranked before it can be retrieved; nothing
retrieved before it is captured; nothing measured before it is consumed.
Legibility sits first because it has zero upstream dependency and is what
actually delivered value.

### Phase 0: Legibility (no dependency, the proven floor)

Make every reader surface lead with cause and remedy, in the same words, at the
three places the failure repeated this session:

- `source-record.ts` run-close `next_action` (~line 579): replace the generic
  "Inspect the process evidence and rerun with a corrected goal" with the typed
  cause (completion-gate gap or abort reason) plus a remediation line.
- `memory-preview.ts` `hintText()`: lead with the diagnostic summary, never
  `hit.snippet` (the goal-echo window that buries the gap).
- `extract.ts` `makeRunDocument`: a failure document's `summary` must be the
  diagnostic (`reason` / `gap`), redacted to typed fields, not "Run closed with
  outcome aborted."
- The orchestrator-facing `run.md` surface: lead with cause and remedy.

Pair this with the two-vocabulary reconciliation: a single `isFailureOutcome`
predicate (`aborted | failed | blocked`) used by `buildFacets`, the distiller,
and any failure-aware ranker, so the run recorded as `aborted` in the trace and
`failed` in the envelope is treated as one failure class everywhere.

Metric: on the circuit-land corpus, the run-close surface and the recall hint
both name the missing-check-script cause and a remediation, with zero
occurrences of the generic "rerun" string on a run that has a typed gap. Binary,
provable today.

### Phase 1: Relevance-native retrieval (depends on nothing in code)

Add a lesson retrieval mode in `query.ts`. Given `(repoRoot, flowId)`, select
failure-faceted documents and rank by `freshness(hash re-verified) >
recency(recorded_at desc) > lexical-affinity(tie-breaker)`. Stop passing
`perRunLimit: 1` for lessons (`run-start-recall.ts:84`) so one goal-echo doc
cannot crowd out the failure doc.

A scope nuance the Codex review surfaced: the project-fact push path
(`loadProjectFactCandidates`, fed straight to `applyEarnedPrecision` at
`run-start-recall.ts:105-115`) already bypasses the `score > 0` gate, so a
scope-matched lesson stored as a project fact is injected regardless of lexical
overlap with no gate change needed. The `score > 0` gate (`query.ts:306`) only
binds the recall and pull query path. So removing or relaxing the gate matters
only for the pull path (Phase 3), not for pushed lessons. Do not present
gate-removal as load-bearing for the lesson push.

This lifts the recursion floor from "run N that hits the cluster threshold" to
run 2, the theoretical minimum. Scope plus recency is gated on neither a 2-run
cluster nor a min-arm size, so one prior hash-verified failure in
`(project, flow)` ranks first on the very next run, and recency makes the thin
cold corpus a feature (newest failure is most relevant).

Risk and guard: recency-without-recurrence can resurface an already-fixed one-off
as a distractor. Hash re-verification and recency age-out are proxies for "source
bytes moved," not "condition resolved." Carry an operator or agent resolve marker
on a lesson, and age a lesson out when the flow's newest run in this repo no
longer carries that failure facet. Do not trust recency alone.

Experiment captured against the live circuit-land corpus: confirm the baseline goal query at
`--per-run-limit 1` returns only the goal-echo `run-envelope.json` docs (summary
"Run closed with outcome aborted"), and that a symptom-worded query already
retrieves the gap-bearing `step.aborted` trace docs (it returns three results
topped by the then-current missing-script reason, which is why the bottleneck is
relation and curation, not reach). Then confirm the new failure-aware ranker
surfaces the gap-bearing doc as rank 1 under the goal query too, and under a
synthetic build run with a deliberately different goal ("add a pricing section").
If the lesson surfaces under a non-overlapping goal and the baseline does not,
the relation is fixed.

### Phase 2: Reasoning-bearing capture from canonical review reports (depends on Phase 1)

Gate this phase on a prerequisite, because it is unproven (section 3): first
capture one findings-bearing review (a `reject` or `accept-with-fixes` run,
whose canonical report carries a non-empty `findings[]`) and show it distills
into a useful, cited, redacted lesson. Only then build the rest.

- Add a `LessonV1` record (or extend `MemoryInputV0`) carrying `{symptom,
  root_cause, fix, reasoning, scope:(project, flow, file_refs), citations[]}`,
  all hint-only, cited, hash-verified. `fix` and `reasoning` are authored prose
  from the diagnosing agent or a code-owned remediation constant, never mined
  raw, preserving the `NOISY_FIELDS` redaction.
- Capture the CANONICAL review reports (`reports/<flow>/review.json`), which are
  already indexed, not the skipped relay duplicate. Add a small relay allowlist
  only where a flow's canonical report lacks the needed finding detail, and
  schema-probe each flow first.
- Normalize the per-flow review schemas, which are heterogeneous: synthesize a
  stable finding id where a flow lacks one (Build, Fix, Pursue), and restrict v1
  to the flows whose schema you can prove.
- Build `review-capture-write-back.ts`: at run close, read the run's canonical
  review report and write a `(project, flow, file_refs)`-scoped cited lesson per
  non-low finding. A single critical finding is signal, so no cluster threshold.
- Preserve citations on write-back. The persisted fact (`MemoryInputV0`) carries
  a singular `source` plus `staleness`, and `appendProjectFact`
  (`project-store.ts`) preserves it, so persist the lesson through that path. Do
  NOT route a rich event through the envelope's `memoryUpdates` adapter:
  `memoryUpdateEvents` (`source-record.ts:489-509`) overwrites `source_refs` to
  `[processEvidence.ref]` and drops staleness, so the audit event would record a
  misleading citation. If the envelope audit event must carry the real citation,
  widen that adapter to pass `source_refs` and `staleness` through.
- Add an agent-authored feeder: a `circuit lesson capture` path the orchestrator
  calls when it diagnoses a silent or non-recurring defect. This is the path that
  would have caught this session's two real bugs.
- Build file-scoped injection. `readProjectFacts` filters by `flow_id` only
  (`project-store.ts:118`, by D6 design). The signature feature, "a finding about
  file X resurfaces when a future run touches file X," requires net-new injection
  logic and should be a named slice, not a footnote.

This severs value from corpus recurrence: the first review creates a lesson the
first subsequent run consumes. No cluster, no arm size, no verdict.

Risk and guard: agent-authored prose is unverifiable in the way a cited typed gap
is not. Hashing protects against the cited source drifting, not against a
confidently-wrong fix cited to a real, unchanged trace. Mitigation: every lesson
is hint-only and cited so the reader re-verifies; reject any lesson with no
grounding citation; carry the Phase 1 resolve marker; and let the Phase 4 effect
loop eventually demote lessons that correlate with worse runs. Residual risk is
authoring discipline and prose trust, and the experiment must measure it.

### Phase 3: Agentic pull surface (depends on Phase 2 and Phase 1)

The `pull` subcommand already exists and writes a pull log (`history.ts`
`runPull` + `appendPullLogEntry`). The work is to extend it, not build it: mirror
it dual-host into a "Circuit Lessons Ask" (a Claude command and a Codex skill, as
run and handoff are), scoped to `(project, flow)` plus an optional topic, and
keep recording each consumed lesson in the pull log. That log is the
consumption-event substrate Phase 4 needs.

Honest bound on pull, retracting an earlier overclaim: pull is useful but not a
near-free win. Run-start auto-queries the goal, and the failure-facet boost
(`query.ts:122`) only fires when the query string itself contains failure words,
which the agent does not have at run start (the failure has not happened yet). So
a symptom-worded query retrieves the lesson only once the agent already suspects
the symptom (mid-run, or on a re-run after seeing a related error); a generic
run-start failure query is low-precision; and the `score > 0` gate still governs
this path. Pull complements the pushed lessons (Phase 2) for the
agent-already-suspects case, it does not replace them.

### Phase 4: Measurement as scoreboard and falsification instrument (depends on all above)

Auto-emit `buildMemoryMergeReport` then `buildMemoryEffectReport` at run close
(the planned `memory-reports-byproduct.ts` wired into `emitPostRunArtifacts`).
Then add an ablation harness (`circuit history ablate`) that forces
`memory_context.used` true/false across N paired runs against a fixed fixture,
manufacturing the comparable runs the verdict needs. Upgrade `classifyEffect`
from binary `complete_rate`/`adverse_rate` to also derive continuous
elapsed-to-complete and attempts-to-complete from
`RunProcessAttempt.started_at`/`completed_at`, which can register direction from
far fewer paired observations than a 0/1 rate clearing margin 0.5. Ship a
falsification report: given the corpus, print whether any cohort ever reached a
non-`not_enough_data` verdict, with cohort count and median arm size.

This is last because it depends on lessons existing, being retrievable, and being
consumed. It is a scoreboard, not a gate: earned-precision suppression stays
wired and fails open until a real verdict exists, and nothing waits on it. The
harness either produces Circuit's first real verdict on deliberately favorable
paired runs, or it reads `not_enough_data` forever on a fully populated favorable
corpus, which is a decisive, reportable refutation of measured push-memory and
tells us to live on Phases 0 to 3. Either result is worth having.

Goodhart guard: a green harness is a floor (the mechanism can discriminate), not
proof of field value. Report harness verdict and real-run flow-contrasts side by
side so a harness-only green never masquerades as proven field value.

## 5. What this drops or demotes

- The outcome-distiller as a primary feeder: kept only for genuinely recurring
  aborts, wired late. Not load-bearing.
- Goal-lexical BM25 as the lesson ranker: verified wrong-relation for the recall
  path. It ranks the goal-echo envelope above the failure doc, and the
  `score > 0` gate drops a query that shares no terms with a doc. (Pushed project
  facts bypass this path entirely, so the wrong relation only bites the recall
  and pull queries.)
- The measurement loop as a precondition: moved to the end as a scoreboard, never
  a gate.
- Embeddings: the relation that matters is categorical scope membership, not
  semantic similarity. Embeddings re-encode the same wrong goal-to-document
  relation more expensively and lose the hash-verified provenance the system
  depends on.

## 6. How the program confronts the verified constraints

- Blind class (silent and architectural defects): routed to canonical review
  capture (Phase 2) and the agent-authored lesson path, the instruments that
  actually see them. The outcome store is not contorted to catch them; it stays
  in its lane for recurring aborts.
- Recursion floor (the first run has no prior): scope plus recency (Phase 1)
  clears the floor to run 2, and single-finding capture (Phase 2) fires on run 1.
- Thin and non-recurring corpus (the existential risk): scope plus recency needs
  no recurrence, single-finding capture needs no cluster, and the Phase 4 ablation
  harness manufactures comparable runs or proves they cannot exist.
- Unvalidated keystone: measurement is demoted to a falsification instrument that
  gates nothing, so no work rests on a verdict that may never come.

## 7. Open decisions for the operator

- The verdict is split, so the decision is sequenced, not binary. Phase 0
  legibility plus the two-vocabulary reconciliation are unambiguous and depend on
  no contested construction; ship them first. The kind-change (the
  reasoning-bearing lesson unit fed by review capture) is the bet to validate at
  the Phase 2 prerequisite before committing the rest.
- Prose-trust posture: how much to trust agent-authored `fix`/`reasoning` before
  the Phase 4 effect loop can demote bad lessons. Recommended: propose-only first
  (hint-only and cited, but not auto-recorded) except for code-owned deterministic
  remediation constants.
- Whether to fund the ablation harness (Phase 4) at all, or accept Phases 0 to 3
  as the program and treat the ratchet as an explicit non-goal until a corpus
  justifies it.

## 8. File sites this program touches

`src/app/history/extract.ts` (`buildFacets`, `makeRunDocument` summary, and the
`reports/relay/` skip at line 410 which drops only the relay duplicate, not the
canonical review report), `src/app/history/query.ts` (lesson retrieval mode, the
`score > 0` gate at line 306, the failure-facet boost at line 122),
`src/app/history/run-start-recall.ts` (`perRunLimit: 1` at line 84, the
project-fact push that bypasses the gate at lines 105-115),
`src/app/history/memory-preview.ts` (`hintText`),
`src/app/run-envelope/source-record.ts` (run-close `next_action` ~line 579, the
lossy `memoryUpdates` adapter at lines 489-509, `memory_context` ~line 650),
`src/memory/project-store.ts` (flow-only filter at line 118, add file scope;
`appendProjectFact` which preserves the singular cited `source`),
`src/memory/project-injection.ts`, `src/memory/project-distill.ts` (demoted
feeder, `isFailureOutcome`), the per-flow review schemas
(`src/flows/{build,fix,pursue,review}/reports.ts`, which vary and need id
normalization), new `src/memory/review-capture-write-back.ts`, new `LessonV1` in
`src/schemas/`, `src/cli/history.ts` (extend the existing `pull` subcommand),
`src/cli/post-run-artifacts.ts` (auto-emit), `src/app/history/memory-effect.ts`
(continuous signals), and a new `circuit history ablate` under `src/cli/`.
