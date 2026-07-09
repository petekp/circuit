# Pre-registration — task-aware assembler evaluation

> Status: **pre-registered. Committed before any eval data is generated.**
> Date 2026-06-18. This document locks the task set, the structural rubric,
> and the numeric decision rule for evaluating a task-aware flow assembler,
> *before* the assembler is built and *before* any score is computed. No
> fitting the story to the data later: if the data lands outside these
> thresholds, the verdict follows the rule, not the hope.
>
> It is the scientific spine of the run reported in
> [`assembler-rebuild-run-report.md`](deprioritized-ledger.md) and the
> direct follow-up to the gate in
> [`dynamic-assembly-shape-check.md`](deprioritized-ledger.md).

---

## 0. What we are deciding

The gate ([`dynamic-assembly-shape-check.md`](deprioritized-ledger.md))
found the dynamic NL→flow path (`circuit create`) **task-blind**: it discards
the task text, hardcodes `surface_area: small` / `risk: low`, and can emit only
two shapes — build folded (`whole`, 5 steps) or build full (`decomposed`, 9
steps). Every task becomes build with a different label. The bottleneck is the
**assembler's shape vocabulary**, not context passing.

This run builds a **task-aware assembler** and decides, against a rule fixed
here, whether the **dynamic / JIT-workflow direction is now viable** — concretely:

1. Does the assembler **read the task** into assembly signals instead of
   discarding it?
2. Does it **generate a task-appropriate shape per task** — diverse, valid, and
   near the hand-authored bar — rather than build-with-a-label?
3. Is the **dynamic-vs-reference** experiment (run a generated flow against the
   hand-authored reference on a real task) now worth spending real model budget
   on, or is it still a foregone loss?

---

## 1. The OLD baseline (pinned before building)

The current vocabulary, measured by the gate harness
(`experiments/flow-lab/dynamic-shape-check.ts`) and pinned here so the
comparison is honest. For **every** task, regardless of text:

| Property | OLD stub (today) |
|---|---|
| Task signal used | **none** (`surface_area`/`risk` hardcoded; text → slug + purpose only) |
| Archetype family reachable | **build only** |
| Distinct compiled shapes across any task set | **2** total (`whole` ⊕ `decomposed`), and only `whole` without the `--decompose` flag |
| `primary_result` binding | always `build.result@v1` |
| Editorial-feature overlap vs the explainer reference | **0.0** (`whole`) / **0.125** (`decomposed`, all of it the one false positive) |
| Validity (compiles + catalog gate + primary_result bound) | yes (it is build) |
| Determinism | total (no model in the path) |

The OLD stub's score on the rubric below is therefore knowable in advance:
**task-signal-used = false on all 8 tasks; family correct only on the one
build-family task; 2 distinct shapes; editorial overlap ≈ 0.** The NEW assembler
must beat this by reading signals and producing diverse, family-appropriate,
valid shapes.

---

## 2. The task set (representative range, locked)

Eight natural-language tasks spanning the archetype families plus a
surface-area / risk pair. Each is the kind of one-line description an operator
would type into `circuit create --description "<task>"`. The expected family and
grain are pre-registered; the assembler does not see this table.

| # | id | Task text (operator types this) | Expected family | Expected grain | Has hand-authored reference? |
|---|---|---|---|---|---|
| T1 | `explainer-paper` | build an interactive explainer website for the research paper "Attention Is All You Need" | editorial / explainer | n/a (editorial spine) | **explainer** |
| T2 | `feature-darkmode` | add a dark-mode toggle to the settings page that persists the user's choice | build / feature | whole (small/low) | build |
| T3 | `fix-race` | fix the race condition causing duplicate webhook deliveries under retry | fix / bug | whole (focused) | **fix** |
| T4 | `research-state` | research and compare state-management options for our React app and recommend one | research / analysis | n/a (research spine) | **explore** |
| T5 | `review-auth` | review the authentication module for security and correctness issues | review / audit | n/a (review spine) | **review** |
| T6 | `migrate-billing` | migrate the entire billing system from Stripe Charges to PaymentIntents across the codebase | build / feature | **decomposed** (large + high risk) | build |
| T7 | `tweak-rename` | rename the `count` variable to `total` in the request logger | build / feature | whole (small/low, minimal) | build |
| T8 | `proto-hero` | prototype three landing-page hero layouts and pick the best one | prototype / variant | n/a (variant spine) | **prototype** |

Rationale: T1/T4/T5/T8 are the families the OLD stub cannot reach at all
(editorial, research, review, variant). T2/T6/T7 are the same nominal family
(build) at three different surface/risk levels, to test that the **signal axis**
(small/low → `whole`, large/high → `decomposed`) actually moves the shape from
the text. T3 is a fix that should look like fix (diagnose/reproduce), not build.

