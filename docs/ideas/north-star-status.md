# North-star status — where Circuit stands

> The one doc to read to know what is built, what is in flight, and what is
> reserved for operator ratification. Written 2026-06-16; last refreshed
> 2026-06-21. This is a **living status map**, not a design doc: it points at the
> design docs and run reports, and it is grounded against the actual state of
> `main` at the time of writing (HEAD `a8b2f6c8`, PR #123 merged), verified
> against `src/`. Each row links to the doc that owns the detail.
> Last refreshed against HEAD `a07960a0` (PR #141 merged — the generator's
> **PROPOSE half** now runs **4/4 runnable** on the real-task driver after the
> vocabulary-class repair-guidance fix + raised repair budget; still engine-first,
> no product command yet; see §2 and §7). Previously refreshed against HEAD
> `21e44911` (PR #140 — `proposeFlow` first landed). Before that, HEAD `2983ec2b`
> (PR #138 merged — Phase D, the shape-sensitivity live experiment), which landed the
> **frontier phases A–D**:
> the two-layer composer-intelligence frontier (producibility-aware *selection* and
> family *reachability*) is now **shipped** for fix, build, and goal; a **second
> family** (build) composes from blocks and runs end-to-end; and the topology question
> is answered — flow shape is **efficacy-flat and cost-real** on these tasks (see §2
> and §6). Earlier on `main`: PR #133 (composed **fanout** runs LIVE end-to-end), PR
> #132 (the composed-vs-reference efficacy arm landed **COMPOSITION-VIABLE**, the first
> efficacy-grade head-to-head between a flow Circuit **composed from blocks** and a
> hand-authored one), the verification-reads engine fix, and PRs #130 + #131
> (genuine-LINEAR live close + the offline runnability wall). With Phase C (#135),
> **all four composed shapes (linear, loop, sub-run, fanout) now run a full composed
> flow to `@complete`** — sub-run was the last that had only run its step in isolation.

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
  Report: [`assembler-rebuild-run-report.md`](assembler-rebuild-run-report.md). The
  recommended next step then **ran and returned a verdict (PR #121):** a live
  experiment compared an **instantiated-generated** flow against the hand-authored
  reference on `fix` + `build` (48 runs, pinned `claude-haiku-4-5`, both arms
  Circuit) and scored **WORTH-INVESTING** on the pre-registered §5 rule — the
  generated flow matched the reference on quality and honesty (**0% false-fixed
  across all 48 runs**, 0 pipeline failures), and on `build` the grain fold paid for
  itself (whole on small/low tasks at ~1/3 the cost at equal quality; full
  decomposed shape held on large/high). It proves the **instantiation** path on two
  families, not genuine block-composition.
  [`dynamic-vs-reference-run-report.md`](dynamic-vs-reference-run-report.md). Of the
  two **recorded follow-ups** (non-blocking, both fail-closed): per-mode runtime trust
  is **CLOSED** (PR #119 — publish now records every compiled-flow file under
  `flow_paths`; the trust gate blesses the default `circuit.json` or any recorded
  `<mode>.json` sibling; an unrecorded sibling still fails closed, now with a clear
  "mode not published" reason; default-mode trust byte-identical, M9-C intact). The
  remaining follow-up is signing off the loosened `src/flows/resolvers/` intra-flows
  import zone.
- **Genuine block-composition — 📋 RESEARCH PROBLEM, with the first non-linear
  increment now SHIPPED.** An offline Phase 2 spike (git-untracked, never merged)
  tried to compose a **novel** flow (a topology none of the six families) from typed
  catalog blocks. It hit **eight fail-closed authoring walls** before the contract
  gates even ran, because the typed block catalog does not carry the per-block /
  per-flow intent the safety gates require (execution-kind disambiguation, contract
  aliasing, route-DAG synthesis, check/relay defaulting). The walls are the safety
  system working, not a bug. A feature path exists but needs catalog enrichments plus
  a model in the loop for the irreducibly intentional choices; held as a separate
  research track (see §7). **Update (PR #123, merged `a8b2f6c8`):** the composer was a
  pure **linearizer** (it only ever emitted forward routes), and it now proposes its
  first **non-linear** shape: a bounded inspect/fix/verify **loop**
  (`CompositionRole.loopBackTo` emits a `retry` back-edge to an upstream step). Proven
  offline `$0` and locked by test to be **valid** (real gates), **live** (the
  work-contract projection auto-derives a `narrow_scope` recovery binding that accepts
  the `failed_check` cause a failed verification raises, exactly as `fix`'s
  hand-authored loop), and **bounded** (`must_respect_max_attempts`). Default-OFF;
  built-ins byte-identical. An offline probe sweep then mapped the rest of the
  non-linear frontier into **three tiers** by new-machine cost: **free** re-entry
  edges (the loop, shipped); **static-analysis-bounded** forward branches and
  self-loops (need an in-vocabulary route key plus route-aware `optional_inputs` on
  consumers a skip arm orphans, no live run); and **execution-machine-bound** sub-run
  and fanout (the actuals are already in the menu, but the execution descriptor is
  large and dependency-bearing — the catalog-coverage wall). **Update (PR #124,
  merged `e0241662`): sub-run is now SHIPPED** — the composer emits its first shape
  that crosses a **flow boundary** (one step runs a whole child flow, admitted back
  only through the child's `RunResult` verdict). Three walls fell minimally: the
  raw-generic exclusion was relaxed so the goal/pursuit families (which register only
  their raw generic) become composable; `buildExecution` now synthesizes the sub-run
  descriptor (its `flow_ref` taken from the bound donor actual, not parsed from the
  name); and a single-kind sub-run block force-emits its four-key execution. Proven
  `$0` and locked by test as **valid** (real floor), **live** (runs the child and
  gates on its verdict, pinned to the gate's own abort reason), and **bounded** (the
  runtime recursion cap refuses the composer's own emitted step before any child
  starts), never *sensible*; `GOAL_THEN_FIX` is the milestone role set. Default-OFF;
  built-ins byte-identical; adversarially reviewed clean. **Update (PR #125, merged
  `9866ccf0`, then PR #126, merged `e7569115`): fanout is now SHIPPED and at full
  validity** — the composer emits its first **multi-child** shape (one step fans out
  to a fixed set of child flows in parallel, joined by aggregate-survivors). PR #125
  landed it **valid** and **bounded** (at the recursion cap every branch refuses, no
  child starts) with the **live** join honestly walled: the join wrote its aggregate
  against the donor flow's strict relay schema, which a child `RunResult` does not
  match. PR #126 **lifted that wall** by minting one dotted generic aggregate contract
  (`fanout.aggregate@v1`) that types the envelope but leaves each branch's body open,
  so the aggregate write validates while the survivors join admits any complete child
  run — the first **genuine live** multi-child pass for a composed flow. With this the
  **loop / sub-run / fanout validity ladder is complete**: all three non-linear shapes
  compose, run their children, and pass on real gates. Default-OFF; built-ins
  byte-identical (the composer is tree-shaken out of the shipped CLI); adversarially
  reviewed MERGE/0-block, the proof falsified-and-recoupled. **Update (PR #130, merged
  `9ac8596c`): a plain-LINEAR composed short-tail flow now runs to `@complete`** — the
  linear analog of the fanout unlock, on the ordinary `close-with-evidence` terminal. A
  novel triage shape (frame→gather→diagnose→close) cannot produce the family-result
  evidence a `fix`/`build` close requires, so it used to abort at close. The fix mirrors
  the fanout one: register a loose `flow.result@v1` body plus a reads-agnostic generic
  close builder, and the composer rebinds the terminal to the generic when the family
  result's required reads are not produced upstream. Honesty held — the outcome still
  derives from the terminal route, not the body (a degraded upstream relay closes
  `stopped`, not `complete`). **Update (PR #131, merged `fb07cdd6`): an offline
  RUNNABILITY check now catches un-runnable composed flows the structural floor was blind
  to.** A compose/close writer declares required upstream reads by family schema, and the
  run aborts the instant a required read has no producer. `evaluateRunnability` runs the
  real runtime resolvers offline and reports every step that would abort; opt-in
  `composeFlow({enforceRunnability:true})` turns that into a wall (default-OFF →
  byte-identical, proven by a FIDELITY test against the real runtime path). It surfaced
  that `RESEARCH_THEN_BUILD` — the pre-registered Phase 0 milestone shape — is
  offline-*valid* but not *runnable* (its build-family `plan` step needs a `build.brief`
  the compose frame can never produce), a finding **reserved for an operator decision**:
  re-point the milestone at a runnable shape, or enforce runnability by default. The last
  unsynthesized shape is the **Tier-2 forward branch / self-loop** (route-aware
  `optional_inputs`), low value per the strategic read; the composer-intelligence
  follow-up named here — **producibility-aware selection** (repair, not just detect) — has
  since SHIPPED as frontier Phase A (PR #134), and the build/goal reachability that the
  `RESEARCH_THEN_BUILD` wall pointed at shipped as Phases B/C (PRs #135/#136), so a
  checkpoint-fronted build chain (`BUILD_LINEAR_FULL`) is now runnable. (The
  `RESEARCH_THEN_BUILD` role set itself, a multi-family research→build arc, still walls
  honestly: selection finds no single runnable family for it — the floor working, not a
  gap. The pre-registered Phase 0 milestone decision is unchanged.) Everything
  past this is **efficacy** — is a composed shape as good as its hand-authored reference —
  which needs new harness wiring and a live spend; that arm has since run for both the fix
  and build families (see §2 and §6).
  [`non-linear-composition-frontier.md`](non-linear-composition-frontier.md). **Update
  (✅ on `main`, PR #132 `cb5fb81d`): the efficacy arm RAN TWICE and the re-run on the
  fixed engine landed COMPOSITION-VIABLE — the first efficacy-grade head-to-head a
  composed flow has cleared.** An opt-in `--with-composed`
  third arm runs a genuinely composed fix flow (`frame→gather-context→diagnose→act→
  run-verification→close-with-evidence`, all block-level, not delegating) against the
  **same hidden objective tests** as the hand-authored `fix` reference. The **first** run
  was PIPELINE-BROKEN: the composed `run-verification` step aborted on every task, root cause
  the **verification-reads coupling wall** — a verification writer sources its command list
  from an upstream typed report (`fix.verification` reads `fix.brief@v1`), enforced
  imperatively in `loadCommands` and NOT captured by the block's input contracts; the composed
  arc had no hand-wiring, so the step omitted the brief read and aborted (the gap the PR #131
  runnability detector disclosed as uncovered, now actually hit). The fix: a `reads` descriptor
  on every source-coupled verification writer, the composer injects each required verification
  read or **walls honestly** (a verification writer has no reads-agnostic generic to rebind to,
  unlike the #130 terminal close), `evaluateRunnability` now covers verification reads, and a
  golden test locks the invariant universally; built-ins stay byte-identical. The **re-run** on
  the fixed engine (under operator sign-off, ~$20, pinned haiku, 12 held-out fix runs) cleared
  the wall on all 12 (`pipeline=ok, steps=6`): objective-fixed **12/12** vs reference 11/12,
  **0 false-fixed**, ~16% cheaper ($0.1624 vs $0.1931 median), ~19% faster (101.5s vs 125.5s),
  **0 pipeline failures** (was 12/12) → **COMPOSITION-VIABLE**. The one honest asymmetry is
  **proof richness**: composed mean proof quality **0** vs reference **3** — the leaner 6-block
  arc closes with the generic `flow.result@v1` writer and skips the fix family's auxiliary
  regression-baseline / regression-rerun / change-set proof steps, so it leaves a generic,
  thinner receipt (not "no evidence" — verification passed and claim-parse is clean), and that
  is part of why it is cheaper. Closing that gap is the natural next frontier, not a viability
  blocker. [`composed-arm-finding`](../../evals/dynamic-vs-reference/composed-arm-finding.md).
  **Update (PR #133, merged `f42c2e4e`): the composed FANOUT shape now runs LIVE to
  `@complete` through its terminal close.** The fanout unlock (#125/#126) proved the fanout
  *step* runs live, but it ran that step in **isolation** — the full `FANOUT_PARALLEL_BUILD`
  flow still aborted at the terminal, because `selectActual` bound the close to the prototype
  family result (`prototype.result@v1`), whose close builder requires reading
  `prototype.plan@v1`; the plan output is **consumed** by the intermediate fanout step, so the
  terminal evidence-soak (which folds only *unconsumed* upstream readables) never lists the plan
  read and the runtime close-read resolver throws. The #130 terminal-close rebind was meant to
  catch this but its predicate was too lenient — it asked "is the required read's *schema*
  produced upstream" (true) instead of "will the terminal close actually *read* it" (false). The
  fix sharpens the rebind predicate to the close's **resolved input** (`Object.values(input)`),
  so the terminal falls back to the reads-agnostic generic `flow.result@v1` whenever the family
  close would abort at runtime — exactly as the linear triage shape does. A live test runs the
  full compiled fanout flow through the real engine (`runCompiledFlow`): both children spawn
  (`childRunnerCalls === 2`, ids `['build','fix']`) and the run closes `@complete` writing a
  `flow.result@v1` body. With this, **all three non-linear shapes (loop, sub-run, fanout) run a
  full composed flow end-to-end**, where before only the linear triage (#130), the bounded loop,
  and the isolated steps did. Default-OFF; built-ins byte-identical; adversarially reviewed (the
  no-regression argument: the new "preserve family" condition is exactly the runtime-success
  condition, so any newly-rebound flow was already aborting at runtime). The remaining
  composer-intelligence frontier resolves to **two layers** — producibility-aware *selection*
  (don't bind a writer whose required reads no upstream selection produces; prefer the producible
  family) and family *reachability* (expose checkpoint-gated entry contracts so build/goal chains
  can start) — detailed in
  [`non-linear-composition-frontier.md`](non-linear-composition-frontier.md). **Update (frontier
  phases A–D, merged `67594dfa`…`2983ec2b`): both layers are now SHIPPED, a second family
  composes, and the topology question is answered.** (A, PR #134) producibility-aware *selection*
  is built: `selectActual` breaks a family-rank tie toward the family whose whole-line writer
  reads are least starved (`computeFamilyCoherence`), turning the runnability gate from
  detect-only into **repair-then-wall** — a compose-only shape that greedily bound `explainer`
  (and aborted at `plan`) now binds the runnable `prototype` family end-to-end, while a role set
  with no runnable family still walls. (C, PR #135) the `goal` family is now *reachable*: a
  composed `goal` step needs to read `goal.clarified-task@v1`, so an upstream `clarify` relay
  produces it and a new always-on intermediate compose-reads pass wires it in;
  `GOAL_CLARIFY_THEN_FIX` now composes, validates, **and runs end-to-end** — sub-run was the last
  shape that had only run its step in isolation, so **all four composed shapes now run full
  flows**. (B, PR #136) the `build` family is now *reachable*: its content-checkpoint `frame`
  step emits a readable `build.brief@v1` (a `checkpointWritesReport` flag adds the report path and
  the donor's `report_template`), so `BUILD_LINEAR_FULL` composes and is runnable offline. (B-live,
  PR #137) `BUILD_LINEAR_FULL` ran against the hand-authored build reference on the same hidden
  tests — **4/4 objective-fixed, 0 false-fixed, strictly cheaper on every task** ($0.118 vs $0.191
  median); the **second family** to compose from blocks and close honestly, an existence proof at
  lower cost (RAW aggregate, no verdict — the composed decision rule is fix-only; the tasks were
  non-discriminating). (D, PR #138) a shape-sensitivity live experiment varied the same fix arc
  across three topologies (lean 5-block / full 6-block / loop 6-block+retry, 36 runs): **flow
  topology is efficacy-flat and cost-real** — the arms tie on the objective (lean 11/12 vs 12/12 is
  one rep-flip the miss-analysis traces to model variance on a fix reachable without the dropped
  block), but cost and latency track block count cleanly (lean ~32% cheaper, ~31% faster), and the
  loop's recovery route never fired so it cost the same as full. The read: **step-level judgement,
  not graph shape, is the scarce ingredient** — graph shape is close to free on efficacy and not
  free on cost.
  [`composed-build-arm-finding`](../../evals/dynamic-vs-reference/composed-build-arm-finding.md),
  [`composed-shape-sensitivity-finding`](../../evals/dynamic-vs-reference/composed-shape-sensitivity-finding.md).
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
- **P0 — resumable runs / a checkpoint after editorial. ✅ Fixed (PR #120).** The
  flow did its expensive editorial fan-out (digest → ideate → tournament → harden →
  PICK → spec) and then delegated the build to a child sub-run, with no durable
  boundary between "editorial done" and "build done" — so a build failure re-spent
  the editorial (about $6). The fix inserts **two** checkpoints: a post-editorial
  `build-gate-step` (plan, after `spec`), and a fresh `retry-gate-step` (act) that
  `build-step`'s `stop` recovery route lands on when the child build closes
  non-complete. A 3-arm offline engine probe ($0) proved checkpoint-**only** is
  insufficient (a build failure closes the run terminally with the gate already
  resolved → not resumable → editorial re-run); routing back to the resolved gate
  aborts; only the second, never-resolved gate parks the run **resumably**, so the
  editorial is recorded once and reused. Pure flow wiring in
  `src/flows/explainer/data.ts`; no engine change. A real-explainer end-to-end test
  drives intake → failed build → retry-gate and asserts `digest`/`tournament`/
  `hardening`/`spec`/`build` each enter exactly once across all resumes.
- **P1 — greenfield-scaffold gap** (the flow assumes a Node project already exists),
  the build-flow verify-contract mismatch, and the single-shot build-child budget
  ceiling.
- **P2 — promote the faked `digest`/`ideate` compose steps to real model-backed
  blocks**, and add real fidelity + a11y checks to the verify stage.
- **P3 — intake leaks the arXiv URL** into the subject/titles.
- Plus operator-noted **craft gaps** (responsive layout + animations).

---

## 6. Experiments that returned a verdict

- **Dynamic vs reference — WORTH-INVESTING.** 48 live runs (8 held-out tasks × 2
  arms × 3 reps, pinned `claude-haiku-4-5`). A flow **instantiated** from a
  plain-English task (`circuit create`, default mode) finished *as well as* the
  hand-authored reference on `fix` and `build`: quality within margin, **0%
  false-fixed across all 48 runs**, 0 pipeline failures. `fix` is a cost wash (same
  seed, 13 steps both arms); `build` folds to a thinner `whole` shape on small/low
  tasks (~1/3 the cost at equal quality) and holds the full `decomposed` shape on the
  large/high task. Proves the **instantiation** path, not genuine block-composition.
  The pre-registered §5 rule was locked before any data; the one generated miss was
  an honest partial, not a laundered done. Report:
  [`dynamic-vs-reference-run-report.md`](dynamic-vs-reference-run-report.md); brief +
  rule: [`dynamic-vs-reference-experiment-brief.md`](dynamic-vs-reference-experiment-brief.md);
  next direction (breadth-first):
  [`dynamic-vs-reference-followup.md`](dynamic-vs-reference-followup.md).
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
- **Composed vs reference — COMPOSITION-VIABLE (✅ on `main`, PR #132 `cb5fb81d`).** The
  first time a flow Circuit **composed from blocks** was scored against a hand-authored one
  on the same hidden objective tests — and it cleared the bar. The first run was PIPELINE-BROKEN (the
  verify→close tail aborted on the verification-reads coupling wall); that wall is fixed and
  the re-run on the fixed engine ran clean on all 12: objective-fixed **12/12** vs reference
  11/12, **0 false-fixed**, ~16% cheaper, ~19% faster, **0 pipeline failures** → VIABLE. The
  one honest gap is proof richness — the leaner composed arc leaves a generic receipt
  (proof quality 0 vs 3), not the fix family's purpose-built proof bundle, which is part of
  why it is cheaper. Detail in §2.
  [`composed-arm-finding`](../../evals/dynamic-vs-reference/composed-arm-finding.md).
- **Composed BUILD vs reference — existence proof at lower cost (✅ on `main`, PR #137
  `41a86da0`).** The **second** family to compose genuinely from blocks and run end-to-end on
  external-truth hidden tests. `BUILD_LINEAR_FULL` matched the hand-authored build reference:
  **4/4 objective-fixed, 0 false-fixed, 0 pipeline failures, strictly cheaper on every task**
  ($0.118 vs $0.191 median; the most expensive composed run cost less than the cheapest
  reference). This is a RAW aggregate with **no verdict** — the composed decision rule is
  pre-registered for fix only, and all three arms scored 100% (the tasks did not discriminate),
  reps=1. The proof-richness asymmetry is still present but the build proof scorer is coarse
  (outcome-only) and cannot register it. Detail in §2.
  [`composed-build-arm-finding`](../../evals/dynamic-vs-reference/composed-build-arm-finding.md).
- **Shape-sensitivity — topology efficacy-flat, cost-real (✅ on `main`, PR #138 `2983ec2b`).**
  The same composed fix arc at three topologies (lean 5-block / full 6-block / loop 6-block +
  recovery), 4 held-out tasks × reps=3 = 36 runs. Efficacy did not separate (lean 11/12, full and
  loop 12/12 — a single rep-flip the miss-analysis traces to model variance on a fix reachable
  without the dropped block); cost and latency tracked block count cleanly (lean ~32% cheaper,
  ~31% faster than full); the loop's recovery route **never fired**, so loop cost the same as
  full. The read: **the judgement inside a step, not the wiring between steps, is the scarce
  ingredient** — graph shape is near-free on efficacy and not free on cost. Bounded claim: "no
  topology effect detected on **non-discriminating** tasks," not "topology doesn't matter."
  [`composed-shape-sensitivity-finding`](../../evals/dynamic-vs-reference/composed-shape-sensitivity-finding.md).

---

## 7. What's next, and what's reserved for operator ratification

**Most recent (the generator's PROPOSE half now runs 4/4, 2026-06-21, merged `a07960a0`,
PR #141):** the composer (§2) is a *linearizer* — it turns a hand-authored role set into a
runnable flow but never *proposed* the role set itself. That proposing half lives in `src`
as **`proposeFlow`** (`src/flows/composition/propose.ts`, first landed PR #140): a task goes
in, an injected model proposes a `CompositionRoleSet`, the **same proven offline floor**
(`composeFlow → evaluateValidity → evaluateRunnability`) verifies it, and on a wall the
verifier's exact errors feed back for bounded repair — out comes either a runnable flow
(role set + spec) or an honest fail-closed `parse`/`relay`/`wall`. It is **engine-first, no
product command yet** (the deliberate v1 shape): default-OFF, zero production callers, inert
at import, selection-agnostic, the model reached only through an injected relay. The first
live run was **2/4 runnable**; the two walls were both *vocabulary* errors (the model naming
a stage / block / execution kind outside the closed menu) that the repair guidance had been
mis-framing as missing-input problems. PR #141 fixed that — generalized the repair preamble,
added three vocabulary-class repair rules keyed to the floor's real wall strings, and raised
the default repair budget 2 → 4. Re-proven live (pinned haiku): **4/4 runnable** — a linear
fix, a loop for a flaky test, review-only for an audit, and the build-family CSV export that
previously walled (now converges at repair round 1). This is the first piece of the
**generator** (as opposed to the *linearizer*) to reach `main` and clear its real-task bar.
The next step is the deferred product command. Tests:
`tests/contracts/composition-propose.test.ts`; driver:
[`propose-real-tasks.ts`](../../experiments/flow-lab/propose-real-tasks.ts).

**Before that (frontier phases A–D, 2026-06-21, merged `67594dfa`…`2983ec2b`):** the
two-layer composer-intelligence frontier this doc previously held *reserved for
ratification* is now **shipped**, a second efficacy family runs, and the topology
question is answered. **A** (PR #134) producibility-aware *selection* (repair-then-wall
in `selectActual`); **C** (PR #135) goal-family *reachability* (the goal opener reads
its clarified task; `GOAL_CLARIFY_THEN_FIX` runs end-to-end — so all four composed
shapes now run full flows, not just their step); **B** (PR #136) build-family
*reachability* (readable content-checkpoint brief; `BUILD_LINEAR_FULL` runnable);
**B-live** (PR #137) the composed **build** arm matched the reference at lower cost (an
existence proof, non-discriminating, RAW/no-verdict); **D** (PR #138) the
shape-sensitivity experiment found flow **topology efficacy-flat and cost-real** —
step-level judgement, not graph shape, is the scarce ingredient (see §2 and §6). Just
before this: the **composed-vs-reference efficacy arm** (PR #132 — **COMPOSITION-VIABLE**,
the first efficacy-grade head-to-head a composed-from-blocks flow cleared, plus the
verification-reads engine fix) and the **fanout terminal-close fix** (PR #133).

**Recently shipped (between 2026-06-17 `f4d260b1` and 2026-06-19 `94fe670d`):**
the F2 reshape operator surface + the splice-seam spec (PR #108), the F1
equipment-reshape resume reseed + the Phase 0 splice demonstrator (PRs #110, #111),
the on-demand context-pull **live channel** (PRs #112–#115 — typed query channel,
pull-then-retry delivery, real-guided-worker last-mile, opt-in/default-OFF), the
**task-aware assembler** (PR #117 — verdict VIABLE), the **per-mode runtime trust**
gate (PR #119), the **thin-envelope unlock** (PR #116 — thinned Build plan +
lifted corridor skip; quality holds, payoff reframed as ~3.9% in-flow vs the delivery
channel's selectivity, still opt-in), and the **paper-to-site post-editorial
checkpoint** (PR #120 — the §5 P0; a build-gate + a fresh retry-gate so a child-build
failure parks resumably and the editorial fan-out is recorded once, not re-spent),
and the **dynamic-vs-reference live experiment** (PR #121 — verdict
**WORTH-INVESTING**; an instantiated-generated flow matched the hand-authored
reference on `fix` + `build` over 48 runs at 0% false-fixed, with the `build` grain
fold paying for itself; see §2 and §6). All moved off the "next/in-flight" list
below; the rows above carry the detail.

**Next (sequenced, low ambiguity):**

1. **Add the `proposeFlow` product command** (the deferred "command after") — the
   runnable-rate work is **done** (PR #141 took the live driver from 2/4 to 4/4 by fixing
   the vocabulary-class repair guidance + raising the budget). What remains is the v1
   shape's second half: a command that resolves the session power dial into a
   `ResolvedSelection`, wraps the real connector as the relay, calls `proposeFlow`, and on
   success publishes the composed flow (the driver already proves this path end-to-end with
   `--publish`). The one *structural* residual (the family-locked goal-close sub-run
   terminal) is a separate engine unlock, not a blocker for the command. Driver:
   [`propose-real-tasks.ts`](../../experiments/flow-lab/propose-real-tasks.ts).
2. **Breadth of instantiation** — the dynamic-vs-reference follow-up's recommended
   next step now that the two-family result is in. A measurement-only sibling eval
   over the **untested** families (`research`, `prototype`, `explain`/editorial),
   same two arms / same pinned model / same cost instrument, to learn whether the
   WORTH-INVESTING result is a two-family property or generalizes. The hard part is
   an **honest external check** per family (a document's quality is not a passing
   test) — a family with no such check does not enter the set. Pure measurement on
   the existing generator; no assembler/resolver edit. Do **not** yet spend on the
   genuine-block-composition arm (gated behind the Phase 2 catalog enrichments).
   [`dynamic-vs-reference-followup.md`](dynamic-vs-reference-followup.md).
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
  blocks via the **instantiation assembler** is a RESEARCH PROBLEM (eight fail-closed
  authoring walls). A feature path needs catalog enrichments (execution-capability
  table, contract-alias solver, route-DAG synthesizer, check/relay defaulting) plus a
  model for the irreducibly intentional choices. Hold as a separate track.
  [`assembler-rebuild-run-report.md`](assembler-rebuild-run-report.md). **Note:** the
  genuine-composition progress recorded in §2 came through a *different* route — the
  experimental `composeFlow` **composer** (default-OFF, zero production callers), which
  now composes all four shapes, runs both the fix and build families end-to-end, and is
  scored against hand-authored references. This catalog-enrichment route for the
  *shipped* `circuit create` assembler remains the un-pursued alternative; the active
  line is the composer (§2), and folding its proven pieces into the product surface is a
  separate, larger ratification question.
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
  `assembler-rebuild-run-report.md`, `dynamic-vs-reference-run-report.md`,
  `overnight-reliability-run-report.md`,
  `grain-chooser-run-report.md`, `overnight-run-report.md`,
  `paper-to-site-2nd-run-findings.md`, `equipment-scope-enforcement-report.md`,
  `e1-run-report.md`.
- The index of all idea docs, grouped by kind: [`README.md`](README.md).
