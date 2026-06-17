# North-star status — where Circuit stands

> The one doc to read to know what is built, what is in flight, and what is
> reserved for operator ratification. Written 2026-06-16; refreshed 2026-06-17.
> This is a **living status map**, not a design doc: it points at the design docs
> and run reports, and it is grounded against the actual state of `main` at the
> time of writing (HEAD `f4d260b1`), verified against `src/`. Each row links to
> the doc that owns the detail.

## Status legend

- ✅ **Built** — on `main`, verified in `src/` (or in `experiments/` where noted).
- 🚧 **In flight** — being built on a branch, not yet merged to `main`.
- 📋 **Surfaced** — decision-ready spec or captured idea; not built; reserved for
  ratification.
- ⏸️ **Deferred** — intentionally not next; waiting on a prior piece or a decision.

---

## 1. The four micro-harness scopes

A Circuit step is a narrow harness. Four axes scope what that harness is: **context**
(what the step sees), **equipment** (what tools/skills it has), **model/effort**
(which model and how much budget), and **structure** (one big step vs. many small
ones, the chop/hold grain). The bet behind the decision layer is that each axis
becomes a swappable **resolver** you can A/B, not bespoke logic inside an assembler.
See [`decision-layer-exploration.md`](decision-layer-exploration.md).