---

## 3. The structural rubric (objective, offline, locked)

Everything scored **offline**, no execution, by structural predicates over the
**compiled** flow — the same machinery as the gate harness, generalized to a
per-family feature detector. The Phase 3 breadth harness
(`experiments/flow-lab/assembler-breadth-eval.ts`) implements exactly these
predicates. For each task it generates the flow N=10 times (determinism check)
and scores:

### 3.1 Task-signal-used (the headline)
Binary, plus which signals fired. **TRUE** iff:
- the chosen **archetype family matches** the pre-registered expected family
  (§2), **and**
- the chosen **grain matches** the expected grain where the family has a grain
  axis (T2/T6/T7: whole vs decomposed must match surface/risk).

This is the metric the OLD stub scores **false** on 7 of 8 tasks (it can only
ever land the build family at `whole`). It is the most direct measure of "reads
the task instead of discarding it."

### 3.2 Shape-appropriateness (per-family feature checklist)
Each expected family declares a checklist of **required** structural features and
**forbidden** features, detected structurally (by stage + execution kind, not by
step id, so the detector is fair to different names):

- **editorial / explainer** — required: a digest/analyze step; a plan-stage
  ideation compose; a plan-stage **fanout** (tournament); a plan-stage
  operator **checkpoint** (pick); a spec compose; a **sub-run** (delegated
  build); a verify; a post-verify **second checkpoint** (sign-off); a close
  compose. forbidden: none specific.
- **fix / bug** — required: a frame; a diagnose/analyze step (reproduce/locate);
  a plan; an act relay; a verify; a close. forbidden: a plan-stage **fanout**;
  a **sub-run**; a second operator checkpoint. (A fix is focused, not a
  tournament.)
- **research / analysis** — required: a gather/analyze emphasis (≥1 analyze or
  research relay/compose); a synthesizing close. forbidden: an act
  implementation relay; a verification-of-a-build step. (Research reads and
  reports; it does not ship code.)
- **review / audit** — required: a review relay (audit); a close verdict.
  forbidden: an act implementation relay; a build sub-run.
- **prototype / variant** — required: a **fanout** (variants); a checkpoint or
  variant-evidence step; a close. forbidden: none specific.
- **build / feature** — required: frame; plan; act relay; verify; close.
  required for **decomposed** (T6): analyze + review present. required for
  **whole** (T2/T7): analyze + review **folded out** (5-step spine). forbidden:
  a plan-stage fanout; a sub-run.

Score per task: `features_present_fraction` (of required) and
`forbidden_present_count`.

### 3.3 Validity (non-negotiable)
Binary per task: the generated flow **compiles** (`compileSchematicToCompiledFlow`
returns a single package), **passes the fail-closed catalog gate**
(`collectSchematicCatalogIssues` → 0), and **binds `runtime_surface.primary_result`**
(a close-stage compose routes `@complete`). An invalid flow is a hard fail for
that task regardless of shape.

### 3.4 Diversity
- **Across-task distinct shapes**: number of distinct compiled-flow hashes across
  the 8 tasks. OLD stub = 2 (really 1 without flags). 
- **Within-family signal sensitivity**: do T2 (whole) and T6 (decomposed) differ?
  Do two different-text tasks in the same family differ when their signals differ?

### 3.5 Consistency
Determinism: N=10 draws of each task collapse to a single compiled hash.
(Offline, no model → this should hold; a failure here is a bug, not a quality
signal. Consistency is a property, not a virtue to be traded against.)

### 3.6 Overlap with the hand-authored reference (for T1–T6, T8)
For each task with a reference flow (§2), compute, exactly as the gate harness:
- **canonical-stage Jaccard** — the trivial engine-skeleton overlap (every flow
  rides the same canonical stages; this is near-free and means little), and
- **feature overlap** — the meaningful overlap: fraction of the reference's
  family features that the generated flow also has.

The reference is the *bar*, not a thing to clone: scoring high on **feature
overlap** without cloning the reference's exact bytes is the goal.

---

## 4. Per-task PASS definition (locked)

A task **PASSES** iff **all four** hold:

1. **Valid** (§3.3): compiles + catalog-gate-clean + `primary_result` bound.
2. **Signal used** (§3.1): family matches expected **and** grain matches expected.
3. **Shape appropriate** (§3.2): `features_present_fraction ≥ 0.75` **and**
   `forbidden_present_count = 0`.
4. **Deterministic** (§3.5): N=10 → 1 hash.

---

## 5. The numeric decision rule (locked before data)

