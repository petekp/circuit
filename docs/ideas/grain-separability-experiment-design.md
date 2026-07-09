# Experiment design: grain × task-separability

> Pre-registered design. **Status: designed AND RUN (2026-06-16) — verdict NULL on
> the pre-committed metric.** The experiment was first deferred at its Step-0 gate
> (no entangled tasks; see
> [`grain-experiment-deferred.md`](deprioritized-ledger.md)), then the taskset
> was built and the harness gap closed
> ([`grain-taskset-ready.md`](deprioritized-ledger.md)), B0 re-passed, and the run
> executed: 40 live runs (4 tasks × 2 grains × 5 repeats), ≈$24. **The false-fixed
> rate was 0 in every cell** — both grains, both bands — so neither H-coherence nor
> H-verification could be adjudicated: the honesty metric the design hinges on
> never fired. The decision rule routed the null to its explicit branch: **hold the
> thin-conservative chooser and surface "needs more data."** No chooser code
> changed. The design below stands as written and was followed faithfully; what it
> taught is that these held-out fix tasks induce *honest* failure (abort/miss), not
> dishonest completion, regardless of grain. The real follow-up is tasks that
> actually provoke a false claim of done, not more repeats. Full results:
> [`grain-chooser-run-report.md`](deprioritized-ledger.md).
>
> *(Original framing, kept as the design record: "designed, not run. Fire at M7 …")*
> Built on E1's harness and methodology (`experiments/e1/`, the B1 matrix runner)
> and the E1 run report. Designed while the thinking was fresh, so the run — when it
> came — was well-formed rather than hasty. Pre-registering the hypotheses and the
> decision rule guards against fitting a story to noisy data (the n=1 lesson from
> the first live run).

## The question it answers

When the assembler (M7) decides whether to do a task in one piece (**holistic**)
or break it into smaller steps (**separated**), what should its default be — and
when should it flip? This experiment produces the evidence behind that default.

## Two competing hypotheses (the point of the experiment)

The earlier framing — "separation pays off as fewer false-fixes on hard tasks" —
was one-sided. The sharper design pits two grounded, **opposing** predictions
against each other, because we genuinely don't know which dominates:

- **H-coherence** (from the holism/separation framework): chopping an *entangled*
  task destroys the coherence that lived in holding it in one context, so on
  entangled tasks the separated grain produces **more** false-fixes / worse
  outcomes. → Validates the "lean to whole" default; M7's planner should chop only
  where separability is demonstrated.
- **H-verification** (from E1's observed cost-shape — `build`'s slice loop spread
  26% onto the reviewer role, doing more downstream verification): the separated
  grain's extra verification catches more errors, so on hard tasks the separated
  grain produces **fewer** false-fixes. → "Lean to whole" would be wrong; M7 can
  chop more aggressively because the verification structure compensates.

