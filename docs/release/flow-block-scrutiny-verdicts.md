# Flow and block scrutiny: verdict cards and rework plan

Pre-v1 scrutiny of Circuit's six public flows and 29 blocks. The goal was to
set a high bar before the first public release and to check we are not shipping
a local optimum. This is the decision document. It rolls up four independent
instruments into a verdict per flow, per block family, and for the set as a
whole.

## The instruments

Four methods, run independently, so a finding that shows up in more than one is
corroborated rather than an artifact of one lens.

1. **Pattern catalog.** Contemporary agentic-coding practice from frontier
   labs, academia, and practitioner tools, graded A (benchmarked) to D
   (folklore), with familiarity tracked as a separate axis.
   `docs/learnings/agentic-coding-patterns-catalog.md`.
2. **Ground-truth audit.** Coverage matrix, run-trace mining, and block static
   analysis. Measurement only.
3. **Balance instruments.** Three blind routers over a 44-intent corpus
   (router unambiguity), a block-overlap measure, and an 80/20 coverage map.
4. **Blind re-derivation.** Independent designers re-derived each flow, the
   whole flow set, and the block vocabulary from charters and field patterns,
   never seeing the shipped code, then we diffed. Convergence validates.
   Systematic divergence (all designers moving the same way away from what
   ships) flags a possible local optimum.
5. **Fool-the-check probes.** Adversarial red-team of every check kind, each
   verified against the real engine code.

## The one-paragraph result

The architecture is sound and the scrutiny said so from three directions. The
seven-stage spine, single-writer-with-reviewer-fan-out, fresh-context review,
execution-grounded verification, and evidence-backed close all came back from
independent design under matching names. Five of six flows are near-consensus.
The honesty floor survived adversarial probing on five of six check kinds. The
exercise did **not** find a set stuck on a local optimum needing a rewrite. It
found one launch-blocking correctness bug (fixable with the engine's existing
outcome-bind machinery, though the edit is a coordinated bundled-surface change,
not a one-liner), one genuine strategic fork (Pursue), and a prioritized backlog
of post-v1 improvement candidates whose top items share a single root cause. The
backlog is a set of ranked opportunities, each still subject to its own go/no-go
and the launch plan's deferred-features process; none is a standing build
commitment.

## Convergence map

A finding backed by more than one independent instrument is high-confidence.

| Finding | Balance | Re-derivation | Fool-the-check | Confidence |
|---|---|---|---|---|
| Review terminus is unsound | security-review homeless | systematic-divergence | CONFIRMED (Part B) | 3 methods |
| Refactor flow missing | uneasy routing, head gap | 3/3 designers minted it | — | 2 methods |
| Visual/UI oracle gap (Build, Prototype) | biggest head gap | systematic-divergence | — | 2 methods |
| Block merges A/B/C | measured duplicates | CONFIRMED same three | — | 2 methods |
| Pursue is mis-carved | earns keep (disagrees) | surplus, systematic-divergence | — | split |

---

## Per-flow verdict cards

Verdict scale: KEEP (validated, do not touch) / REFINE (keep shape, add a
missing pattern) / REWORK (change the shape) / DEMOTE / CUT.

### Fix — KEEP (strongest flow)

- **Evidence.** Re-derived exactly by 3/3 blind designers, unanimous, with the
  reproduce-as-failing-test then root-cause then patch-to-green then
  leave-regression-test spine. The fool-the-check command attack was REFUTED:
  `fix-regression-baseline` runs the regression command before the fix and
  expects failure, `fix-regression-rerun` requires it to clear after, and
  `projectFixResult` gates `fixed` on both. `tests/integration/fix-false-done-bar.test.ts`
  encodes six false-done patterns and all six pass; the exact no-op attack
  (pattern 06) closes `aborted` with exit 1.
- **Verdict.** KEEP. This is the reference implementation for the whole set.
  Reproduce-before-fix is the load-bearing pattern and Fix already enforces it.
- **Credit already earned.** Reproduce-before-fix (Zeller scientific
  debugging), regression-test-stays (Beck).

### Build — KEEP for v1, REFINE post-v1

