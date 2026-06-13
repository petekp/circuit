# Circuit Remediation Backlog

Source: `docs/audits/2026-06-13-circuit-critique-answers.md` (17 answered critique questions).

This backlog covers every finding tagged `weakness_confirmed` or `partly_valid`.
It ranks now-fixable code and doc changes above items that need a new
measurement run. The three blocked items (V-4, V-5, MA) need a measurement run,
not a code change, so they live in their own section at the end. WI-3 is a
genuine strength that is undersold, so it gets a short surfacing note rather than
a fix.

The single thread running through most of the high-rank items: the only
committed Fix proof is a synthetic fixture whose review was skipped and whose
outcome was "partial," yet every prose surface a human reads says "Verification:
passed" and "complete." Fixing that one laundering path plus replacing the proof
corpus closes or softens WI-1, HW-1, HW-2, HW-3 (evidence half), WF-3, WF-4, and
WF-5 at once.

## Top 5 recommended actions

| Rank | Finding id(s) | Action | Why it matters | Effort |
|---|---|---|---|---|
| 1 | HW-1, WI-1, WF-3, WF-5 | Stop the operator digest from laundering a skipped review and a "partial" outcome into "Verification: passed" / "complete." Emit a "Review: skipped (reason)" line and carry the real outcome word to every prose surface. | The product's entire pitch is "we do not fabricate a clean result," yet its own digest does exactly that when review is bypassed. The honest signal already exists in `fix-result.json`; it is dropped on the way to the human. | M |
| 2 | WI-1 | Replace the committed Fix proof corpus with at least one real-bug run (real failing test, real diff, real review that actually ran). Keep the synthetic fixture only if clearly labeled and not the headline proof. | The one artifact a buyer inspects currently proves only that the run-folder shape is well-formed. A real run is the difference between "trust us" and "look." | L |
| 3 | WF-3, WF-5 | Add a plain "who this is not for" section to the README and reconcile the README front-door pitch with `first-run.md`. Name the shallow-bug / solo-skeptic non-fit and the cost it carries. | The README pitches `/circuit:run` as the universal front door and names no audience it is wrong for, while the eval shows zero outcome change on trivial bugs at ~3.5x wallclock. | S |
| 4 | WF-2, HW-2 | Fix the docs to state plainly that the worker boundary is detection-after-the-fact, not an OS sandbox, and that containment downgrades the outcome rather than preventing the write. Point untrusted-work users to a real sandbox. | "read-only is a routing signal, not an OS sandbox" is already half-said; the gap is a security-relevant one for junior or untrusted agents on a shared checkout. | S |
| 5 | V-2, MA | Print a pre-run cost estimate (or at least a "this will make N model calls" warning) before the run spends, and fix the charter doc that still claims dollars are not recorded. | The only price an operator ever sees is a post-hoc receipt after the money is spent, and the project's own cost description is internally inconsistent with the committed `$0.56/fix` figure. | M |

## Full backlog

Ranked by severity times fixability. Now-fixable code and doc changes rank
above items that need new measurement.

### Rank 1: HW-1 (and the shared laundering path: WI-1, WF-3, WF-5)

- Problem: when the independent review is bypassed, the operator's digest reads
  as a clean pass and says nothing about the skipped audit; the run-level outcome
  is laundered from "partial" to "complete."
- Cited location: `src/shared/operator-summary/projections.ts:170` (the "Review:"
  line only emits when `review_verdict` is defined), `src/flows/fix/reports.ts:898`
  (schema forbids `review_verdict` on a skip, so the line is structurally
  omitted), `src/app/operator-summary/writer.ts:413` (`caveatsFrom` only harvests
  Confidence/Residual/Fold-in/Consider, none of which a skip produces). Honest
  data exists at `fix-result.json` (`outcome: partial`, `review_status: skipped`).
- Smallest defensible fix: emit a "Review: skipped (reason)" line whenever
  `review_status` is `skipped` (independent of `review_verdict`), and carry the
  backing `outcome` word ("partial") through to `operator-summary.md`,
  `run-surface.md`, and `result.json` instead of overwriting it with "complete."
  A failing test should reproduce the contradiction first (digest says passed
  while `fix-result.json` says partial/skipped).
