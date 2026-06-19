# North-star status — where Circuit stands

> The one doc to read to know what is built, what is in flight, and what is
> reserved for operator ratification. Written 2026-06-16; last refreshed
> 2026-06-18. This is a **living status map**, not a design doc: it points at the
> design docs and run reports, and it is grounded against the actual state of
> `main` at the time of writing (HEAD `c8026ef2`, PR #117 merged), verified
> against `src/`. Each row links to the doc that owns the detail.

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
| **context** | ✅ Built (basic + live pull, opt-in) | Route-aware context availability shipped with the M-spine (primitive 3a). The richer idea — let a step **pull more context on demand** from its parents through a typed surface — is now ✅ **built live** (PRs #112–#115), opt-in behind `enableContextDelivery` (default OFF): a typed query channel (`src/runtime/run/context-pull.ts`), pull-then-retry delivery + resume reseed (`context-delivery.ts`), and the prompt affordance + worker guidance (`shape-hints/from-zod.ts`, `build/relay-hints.ts`). A real guided worker pulls the named slice it needs (narrowly, not reflexively) and refuses honestly when a fact is unpullable. PR #116 then **thinned the Build plan** (when delivery is active it names the literal pull path instead of inlining the full synthesis; byte-identical when off/at deep depth) and **lifted the corridor skip** (head-step pulls inside a slice loop are now resolved-and-recorded, resume-safe). Measured: **quality holds** (10/10 thin workers correct, pull goes load-bearing only when the plan distillation is lossy), but plan thinning alone is **~3.9% in-flow** — the ~11x is the delivery channel's *selectivity*, not a whole-envelope shrink; the dominant fat (`checkpoint_packet`, ~31%) is the real next lever. Pull stays a **correct, safe, opt-in channel**; the recommendation is to ratify the mechanism, not default-ON (see §4 and §7). [`thin-envelope-unlock-report.md`](thin-envelope-unlock-report.md), [`context-pull-last-mile-report.md`](context-pull-last-mile-report.md), [`on-demand-context-pull.md`](on-demand-context-pull.md). |
| **equipment** | ✅ Built | Two halves on `main`: the **tools** axis (declared + enforced per-step tools via `claude-code --tools`, with an honest downgrade, PR #89) and the **skills** axis (the `equipment` resolver chooses the kit, real house-style injection rides `skill_slots`, PRs #96/#97; the skill-slot ratchet dropped 15 → 1). The enforced-tools ratchet still has one increment left (`TOOL_SCOPE_GAP_BASELINE = 5`). Specs: [`e2-equipment-scope-spec.md`](e2-equipment-scope-spec.md), [`equipment-scope-build-brief.md`](equipment-scope-build-brief.md), report: [`equipment-scope-enforcement-report.md`](equipment-scope-enforcement-report.md). |
| **model/effort** | ✅ Built (as a dial); 📋 not yet a resolver | The depth/power dial is real (`build --depth medium|high`, the power/model tier). It is **not yet a swappable resolver** — a `depth` resolver is one of the two candidate **third instances** that would earn the resolver abstraction. See [`depth-and-power.md`](depth-and-power.md). |
| **structure** | ✅ Built | The `structure` resolver (`src/flows/resolvers/structure.ts`, PR #95) is thin-conservative: it leans to **whole** and chops to **decomposed** only on a clear signal (operator ask, large surface, or high risk). The grain experiment ran and returned **null** on its metric, so the conservative default holds (see §6). The whole-grain fold is now **runnable** for build-derived flows after the close-writer fold tolerance landed (PR #102): a folded flow with passing verification lands at `needs_attention` rather than aborting. |

**The resolver abstraction itself is 📋 not extracted, on purpose.** Two **axis**
instances (structure, equipment) revealed a shared four-part shape but disagree on
three of four divergences (scope, enforcement, downgrade channel, binding time). A
**third axis instance** (context or depth) is the honest trigger before committing
a `Resolver` type — and it is **still unbuilt**. The task-aware assembler added two
new files under `src/flows/resolvers/` (`signals.ts`, `archetype.ts`; see §2), but
those are a **different layer** (signal extraction + family selection), not a third
instance of the four-axis micro-harness shape; and on-demand context-pull shipped
as a **runtime channel** (`src/runtime/run/`), not a resolver. So the four-axis
abstraction trigger remains open. Observed shape:
[`resolver-shared-shape.md`](resolver-shared-shape.md); reserved decision:
[`deepfork-resolver-abstraction-spec.md`](deepfork-resolver-abstraction-spec.md).

---

## 2. The assembler, the typed seam, and self-hosting

- **Typed seam — ✅ built.** First-class composition (M1–M9) merged. By-id package
  resolution is gone; bindings travel manifest-first; there is one shared,
  safety-floored assembly path. See
  [`../architecture/first-class-composition-optimal-path.md`](../architecture/first-class-composition-optimal-path.md)
  and [`first-class-composition-sequence.md`](first-class-composition-sequence.md).
- **Fixed-or-JIT assembler — ✅ built and general.** The same assembler produces a
  **fixed** flow (hand-authored built-ins and the `explainer` flow) and a
  **just-in-time** flow (`create`). The assembler is genuinely general, not
  build-locked.
- **Task-aware `create` — ✅ built; the dynamic / JIT direction is VIABLE (PR #117).**
  The shape-check gate ([`dynamic-assembly-shape-check.md`](dynamic-assembly-shape-check.md))
  caught `create` **task-blind**: it discarded the task text, hardcoded
  `surface_area: small` / `risk: low`, and could emit only build's spine (folded or
  full) — "build, renamed." The rebuild makes it read the task: `signals.ts`
  extracts `AssemblySignals` (family, surface, risk, domain) by **word-aware**
  keyword cues, and `archetype.ts` (resolver #2) picks an archetype **family** —
  editorial, fix, review, research, prototype, or build — and instantiates a
  task-appropriate `FlowSchematic` (the build family is **folded** by the structure
  resolver; the rest **instantiate** a proven family seed). Per-mode families compile
  to a per-mode package (`compiled-flow-file-plan.ts`). Against the pre-registered
  rule ([`assembler-rebuild-preregistration.md`](assembler-rebuild-preregistration.md)),
  the measured verdict is **VIABLE**: `P = 8/8` tasks pass, editorial feature overlap
  `E = 1.00`, `D = 7` distinct structural shapes, `V = 8/8` valid; the live depth
  arms (`fix`, `build`) reached `@complete` with correct on-task output. The win is
  **selection-and-instantiation** — it reads the task and lands the right family and
  grain — **not** genuine generation (the high overlap is *reuse* of proven seeds).
  Report: [`assembler-rebuild-run-report.md`](assembler-rebuild-run-report.md). Of the
  two **recorded follow-ups** (non-blocking, both fail-closed): per-mode runtime trust
  is **CLOSED** (PR #119 — publish now records every compiled-flow file under
  `flow_paths`; the trust gate blesses the default `circuit.json` or any recorded
  `<mode>.json` sibling; an unrecorded sibling still fails closed, now with a clear
  "mode not published" reason; default-mode trust byte-identical, M9-C intact). The
  remaining follow-up is signing off the loosened `src/flows/resolvers/` intra-flows
  import zone.
- **Genuine block-composition — 📋 RESEARCH PROBLEM, not a feature.** An offline
  Phase 2 spike (git-untracked, never merged) tried to compose a **novel** flow (a
  topology none of the six families) from typed catalog blocks. It hit **eight
  fail-closed authoring walls** before the contract gates even ran, because the typed
  block catalog does not carry the per-block / per-flow intent the safety gates
  require (execution-kind disambiguation, contract aliasing, route-DAG synthesis,
  check/relay defaulting). The walls are the safety system working, not a bug. A
  feature path exists but needs catalog enrichments plus a model in the loop for the
  irreducibly intentional choices; held as a separate research track (see §7).
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
foundation is built, the first live reshape (additive equipment injection) has
landed, and both of its follow-ups — legibility (F2) and resume (F1) — are now
closed; the **structural** path stays gated but is now fully designed (the
splice-seam spec) and proven sound offline (the Phase 0 demonstrator). Run reports:
[`recompile-foundation-run-report.md`](recompile-foundation-run-report.md),
[`step2-live-equipment-reshape-report.md`](step2-live-equipment-reshape-report.md),
[`f2-and-splice-spec-run-report.md`](f2-and-splice-spec-run-report.md),
[`splice-phase01-run-report.md`](splice-phase01-run-report.md).

| Step | Status | Detail |
|---|---|---|
| **Step 0** — offline demonstrator | ✅ Built (in `experiments/`) | `experiments/flow-lab/recompile-demonstrator.ts` fires the real assemble→compile chain on a simulated runtime discovery, bounded, with the catalog gate as the safety floor. Throwaway; never moves to `src/`. It proved the conservative defaults hold and that equipment injection is the safest first live reshape. |
| **Step 1** — the recursion bound | ✅ Built (in `src/`) | `RECURSION_DEPTH_CAP = 8` + an ancestor-flow-id cycle guard, threaded child-to-child across **both** child-run edges (`src/runtime/executors/sub-run.ts`, `src/runtime/fanout/branch-execution.ts`), plus a compile-time self-reference reject. This is the prerequisite any live reshape needs. |
| **Step 2** — first live reshape (equipment injection) | ✅ Built (in `src/`) | A relay bubbles up a confirmed `equipment_discovery`; the runner re-resolves equipment for the remaining relay steps and re-compiles through the existing chain, merging skills **additively** so the step sequence, routes, cursor, and corridor are untouched and there is no splice seam (PR #103, merge `4fa7dae4`; `src/flows/equipment-reshape.ts`, `src/runtime/run/equipment-reshape.ts`). Bounded (budget of 3 + per-step cycle guard), the catalog gate is the safety floor, and any miss downgrades to a recorded finding — a run that surfaces no confirmed discovery is byte-identical to before. Follow-ups: F2 (operator surface for reshapes) is ✅ **built** (PR #108) — an honored reshape and a parked discovery now surface in the operator summary (`equipment_reshapes` records and an `equipment_discovery_parked` warning). F1 (resume reseed) is now ✅ **built** (PR #110): `seedEquipmentReshapeFromTrace` (`src/runtime/run/equipment-reshape.ts`) replays each honored reshape onto the loaded flow on resume, wired at `checkpoint-resume.ts`; still inert in every shipped flow today (no flow routes a passing relay into a checkpoint), but the fix lands ahead of the flow that needs it. [`step2-live-equipment-reshape-report.md`](step2-live-equipment-reshape-report.md), [`splice-phase01-run-report.md`](splice-phase01-run-report.md). |
| **Step 3** — splice seam, splice-as-leaf, structural auto-reshape, reduced-bindings oracle | ⏸️ Phase 0/1 done; Phase 2/3 📋 reserved | Everything that reshapes the remaining step *sequence*. The decision-ready design is now written and wired: [`deepfork-splice-seam-spec.md`](deepfork-splice-seam-spec.md) (PR #108, surface-only), co-designed for both the structural recompile and the splice-as-leaf forks: [`deepfork-adaptive-bubble-up-recompile-spec.md`](deepfork-adaptive-bubble-up-recompile-spec.md), [`deepfork-uniform-recursion-e3-spec.md`](deepfork-uniform-recursion-e3-spec.md). Its four-phase plan, each phase its own gate: **Phase 0** — offline splice demonstrator ✅ **built** (PR #111, `experiments/flow-lab/splice-demonstrator.ts`, 14 tests; the four-piece migration contract holds and the gate fails closed; it surfaced four caveats as Phase 2 design inputs — notably the outbound re-home can *launder a malformed exit route*, and a structural splice must route the **full parse + compile**, not the additive reshaper's lighter `safeParse`-on-CompiledFlow); **Phase 1** — the additive resume reseed (F1) ✅ **built** (Step 2 row); **Phase 2** — the structural `spliceIntoRemainingSteps` seam in `src/` behind a flag, and **Phase 3** — splice-as-leaf on the same seam, both 📋 **reserved** (no `spliceIntoRemainingSteps` in `src/` today — it lives only in the experiment). Recommendation: design Phase 2 *with* the first concrete flow that needs to decompose a step mid-run, behind a `CompiledFlowEngineFlags` opt-in, never into the engine unconditionally. [`splice-phase01-run-report.md`](splice-phase01-run-report.md). |

**Uniform recursion (E3).** The bound (piece 1 of the E3 sequence) shipped. The
non-empty `reducedBindings` legibility oracle (piece 2) and splice-as-leaf behind a
flag (piece 3) are 📋 not built. Splice-as-leaf relocates the isolation boundary, so
it is an explicit operator ratification item.

**On-demand context pull — now ✅ built live (opt-in), not just spiked.** The
runtime-binding sibling of recompile (pull *context* at runtime, where recompile
re-plans). The offline spike (PR #107) validated the trade (thin-plus-pull reaches
fat-push completeness at ~10x fewer carried bytes); PRs #112–#115 then built the
**live channel** in `src/`: a typed query channel (`context-pull.ts`, with the
untrusted `field_path` fenced by `Object.hasOwn`), pull-then-retry delivery that
folds the answered slice and re-runs the step once (`context-delivery.ts`), a resume
reseed (`seedContextDeliveryFromTrace`), and the prompt affordance + conservative
worker guidance. A battle-test and a real-guided-worker confirmation showed a
starving worker pulls the **one named slice** it needs, stays conservative when the
envelope suffices, and refuses honestly when a fact is unpullable; the engine
resolves the real model's request end-to-end. The two blockers the last-mile report
named are now **both built** (PR #116, opt-in, verify green): the Build plan **thins**
when delivery is active (stops inlining the full `observations` synthesis and names
the literal pull path instead, gated on a new `contextDeliveryActive` signal;
byte-identical when off or at deep depth), and the **corridor skip is lifted** so a
head-step pull inside an active slice loop is now resolved-and-recorded (legible,
fail-safe, resume-safe). The measured result reframed the payoff honestly: **quality
holds** (10/10 thin workers correct; pull goes load-bearing exactly when the plan
distillation is lossy), but **plan thinning alone is ~3.9% in-flow**, not 10x — the
~11x is the **delivery channel's selectivity** (a narrow pull vs a full push), not a
whole-envelope shrink. The dominant remaining fat is the `checkpoint_packet` (~31% of
the act-step envelope, which the implementer never reads); thinning **that** is the
real next byte lever. **It stays opt-in (`enableContextDelivery` default OFF); the
report's recommendation is to ratify the mechanism, NOT default-ON for byte reduction.**
[`thin-envelope-unlock-report.md`](thin-envelope-unlock-report.md),
[`context-pull-last-mile-report.md`](context-pull-last-mile-report.md),
[`runtime-binding-battle-test-report.md`](runtime-binding-battle-test-report.md),
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

**Recently shipped (between 2026-06-17 `f4d260b1` and 2026-06-18 `c8026ef2`):**
the F2 reshape operator surface + the splice-seam spec (PR #108), the F1
equipment-reshape resume reseed + the Phase 0 splice demonstrator (PRs #110, #111),
the on-demand context-pull **live channel** (PRs #112–#115 — typed query channel,
pull-then-retry delivery, real-guided-worker last-mile, opt-in/default-OFF), the
**task-aware assembler** (PR #117 — verdict VIABLE), the **per-mode runtime trust**
gate (PR #119), and the **thin-envelope unlock** (PR #116 — thinned Build plan +
lifted corridor skip; quality holds, payoff reframed as ~3.9% in-flow vs the delivery
channel's selectivity, still opt-in). All moved off the "next/in-flight" list below;
the rows above carry the detail.

**Next (sequenced, low ambiguity):**

1. **The dynamic-vs-reference live experiment** — the task-aware assembler report's
   recommended next step. On the two cleanest families (`fix`, `build`, where the
   live arms already succeed), compare an **instantiated-generated** flow against the
   hand-authored reference on a small held-out task set, with the cost-capture
   instrument, to learn whether the generated arm finishes *as well as* the
   hand-authored bar and at what cost. Do **not** yet spend on the
   genuine-block-composition arm (gated behind the Phase 2 catalog enrichments).
   [`assembler-rebuild-run-report.md`](assembler-rebuild-run-report.md).
2. **Paper-to-site — the remaining P0**: a post-editorial checkpoint, so a build
   failure does not throw away correct, expensive editorial output. (The
   recovery-binding hard-abort P0 is now fixed.)
3. **The remaining task-aware-assembler follow-up** (non-blocking): sign off the
   loosened `src/flows/resolvers/` import zone. (Per-mode runtime trust is **done** —
   PR #119 blesses recorded `<mode>.json` siblings and fails closed with a clear
   reason for unrecorded ones.)
4. **The two `--reuse-children-from` follow-ups** — a run-start git baseline +
   staleness probe (close the documented version/base limitation), and a
   `reclaim`/inbox discovery surface for reusable dead-run folders. Both non-gating.

**Reserved for operator ratification (do not start without a green light):**

- **Step 3 — Phase 2 and Phase 3** (the structural `spliceIntoRemainingSteps` seam
  in `src/` behind a flag, then splice-as-leaf on the same seam). Phase 0 (offline
  demonstrator) and Phase 1 (F1 resume reseed) are done; Phase 2/3 reshape the
  remaining step *sequence*, fail open if rushed, and need a green light — ideally
  designed *with* the first concrete flow that wants to decompose a step mid-run, and
  treating the demonstrator's four caveats as the spec.
  [`deepfork-splice-seam-spec.md`](deepfork-splice-seam-spec.md).
- **Genuine block-composition (the Phase 2 assembler research track).** The dynamic
  assembler is VIABLE *by instantiation*; composing a **novel** flow from typed
  blocks is a RESEARCH PROBLEM (eight fail-closed authoring walls). A feature path
  needs catalog enrichments (execution-capability table, contract-alias solver,
  route-DAG synthesizer, check/relay defaulting) plus a model for the irreducibly
  intentional choices. Hold as a separate track.
  [`assembler-rebuild-run-report.md`](assembler-rebuild-run-report.md).
- **Defaulting on-demand context-pull ON.** The live channel is built and opt-in
  (`enableContextDelivery` default OFF). The two prerequisites it used to wait on —
  thinning the Build envelope and lifting the corridor skip — are now **both built**
  (PR #116), and the measurement says quality holds. But defaulting ON still should
  **not** be done for byte reduction: plan thinning alone is ~3.9% in-flow, and the
  dominant fat (`checkpoint_packet`, ~31% of the act-step envelope, which the
  implementer never reads) is untouched. The honest next move toward a real
  whole-envelope win is to thin the `checkpoint_packet`, then revisit a default flip
  with the two thinnings stacked. The mechanism is **ratifiable now**; the default
  flip is not. [`thin-envelope-unlock-report.md`](thin-envelope-unlock-report.md).
- **The resolver abstraction extraction** — earnable, but still waiting on a **third
  axis-resolver** (context or depth) to confirm the parameters. The new
  `signals`/`archetype` resolvers are a different layer (§1), not that third instance.
- **A grain re-run** with tasks engineered to induce false-fixing (the metric the
  first run could not move).
- **The enforced-tools ratchet increment** (`TOOL_SCOPE_GAP_BASELINE = 5`).

---

## Pointers

- Run reports (history, do not edit): `recompile-foundation-run-report.md`,
  `step2-live-equipment-reshape-report.md`, `f2-and-splice-spec-run-report.md`,
  `splice-phase01-run-report.md`, `context-pull-live-run-report.md`,
  `runtime-binding-battle-test-report.md`, `context-pull-last-mile-report.md`,
  `dynamic-assembly-shape-check.md`, `assembler-rebuild-preregistration.md`,
  `assembler-rebuild-run-report.md`, `overnight-reliability-run-report.md`,
  `grain-chooser-run-report.md`, `overnight-run-report.md`,
  `paper-to-site-2nd-run-findings.md`, `equipment-scope-enforcement-report.md`,
  `e1-run-report.md`.
- The index of all idea docs, grouped by kind: [`README.md`](README.md).
