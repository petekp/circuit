# M9 grounding brief — open the composed runtime (the finale)

> **Purpose.** Ground M9 — the last milestone of the first-class-composition
> migration, the one that delivers "assembled dynamically per task." Written for
> the migration session to ground against, and for Pete to review. It deliberately
> carries **cross-track inputs the migration session does not have**, because M9
> is where the migration track and the parallel exploration track (the E1 /
> `experiments/` work) converge. Read it alongside the docs listed under
> *Cross-track inputs* before sequencing M9.
>
> **Status:** grounding aid, not a plan of record. The migration session should
> ground each claim against the code as usual; this brief sets the frame, the
> sequencing discipline, the convergence bucket, and the decisions that are Pete's.

## 1. What M9 actually delivers (the intent, in one breath)

Today the 8 built-in flows are first-class and anything else runs as a degraded
template-clone-of-Build. M9 ends that: it opens **one shared assembly/runtime path
that every flow goes through — built-in or composed — so a flow assembled per task
runs exactly the way a built-in does.** The headline consequence is the
"self-hosting" payoff the whole arc was for: **the built-ins become the
assembler's first customers.** Improve the assembly path once and every flow
improves; a flow proven on the shared path is trusted everywhere it appears; the
privileged path and the general path stop diverging because there's only one path.

That is the end-state. M9 is what makes "assemble dynamically per task" real
rather than a thinner, second-class imitation.

## 2. The core discipline: close the safety floor BEFORE you open the door

M9's central risk is sequencing. The moment composed/assembled flows run for real,
a whole class of failures that is **inert for the 8 hand-wired built-ins goes
live** — because a machine, not a careful human, is now wiring steps together. So
M9 must be built in this order, and the runtime-opening step comes **last**:

**Phase A — close the safety floor (entry conditions; none are optional):**