- **Evidence.** The seven-stage spine Frame / Analyze / Plan / Act / Verify /
  Review / Close is exactly what all three blind designs produced. Single
  writer with reviewer fan-out, analyze-before-plan grounding, fresh-context
  review, execution-grounded verify, machine-checkable close: all validated.
  Two gaps, both minor-to-systematic: no visual/UI oracle (Verify runs
  tests/build/lint only, the half the designs consider already covered), and
  Agent TDD is not enforced in Act (no red-before-green ordering; act-step
  checks only files-changed-on-disk).
- **Verdict.** KEEP the shape. REFINE post-announcement: add a UI-classified
  branch to Verify (boot, render, capture, inspect, with any VLM design-diff
  advisory-only) and foreground a written-first, confirmed-red pinning test in
  Act.
- **Launch relevance.** Both refinements add capability, so they are post-v1
  under the no-new-features rule. The visual oracle is the omission independent
  design flagged most consistently across the build-shaped flows.
- **Credit to attach.** Anthropic frontend guidance and Playwright MCP (render
  loop), WebVoyager / MLLM-as-a-Judge (advisory grade), Kent Beck / TDFlow
  (Agent TDD).

### Explore — KEEP, minor REFINE post-v1

- **Evidence.** Frame-first and a cross-model adversarial review that is
  deliberately not self-review were independently reproduced with matching
  rationale, as was the conditional human-gated decision tournament. The
  tournament path is well-designed. One minor gap: the default (non-tournament)
  path buries scientific-debugging discipline. The analyze block is named
  "diagnose" but gates only on "aspects," so a run can reach close without
  refuting any hypothesis.
- **Verdict.** KEEP. REFINE post-v1: split analyze into grounded-retrieval and
  hypothesis-enumeration, make competing hypotheses a required section, add a
  reproduce-before-fix gate on the default path.
- **Credit to attach.** Tree-of-Thoughts (hypothesis enumeration), Zeller
  (predict-then-refute).
- **Evidence caveat.** Explore lost two of its three blind designers to
  structured-output failures, so this REFINE rests on thinner design coverage
  than the others. Re-validate before it is picked up post-v1; do not treat it
  as settled.

### Review — REWORK the terminus now (LAUNCH BLOCKER), refine grounding post-v1

- **Evidence.** Three instruments converge on one thing: Review's *terminus* is
  unsound. This is the only genuine 3-method finding in the exercise, and it is
  not a whole-flow indictment. Review's reviewer-identity rule (REVIEW-I1),
  single-writer fan-out, execution-grounded verify, and machine-checkable close
  are all validated do-not-touch strengths. The fool-the-check probe,
  independently re-verified, splits the terminus finding cleanly into two parts.
  - **Part A (inherent, not a bug, not a blocker).** The audit trusts the
    reviewer's verdict and severity with no independent oracle. This is a
    genuine limit of single-reviewer audit. It is already disclosed by the
    positioning doc's honest-nuance block ("checks the report is well formed,
    not that its content is correct ... does not come from the engine reading
    minds"). Closing it needs an evidence-backed gate, a post-v1 design change.
  - **Part B (real correctness bug, launch blocker for the claim).** An honest
    `ISSUES_FOUND` verdict over a real blocking bug still closes the run
    `complete`. Review never arms `bindsTerminalOutcomeToPrimaryResult`, has no
    verdict-conditional route, and both verdicts route pass to `@complete`. So
    an operator scanning outcomes sees a green run over a known bug. This
    contradicts the live claim "the run cannot reach its end without the
    evidence its final report requires" and "reports honestly as not done
    instead of laundering into done." It is the same shape as the retired "it
    can't fake done" overclaim.
- **Verdict.** REWORK the terminus (a blocker while the honesty claim stays
  broad). This is the only finding in the whole exercise that touches v1
  directly.
- **Fix (recommended).** Bind the terminal outcome to the verdict so a blocking
  review cannot close `complete`. The bind logic already exists in
  `run-close.ts:51-86`, but the flag is resolved from the *compiled manifest*,
  not a `data.ts` literal: the goal flow declares
  `binds_terminal_outcome_to_primary_result` on its assembled schematic
  (`goal/schematic.json:713`), and `goal/data.ts:192-193` explicitly notes it
  "intentionally carries no engineFlags." Review must follow that precedent, so
  the real change set is five to six coordinated files: (a) add an `outcome`
  field to `ReviewResult`, (b) derive it from the verdict in the projection, (c)
  emit the flag on Review's assembled schematic, (d) regen the review bundle plus
  Codex cache, (e) move the byte-identical prove-by-equivalence fixture in
  lockstep, (f) run FULL verify (a bundled surface changes; not verify:fast) in a
  clean tree. It reuses the engine's bind machinery, but it is a coordinated
  bundled-surface edit, not a one-liner.