- Effort: M
- Status (2026-06-13): operator-surface half DONE (PR off main). `buildFixDetails`
  now falls back to `review_status` and emits `Review: skipped. Reason: <skip
  reason>`, so a bypassed review is named on the digest and key points instead of
  being silently dropped. Locked by a TDD failing-then-passing test in
  `tests/runner/operator-summary-writer.test.ts` (red without the fix, green with
  it). Still open, and intentionally left out of that PR:
  - The committed golden Fix proof still renders the laundered surface.
    Refreshing it is deferred because main's entire proof corpus is stale versus
    the current engine: regenerating any single proof also pulls in unrelated
    `manifest_hash` and receipt-footer drift, and the capture script crashes
    partway on a checkpoint-resume scenario (reproduced on clean `origin/main`).
    This needs its own corpus-wide proof-refresh pass; it folds into WI-1 below.
  - The run-level envelope (`result.json` / `run-surface.md`) still reports
    `complete` rather than carrying the `partial` outcome word. That is a
    separate run-envelope projection and remains the rest of this rank.

### Rank 2: WI-1 (committed proof corpus is synthetic)

- Problem: the headline proof set a buyer inspects contains zero real-bug runs;
  the one synthetic run it ships is misrepresented as a clean complete pass.
- Cited location: `docs/release/proofs/runs/fix/run/reports/fix/brief.json:5`
  (scope "Synthetic Fix proof fixture."), `verification.json:5` (verification is
  `['node','-e','process.exit(0)']`), `change-set.json:4` (all-zero SHAs over a
  fabricated `src/login.ts`), `docs/release/proofs/index.yaml:115` (declares the
  scenario "Uses a synthetic bug fixture"). Real failing-test evidence exists only
  under `evals/` and is itself a single-function throwaway fixture
  (`evals/fix-vs-vanilla/tasks/discovery-amount-cents/task.json:7`).
- Smallest defensible fix: run Fix on at least one real bug in a real repo (with a
  genuine failing test and a review that actually runs), commit that run folder as
  the headline proof, and either drop the synthetic fixture or label it clearly as
  a shape-only fixture that is not evidence of real work. Wiring the existing
  real-bug eval tasks into the proof corpus is the cheaper interim step.
- Effort: L (a real-repo run plus corpus regeneration; interim eval-wiring is M)

### Rank 3: WF-3 and WF-5 (no "who this is not for"; README vs first-run disagree)

- Problem: the README pitches `/circuit:run` as "the normal front door on every
  host" for any task and names no audience it is wrong for, while the eval shows
  the full 11-step Fix flow changes the outcome by zero on trivial bugs at ~3.5x
  wallclock. Separately, `first-run.md` steers a newcomer to a read-only Review
  and a doctor JSON dump, contradicting the README's "fix my bug" pitch.
- Cited location: `README.md:104-106` (universal front door), `README.md:55`
  (leads with a shallow bug example), `first-run.md:68-70` (Review-first steer),
  `docs/audits/2026-06-11-eval-heldout-hardening.md:315-318` (only wrap-index
  discriminates; two tasks trivial), `UBIQUITOUS_LANGUAGE.md:10-14` (11-term
  vocabulary tax).
- Smallest defensible fix: add a short "who this is not for" paragraph to the
  README (shallow well-reproduced bugs, solo devs who already hand-verify every
  diff, anyone cost-sensitive at small scale) and state the ~3.5x wallclock plus
  extra-steps cost in plain terms. Reconcile `first-run.md` by framing the
  Review-first path explicitly as the cautious-evaluator track, not the default
  first run.
- Effort: S

### Rank 4: WF-2 and HW-2 (containment is convention, not enforcement)

- Problem: Circuit imposes no OS-level filesystem isolation on its write-capable
  workers; the one structural gate (`allowed_touch_area`) is Build-only, opt-in,
  inert when undeclared, and even when it fires it is a post-hoc git diff that
  downgrades the outcome rather than preventing the bad write.
- Cited location: `README.md:131-134` (read-only is "a routing signal, not an OS
  sandbox"), `src/connectors/claude-code.ts:284` ("Tools are unrestricted by
  design"), `src/flows/build/writers/baseline-snapshot.ts:41-49` (Build-only,
  opt-in), `src/flows/build/writers/touch-area-projection.ts:46-57` (emits
  `not_enforced` and runs no git when undeclared),
  `src/flows/fix/writers/result-projection.ts:70` (a 'fail' change-set only denies
  the 'fixed' label, drops outcome to 'partial'; the write still landed). The one
  genuine OS boundary is Codex's own CLI sandbox (`src/connectors/codex.ts:24-33`),
  not Circuit's.