1. **Single-actual blindness** (the HIGH residual risk-accepted in M8/PR #85).
   The anti-widening gate only inspects a contract when one name resolves to
   *several* shapes. A contract with a *single* actual is trusted unchecked. That
   is safe when humans wired every flow; it is **exactly the seam an assembler
   trips** — it can wire a consumer onto a single-actual producer of the wrong
   shape and nothing catches it. This must close before composed flows run. It is
   the same logic as "M5 (the gate) had to land before M7 (the assembler)."
2. **Signature collision** (the MEDIUM residual). Two distinct contracts that
   resolve to the same structural signature can be treated as interchangeable by
   an assembler. Close it as part of the same typing pass; it is assembler-safety,
   not cleanup.
3. **#15 — `flow.catalog@v1` live producer.** The route block consumes it and
   nobody produces it today. A composed flow that routes needs it actually
   produced, or routing breaks at runtime. Define the producer (and decide static
   vs dynamic catalog — see Decisions).
4. **Headless-checkpoint policy** (cross-track; the migration session does not
   know this one — see §4). A flow that pauses at a human checkpoint will hang
   when run unattended or nested inside another flow. The composed runtime cannot
   be called "open" if a composed/nested flow can silently hang. Needs an
   engine-side policy, defaulting safe (see Decisions).

**Phase B — prove the shared path is real (the truth test, §3), then open it.**

**Phase C — migrate the built-ins onto the shared path (first customers) and
retire the template-clone-of-Build; dual-host parity.**

If the runtime opens before Phase A is closed, M9 ships a runtime that can mint
silent seam failures in every composed flow. Phase A is not M9 "scope it owns
eventually" — it is M9's entry gate.

## 3. The M9 truth test (run it first, before retiring anything)

Mirror the discipline M7 used. Before retiring the template-clone-of-Build or
migrating any built-in, prove the central claim with one falsifiable experiment:

> **Take one built-in (`fix` is the cleanest; `build` if you want the slice loop
> exercised) and run it through the new shared composed path. Is the result
> behavior-equivalent to its current dedicated execution?**

- **Pass** → the shared path is genuinely first-class; built-ins can become its
  first customers; proceed to migrate them and retire the clone.
- **Fail** → the composed path is not yet equivalent; self-hosting is not ready,
  and the gap must be closed before any retirement. Do **not** retire the old path
  on faith.

Match the proof to the change (byte-identity for metadata-only; a reviewed
behavior-equivalence trace diff for the runtime path). This de-risks the whole
milestone at the start instead of discovering non-equivalence after the clone is
gone.

## 4. Cross-track inputs the migration session is missing

These live on the exploration branch / in `docs/ideas/` and were produced by the
E1 work. Read them before grounding M9:

- **`docs/ideas/e1-run-report.md`** — the **headless-checkpoint finding**: run
  unattended, `build` halts at its opening `frame-step` checkpoint
  (`checkpoint_waiting`) before doing any work. E1 worked around it *harness-side*
  (issuing `circuit resume --checkpoint-choice continue`). M9 needs the
  **engine-side** version: when a flow runs nested or unattended, what happens at a
  human checkpoint? This is Phase-A item 4. The same report also shows the
  one real grain comparison (`fix` vs `build` on one task) and confirms the live
  cost/honesty meters work end to end.
- **`docs/ideas/primitive-readiness-audit.md`** — where the six substrate
  primitives stand after M5/M8 (uniform unit, typed seam, context envelope,
  equipment scope, isolation, commensurable traces). Use it to see which M9
  pieces already have substrate and which are net-new.
- **`docs/ideas/grain-separability-experiment-design.md`** — the parked
  experiment that will tell the assembler when to chop vs hold. Relevant to the
  chop/hold default decision below; it fires *after* M9 opens the runtime (it
  needs the real composed path to be most informative).
- **`docs/ideas/exploration-substrate-two-track-plan.md`** and
  **`docs/ideas/mini-harness-debrief-vs-circuit.md`** — the conceptual frame
  (self-hosting, seam failures, enforced-vs-trusted bindings, the chop/hold
  asymmetry, the recursion horizon). Background for *why* the sequencing above is
  shaped the way it is.

## 5. The decisions that are Pete's (not the agent's)

These shape the platform's behavior, not just the implementation, so surface them
to Pete rather than choosing overnight:

**Locked (Pete, 2026-06-14):** (1) chop/hold = **lean to whole**; (2) checkpoint
policy = **surface or pause, never auto-skip** (auto-continue only if a flow's
manifest explicitly declares a checkpoint auto-continuable when nested);
(3) rollout = **incremental**; (4) `flow.catalog@v1` = **static registry**. The
detail and rationale per item below stand; these are the chosen defaults.

1. **Chop/hold default for the assembler.** When the assembler decides whether to
   do a task in one piece or decompose it, what is its default *before* the grain
   experiment has produced data? **Recommended: lean to whole** — decompose only
   where separability is demonstrable, hold otherwise. Rationale (from the whole
   arc): over-chopping entangled work silently destroys coherence and is invisible;
   under-chopping is visible and recoverable. Ship M9 conservative; let the grain
   experiment relax it later with evidence.
2. **Headless-checkpoint policy.** When a flow hits a human checkpoint while
   running nested/unattended, the default should be one of: surface-to-top-level
   operator, auto-continue, or fail-with-clear-state. **Recommended: do not
   auto-skip human gates by default** — surface or pause, and allow a flow's
   manifest to *explicitly* mark a checkpoint auto-continuable when nested. This is
   the enforced-vs-trusted principle: an auto-continue must be a declared,
   auditable property, never an implicit default.
3. **Self-hosting rollout: incremental vs big-bang.** Migrate all 8 built-ins onto
   the shared path at once, or one at a time behind the truth test? **Recommended:
   incremental** — prove the shared path on one built-in (the truth test), migrate
   it, confirm parity, then roll the rest. M9 is the biggest surface in the
   migration; stage it.
4. **`flow.catalog@v1`: static or dynamic.** Is the catalog the assembler picks
   from the statically registered block set, or something assembled at run time?
   This shapes #15's producer. Likely the agent can ground it, but the
   static/dynamic choice has architectural weight — flag it to Pete if it forks.

## 6. What M9 is NOT (scope guards — keep it bounded)

M9 makes composed flows **run safely** through one shared path. It does **not**:

- build the *intelligent* chop/hold planner (that is E4 / the composition-surface
  work) — M9 ships a **conservative default**, not a learned heuristic;
- build recursion / nested-grain as a first-class feature (that is E3 / unit
  unification) — M9 must not *hang* on nesting (the checkpoint policy), but it need
  not make nesting *smart*;
- run the grain-separability experiment (that fires after the runtime is open).

Holding this line keeps M9 from ballooning into "the whole rest of the roadmap."
Its job is the runtime and the safety floor under it.

## 7. After M9: the frontier reopens

Once the shared runtime is open and the built-ins are its first customers, the
exploration track's deferred items become the main thread, now genuinely
unblocked: **E3** (collapse flow and block into one self-similar unit → uniform
recursion), **E4** (composition-as-data + the chop/hold planner), and the
**grain-separability experiment** (run it against the real composed path to set
the chop/hold threshold with evidence). M9 is the convergence point; these are
what it unlocks.

## 8. Definition of done & discipline

- **Phase A closed and proven**: single-actual blindness + signature collision
  resolved (and enforced without breaking the 8 built-ins), `flow.catalog@v1`
  produced, headless-checkpoint policy in place and defaulting safe.
- **Truth test passed**: at least one built-in proven behavior-equivalent through
  the shared composed path before any retirement.
- **Runtime open**: composed flows run first-class; the template-clone-of-Build is
  retired; built-ins migrated onto the shared path (incrementally, per the
  decision).
- **No second execution model survives** — the M9 analogue of the M4 grep gate:
  no behavior decided by "which of the N flows is this," no special-cased built-in
  path. The composed path is the only path. This is the machine-checkable proof
  that self-hosting actually landed.
- **Dual-host parity** (Claude Code + Codex) verified.
- Standard discipline: task list; failing-test-first for the safety fixes; full
  `npm run verify` green; adversarial review to the cap; **never special-case the
  engine** (if a flow needs special behavior, it rides the manifest, never an
  engine branch); fresh PR; hold merge for Pete.

## 9. One-paragraph summary for the greenlight

M9 opens the single shared runtime that makes composed flows first-class and turns
the 8 built-ins into the assembler's first customers — the self-hosting payoff of
the whole migration. Build it floor-first: close the typing residuals
(single-actual blindness, signature collision), produce `flow.catalog@v1`, and add
a safe headless-checkpoint policy **before** opening the runtime; prove the shared
path on one built-in with a behavior-equivalence truth test before retiring the
old path; then migrate the built-ins incrementally to dual-host parity, ending on
the machine-checkable proof that no second execution model remains. Ship it with a
**conservative chop/hold default** and a **no-auto-skip checkpoint default** —
both are Pete's calls — and leave the intelligent planner, recursion, and the
grain experiment to the frontier M9 unlocks.
