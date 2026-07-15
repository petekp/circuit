# Flow wiring audit: blind-retry bug class across all flows (main @ 4802cb0c)

Date: 2026-07-15 (overnight). Method: static read-only audit by a dedicated
agent, prompted after a live Codex session found that Fix rework retries
never see the reviewer's findings. STATIC-CONFIRMED rows need no runtime
check because the engine has no hidden channel that could deliver the
missing evidence. Remediation status at time of writing: a patch for the
fix-flow faults exists on branch `pkp/fix-review-feedback` (not yet on
main); everything else is unremediated.

Read-only audit of the main checkout (branch `main`). The fix branch
`pkp/fix-review-feedback` was NOT audited. All 13 catalog flows examined
(`src/flows/catalog.ts:31-45`): review, fix, pursue, runtime-proof, converge-proof,
fix-until-green, sweep, cross-tool-build, prototype, build, explore, goal, explainer.
Every flow has a `schematic.json`; the compiled `reads` list (what a worker's prompt
inlines) derives strictly from declared `input` contracts.

## Engine facts — what actually reaches a retried worker (settles every verdict)

These are the load-bearing mechanics. They make most findings STATIC-CONFIRMED rather
than needs-runtime-check, because there is no hidden channel that could rescue a
missing declared input.

1. **Prompt context = declared inputs only.**
   `src/flows/compile-schematic-to-flow.ts:186-210` (`computeReads`): a step's `reads`
   are exactly the report paths of its declared `input` contracts (plus one carve-out:
   an until-loop's `carried_notes` file is injected into the loop HEAD step's reads,
   lines 216-223 and 647-660). `src/runtime/run/relay-support.ts:434-443,507-509`
   (`composeRelayPrompt`): the worker prompt inlines `step.reads` files verbatim and
   nothing else from the run folder.

2. **A generic retry-feedback channel EXISTS but is narrow: acceptance-criteria
   failures, same-step retries only.**
   - `src/runtime/executors/relay.ts:960-988`: only an `acceptance_criteria` failure
     with `on_failure.mode: 'retry-with-feedback'` attaches `acceptance_feedback` to
     the route outcome, and the engine *requires* the retry route to re-enter the SAME
     step (throws otherwise, lines 969-973).
   - `src/runtime/run/recovery-corridor.ts:97-104` (`acceptanceFeedbackForReentry`):
     feedback is surfaced only when the re-entered step IS the corridor origin.
   - `src/runtime/run/graph-runner.ts:1091-1109`: that feedback lands on `RunContext`
     and renders as the "Acceptance Criteria Feedback:" prompt section
     (`relay-support.ts:272-293,450,515`).
   - Consequence: **cross-step retries never carry failure feedback**, and even
     same-step retries triggered by a failed *check* (verdict outside `check.pass`)
     carry nothing — `relay.ts:992-1000` and `verification.ts:437-446` attach only a
     `details.reason` string, which goes to the trace, never to a prompt.

3. **Failed checks route via recovery selection with no payload.**
   `src/runtime/run/recovery-selection.ts:8-15`: fallback order is
   `retry > revise > ask > stop > handoff > escalate`. A reviewer's rejecting verdict
   (outside `check.pass`) is a `failed_check` → takes `routes.retry` → target step
   runs a FRESH worker (subprocess connector, no session carry-over) with only its
   declared reads.

4. **Rework reports ARE on disk — they just don't reach the prompt.**
   `src/runtime/executors/relay.ts:744-750`: a schema-valid body with a rework verdict
   (e.g. review `reject`) is still written to its report path. So every blind edge
   below is a wiring omission, not missing data. (The run-folder path appears in the
   prompt only inside the `circuit history pull` affordance line; nothing directs a
   worker to failure evidence.)

5. **Retry budgets are shared per step, not per failure source.**
   `src/runtime/run/graph-runner.ts:256-265` (`maxAttemptsForRoute`: default 2
   completions for a recovery re-entry) and `:974-1005` (`completedStepCounts` keyed by
   step id + slice/iteration). Every upstream verifier/reviewer that retries into the
   same act step draws from that one budget.

6. **Compose steps are deterministic engine-side writers** (registered builders,
   `src/runtime/executors/compose.ts:43-109`; throws if no builder). A compose step
   re-entered without new inputs rebuilds ~the same report, so a blind revise into a
   compose step re-rolls a deterministic function.