- Smallest defensible fix: state plainly in the README and the worker-boundary
  docs that the boundary is detection-after-the-fact, not prevention, and that for
  untrusted or junior agents on a shared checkout Circuit is not a substitute for a
  container or OS sandbox. Point those users at a real sandbox (or the Codex
  connector's `-s workspace-write`). This is a doc-honesty fix; an actual sandbox
  is a larger separate project.
- Effort: S (doc fix); the real sandbox would be L and is out of scope for this row

### Rank 5: V-2 (per-task dollar cost is not disclosed pre-run; charter is stale)

- Problem: there is no committed dollar multiple versus raw Claude Code at the
  shipped medium default, no price shown before the run, and the charter doc still
  asserts dollars are not recorded while a committed `$0.56/fix` figure exists.
- Cited location: `evals/ledger/fix-vs-vanilla/2026-06-12T15-49-10-758Z-...json:34`
  (Circuit `$6.7518` over 12 tasks, ~`$0.56/fix`), `:37`
  (`vanilla_usage_missing_count 12`, so no ratio),
  `docs/evals/theses-and-hypotheses.md:297` ("Wallclock is recorded; tokens and
  dollars are not", now stale for the Circuit arm),
  `src/app/operator-summary/writer.ts:728` and `:876` (the receipt is accumulated
  from `relay.completed` entries, i.e. printed after the spend).
- Smallest defensible fix: (a) fix the charter line to match the committed
  instrumentation (dollars now recorded on the Circuit arm); (b) print a pre-run
  notice of the expected model-call count (or a coarse cost estimate) before the
  run starts, so the operator sees the cost before committing. The real
  apples-to-apples dollar multiple needs the measurement run in the section below.
- Effort: M (doc fix is S; the pre-run estimate is M)

### Rank 6: WI-2 (routing records, it does not decide; no capability edge)

- Problem: "routing" oversells a logging step. Flow selection is model-only,
  `routed_by`/`router_reason` are constants, and at the only model-isolated control
  Circuit does not fix more bugs than the bare model.
- Cited location: `src/cli/run.ts:307-320` (selection is model-only; no-classifier
  comment at `:315-316`), `src/cli/run-output.ts:6` (`routed_by` is the literal
  'explicit'), `src/commands/run.md:149-151` (`router_reason` is a fixed
  placeholder), `docs/audits/2026-06-11-eval-heldout-hardening.md:295-307`
  (objective-fixed 0.50 in both arms).
- Smallest defensible fix: stop calling the logging step "routing" in
  product-facing prose where it implies decision-making. Either describe it
  accurately ("records the selected flow") or, if "router" stays, footnote that
  selection is the model's and Circuit records it. This is a vocabulary-honesty
  fix, not an engine change.
- Effort: S

### Rank 7: HW-2 (no committed live containment proof), grouped with WF-2 above

- Problem: there is no committed live proof of the containment mechanism firing on
  a real out-of-scope edit; the only Fix proof is the synthetic all-zeros fixture,
  so its declared==observed parity is vacuous.
- Cited location: `change-set.json:4`, `baseline-snapshot.json:3`, `brief.json:5`
  (synthetic fixture, never exercises the live git path). The live mechanism in
  source is real: `src/shared/git-state.ts:84,94,138`,
  `src/shared/runtime-touched-files.ts:116,155`.
- Smallest defensible fix: included in the Rank 2 proof-corpus replacement. The
  real-bug run should include one case where the worker is steered out of scope so
  the change-set status genuinely flips to 'fail', proving the git diff fires.
- Effort: M (folds into Rank 2; the steered-out-of-scope case is the marginal add)

### Rank 8: WF-1 and WF-4 (single measured win is redundant for a hand-verifying solo dev)

- Problem: the only proven win is honesty (the agent over-claims less), which a
  skeptical engineer who reads the diff and runs the test captures for free; for
  that user the honesty layer is redundant insurance at ~3.5x wallclock, and most
  of the nine-link evidence chain is built for an absent third party, not the solo
  dev staring at the diff.
- Cited location: `docs/audits/2026-06-11-eval-heldout-hardening.md:297-302`
  (0.500 to 0.333 at equal 0.50 objective), `docs/evals/theses-and-hypotheses.md:69`
  ("evidence a human can audit, scope the agent provably stayed inside", the
  absent-party audience), `:142-143` ("the flow did not fix more, it lied less"),
  `:297-300` (~3.5x wallclock, no dollar ratio).
- Smallest defensible fix: this is largely answered by the Rank 3 "who this is not
  for" copy (name the solo-skeptic non-fit) plus the Rank 8/V-4 honesty-at-default
  measurement. No separate code change; the honest framing is the fix. Position the
  evidence chain explicitly as for teams/reviewers/auditors (an absent party), not
  the solo present party.
- Effort: S (copy; rides on Rank 3)

### Rank 9: V-1 (honesty win is two flipped cells dressed as a rate)

- Problem: the headline structure-isolated honesty win rests on two flipped cells
  out of twelve, on a suite the project's own charter says has ~3% power and cannot
  reach significance under any outcome; no CI excludes zero, and the next-day run
  erases the gap.
- Cited location: `docs/audits/2026-06-11-eval-heldout-hardening.md:294-300` (0.333
  vs 0.500, n=12), `:313-318` (wrap-index 3/0 vs 2/0, fit-width 3/0 vs 2/0; two
  flips), `docs/evals/theses-and-hypotheses.md:381-384` (4-task suite "cannot reach
  significance under any outcome"), `:400-406` (bind reporting to "claim direction,
  not magnitude").
- Smallest defensible fix (now-doable, doc-only): audit every product-facing and
  internal use of "0.500 to 0.333" / "25% vs 58%" and ensure each is stated as a
  direction at n=12 with the power caveat, never as a rate or a generalizable
  effect. The real resolution (a CI that excludes zero) needs the measurement run
  below. The doc-honesty pass is the smallest defensible fix now.
- Effort: S (doc honesty pass); full resolution is in the measurement section

### Rank 10: V-3 (capability portion is prompt-shapeable)

- Problem: the dial sweep is flat (low/medium/high all 0.25/0.75) and the only
  shared ingredient is an opus researcher, so the capability portion is a
  diagnosis-tier effect a strong-model prompt can reach; Circuit's honest
  differentiator is only that the habit fires by default without operator
  discipline.
- Cited location: `docs/audits/2026-06-11-eval-heldout-hardening.md:280-287` (flat
  dial sweep), `docs/evals/theses-and-hypotheses.md:48-53` (T3 concedes the
  one-liner fix), `:55-60` (T4: external hidden check drives the result).
- Smallest defensible fix: in product-facing positioning, drop any implication that
  the implement/review tiers buy capability, and state honestly that Circuit's
  value is making opus-first diagnosis plus external verification fire by default
  (a packaging-of-habits claim, not an "impossible to hand-roll" claim). Doc-only.
- Effort: S

### Rank 11: MA (combined honesty-win-per-dollar number does not exist); doc half here, measurement half below

- Problem: the single "is it worth it" number does not exist in committed
  artifacts, and the way the artifacts fall (honesty delta in a cost-free run, cost
  figure in a model-confounded run with a broken vanilla arm) makes it look like
  avoidance.
- Cited location: `evals/ledger/fix-vs-vanilla/2026-06-11T22-27-58-442Z-...json:18-27`
  (same-model honesty, no token/dollar fields),
  `...2026-06-12T15-49-10-758Z-...json:34-43` (Circuit `$6.7518`,
  `vanilla_usage_missing_count 12`), `docs/evals/theses-and-hypotheses.md:297-300`
  (cost half conceded unmeasured).
- Smallest defensible fix (now-doable): the doc half is to keep stating plainly
  that the combined worth-it number is not yet measured (the charter already
  concedes this; keep it from drifting into an implied claim). The number itself
  needs the single measurement run in the section below.
- Effort: S (doc honesty); full resolution is in the measurement section

## Needs a measurement run (not a code fix)

V-4, V-5, and MA are all `blocked` because the comparison they demand has never
been run, not because a line of code is wrong. Two of the three (V-4 and MA) can
be closed by ONE run. V-5 needs a separate instrument (the Build complexity
ladder) and is called out on its own.

### One run that closes V-4, MA, and the statistical half of V-1

Run a single head-to-head with these controls:

- Same model in both arms. Force-pin both Circuit and raw Claude Code to the
  shipped default medium stack (researcher opus, implementer/reviewer sonnet),
  using the force-override wrapper so the Power dial cannot inject a per-role
  model. This is what makes it apples-to-apples (V-4) rather than the confounded
  "opus/sonnet Circuit vs single-shot Haiku" headline.
- n at the charter's target. Use a non-degenerate held-out set of 25-40
  discriminating tasks (drop the trivial-tie and unsolvable tasks that carry zero
  information), so the result can carry a confidence interval instead of resting on
  two flipped cells (V-1).
- Captured token and dollar cost on both arms. The 2026-06-12 run lost the vanilla
  side to the envelope bug. This run must run after the PR #71 vanilla-envelope fix
  and confirm `vanilla_usage_missing_count == 0` and
  `vanilla_claim_parse_failure_count == 0` before scoring, so a real Circuit:vanilla
  dollar multiple exists.
- No envelope / usage-missing defect. Verify both arms log usage before trusting
  the cost numbers; a usage-missing arm invalidates the whole run for cost
  purposes.
- Report shape. A same-model false-fix reduction with a mid-p McNemar test and a
  Wilson or Bayesian confidence interval, divided by the real Circuit:vanilla
  dollar multiple. That single quotient is the missing "is it worth it" number (MA),
  proves or refutes flow honesty at the default stack (V-4), and gives V-1 its CI.

What it must control for, restated as a checklist:
- both arms the same model (no per-role model leak from the dial)
- n = 25 to 40 non-degenerate tasks (no trivial-tie or unsolvable fillers)
- token and dollar cost captured on BOTH arms
- zero usage-missing / envelope-parse failures before scoring

### V-5 needs a separate instrument (the Build complexity ladder)

V-5 cannot ride on the run above because the instrument does not exist. To close
it: build the Build complexity ladder (graded tasks from single-function to
cross-cutting, each with hidden adjacent-regression checks and `diff_scope`
tracking, rungs assigned before any arm runs), then run three arms up the ladder
at a fixed model: Circuit Build, single-shot direct Claude, and Claude Code
orchestrating its own subagents (the named baseline that has never run). Report
objective pass, hidden regression rate, and `diff_scope` per rung. T6 confirms
only if the Circuit-minus-baseline gap is ~zero at the bottom and positive at the
top. Cited support: `docs/evals/theses-and-hypotheses.md:176-177` and `:338-339`
(instrument "does not exist yet"), `evals/registry.json:7` (only
fix/auto/review/handoff registered).

## Undersold strength to surface (WI-3)

WI-3 is a genuine strength, not a weakness, and it is currently undersold. The
graph-runner enforcement is real, deterministic, and engine-enforced, which a
disciplined CLAUDE.md cannot replicate: a prompt can ask the model to retry N
times or stay in a step, but compliance stays the model's discretion; the engine
takes that discretion away. The four mechanisms:

- `maxAttempts` is a coded integer enforced at step entry and route selection
  (`src/runtime/run/graph-runner.ts:174-185`, `:458-488`).
- an undeclared route is a hard abort (`src/runtime/run/run-transition.ts:41-46`).
- self-pass and completed-step re-entry are distinct coded cycle aborts
  (`run-transition.ts:82-107`).
- retry-with-feedback hard-throws unless the retry route provably targets the same
  step (`src/runtime/executors/relay.ts:860-890`), under a typed failure policy
  that defaults to hard-fail (`src/schemas/acceptance-criteria.ts:40-52`).

Surfacing move: say plainly in the README and marketing that these are
state-machine guarantees a prompt cannot make, with the two honest limits intact
(the enforcement disciplines Circuit's own loop, not the worker's edits or the
diagnosis; and the demonstrated payoff so far is the narrow honesty margin, not
capability). This is a real differentiator against the "thin wrapper" prior and
costs nothing but accurate copy. Do not overstate it past those two limits.

## Out of scope (no action)

- WI-3: genuine strength, surfaced above, no fix.
- HW-3 (`close_allowed`): tagged `defensible`. The gate is real and double-checked
  (`src/runtime/run/run-close.ts:110-133,143-144`,
  `src/schemas/trace-entry.ts:667-672`). The only weakness here is the hollow
  evidence it consumed in the synthetic fixture, which is fixed by the Rank 2
  proof-corpus replacement, not by changing the gate.
