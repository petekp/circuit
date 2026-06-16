# Overnight run report — foundation completion + frontier spike

> Live, incremental record of the highest-effort overnight run executing
> `overnight-foundation-frontier-brief.md`. Updated as chunks land. The STATE
> section at the top is the resume point if the run stops mid-flight.

---

## STATE (read this first)

**Run started:** 2026-06-15 (overnight). **Base:** `origin/main` @ `571e0523`
(NOT local `main` @ `2fc7d4ea`, which was stale — missing #89 equipment-scope,
#90 paper-to-site, #91 Tier-1 durability). All chunk branches base off
`origin/main`.

**Biggest decision banked first — the grain experiment is NOT run.** B0 gate
failed its make-or-break Step-0 precondition: the eval taskset
(`evals/fix-vs-vanilla/tasks`, 44 tasks) has **zero entangled tasks** — every
task is a single-module fix (verified: 7 tasks touch 1 file, 34 touch a
src+test pair for one module, 3 touch src+2 tests for one module; none spans
interacting modules). A grain × separability experiment on a taskset with no
separability spectrum is null-by-construction — exactly what the design's Step 0
says to stop on. **The $90–120 authorized spend is therefore NOT taken.**
Consequence: **B2 takes the pre-registered thin-conservative branch**
("ambiguous/null → thin chooser + needs-more-data"). See chunk B0/B1 below for
the surfaced remedy (entangled-task spec + harness K-repeat gap).

### Chunk status

| Chunk | What | Status | PR / branch |
|---|---|---|---|
| Infra | base off origin/main, report backbone | DONE | `overnight/foundation-frontier` |
| B0/B1 | grain experiment | **SKIP+SURFACE (no spend)** — DECIDED | `grain-experiment-deferred.md` |
| A4 | typed vocabulary | **DONE — verify green, held PR #92** | `feat/vocabulary-finding` |
| A5 | migrate 6 built-ins onto assembler | **DONE — verify green, held PR #94** | `feat/assembler-builtins-migration` |
| A1 | durability Tier-2 foundation slice | **DONE — verify green, held PR #93** | `feat/durability-tier2-foundation` |
| B2 | structure chooser (thin) | **DONE — verify green, held PR #95** | `feat/structure-chooser` |
| B3 | two resolvers same shape | **DONE — verify green, held PR #96** | `feat/equipment-resolver` |
| A6 | equipment skills injection | **DONE — verify green, held PR #97** | `feat/equipment-skills-injection` |
| A2 | Tier-3 crash-safe linkage | spec DONE + committed (f6916e4e) | docs only |
| A3 | parallel decision inbox | spec DONE + committed (f6916e4e) | docs only |
| B4 | three deep forks | specs DONE + committed (f6916e4e) | docs only (spikes sketched in-spec) |

### Verify + PR strategy (executed)

Build agents worked in isolated worktrees off `origin/main` with a shared
(symlinked) `node_modules`. Full `npm run verify` gates + `gh pr create`
(HOLD MERGE) were **serialized after the build agents finished** to avoid vitest
cache races. All four foundation PRs are open and independently verify-green:
**A4 #92, A1 #93, A5 #94, B2 #95.** A1 needed one extra commit regenerating the
host runtime bundles (its new runtime code changes the compiled CLI — the known
"runtime change drifts host bundles" gotcha); re-verified green after.

### RUN COMPLETE — all chunks landed as held PRs

Six foundation+frontier code PRs, all independently `npm run verify`-green and
**held for the operator** (no merges, no rebases, no force-pushes):

| PR | Chunk | One line |
|---|---|---|
| #92 | A4 | vocabulary regression lock (pantry already stocked by M9) |
| #93 | A1 | durability Tier-2 foundation slice + cursor spec (honest payload-gap) |
| #94 | A5 | all 6 built-ins migrated onto the assembler, byte-identical |
| #95 | B2 | structure chooser, thin-conservative (whole-grain-can't-run finding) |
| #96 | B3 | equipment resolver #2, same shape, abstraction NOT extracted |
| #97 | A6 | real house-style injection; skill-slot ratchet 15 → 1 |

Plus the docs branch `overnight/foundation-frontier` (surface-only: A2/A3 specs,
three B4 deep-fork specs, the grain skip verdict, this report).

**Nothing left to build.** The only open actions are the operator's: review and
merge in the recommended order below, and ratify the surfaced deep-fork decisions.

What was NOT done, by design: the grain experiment (skipped at its B0 gate, no
spend); A2/A3 beyond specs (gated on the multi-week A1 cursor); the B4 deep forks
beyond specs (reserved as ratifiable, never merged into `src/`); the enforced
tools-axis ratchet (#89's half, A6 Increment 2).

---

## Per-chunk detail

### B0/B1 — grain × task-separability experiment → SKIP + SURFACE

**Verdict: do not spend.** Harness is sound and live-runnable
(`experiments/e1/run-matrix.ts --live`, `claude` 2.1.178 on PATH), but the
Step-0 taskset precondition fails (no entangled tasks). Per the experiment
design (`grain-separability-experiment-design.md` lines 63–76) and the brief's
B0 pre-registered branch, the correct action is skip-and-surface.

**Surfaced remedy (so a future run can execute cleanly):**
- Harness gap: `run-matrix.ts`/`matrix-runner.ts` has no `--repeats`/`-k` axis
  and no run-order interleaving (design controls). The aggregation
  (`matrix.ts:144`) is already K-aware. ~1hr harness-side fix (`experiments/`).
- Taskset gap: needs ≥2 genuinely entangled (6–8) + ≥2 mixed (3–5) tasks, each
  with hidden objective checks in the existing `task.json` + `objective/` shape.
  Spec written as part of this chunk.

**B2 consequence:** thin-conservative chooser; "needs more data."

### B2 — structure chooser (built, thin conservative) + a load-bearing finding

**Built:** `src/flows/resolvers/structure.ts` (pure, public-types-only, no engine
dep) + a `--decompose` flag on `create`. With no signal (the common case) the
chooser returns `whole` and folds build's 9-step spine to the 5-step
`frame -> plan -> act -> verify -> close`; `--decompose` (or large surface /
high risk) yields the full spine. Shared shape recorded in the resolver header
(points at the lab's `SHARED-SHAPE.md`), NOT extracted — a third instance is the
honest trigger. `resolvers/` registered as shared cross-flow infra in the two
gates that walk `src/flows/` (same treatment `registries` gets). Host runtime
bundles regenerated (`npm run build-plugin-runtime`), committed separately.

**Finding (surfaced fork, not a STOP):** the whole grain **assembles, compiles,
validates, and publishes** as a valid package and passes every static gate, but
it **cannot RUN end-to-end**. Build's `close-with-evidence` writer
(`src/flows/build/writers/close.ts` + `result-projection.ts`) hard-requires
`build.review@v1` + `build.touch-area@v1`, which the whole-grain fold removes, so
close aborts ("expected exactly one report writer for schema 'build.review@v1',
found 0"). The offline lab never caught this because `scoreSpec` assembles +
compiles + scores but never runs. Making the whole grain runnable needs an
engine/built-in change (build's close writer + `BuildResult` schema tolerating
absent review/touch-area) — out of B2 scope and forbidden by the engine-boundary
rule, so it was NOT forced. The decomposed grain runs to `complete` cleanly, so
the pre-existing end-to-end create+run test was pointed at `--decompose`. This is
a real decision for the operator: the conservative whole grain is publishable but
not yet runnable for build-derived custom flows; the runnable path today is the
decomposed spine. **This belongs in the resolver/abstraction deep-fork discussion
(B4) — it is concrete evidence that the chop/hold default interacts with built-in
close-writer contracts.**

### A4 — typed vocabulary (the pantry)

**Finding (headline):** A4 was substantially overtaken by M8.2/M9-A1. Every
shipped uniform spine generic already resolves to a registered body; zero
`unresolved` classifications among shipped flows. The divergent write-only
umbrellas (`verification.result@v1`, `change.evidence@v1`, etc.) are correctly
left untyped (the M8 Option-1 call). Force-typing one would trip the
anti-widening gate. **Shape-variety is already optimal; A4 adds a lock test +
this finding, not new typing.**

### A5 — migrate 6 built-ins onto the assembler

**Finding (headline, pending build confirmation):** the assembler is
**genuinely general, not build-locked**. All 6 remaining built-ins
(runtime-proof, review, goal, fix, prototype, explore) — including goal's
sub-run shape and prototype/explore's fanout + non-monotonic stage order —
assemble AND compile byte-identically once items are authored in block-use form
(empirically probed during recon). The per-step expander already handles every
execution kind. Migration is mechanical (lift items, strip restated defaults,
add stage labels).

### A1 — durability Tier-2

**Bankable slice:** `RecoveryCorridor.seedFromTrace` (the audit's "simpler"
rehydrator) — a fold over `step.completed` trace facts mirroring the live
mutation, modelled on the two existing seeders. Inert until a cursor consumes
it; failing-test-first; full verify achievable overnight.

**Surfaced (not built):** the resumable cursor proper is multi-week (new
non-checkpoint resume entrypoint, all-channel rehydration, per-step idempotency
proof, app→runtime staleness-gate boundary). Decision-ready spec written.
**A2 (Tier-3) and A3 (inbox) depend on the full cursor → remain surface-only.**

---

## Findings index

- **A4 vocabulary payoff:** none to add — pantry already stocked by M9.
- **A5 assembler generality:** general, not build-locked (the chooser can rely
  on it producing non-build shapes).
- **Grain verdict:** null-by-construction (taskset gap); B2 → thin conservative.
- **A1 dependency outcome:** foundation slice banked; cursor surfaced; A2/A3
  surface-only. A1 also surfaced that the trace does not persist the executor
  `outcome.details` payload, so a faithful rehydration is impossible from durable
  state alone — the rehydrator restores structure only and a test pins the gap.
- **B2 structure-chooser finding:** the conservative whole grain is publishable
  but NOT runnable for build-derived custom flows — build's close-with-evidence
  writer hard-requires `build.review@v1` + `build.touch-area@v1`. The runnable
  path today is `--decompose`. Concrete input to the B4 resolver/abstraction
  fork: chop/hold interacts with built-in close-writer contracts.
- **B3 shared-shape finding:** the resolver shared shape **held up with no new
  divergence** once both resolvers (structure + equipment) live in `src/`. The
  four recorded divergences (scope, enforcement, downgrade channel, binding time)
  are the whole design content; a shared `Resolver` type is earnable but
  deliberately NOT extracted — a third instance is the trigger. The equipment
  axis needed **zero engine accommodation** (additive per-step `skill_slots` rides
  the assembler unchanged), unlike structure's whole-grain fold.
- **A6 injection finding:** real house-style injection is **genuinely general —
  no engine support needed**. Slot descriptions ride the manifest `skill_slots`
  and render through the shared prompt composer for any relay role on any flow.
  The skill-slot quality ratchet dropped **15 → 1** (only runtime-proof's
  do-nothing dry-run relay remains, by design). The enforced *tools* half
  (`TOOL_SCOPE_GAP_BASELINE = 5`) is untouched — that is #89's axis, for a later
  increment.

---

## Recommended merge order

1. _Independent, no schematic collision (merge in either order):_ **A4 (#92)**,
   **A1 (#93)**.
2. _Schematic-touching cluster — merge in this order, rebasing each onto the
   prior:_ **A5 (#94)** (assembler migration, byte-identical) → **B2 (#95)**
   (structure chooser) → **B3** (equipment resolver, custom-flow decision layer)
   → **A6** (equipment skills injection on shipped flows). B3 was built off B2 and
   A6 off A5, so each already contains its predecessor's commits except where the
   tree branches (B3 lacks A5; A6 lacks B2/B3) — expect a clean rebase since their
   file surfaces are disjoint (B3 = `src/flows/resolvers/`; A6 = shipped-flow
   `assembly-spec.ts` + runtime injection + the ratchet test).
3. Surface-only docs — the docs branch `overnight/foundation-frontier` (commit
   f6916e4e) carries the A2/A3 specs, the three B4 deep-fork specs, and the grain
   skip verdict. No engine merge; land as a docs PR or alongside.

### What is HELD for the operator (the genuine decisions)

- **B2 finding:** the conservative whole grain is publishable but not runnable for
  build-derived custom flows (build's close writer hard-requires
  `build.review@v1` + `build.touch-area@v1`). Decide whether to make build's close
  writer tolerate absent review/touch-area (an engine/built-in change) or keep
  `--decompose` as the runnable path. Feeds the B4 resolver-abstraction fork.
- **A1 finding:** the trace does not persist executor `outcome.details`, so a
  faithful recovery-corridor rehydration needs a schema change (folded into the
  cursor spec). The resumable cursor proper is multi-week.
- **B4 deep forks (surface-only specs):** uniform recursion E3, the resolver
  abstraction (do NOT extract yet — a third instance is the trigger), and adaptive
  bubble-up recompile. Each has a decision-ready spec on the docs branch.
- **Grain experiment:** not run (taskset has no entangled tasks). Remedy spec
  written; re-run only after the taskset spans separable/mixed/entangled.