7. **Until-loops carry evidence across iterations ONLY via `carried_notes`**
   (judge lesson + engine steers, appended at `graph-runner.ts:1440-1462`, gated on the
   flag being declared; injected into the head step's reads at compile). The evidence
   floor (`graph-runner.ts:501-505`) lets the ENGINE veto a false `goal_met: true`
   against trace proof, but it feeds nothing into any prompt.

## Main table — rework edges (S → T): does S's evidence reach T?

Verdicts: **NO (STATIC)** = wiring provably omits it (declared inputs quoted from the
schematic); **YES** = declared input or engine channel delivers it; **PARTIAL** =
some channel exists but not the report itself. Severity considers flow visibility
(public vs internal) and cost of the blind step.

### fix (public) — the reported bug class, confirmed on main

| flow | edge (S→T) | evidence artifact | reaches retry? | severity | notes |
|---|---|---|---|---|---|
| fix | fix-review --retry/revise--> fix-act | fix.review@v1 (reports/fix/review.json) | **NO (STATIC)** | **critical** | fix-act inputs = brief+diagnosis only (`src/flows/fix/schematic.json:298-302`); review routes `:485-492`. The reported bug. Report IS written on reject. |
| fix | fix-verify --retry--> fix-act | fix.verification@v1 | **NO (STATIC)** | **high** | Failing verification report (commands, exit codes) never reaches the re-run implementer. |
| fix | fix-change-set --retry--> fix-act | fix.change-set@v1 | **NO (STATIC)** | **high** | Bookkeeping check (declared vs observed files) fails → blind retry of fix-act; see burn section (fault 2). |
| fix | fix-regression-rerun --retry--> fix-act | fix.regression-rerun@v1 | **NO (STATIC)** | **high** | Regression-still-red evidence invisible to the retry. |
| fix | fix-diagnose --retry--> fix-gather-context | fix.diagnosis@v1 | **NO (STATIC)** | medium | Researcher re-gathers context without the diagnosis that judged it insufficient. |
| fix | fix-regression-baseline --retry--> fix-frame | fix.regression-proof@v1 | **NO (STATIC)** | medium | Frame re-composes brief without the baseline failure (compose builder; deterministic re-roll risk). |
| fix | fix-act --retry--> fix-act [same] | acceptance feedback | **YES** (acceptance channel) | ok | The one working feedback path: `retry-with-feedback` (`schematic.json:339-363`). Only for acceptance-criteria failures, not failed checks. |
| fix | fix-gather-context --retry--> [same] | (own failed check) | **NO** — blind re-roll | low | Identical prompt, fresh worker; failed-check same-step retries carry no reason. |

### build (public) — same class, act step is the expensive target

| flow | edge (S→T) | evidence artifact | reaches retry? | severity | notes |
|---|---|---|---|---|---|
| build | review-step --retry/revise--> act-step | build.review@v1 | **NO (STATIC)** | **critical** | act-step inputs = brief+plan only (`src/flows/build/schematic.json:206-210`); review routes `:355-356`. Identical to the Fix bug, in the flagship public flow. |
| build | verify-step --retry--> act-step | build.verification@v1 | **NO (STATIC)** | **high** | `schematic.json:285`. Failing build/test output invisible to the re-run implementer. |
| build | analyze-step --retry--> [same] | (own failed check) | NO — blind re-roll | low | `:126`. |
| build | plan-step --revise--> [same] | (own failed check) | NO — deterministic re-roll | low | Compose builder rebuilds from same inputs; a schema-shaped failure repeats identically until budget aborts. |
| build | verify-step --advance--> act-step | (slice loop) | n/a | ok | `iterates_slice_loop` advance = next slice after PASS, not a retry. |

### pursue (internal) — same class

| flow | edge (S→T) | evidence artifact | reaches retry? | severity | notes |
|---|---|---|---|---|---|
| pursue | review-step --retry--> batch-step | pursuit.review@v1 | **NO (STATIC)** | **high** | batch-step inputs = queue+brief+plan (`src/flows/pursue/schematic.json:145-149`); review route `:241`. |
| pursue | verify-step --retry--> batch-step | pursuit.verification@v1 | **NO (STATIC)** | **high** | `:204`. |
| pursue | batch-step --retry--> [same] | (own failed check) | NO — blind re-roll | low | No acceptance criteria on batch-step. |

### cross-tool-build (internal)

| flow | edge (S→T) | evidence artifact | reaches retry? | severity | notes |
|---|---|---|---|---|---|
| cross-tool-build | verify-step --retry--> implement-step | cross-tool-build.verification@v1 | **NO (STATIC)** | **high** | implement inputs = brief+spec+spec_review (`src/flows/cross-tool-build/schematic.json:217-221`); route `:267`. Cross-connector retry (Codex doer) re-launched blind. |
| cross-tool-build | implement/propose/spec/review-* --retry--> [same] | (own failed check) | NO — blind re-roll | low | Five same-step retries, none with acceptance feedback. |
| cross-tool-build | review-proposal / review-spec `revise` verdict | proposal-review / spec-review | **YES** | ok | `revise` is in `check.pass`; flow moves FORWARD and the next step declares the review as input (`:146-151`, `:217-221`). Sound design: rework-with-evidence, not blind retry. |

### explore (public) — contains the CORRECT exemplar and one blind edge

| flow | edge (S→T) | evidence artifact | reaches retry? | severity | notes |
|---|---|---|---|---|---|
| explore | review-step --retry/revise--> synthesize-step | explore.review-verdict@v1 | **YES (STATIC)** | ok — exemplar | synthesize-step declares `review: explore.review-verdict@v1` in `input` with `optional_inputs: ["review"]` — absent file renders `[reads unavailable]` on pass 1, the verdict on rework. This is the pattern the whole codebase should follow. |
| explore | stress-proposals-step --revise--> decision-options-step | explore.tournament-review@v1 | **NO (STATIC)** | **high** | decision-options builder reads brief+analysis only (`src/flows/explore/writers/decision-options.ts:16-19`). Deterministic builder re-emits ~same options, then the full proposal FANOUT re-runs on unchanged inputs — expensive tournament loop that cannot converge. |
| explore | synthesize-step --retry--> [same] | (own failed check) | NO — blind re-roll | low | |

### review / prototype / runtime-proof / goal / explainer

| flow | edge (S→T) | evidence artifact | reaches retry? | severity | notes |
|---|---|---|---|---|---|
| review | audit-step --retry--> [same] | (own failed check) | NO — blind re-roll | low | Only rework edge in the flow; malformed-verdict retry gets an identical prompt. |
| prototype | (none) | — | n/a | ok | No retry routes; failures route `stop` → close gracefully. |
| runtime-proof | (none) | — | n/a | ok | Linear proof flow. |
| goal | goal-evidence-evaluation → goal-recovery → goal-recovery-checkpoint | evaluation/recovery reports | **YES** | ok | Each hop declares the prior report as input. |
| goal | goal-recovery-checkpoint --continue--> goal-close | (recovery selection) | — | medium (different class) | ALL non-blocked checkpoint choices route to goal-close (`schematic` routes `{continue: goal-close, blocked: goal-close}`); the `retry-selected-flow` / `run-fix` recovery options can never actually re-run a child flow. Recovery is decided, recorded, then the run just closes. |
| explainer | build-step --stop--> retry-gate-step --continue--> build-step | explainer.build-result@v1 | **NO (STATIC)** | medium (internal) | retry-gate checkpoint inputs = spec + tournament-aggregate, NOT the failed build result; the re-entered sub-run gets `contract: explainer.spec@v1` only. Operator approves a retry they can't see the failure of, and the retry re-runs blind. |
| explainer | verify-step --retry--> [same] | (own failed check) | NO — deterministic re-roll | low | Re-runs the same verification commands; can only help for flakes. |

### Until-loop flows (loop-body class, section d)

| flow | edge (S→T) | evidence artifact | reaches retry? | severity | notes |
|---|---|---|---|---|---|
| fix-until-green | judge-step --advance--> act-step (next iteration) | converge.judgment@v1 lesson | **PARTIAL** (carried notes) | medium | `carried_notes` declared; engine appends the judge's lesson (≤600 chars) + steers to `reports/fix-until-green/carried-notes.json`, compiled into act-step's reads. The lesson reaches iteration N+1 — but see the judge-blindness finding below: the lesson is authored without evidence. The verification REPORT itself never carries over. |
| sweep | judge-step --advance--> partition-step (next iteration) | converge.judgment@v1 lesson | **PARTIAL** (carried notes) | medium | Same as fix-until-green. Rescan report does not carry over. |
| converge-proof | judge-step --advance--> head-step (next iteration) | converge.judgment@v1 (lesson) | **NO (STATIC)** | **high** (internal) | NO `carried_notes` in `engine_flags` (`src/flows/converge-proof/schematic.json`), and head-step's only input is the initial brief → iteration N+1's planner prompt is byte-identical to iteration N's. The judge's lesson is computed, schema-required ("lesson is carried verbatim into the next attempt" per the shape hint), then discarded. The loop REPEATS, it does not LEARN — contradicting the flow's own judge prompt. |

## Adjacent class (a) — judges/reviewers whose inputs omit what they judge

| flow | step | missing artifact | evidence | severity |
|---|---|---|---|---|
| fix-until-green | judge-step (decides `goal_met`) | fix-until-green.verification@v1 | judge input = `{brief}` only (`src/flows/fix-until-green/schematic.json:114-121`); brief is an initial contract → compiled reads = []. Its own shape hint orders: "set goal_met true ONLY when ... the verification you can see actually backs it" (`src/flows/fix-until-green/relay-hints.ts:32`) — but the wiring delivers NO verification. Judge must re-derive everything with its own tools. Engine floor (`graph-runner.ts:501-505`) can veto a false `goal_met: true` from trace proof, but cannot fix a wrong lesson or a wrong `goal_met: false`. | **high** |
| sweep | judge-step (decides backlog clear) | sweep.verification@v1 (rescan), sweep.wave-aggregate@v1 | judge input = `{brief}` only (`src/flows/sweep/schematic.json:176-183`). Judges "backlog clear" without the rescan report or the wave results. | **high** |
| converge-proof | judge-step | change.evidence@v1 (work-step result) | judge input = `{brief}` only. No verification step exists in this flow at all; goal_met stands on the judge alone (acknowledged in `graph-runner.ts:495-496`). | high (internal proof flow) |
| fix | fix-review | fix.change-set@v1 (git-computed ground truth), fix.regression-rerun@v1 | reviewer inputs = brief + change (implementer SELF-report) + verification (`src/flows/fix/schematic.json:467-471`). The computed change-set — built precisely to catch self-report overclaim — routes only to fix-close. Reviewer audits the claim, not the diff. (Known seam: "changed_files self-report can overclaim".) | medium |
| build | review-step | — | build's reviewer DOES get verification + touch-area + implementation (`build/schematic.json:333-339`) — the good counter-example for reviewers. | ok |
| goal | goal-attempt / goal-evidence-evaluation | goal.child-*-result@v1 not in schematic inputs | Mitigated: the attempt compose builder hard-codes the child result paths and reads them directly (`src/flows/goal/writers/attempt.ts:8-12,36-44`). Consumed engine-side despite the undeclared input — wiring-hygiene note only. | low |

## Adjacent class (b) — dead evidence (produced, no consumer)

Filtered: terminal `*.result@v1` reports are engine-consumed (primary result), checkpoint
responses are engine-recorded, and the until-judgment reports are engine-read
(`stop_judge`). What remains genuinely unread by any step OR engine channel:

| flow | artifact | producer | note |
|---|---|---|---|
| fix-until-green | fix-until-green.verification@v1 | verify-step | No step consumes it; judge doesn't see it; only the trace-level proof floor reflects its outcome. The loop's only typed report is written and never read as content. |
| sweep | sweep.verification@v1 (rescan), sweep.wave-aggregate@v1 | rescan-step, fanout-step | Same pattern: judge and next iteration never see rescan findings or per-wave outcomes. |
| converge-proof | change.evidence@v1 | work-step | Judge never sees what the worker did. |
| explainer | explainer.selection@v1 (pick checkpoint) | pick-checkpoint-step | No report path (`writes` has none); spec-step inputs omit it — the operator's tournament pick reaches spec-step only if the compose builder reads the checkpoint response file. NEEDS-RUNTIME-CHECK (internal flow). |
| fix | fix.no-repro-decision@v1 | fix-no-repro-decision | Decision recorded; fix-act re-entered via `continue` does not receive it (fix-act inputs unchanged). Low: checkpoint's purpose is authority, not context. |

## Adjacent class (c) — retry-budget burn (bookkeeping failures spending act budgets)

Engine basis: one completion count per step (`graph-runner.ts:974-976`), default cap 2
for recovery re-entries (`:261`). All of the following share the act step's budget:

1. **fix (STATIC-CONFIRMED, the second reported fault).** fix-act's report
   `reports/fix/change.json` is overwritten per attempt (`writes.report_path` is a
   fixed path; the run-file store keeps no per-attempt copies). fix-change-set then
   computes `observed` = git diff vs baseline and fails on `undeclared_extras`
   (`src/flows/fix/writers/change-set.ts:5-15`). On fix-act attempt 2, files changed in
   attempt 1 remain observed-dirty but are no longer declared → forced `status: fail`
   → `retry: fix-act` → burns the shared 2-attempt budget on clean files, blind
   (change-set report not in fix-act's inputs). Bookkeeping failure is
   indistinguishable from a real failure to the budget.
2. **fix:** fix-verify, fix-change-set, fix-regression-rerun, and fix-review ALL retry
   into fix-act — four failure sources, one 2-completion budget. Two cheap bookkeeping
   trips exhaust the act step and abort the run
   (`route 'retry' for step ... exhausted max_attempts=2`, `graph-runner.ts:1001-1005`).
3. **build:** verify-step and review-step share act-step's budget (2 sources). Lower
   risk than fix: build-touch-area (the analogous accounting check) compares observed
   changes against the PLAN's allowed area, not the self-report
   (`src/flows/build/writers/touch-area.ts:50-53`: self-report is "best-effort
   corroboration, not required") — immune to the attempt-overwrite fault. But
   build-touch-area declares NO retry/revise route (`routes: {continue, stop}`), so
   fallback recovery picks `stop`: a containment bookkeeping failure hard-stops the
   whole run instead of routing anywhere.
4. **pursue:** verify-step and review-step share batch-step's budget (2 sources).
5. **Schema-shape burn (all relay steps):** an unparseable/wrong-verdict body is a
   `failed_check` exactly like a substantive rejection (`relay-support.ts:37-69`) and
   spends the same budget with zero feedback. Cross-tool-build is most exposed
   (6 same-step retry routes, zero acceptance criteria, cross-connector workers).

## Adjacent class (d) — loop iteration blindness (summary)

- **converge-proof: iteration N+1 sees NOTHING from iteration N** (no carried notes, no
  input wiring, judge reads nothing). max_iterations=3 of identical prompts.
  STATIC-CONFIRMED.
- **fix-until-green / sweep: lesson-only carry.** The 600-char judge lesson is the sole
  cross-iteration channel, and the judge writes it without seeing the verification /
  rescan evidence. The in-iteration failure evidence (which command failed, what the
  rescan found) never reaches the next pass directly.
- Body-step retry exhaustion inside an until loop correctly latches an overclaim and
  re-enters a fresh iteration (`graph-runner.ts:1007-1046`) — but the fresh iteration's
  prompt carries no trace of WHY the previous one exhausted unless carried notes exist
  and the judge ran (a body step that exhausts before the tail writes no lesson; the
  engine appends carried notes only at the tail, `graph-runner.ts:1438-1462`).

## Correct exemplars on main (the fix pattern already exists)

1. **explore synthesize-step**: declares the downstream reviewer's verdict as an
   `optional_inputs` entry — first pass renders `[reads unavailable]`, rework pass
   inlines the verdict. This is the minimal, compile-clean fix for every NO row above.
2. **cross-tool-build forward-rework**: reviewer `revise` is a PASS verdict routing
   FORWARD to a step that declares the review as input.
3. **build review-step inputs**: reviewer receives implementation + verification +
   touch-area (vs fix-review, which misses the computed change-set).

## Counts

- **Critical: 2** (fix-review→fix-act; build review-step→act-step — both public flows,
  reviewer rejection re-launches implementer blind)
- **High: 9** (fix-verify→fix-act; fix-change-set→fix-act; fix-regression-rerun→fix-act;
  build verify→act; pursue review→batch; pursue verify→batch; cross-tool-build
  verify→implement; explore stress-proposals→decision-options; converge-proof
  no-carry loop) plus 2 high judge-blindness findings (fix-until-green, sweep)
- **Medium: 7** (fix-diagnose→gather-context; fix-regression-baseline→frame; fix-review
  missing change-set; explainer retry-gate blind; goal recovery dead-end; loop
  lesson-only carry ×2)
- **Low / hygiene: ~10** (same-step blind re-rolls; goal undeclared child-result inputs;
  dead-evidence entries; build-touch-area stop-on-bookkeeping)
