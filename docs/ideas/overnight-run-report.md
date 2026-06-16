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
| B0/B1 | grain experiment | **SKIP+SURFACE (no spend)** | finding below |
| A4 | typed vocabulary | in progress | `feat/vocabulary-finding` |
| A5 | migrate 6 built-ins onto assembler | in progress | `feat/assembler-builtins-migration` |
| A1 | durability Tier-2 foundation slice | in progress | `feat/durability-tier2-foundation` |
| B2 | structure chooser (thin) | not started | — |
| B3 | two resolvers same shape | not started | — |
| A6 | equipment skills injection | not started | — |
| A2 | Tier-3 crash-safe linkage | surface-as-spec (not started) | docs only |
| A3 | parallel decision inbox | surface-as-spec (not started) | docs only |
| B4 | three deep forks | surface-as-spec (not started) | docs/experiments only |

### Recommended next step for a fresh session

Pick up from the chunk-status table. Schematic-touching chunks (A5, B3, A6)
collide at merge — see **Recommended merge order** at the bottom. Each PR is
held and independently verify-green off `origin/main`; do not merge here.

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
  surface-only.

---

## Recommended merge order

_(filled in as PRs open)_

1. _Independent, no schematic collision:_ A4, A1.
2. _Schematic-touching cluster — merge in this order, rebasing each onto the
   prior:_ **A5** (assembler migration, byte-identical) → **B2** (structure
   chooser) → **B3** (equipment trusted resolver, adds skill_slots) → **A6**
   (equipment skills enforcement on top).
3. Surface-only docs (A2/A3/B4 specs, grain spec) — no engine merge; land as a
   docs PR or alongside.