Let `P` = number of the 8 tasks that PASS (§4). Let `E` = the editorial task
(T1) **feature overlap** vs the explainer reference (§3.6). Let `D` = distinct
compiled shapes across the 8 tasks (§3.4). Validity is `V` = number of the 8
that are valid (§3.3).

The dynamic / JIT direction is classified as exactly one of:

### VIABLE — ship Phase 1 **and** green-light dynamic-vs-reference runs
- `P ≥ 7/8`, **and**
- `E ≥ 0.60` (the editorial task reaches ≥ 60% of the explainer reference's
  features, vs ≈ 0 today), **and**
- `D ≥ 5` distinct shapes, **and**
- `V = 8/8` (every task valid).

Reading: the assembler genuinely reads the task and generates appropriate,
diverse, valid shapes near the hand-authored bar. The dynamic-vs-reference
experiment is now worth real budget.

### PROMISING — ship Phase 1; dynamic-vs-reference worth running, with caveats
- `P` in `5..6` (inclusive), **and**
- `E ≥ 0.35`, **and**
- `D ≥ 4`, **and**
- `V = 8/8`.

Reading: clear signal-use and real shape diversity, a large improvement over the
stub, but a gap to the reference bar remains on one or two families. Ship the
foundation; run the comparison knowing the generated arm may still lose on the
families that fell short.

### RESEARCH-GRADE-NOT-READY — ship Phase 1 only if valid; do NOT green-light dynamic-vs-reference yet
- Anything that does not meet PROMISING. In particular: `P < 5`, **or** `E < 0.35`,
  **or** `D < 4`, **or** `V < 8`.

Reading: the assembler may read signals, but it cannot yet generate
reference-quality shapes for enough families, or it produces an invalid flow.
The dynamic-vs-reference comparison would still be a foregone loss; fix the
remaining families first.

**Validity override.** If `V < 8` (any task fails to compile or trips the catalog
gate), the classification is **at most** RESEARCH-GRADE-NOT-READY regardless of
the other numbers, and Phase 1 does **not** ship until validity is restored. A
generator that emits an invalid flow is worse than the honest stub.

---

## 6. The live (DEPTH) confirmation (pre-registered, confirmatory)

Offline structural scores can be gamed by a generator that assembles
plausible-looking shapes that do not actually run. So we also **execute** the
best generated flow end-to-end for **≥ 2 task types**:

- a **build/fix on a real coding task** (the cleanest live arm), and
- an **explainer-shaped flow on a real paper**, *if* its known rough edges
  (scaffold, build-timeout) can be handled as setup; if they cannot in the
  budget, the explainer live arm is reported as **not-run with reason**, not
  silently skipped.

A live run **succeeds** iff the generated flow: reaches `@complete` (or an
honest checkpoint/abort — not a false "done"), writes its `primary_result` file,
and produces output an operator can judge as on-task. Live runs are
**confirmatory**, not part of the §5 numeric gate (N is too small to be a gate).
But:

**Live-failure downgrade.** If the single cleanest live arm (the build/fix
coding task) **fails to execute** at all — does not reach a terminal, or emits
no primary_result — the classification is **downgraded by one tier** (VIABLE →
PROMISING, PROMISING → RESEARCH-GRADE-NOT-READY). A shape that assembles but
cannot run is not viable.

---

## 7. The Phase 2 spike verdict (pre-registered: feature vs research)

Phase 2 attempts **genuine composition of a novel flow from typed blocks** (not
instantiating a pre-designed archetype) for a task, as an **offline spike**
(never merged to `src/` regardless of result). Its verdict is one of:

- **FEATURE** — the generative-from-typed-blocks path reliably produces a
  **valid** (compiles + catalog-gate-clean + primary_result) and
  **family-appropriate** novel shape for a held-out task **deterministically and
  without inventing unregistered contracts**. The hard part is engineering.
- **RESEARCH PROBLEM** — it cannot reliably produce valid shapes: it trips the
  anti-widening / single-actual catalog gates, needs unregistered contract
  bodies, or needs a model in the loop to be any good. The hard part is open.

The spike reports which, with evidence, and surfaces a decision-ready spec +
prototype. It does not gate Phase 1.

---

## 8. Anti-fitting commitments

- This file is committed **before** the assembler is built and **before** any
  score is computed. Its git commit precedes every eval-data commit.
- The rubric predicates are **structural** (stage + execution kind), not
  step-id matches, so the detector cannot be tuned to a specific generator's
  naming.
- The decision thresholds in §5 are **fixed**. If the data lands between tiers,
  the lower tier governs. If a predicate turns out mis-specified (a true false
  positive, as the gate found one), the correction is **disclosed and discounted
  in the report**, not silently rewritten.
- The OLD-stub baseline (§1) is knowable in advance and is reported alongside
  the NEW scores, so "improvement" is measured, not asserted.