- **Decide first: the medium-severity policy.** `computeReviewVerdict`
  (`reports.ts:121`) returns `ISSUES_FOUND` when any finding is above `low`, so
  medium trips it too. A straight CLEAN-to-complete / ISSUES_FOUND-to-stopped map
  would close a review whose worst finding is a single medium nit as `stopped`,
  which under the exit-code contract exits non-zero and fails a CI gate. That
  trades Part B's false-green for a new false-red. Pick the policy before writing
  the map: either map only critical/high to `stopped` (a severity gate in the
  derivation), or add a complete-with-findings signal so a medium note is not
  laundered into a hard failure.
- **Launch relevance.** In scope, and the reason is the exit-code contract, not
  just the wording. Two honest resolutions exist: (2a) narrow the claim with a
  one-sentence positioning amendment (the outcome means the audit ran to a
  well-formed verdict; read the verdict field for pass/fail), zero engine work;
  or (2b) the code fix. Narrowing alone is insufficient here: "all non-complete
  closes exit 1" means the run outcome is machine-consumed by CI and scripts, so
  a green exit over an honest ISSUES_FOUND misleads automated consumers, and a
  positioning sentence cannot fix a machine-read signal. That is why the code fix
  wins. It is the honesty reconciliation the launch plan already lists as item 7,
  not a new feature.
- **Post-v1 REFINE.** Execution grounding (run the suite, cite an artifact per
  finding), an anti-exhaustion terminus where CLEAN requires positive evidence
  not mere absence of findings, and a dedicated security-review sub-flow with a
  threat-model stage.
- **Credit to attach.** SWE-bench and CRITIC (execution grounding), Circuit's
  own Converge honesty-ledger (the anti-exhaustion terminus).

### Prototype — KEEP (validated), REFINE post-v1

- **Evidence.** Both instruments keep it. The honesty floor (up-front
  `claim_limits`), authored typed seams, plan gate, operator checkpoint, and the
  conditional model-comparison path ship more complete than any blind sketch.
  Systematic-divergence on one axis only, shared with Build: no render/screenshot
  oracle. V1 explicitly excludes screenshots and verifies file integrity, not
  that the artifact boots and renders.
- **Verdict.** KEEP as-is for v1. REFINE post-v1: a round-trip screenshot plus
  execution-boot receipt, gated to UI prototypes.
- **Credit to attach.** Anthropic frontend guidance, SWE-bench execution
  grounding.

### Pursue — STRATEGIC FORK (Pete's call)

- **The disagreement.** This is the one place the instruments diverge, and it is
  an honest tension worth surfacing rather than smoothing.
  - Balance said Pursue earns its keep. It is the nearest home for long-task and
    migrate intents; the imbalance is under-coverage elsewhere, not
    over-investment here.
  - Re-derivation said Pursue is a surplus. No blind designer produced it. Every
    one reasoned against multi-task orchestration as "an orchestration dial, not
    a workflow you reach for by intent." It is the only flow with zero external
    corroboration, and its internal shape drew systematic-divergence too: it
    runs one coarse batch where both designs demanded a bounded per-piece loop
    with failing-test-first and an independent stop-judge plus append-only
    ledger.
- **Reconciliation.** Both agree the territory (long-horizon, multi-piece,
  migrate) needs covering. They disagree on whether "Pursue-the-flow" is the
  right shape. It is carved by autonomy-scale, not intent-type, which is exactly
  why the router cannot cleanly separate it from Build (the only pair that ever
  split). Validated guarantees inside Pursue (serial-writer PURSUE-I1, honest
  outcome projection) are load-bearing and correct; the multi-goal framing is
  the contested part.
