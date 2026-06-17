# North-star status — where Circuit stands

> The one doc to read to know what is built, what is in flight, and what is
> reserved for operator ratification. Written 2026-06-16. This is a **living status
> map**, not a design doc: it points at the design docs and run reports, and it is
> grounded against the actual state of `main` at the time of writing (HEAD
> `af7345d2`), verified against `src/`. Each row links to the doc that owns the
> detail.

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
| **context** | ✅ Built (basic) | Route-aware context availability shipped with the M-spine (primitive 3a). The richer idea — let a step **pull more context on demand** from its parents through a typed surface — is 📋 captured in [`on-demand-context-pull.md`](on-demand-context-pull.md), sequenced after the live-recompile work. |
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
| **Restart-cheapness** (next) | 📋 Surfaced | `circuit run --reuse-children-from <dead-run-folder>`: re-enter by addressing prior children by stable structural address, never resume the dead folder. Spec only (PR #101). The A2-later linkage and A3-later bulk-resume both fold into this. [`durability-tier3-restart-linkage-spec.md`](durability-tier3-restart-linkage-spec.md). |

---

## 4. The recompile / recursion frontier

The adaptive promise: a step discovers mid-run that its grain or equipment was wrong
and the flow **re-resolves, re-assembles, and re-compiles its remaining steps**. The
foundation is built; the live path is staged. Run report:
[`recompile-foundation-run-report.md`](recompile-foundation-run-report.md).

| Step | Status | Detail |
|---|---|---|
| **Step 0** — offline demonstrator | ✅ Built (in `experiments/`) | `experiments/flow-lab/recompile-demonstrator.ts` fires the real assemble→compile chain on a simulated runtime discovery, bounded, with the catalog gate as the safety floor. Throwaway; never moves to `src/`. It proved the conservative defaults hold and that equipment injection is the safest first live reshape. |
| **Step 1** — the recursion bound | ✅ Built (in `src/`) | `RECURSION_DEPTH_CAP = 8` + an ancestor-flow-id cycle guard, threaded child-to-child across **both** child-run edges (`src/runtime/executors/sub-run.ts`, `src/runtime/fanout/branch-execution.ts`), plus a compile-time self-reference reject. This is the prerequisite any live reshape needs. |
| **Step 2** — first live reshape (equipment injection) | 🚧 In flight | Re-resolve equipment on the remaining spec and re-compile through the existing chain. Additive, needs no splice. On a branch, not yet on `main`. |
| **Step 3** — splice seam, splice-as-leaf, structural auto-reshape, reduced-bindings oracle | ⏸️ Deferred / 📋 reserved | Everything that reshapes the remaining step *sequence*. Separately ratified. Specs: [`deepfork-adaptive-bubble-up-recompile-spec.md`](deepfork-adaptive-bubble-up-recompile-spec.md), [`deepfork-uniform-recursion-e3-spec.md`](deepfork-uniform-recursion-e3-spec.md). |

**Uniform recursion (E3).** The bound (piece 1 of the E3 sequence) shipped. The
non-empty `reducedBindings` legibility oracle (piece 2) and splice-as-leaf behind a
flag (piece 3) are 📋 not built. Splice-as-leaf relocates the isolation boundary, so
it is an explicit operator ratification item.

**On-demand context pull.** The runtime-binding sibling of recompile (pull *context*
at runtime, where recompile re-plans). 📋 captured, sequenced **after** Steps 2–3.
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

**Open findings (none fixed on `main` yet):**

- **P0 — recovery-binding hard-abort bug.** A child build abort makes `build-step`
  select recovery route `stop`, but the `WorkContract` declares no matching binding,
  so the **whole parent hard-aborts** and re-spends the editorial fan-out. Fix is
  🚧 in flight on `feat/paper-to-site-flow`.
- **P0 — resumable runs / a checkpoint after editorial**, so a build failure does
  not throw away correct, expensive editorial output.
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

**Next (sequenced, low ambiguity):**

1. **Step 2 — the first live reshape (equipment injection).** 🚧 in flight; the
   foundation (bound + demonstrator) is in place.
2. **Restart-cheapness (`--reuse-children-from`).** 📋 spec'd; the chosen
   forward-recovery direction under Option C.
3. **Paper-to-site P0 fixes** — recovery-binding degradation and a
   post-editorial checkpoint.

**Reserved for operator ratification (do not start without a green light):**

- **Step 3** — the splice seam, splice-as-leaf, structural auto-reshape, and the
  reduced-bindings oracle. The line between Step 2 and Step 3 is "reshape the
  remaining step *sequence*."
- **The resolver abstraction extraction** — earnable, but waiting on a **third
  resolver instance** (context or depth) to confirm the parameters.
- **On-demand context pull** — after Steps 2–3, once the runtime-binding seam is
  proven.
- **A grain re-run** with tasks engineered to induce false-fixing (the metric the
  first run could not move).
- **The enforced-tools ratchet increment** (`TOOL_SCOPE_GAP_BASELINE = 5`).

---

## Pointers

- Run reports (history, do not edit): `recompile-foundation-run-report.md`,
  `grain-chooser-run-report.md`, `overnight-run-report.md`,
  `paper-to-site-2nd-run-findings.md`, `equipment-scope-enforcement-report.md`,
  `e1-run-report.md`.
- The index of all idea docs, grouped by kind: [`README.md`](README.md).