| Scope | Status | Where it stands |
|---|---|---|
| **context** | ✅ Built (basic) | Route-aware context availability shipped with the M-spine (primitive 3a). The richer idea — let a step **pull more context on demand** from its parents through a typed surface — is now ✅ **spiked offline** (PR #107): a pure-function demonstrator in `experiments/flow-lab/` reaches fat-push completeness at about a tenth of the carried bytes. No live/`src/` channel yet; sequenced after the live-recompile work. [`on-demand-context-pull.md`](on-demand-context-pull.md). |
| **equipment** | ✅ Built | Two halves on `main`: the **tools** axis (declared + enforced per-step tools via `claude-code --tools`, with an honest downgrade, PR #89) and the **skills** axis (the `equipment` resolver chooses the kit, real house-style injection rides `skill_slots`, PRs #96/#97; the skill-slot ratchet dropped 15 → 1). The enforced-tools ratchet still has one increment left (`TOOL_SCOPE_GAP_BASELINE = 5`). Specs: [`e2-equipment-scope-spec.md`](e2-equipment-scope-spec.md), [`equipment-scope-build-brief.md`](equipment-scope-build-brief.md), report: [`equipment-scope-enforcement-report.md`](equipment-scope-enforcement-report.md). |
| **model/effort** | ✅ Built (as a dial); 📋 not yet a resolver | The depth/power dial is real (`build --depth medium|high`, the power/model tier). It is **not yet a swappable resolver** — a `depth` resolver is one of the two candidate **third instances** that would earn the resolver abstraction. See [`depth-and-power.md`](depth-and-power.md). |
| **structure** | ✅ Built | The `structure` resolver (`src/flows/resolvers/structure.ts`, PR #95) is thin-conservative: it leans to **whole** and chops to **decomposed** only on a clear signal (operator ask, large surface, or high risk). The grain experiment ran and returned **null** on its metric, so the conservative default holds (see §6). The whole-grain fold is now **runnable** for build-derived flows after the close-writer fold tolerance landed (PR #102): a folded flow with passing verification lands at `needs_attention` rather than aborting. |

**The resolver abstraction itself is 📋 not extracted, on purpose.** Two instances
(structure, equipment) revealed a shared four-part shape but disagree on three of
four divergences (scope, enforcement, downgrade channel, binding time). A **third
instance** (context or depth) is the honest trigger before committing a `Resolver`
type. Observed shape: [`resolver-shared-shape.md`](resolver-shared-shape.md);
reserved decision: [`deepfork-resolver-abstraction-spec.md`](deepfork-resolver-abstraction-spec.md).

---

## 2. The assembler, the typed seam, and self-hosting

- **Typed seam — ✅ built.** First-class composition (M1–M9) merged. By-id package
  resolution is gone; bindings travel manifest-first; there is one shared,
  safety-floored assembly path. See
  [`../architecture/first-class-composition-optimal-path.md`](../architecture/first-class-composition-optimal-path.md)
  and [`first-class-composition-sequence.md`](first-class-composition-sequence.md).
- **Fixed-or-JIT assembler — ✅ built and general.** The same assembler produces a
  **fixed** flow (hand-authored built-ins and the `explainer` flow) and a
  **just-in-time** flow (`create`, with the structure choice applied). The assembler
  is genuinely general, not build-locked.
- **Self-hosting — ✅ built.** All six built-ins (runtime-proof, review, goal, fix,
  prototype, explore) were migrated onto the assembler and assemble/compile
  **byte-identically** (PR #94), including goal's sub-run shape and the
  prototype/explore fanout. The engine derives its registries from the catalog; a
  normal flow addition needs no engine edit.
- **The catalog gate is the safety floor.** Every compile runs
  `collectSchematicCatalogIssues`; an illegal flow fails to compile rather than
  running broken. This is what makes a *recompiled* tail thinkable (see §4).

---

## 3. Durability

Crash-safety in tiers. The forward-recovery cursor fork was **decided: Option C**
(invest the foundation + restart-cheapness, do **not** build a forward-recovery
cursor). See [`durability-tier2-cursor-spec.md`](durability-tier2-cursor-spec.md).

| Slice | Status | Detail |
|---|---|---|
| **Tier-1** crash degradation | ✅ Built | Torn-trace tolerance, atomic whole-file writes, `result.json` regeneration (PR #91). The trace is a trustworthy authority; a parked checkpoint resumes soundly. |
| **Tier-2 foundation** | ✅ Built (inert) | `RecoveryCorridor.seedFromTrace` (`src/runtime/run/recovery-corridor.ts`, PR #93), wired inert behind resume. The general/bounded forward-recovery cursor is ⏸️ **not built** (path not taken under Option C). |
| **Tier-3 reaper** (A2-now) | ✅ Built | Startup worktree reaper + run-owner lock + `reclaim` CLI (`src/runtime/fanout/worktree-reaper.ts`, `run-owner-lock.ts`, `src/cli/reclaim.ts`, PR #99). Stops orphaned-worktree leaks from a mid-fanout kill. [`durability-tier3-linkage-spec.md`](durability-tier3-linkage-spec.md). |
| **Decision inbox** (A3-now) | ✅ Built | Read-only inbox: discovery + filter on `checkpoint_waiting` + staleness triage + links to per-run resume (`src/app/inbox/`, `src/cli/inbox.ts`, PR #99). [`parallel-decision-inbox-spec.md`](parallel-decision-inbox-spec.md). |
| **Restart-cheapness** | ✅ Built | `circuit run --reuse-children-from <dead-run-folder>`: a fresh run reuses a dead run's **finished sub-run children** by their stable structural address `(step_id, branch_id)`, never resuming the dead folder (PR #106, `src/runtime/run/reuse-children.ts`). Behind a four-gate safety floor (sub-run branch, same flow id, `complete`+admissible, usable git worktree) that fails safe to a fresh run on any miss. **Documented limitation:** the child flow *version* and base commit are not checked — it assumes the same flow at the same goal. Two non-gating follow-ups stay open: a run-start git baseline + staleness probe, and a `reclaim`/inbox discovery surface. [`durability-tier3-restart-linkage-spec.md`](durability-tier3-restart-linkage-spec.md). |

---

## 4. The recompile / recursion frontier

The adaptive promise: a step discovers mid-run that its grain or equipment was wrong
and the flow **re-resolves, re-assembles, and re-compiles its remaining steps**. The
foundation is built and the first live reshape (additive equipment injection) has
landed; the **structural** path stays gated. Run reports:
[`recompile-foundation-run-report.md`](recompile-foundation-run-report.md),
[`step2-live-equipment-reshape-report.md`](step2-live-equipment-reshape-report.md).

| Step | Status | Detail |
|---|---|---|
| **Step 0** — offline demonstrator | ✅ Built (in `experiments/`) | `experiments/flow-lab/recompile-demonstrator.ts` fires the real assemble→compile chain on a simulated runtime discovery, bounded, with the catalog gate as the safety floor. Throwaway; never moves to `src/`. It proved the conservative defaults hold and that equipment injection is the safest first live reshape. |
| **Step 1** — the recursion bound | ✅ Built (in `src/`) | `RECURSION_DEPTH_CAP = 8` + an ancestor-flow-id cycle guard, threaded child-to-child across **both** child-run edges (`src/runtime/executors/sub-run.ts`, `src/runtime/fanout/branch-execution.ts`), plus a compile-time self-reference reject. This is the prerequisite any live reshape needs. |
| **Step 2** — first live reshape (equipment injection) | ✅ Built (in `src/`) | A relay bubbles up a confirmed `equipment_discovery`; the runner re-resolves equipment for the remaining relay steps and re-compiles through the existing chain, merging skills **additively** so the step sequence, routes, cursor, and corridor are untouched and there is no splice seam (PR #103, merge `4fa7dae4`; `src/flows/equipment-reshape.ts`, `src/runtime/run/equipment-reshape.ts`). Bounded (budget of 3 + per-step cycle guard), the catalog gate is the safety floor, and any miss downgrades to a recorded finding — a run that surfaces no confirmed discovery is byte-identical to before. Follow-ups: F2 (operator surface for reshapes) is ✅ **built** — an honored reshape and a parked discovery now surface in the operator summary (`equipment_reshapes` records and an `equipment_discovery_parked` warning). F1 (resume reseed) stays open and inert in every shipped flow today. [`step2-live-equipment-reshape-report.md`](step2-live-equipment-reshape-report.md). |
| **Step 3** — splice seam, splice-as-leaf, structural auto-reshape, reduced-bindings oracle | ⏸️ Deferred / 📋 reserved | Everything that reshapes the remaining step *sequence*. Separately ratified; F2 (the operator surface the Step 2 report asked for first) has now landed, so the decision is unblocked. The dedicated, decision-ready design is [`deepfork-splice-seam-spec.md`](deepfork-splice-seam-spec.md), co-designed for both the structural recompile and the splice-as-leaf forks: [`deepfork-adaptive-bubble-up-recompile-spec.md`](deepfork-adaptive-bubble-up-recompile-spec.md), [`deepfork-uniform-recursion-e3-spec.md`](deepfork-uniform-recursion-e3-spec.md). |

**Uniform recursion (E3).** The bound (piece 1 of the E3 sequence) shipped. The
non-empty `reducedBindings` legibility oracle (piece 2) and splice-as-leaf behind a
flag (piece 3) are 📋 not built. Splice-as-leaf relocates the isolation boundary, so
it is an explicit operator ratification item.

**On-demand context pull.** The runtime-binding sibling of recompile (pull *context*
at runtime, where recompile re-plans). Now ✅ **spiked offline** (PR #107): the
`experiments/flow-lab/context-pull-demonstrator.ts` pure-function module scores three
envelope strategies on the same need and shows thin-plus-pull reaching fat-push
completeness (zero starvation) at **29 carried bytes vs 293 — about a 10x reduction —
with zero irrelevant bytes**. The conservative defaults hold (no `*` query, a bounded
per-step pull budget, a legible per-pull trace). No live/`src/` query channel was
built; sequenced **after** the live recompile work matures.
[`on-demand-context-pull.md`](on-demand-context-pull.md).

---

## 5. The paper-to-site flagship flow (`explainer`)

The first hand-authored, non-`build`-shaped flow: research paper → public
interactive site, with two genuine operator forks (PICK, SIGN-OFF).

- **v1 — ✅ built and shipped** (`src/flows/explainer/`, in the catalog and
  generated surfaces, PR #90). Brief:
  [`paper-to-site-flow-brief.md`](paper-to-site-flow-brief.md).
- **Generalization test — ✅ run** on a second, unseen paper ("Attention Is All You
  Need"). Findings: [`paper-to-site-2nd-run-findings.md`](paper-to-site-2nd-run-findings.md).
  The **editorial spine generalized well**; the **operational plumbing did not**.

**Findings:**

- **P0 — recovery-binding hard-abort bug. ✅ Fixed on `main` (PR #105).** A child
  build abort made `build-step` select recovery route `stop`, but on **resume** the
  `WorkContract` carried no matching binding, so the **whole parent hard-aborted**
  and re-spent the editorial fan-out (about $6). Root cause: the resume path
  (`resumeCompiledFlowResult`) passed `workContractRef` but not
  `recoveryRouteBindings`, so the graph-runner defaulted the binding list to `[]`.
  The fix threads the same bindings the top-level path projects, so a failed child
  now **degrades onto its recovery route** instead of aborting the resumed parent.
- **P0 — resumable runs / a checkpoint after editorial** (still open), so a build
  failure does not throw away correct, expensive editorial output.
- **P1 — greenfield-scaffold gap** (the flow assumes a Node project already exists),
  the build-flow verify-contract mismatch, and the single-shot build-child budget
  ceiling.
- **P2 — promote the faked `digest`/`ideate` compose steps to real model-backed
  blocks**, and add real fidelity + a11y checks to the verify stage.
- **P3 — intake leaks the arXiv URL** into the subject/titles.
- Plus operator-noted **craft gaps** (responsive layout + animations).

---

## 6. Experiments that returned a verdict

- **Grain × separability — null.** 40 live runs (≈$24); the false-fixed rate was 0
  in every cell, so neither coherence nor verification hypothesis could be
  adjudicated. The structure chooser held its thin-conservative default. The real
  follow-up is tasks that provoke a false claim of done, not more repeats. Report:
  [`grain-chooser-run-report.md`](grain-chooser-run-report.md); design + history:
  [`grain-separability-experiment-design.md`](grain-separability-experiment-design.md),
  [`grain-experiment-deferred.md`](grain-experiment-deferred.md),
  [`grain-taskset-ready.md`](grain-taskset-ready.md). The grain fixtures live in an
  isolated set (`evals/grain-separability/`, PR #100) so they cannot contaminate the
  claim suite.

---

## 7. What's next, and what's reserved for operator ratification

**Recently shipped (between 2026-06-16 `af7345d2` and 2026-06-17 `f4d260b1`):**
Step 2 live equipment reshape (PR #103), the paper-to-site recovery-binding fix
(PR #105), restart-cheapness `--reuse-children-from` (PR #106), and the on-demand
context-pull offline spike (PR #107). All four moved off the "next/in-flight" list
below; the rows above carry the detail.

**Next (sequenced, low ambiguity):**

1. **The F2 operator surface for reshapes** — fold the `run.equipment-reshape` trace
   entries into the operator-facing run report and the needs-attention headline. The
   Step 2 report recommends this before the feature is used in anger, and before
   Step 3.
2. **Paper-to-site — the remaining P0**: a post-editorial checkpoint, so a build
   failure does not throw away correct, expensive editorial output. (The
   recovery-binding hard-abort P0 is now fixed.)
3. **The two `--reuse-children-from` follow-ups** — a run-start git baseline +
   staleness probe (close the documented version/base limitation), and a
   `reclaim`/inbox discovery surface for reusable dead-run folders. Both non-gating.

**Reserved for operator ratification (do not start without a green light):**

- **Step 3** — the splice seam, splice-as-leaf, structural auto-reshape, and the
  reduced-bindings oracle. The line between Step 2 and Step 3 is "reshape the
  remaining step *sequence*." The decision-ready design is now written:
  [`deepfork-splice-seam-spec.md`](deepfork-splice-seam-spec.md) (surface-only,
  builds nothing), with a four-phase plan whose each phase has its own gate.
- **The resolver abstraction extraction** — earnable, but waiting on a **third
  resolver instance** (context or depth) to confirm the parameters.
- **On-demand context pull — the live/`src/` query channel.** The offline spike
  (PR #107) validated the trade; building the real runtime query surface waits until
  the live recompile work matures.
- **A grain re-run** with tasks engineered to induce false-fixing (the metric the
  first run could not move).
- **The enforced-tools ratchet increment** (`TOOL_SCOPE_GAP_BASELINE = 5`).

---

## Pointers

- Run reports (history, do not edit): `recompile-foundation-run-report.md`,
  `step2-live-equipment-reshape-report.md`, `overnight-reliability-run-report.md`,
  `grain-chooser-run-report.md`, `overnight-run-report.md`,
  `paper-to-site-2nd-run-findings.md`, `equipment-scope-enforcement-report.md`,
  `e1-run-report.md`.
- The index of all idea docs, grouped by kind: [`README.md`](README.md).