These are not mutually exclusive — both effects likely operate, and the net flips
somewhere along the separability spectrum. **Locating that crossover (or showing
there isn't one) is the deliverable.** Every outcome is decision-relevant:

| Result | What it tells M7 |
|---|---|
| H-coherence dominates on entangled tasks | Default to whole; chop only on demonstrated-separable seams |
| H-verification dominates throughout | Chop aggressively; the slice-loop verification pays its way |
| Crossover at separability score *S* | Make *S* the chop/hold threshold the planner uses |

## Variables

- **Independent — grain (2 levels).** Holistic = `fix`; separated = `build
  --depth high` (the act/verify slice loop). This is a **proxy** for the real
  grain continuum the assembler will eventually choose from; it is not the
  continuum itself. Optional 3rd level: `build --depth medium` (slice loop off) as
  an intermediate, only if budget allows.
- **Moderator — task separability (the crux).** Scored a priori (below). This is
  the axis the two hypotheses trade off along.
- **Dependent — primary: false-fix rate** (claimed `complete`/`accept` while the
  hidden objective check fails, measured against the objective, not the
  self-report — E1 already implements this). **Secondary:** objective pass rate,
  cost (total + per-role shape), step count, wall time, and the qualitative
  failure seam.

The primary DV is the honesty metric, not cost — consistent with the project's
"verification is the durable half" bet and with what the two hypotheses actually
disagree about.

## Step 0 — the make-or-break precondition probe

Before any live run: **audit whether the eval taskset actually spans
separability.** The `fix-vs-vanilla` / held-out tasks skew toward small,
self-contained fixes (e.g. `heldout-wrap-index`). If the set contains no
genuinely *entangled* tasks, the experiment cannot test its own hypotheses —
both arms will pass everything and the result is null-by-construction.

If coverage is thin at the entangled end: **stop and report**, and either source
or author entangled tasks first (multi-file changes with shared state, a
cross-module refactor, a change whose correctness depends on a design decision
spanning parts). Do not run a spectrum experiment on a taskset that has no
spectrum.

## Task selection & a-priori classification

Score each candidate task 0–2 on four dimensions, **before running**, ideally by
someone/something blind to outcomes; pre-register the scores:

1. **Co-change spread** — how many files/functions must change together for a
   correct fix (1 file = 0; many interacting = 2).
2. **Coupling** — do the changed parts share state / contracts / invariants that
   constrain each other (none = 0; tight = 2).
3. **Cross-part design decision** — is there a choice that must be made coherently
   across parts (no = 0; yes = 2).
4. **Independent verifiability** — can sub-parts be checked in isolation, or only
   the assembled whole (isolatable = 0; whole-only = 2).

Sum → separability score 0–8 (low = separable, high = entangled). Select tasks to
populate three bands — **separable (0–2), mixed (3–5), entangled (6–8)** — with at
least 2 tasks per band so a band's result isn't one task's quirk.

## Sample size, budget, and execution strategy

Agents are stochastic — a single run per cell is noise (the first live run's 14%
cost gap was within run-to-run variance). Use **≥3 repeats per cell, prefer 5**,
and report means with spread.

Budget at ~$1.5 / comparison-arm (fix ≈ $0.9, build ≈ $0.8 observed):

| Tier | Shape | Runs | Rough cost |
|---|---|---|---|
| Minimal | 4 tasks × 2 grains × 3 repeats | 24 | ~$40 |
| Standard | 6 tasks × 2 grains × 5 repeats | 60 | ~$90–120 |

**Execution: extremes-first, adaptive.** Run the separable and entangled bands
*first* at full repeats. If false-fix rates diverge cleanly at the extremes, the
signal is captured cheaply — only then spend on the mixed band to locate the
crossover. If the extremes don't diverge, the effect is weak and the middle isn't
worth buying. This tests the boldest prediction first and stops early on a null.

## Controls (confounds to hold constant)

- Carry forward E1's controls: **only grain varies** — same task, same base
  commit, isolated worktree per run, the same check-blind goal given to both arms,
  the checkpoint-aware harness driving both to a terminal outcome.
- **Keep `--autonomous` off both arms** (E1's call — it changes whole-run autonomy
  and would confound grain). Fix the model/power tier across all cells.
- **Interleave run order** across cells rather than running all repeats of one cell
  back-to-back, so any API/time drift spreads evenly instead of biasing one grain.
- **Pre-register** the task classification and the decision rule below before
  looking at any outcome.

## Analysis plan (decision rule pre-committed)

Plot false-fix rate (primary) and cost ratio (secondary) against separability
score. Pre-committed reading:

- **H-coherence supported** if separated false-fix rate exceeds holistic by a
  meaningful margin in the entangled band while the bands are ~equal at separable.
- **H-verification supported** if separated false-fix rate is ≤ holistic across
  bands (especially entangled).
- **Crossover** if the sign of the gap flips between bands — record the score where
  it flips as the candidate chop/hold threshold.
- Treat cost deltas with their spread; do not over-read a small mean difference
  (the n=1 lesson). Report a null or a surprise exactly as found.

## What this is NOT (scope guards)

A 2-grain proxy on two existing hand-built flows. It does **not** test the
assembler's full grain continuum, nested/recursive grain, or cross-cutting/
shared-state composition — those need M7 (the assembler) and E3 (the unified
unit) and are out of scope here. This experiment *informs* M7's default; it is not
the last word on grain.

## Trigger & rails

- **Fire at M7**, or earlier if an M7 design fork specifically needs the evidence.
- Harness-side only: `experiments/` and `docs/ideas/`; existing flows; no
  `src/**`, `generated/**`, `plugins/**`.
- One authorized budget envelope (pick a tier above); no open-ended live looping;
  stop-and-report on any genuine fork.

## Deliverable

`docs/ideas/grain-separability-results.md`: the separability-vs-false-fix plot,
the pre-committed verdict (which hypothesis, and any crossover score), the cost
shapes, and a one-paragraph recommendation for M7's chop/hold default.
