# Pre-registration — genuine flow-shape composition evaluation

> Status: **pre-registered. Committed before any composer is built and before any
> eval data is generated.** Date 2026-06-18. This locks the task set, the rubric,
> and the numeric decision rule for evaluating whether an automated composer can
> **invent** a novel flow by composing intent-enriched blocks — *before* the
> composer exists and *before* any score is computed. No fitting the story to the
> data later: if the data lands outside these thresholds, the verdict follows the
> rule.
>
> It is the direct follow-up to the **Phase 2 spike verdict** in
> [`assembler-rebuild-run-report.md`](assembler-rebuild-run-report.md) §2
> (RESEARCH PROBLEM) and the FEATURE-path spec recorded there. The run it
> governs is reported in
> [`flow-composition-run-report.md`](flow-composition-run-report.md).

---

## 0. What we are deciding

The task-aware assembler (PR #117) reaches the dynamic / JIT bar by
**selection-and-instantiation**: it reads the task, picks a family, and
instantiates a proven family seed. It does **not** compose a new shape from
blocks. The Phase 2 spike asked whether an automated composer *could* build a
valid novel flow from typed blocks and answered **RESEARCH PROBLEM**: a naive
linear composer hit a sequence of **eight fail-closed walls** before the
contract gates even ran, because the typed catalog did not carry the per-block /
per-flow intent the safety gates require.

This run builds the FEATURE-path the spike specified — **intent-enriched blocks**
plus a real composer — and decides, against a rule fixed here, whether **genuine
flow-shape composition works, and how far**:

1. Can the composer produce **one** genuinely-novel, valid, sensible flow
   offline (the Phase 0 make-or-break gate)?
2. If so, across a locked set of novel topologies, how reliably does it produce
   novel, valid, sensible, task-appropriate, consistent flows?
3. Do the best composed flows **run** end-to-end and produce good output, vs the
   instantiated (#117) and hand-authored references?

The capability is **experimental and default-OFF** throughout. The stable
task-aware assembler and the eight built-ins remain the default and must stay
byte-identical (proven, not asserted).

---

## 1. The baseline (pinned before building)

Two baselines, both knowable in advance:

| Baseline | What it does | Novel? | Valid novel shape? |
|---|---|---|---|
| **Phase 2 spike** (`phase2-genuine-generation-spike.ts`) | naive linear composer reading `block-catalog.json` | attempts 3 novel topologies | **0 / 3 valid** (8 walls); positive control (real `review` family) VALID; 1-edit perturbation REJECTED |
| **#117 instantiation** (`resolveArchetype`) | reads task → instantiates a proven family seed | **no** (reuses a family) | yes (it is a family) |

The spike's 0/3 is the bar to beat. The #117 instantiation arm is the
**quality/cost reference** for Phase 2 (a composed flow that runs no better than
the instantiated one, at higher cost, is not worth the generative machinery).
The hand-authored built-in families are the **upper** reference bar.

A key spike defect, pinned here as a hypothesis (not a conclusion): the spike read
`docs/flows/block-catalog.json`, which is generated from `FLOW_BLOCK_DEFINITIONS`
**with `schematicPolicy` (execution kinds + canonical stages) and
`authoringPolicy` stripped**. So the spike could not know each block's allowed
execution kinds (wall 8) or canonical stage (it hardcoded a `STAGE_OF` map). A
composer reading `FLOW_BLOCK_DEFINITIONS` directly already has the
execution-capability table and stage mapping. Whether that, plus intent
enrichment, is *sufficient* is exactly what this run tests.

---

## 2. The "valid", "novel", and "sensible" definitions (locked, mechanical)

All three are computed by the **real engine gates**, offline, `$0` model spend.

### 2.1 VALID (non-negotiable, identical to spike + run-report §3.3)
A composed flow is **valid** iff, run through the SAME fail-closed path the engine
runs:
- `assembleFlowSchematic(spec)` succeeds — i.e. `FlowSchematic.parse` passes every
  `superRefine` check (reachability from `starts_at`, single-producer, terminal
  route binding, stage-path policy, route targets resolve), and
- `compileSchematicToCompiledFlow(schematic)` returns without throwing, and
- `collectSchematicCatalogIssues(schematic)` returns `0` issues (route-aware
  catalog gate + anti-widening + single-actual gates), and
- the compiled flow binds `runtime_surface.primary_result` (a close-stage step
  routes `@complete`).

An invalid flow is a hard fail regardless of how novel or sensible it looks.

### 2.2 NOVEL (the topology is not a built-in)
A composed flow is **novel** iff its **block sequence** — the ordered list of
`(block, executionKind)` pairs across its steps — is **not equal** to the block
sequence of any of the eight built-in flows (build whole, build decomposed, fix,
review, explore, prototype, explainer, goal/pursue as applicable). A flow that is
a built-in with renamed steps is **not** novel. Reported alongside: the
full-compiled structural hash, and which built-in (if any) it most resembles
(Jaccard over the `(stage, block, executionKind)` multiset).

### 2.3 SENSIBLE (the intents compose meaningfully)
A composed flow is **sensible** iff **all** hold, checked structurally over the
assembled schematic:
- **Contract closure** — every contract consumed by a step is either produced by
  an upstream step or is an ambient/initial contract (declared in
  `initial_contracts`). No dangling input.
- **Intent closure** — every block's declared semantic **preconditions** (from
  the intent enrichment) are satisfied by the **postconditions** of an upstream
  block or by the task's initial state. No block runs before its inputs make
  sense.
- **No orphan** — every step lies on a path from `starts_at` to a terminal
  (`@complete`/`@stop`); no step's output is silently dropped except the
  primary-result producer's terminal.
- **Goal-reaching** — the flow terminates in a close-family block that binds
  `primary_result`.

`SENSIBLE` is stronger than `VALID`: a flow can be valid (compiles, gates clean)
yet compose intents that do not belong together. Both are required.

---

## 3. The task set (locked)

### 3.1 Phase 0 — the single make-or-break target
**`research-then-build`**: an operator task of the form *"research X, then build
the chosen option and verify it."* Target topology: a research/investigation
front welded to a build back —
`frame → gather-context → plan → act → run-verification → review → close`. This
is **none** of the six built-in families (build has no `gather-context`; explore
has no `act`/`verify`/`review`; fix has no `gather-context`). It is exactly the
spike's attempt #3 (`research-build`), which scored **0/3**. Phase 0 succeeds iff
the composer produces this (or another genuinely-novel) flow as
NOVEL ∧ VALID ∧ SENSIBLE, offline, deterministically, **without inventing
unregistered contract bodies** (it must reuse registered actuals, binding generics
via `contract_aliases` where needed).

### 3.2 Phase 1 — the breadth set (N = 8 novel topologies, locked here)
Eight distinct novel task-types, each a topology that is not a built-in. Locked
before any composer output:

| # | id | Operator task (one line) | Target novel topology (none is a built-in) |
|---|---|---|---|
| C1 | `research-then-build` | research state-management options, then build the chosen one and verify | frame → gather-context → plan → act → run-verification → review → close |
| C2 | `triage-only` | investigate why webhooks duplicate and report findings (do NOT fix) | frame → gather-context → diagnose → close |
| C3 | `fix-then-prototype` | fix the layout bug, then prototype 3 variants of the new component | frame → diagnose → act → run-verification → prototype-variant-evidence → prototype-checkpoint → close |
| C4 | `audit-then-fix` | review the auth module, then fix the issues it finds and verify | frame → review → act → run-verification → close |
| C5 | `research-then-handoff` | research the migration approach and hand off a plan for a later session | frame → gather-context → plan → handoff |
| C6 | `build-then-review-loop` | implement the feature, verify, and independently audit before closing | frame → plan → act → run-verification → review → close (review as a distinct relay, not folded) |
| C7 | `diagnose-plan-checkpoint` | diagnose the perf regression, plan a fix, and pause for operator go/no-go | frame → gather-context → diagnose → plan → human-decision → close |
| C8 | `gather-verify-close` | collect the current test/coverage state and verify the suite, then report | frame → gather-context → run-verification → close |

These span: research+build welds (C1), diagnose-only (C2), cross-family hybrids
(C3, C4), early-terminate variants (C5 handoff, C2/C8 short), operator-checkpoint
mid-flow (C7), and a build-with-explicit-review (C6). If a target topology turns
out to be unreachable for a principled reason (e.g. a contract genuinely cannot
be produced), that is **reported, not swapped** for an easier one.

---

## 4. The rubric (objective, offline, locked)

Per composed flow, score the five axes:

- **Novel** (§2.2) — binary.
- **Valid** (§2.1) — binary. Non-negotiable.
- **Sensible** (§2.3) — binary (all four sub-checks pass).
- **Task-appropriate** — per-topology feature checklist (required structural
  features present, forbidden absent), `features_present_fraction` and
  `forbidden_present_count`. Detected structurally (stage + execution kind), not
  by step id. PASS iff `fraction ≥ 0.75 ∧ forbidden = 0`.
- **Consistent** — determinism: K=10 draws of the same task collapse to one
  compiled hash. (Offline, no model → must hold; a failure is a bug.)

A composed flow **PASSES** iff Novel ∧ Valid ∧ Sensible ∧ task-appropriate ∧
Consistent all hold.

---

## 5. The numeric decision rule (locked before data)

### 5.1 Phase 0 gate (binary, make-or-break)
Produce **≥ 1** flow that is **Novel ∧ Valid ∧ Sensible** for the
`research-then-build` task, offline, deterministic, no invented contract bodies.
- **PASS** → the mechanism works; proceed to Phase 1.
- **FAIL** → **STOP**. Report exactly which wall blocked it (catalog model /
  composer / gates) and classify the run **INTRACTABLE-AS-BUILT**. A cheap
  decisive "intractable" finding is a successful outcome of this run, not a
  failure.

### 5.2 Phase 1 classification (across N = 8, §3.2)
Let `Val` = # valid, `Nov` = # novel, `Sen` = # sensible, `App` = # task-appropriate,
`Pass` = # that PASS all five (§4), of the 8. `Con` = determinism holds for all.

The genuine-composition capability is classified as exactly one of:

#### WORKS — genuine flow-shape composition is an engineering feature
- `Val = 8/8` (every composed flow valid), **and**
- `Nov ≥ 7/8` (essentially all genuinely novel), **and**
- `Sen = 8/8`, **and**
- `Pass ≥ 6/8` (task-appropriate on at least six), **and**
- `Con` holds.

Reading: the composer reliably invents valid, sensible, task-appropriate novel
flows across a diverse task set. Ship behind the experimental flag; the live
Phase 2 confirmation is worth running.

#### PARTIAL — works for a characterized subclass
- `Val ≥ 5/8`, **and** every valid flow is also Novel ∧ Sensible, **and**
  `Con` holds; **and** it does not meet WORKS.

Reading: genuine composition works for a bounded, characterizable class of
topologies; the rest hit a wall the enrichment does not yet cover. Ship the
working class behind the flag; document the boundary precisely (which topologies
fail and why).

#### INTRACTABLE — still a research problem
- Anything below PARTIAL: `Val < 5/8`, **or** a valid flow is not sensible, **or**
  `Con` fails, **or** Phase 0 failed.

Reading: even with intent enrichment, the composer cannot reliably produce valid
novel flows. Report what is still missing (which walls survive) and hold the
capability as research.

**Validity override.** A composer that emits an *invalid* flow as a "composed
flow" without the gate catching it would be worse than the spike. Validity is
measured by the real gates only; the harness never substitutes its own judgment
of validity for the engine's.

---

## 6. The live (Phase 2) confirmation (pre-registered, confirmatory)

Only if Phase 1 reaches WORKS or PARTIAL, and budget allows. Execute the best
composed flow(s) end-to-end with a real worker, on a real coding task (the
cleanest arm first), via `circuit run <slug> --autonomous`.

A live run **succeeds** iff the composed flow reaches `@complete` (or an honest
checkpoint/abort — not a false "done"), writes its `primary_result`, and produces
output an operator can judge as on-task. Compare to: the #117-instantiated flow
for the same task (quality + cost), and the hand-authored reference where one
exists.

Live runs are **confirmatory**, not part of the §5 numeric gate (N too small).
But: **live-failure downgrade** — if the single cleanest composed live arm fails
to execute at all (no terminal, no primary_result), the classification is
downgraded one tier (WORKS → PARTIAL, PARTIAL → INTRACTABLE). A shape that
composes but cannot run is not a feature.

---

## 7. Anti-fitting commitments

- This file is committed **before** the composer is built and **before** any
  score is computed. Its git commit precedes every eval-data commit.
- The task set (§3) and thresholds (§5) are **fixed**. If a target topology is
  unreachable for a principled reason, that is **reported, not swapped**. If the
  data lands between tiers, the lower tier governs.
- "Valid" is measured by the **real engine gates** only (§2.1) — the harness
  never declares a flow valid that the engine would reject, nor vice versa.
- Rubric predicates are **structural** (stage + execution kind), not step-id
  matches, so the detector cannot be tuned to the composer's naming.
- The capability stays **experimental, default-OFF**. The eight built-ins and the
  stable task-aware assembler must stay byte-identical; this is proven by the
  existing equivalence + drift tests, re-run as a rail.
- "Without inventing unregistered contracts" (§3.1, §5.1) is a hard line: a flow
  that needs a brand-new unregistered contract body to be valid does **not** count
  as composed-without-invention; the composer must reuse registered actuals via
  aliasing. (Additive registration of new bodies, if done, is reported as a
  distinct, weaker result.)