- **The in-scope decision (v1).** Only launch-plan item 4's options touch the
  freeze: (i) bring Pursue to bar with a contract doc plus a release proof run
  and keep it public, or (ii) demote it to internal for v1. Both are compatible
  with no-new-features. This is a public-visibility call, not a reshape.
- **The post-v1 fork (do not resolve before announcement).** Whether Pursue
  earns a permanent top-level slot is a genuine fork the instruments cannot
  break, because the decider is usage data only you have: does long-horizon work
  get invoked by intent, or does it always start as a Build/Fix that grows? Both
  branches are post-announcement code and get equal billing.
  - If usage shows long tasks always start as something else, demote Pursue to
    an internal mode, make the per-piece bounded loop a capability Build / Fix /
    Refactor can enter, and carve a dedicated Migrate flow.
  - If Pursue is deliberately invoked by intent, keep it and rework its
    internals.
  The balance corpus (grounded in the actual 44-intent routing) actively favours
  keep; blind design favours demote. The tie does not need breaking for launch.
- **The one settled, instrument-backed part.** Independent of the fork, Pursue's
  current one-coarse-batch internal shape should change to a bounded per-piece
  loop with failing-test-first and a stop-judge. The stop-judge must terminate on
  a proven-done boolean per piece, must not select a best-of-N attempt on any
  score, and must not treat loop exhaustion as success (exhaustion routes to
  needs-attention, mirroring the until-loop evidence floor). That is the blessed
  until-loop shape, not the declined keep-best loop. This reshape is post-v1.

---

## Set-level verdicts

### Add a Refactor flow — post-v1, top roster gap

The strongest missing-flow signal, backed by two independent instruments: blind
re-derivation (unanimous 3/3 within that instrument, where all three designers
minted a behavior-preserving Refactor flow split from Fix on characterization or
golden-master test pinning) and the balance corpus (the `refactor-04`
uneasy-consensus routing). Two designers argued the router cannot disambiguate
Fix from Refactor without the split. Keep the distinction from the Review
terminus clear: that is the only genuine 3-method finding; Refactor is 2 methods,
and its "3/3" is intra-instrument unanimity within re-derivation, not
cross-instrument breadth. A new flow is forbidden pre-announcement, so this is
the top post-v1 flow-roster addition. If Circuit adds one flow, consensus says
Refactor.

### Carve Migrate — post-v1, weaker

Two of three designers split migrate out as a named source-to-target
transformation carried in resumable slices behind a ratchet. Pursue partially
covers this today. Cleanly post-v1 on its own; its only tie to the freeze would
run through the Pursue demote branch, which is itself post-announcement, so no
in-scope launch decision can pull Migrate forward.

### Merge duplicate blocks A/B/C — post-v1, mechanical, sequence carefully

Confirmed by two instruments with identical conclusions.

- **A.** Collapse `human-decision`, `goal-checkpoint`, `prototype-checkpoint`
  (verbatim-identical evidence sets) into one parameterized operator-decision
  block.
- **B.** Collapse `close-with-evidence` and `goal-close` (verbatim-identical
  evidence sets, identical no-false-completion check) into one close block.
- **C.** Fold `goal-recover` into `goal-evaluate` (recover is evaluate minus the
  completion-gate; strong route-topology overlap, not byte-identical).

Removes four duplicative blocks with no capability loss. Caveat: the goal-*
family serves the internal goal flow and touches generated bundles, so this is a
careful consolidation, not a quick edit. Post-v1.

### Add a Reproduce block — post-v1

The one role the independent 8-block minimal set has that the 29-block catalog
lacks: manufacture a deterministic failing oracle, RED-now, before any fix,
writing test/harness code only. It has an inverted success condition (the check
must fail now), which no shipped block has. It underwrites the TDD discipline in
Fix, Build, and Explore. Fix already does this inline; a first-class block would
let Build and Explore reuse it.

### Block vocabulary size — validated, not bloated in the spine

The 8-role minimal spine (understand, clarify, plan, implement, verify, review,
report, plus the missing reproduce) is fully corroborated: all eight roles
exist in Circuit. The 29-vs-8 gap is not extra roles; it is loops, fan-out, and
the goal/pursue family expressed as blocks where the minimal design expresses
them as routes and properties. Consolidation should target those families, never
the spine.

---

## What is strongly validated (do not touch)

The reassuring half. Independent design reproduced all of this, so churning it
would be motion without value.

- The core flow set: Fix, Build, Explore, Review, Prototype came back 3/3 under
  matching names and boundaries. Only the sixth slot is contested.
- The seven-stage Build spine.
- Single writer with reviewer fan-out, everywhere it appears.
- Fresh-context independent review, never self-review (Review's REVIEW-I1
  reviewer-identity rule is a genuine strength).
- Analyze-before-plan grounding.
- Execution-grounded verification as its own stage: the green the flow runs, not
  asserts.
- Machine-checkable close with evidence pointers.
- Explore's cross-model tournament and human-gated decision path.
- Prototype's honesty floor and typed seams.
- Pursue's serial-writer constraint and honest outcome projection (the framing
  is contested, these guarantees are not).
- The honesty floor on five of six check kinds: engine-run verification with
  real subprocesses, engine-authored runtime-vetoed rubric scoring, and an
  unconditional serialize-all-code invariant the schema cannot violate.

---

## Sequenced plan

### In scope for the launch push

1. **Fix Review Part B** (or narrow the claim). Bind Review's terminal outcome
   to the verdict so a blocking review cannot close `complete`, decide the
   medium-severity policy first, and write the failing test before the fix (an
   honest `ISSUES_FOUND` run must not close `complete`). Correct seam and change
   set are in the Review card: it reuses the engine's bind logic but is a five-
   to-six-file bundled-surface edit needing full verify, not a one-liner. The
   only launch blocker the scrutiny surfaced.
2. **Settle Pursue's v1 visibility** (launch-plan item 4): bring it to bar with
   a contract doc plus a release proof run, or demote it to internal for v1. The
   keep-vs-demote-permanently fork and any internal reshape are post-v1, not part
   of this decision.

### Post-announcement backlog of candidates, ranked

These are ranked opportunities surfaced by scrutiny, not a build commitment. Each
is still subject to its own go/no-go and to the launch plan's deferred-features
process. The top items share one root cause: a verification oracle that is
present-but-narrow or missing, plus a terminus that can report done without
positive evidence. Fixing the oracle and the honest terminus addresses four
flows at once.

1. Visual/UI render-and-screenshot oracle for Build and Prototype Verify. The
   deterministic execution-boot/render receipt (a boolean) is the only gating
   signal; any VLM design-similarity output stays advisory-only and can never
   advance or close a run (this keeps it clear of the declined
   auto-merge-threshold pattern).
2. Review execution grounding and anti-exhaustion terminus (Part A / the
   post-v1 half), plus a security-review sub-flow.
3. Pursue per-piece loop with failing-test-first and a stop-judge terminus (the
   settled internal reshape; applies whether or not Pursue stays public, with the
   anti-exhaustion guard-term spelled out in the Pursue card).
4. Add the Refactor flow.
5. Foreground Agent TDD in Build's Act.
6. Scientific-debugging discipline in Explore's default path.
7. Add the Reproduce block (underwrites 3, 5, 6).
8. Merge duplicate blocks A/B/C.
9. Thread typed non_goals/invariants into Build, Review, Pursue (Circuit ships
   this elsewhere as intent-capture; these flows use prose scope).
10. Re-derive per-flow tournament rubrics (drop copied inert dimensions).

### Coverage caveat

Four blind-designer agents hit structured-output failures, so coverage is uneven
and the affected cells are named here rather than waved away.

- **Explore** lost two of three designers. Its REFINE is the most degraded cell
  and is footnoted on the card as re-validate-before-pickup.
- **Fix** ran no per-flow diff (the set-level diff still recorded 3/3
  convergence), but Fix's verdict is KEEP and is independently anchored by the
  REFUTED fool-the-check with named test coverage, so nothing rests on the
  missing cell.
- **Build, Prototype, and Review had full designer coverage.** So the visual-
  oracle finding (Build plus Prototype) and the Review terminus finding do not
  lean on any degraded cell; those hold firmly.
- **Refactor** is a set-level finding. The set-design track also saw failures,
  so its "3/3" is among the designers that returned, and the balance corpus is
  carrying more of the two-instrument load than the label implies. The ranking as
  top roster gap holds; the strength is 2 instruments with one leg partly
  degraded, not more.
