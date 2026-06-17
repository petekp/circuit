# Two-track plan: the M-spine and the exploration substrate

> Status: **largely realized; superseded in framing.** Written 2026-06-13;
> status note added 2026-06-16. The decision-layer framing in
> [`decision-layer-exploration.md`](decision-layer-exploration.md) is the successor
> to this plan, and the substrate this plan scoped has since been built: the M-spine
> (Track A — the typed seam M5/M8) merged with the first-class-composition work, and
> the start-now-additive pieces shipped — **equipment scope** (primitive 3b, PR #89
> + the equipment resolver) and **commensurable traces / the quality ratchet** (the
> offline flow lab, `experiments/flow-lab/`). What remains on the gated track is the
> self-similar-unit merge (splice-as-leaf) and a fuller legible-composition surface,
> both still surfaced — see
> [`deepfork-uniform-recursion-e3-spec.md`](deepfork-uniform-recursion-e3-spec.md)
> and [`north-star-status.md`](north-star-status.md). The plan below is kept as the
> dependency-cut record.
>
> A plan for making the recursion / holism-separation /
> re-integration techniques *cheap to explore*, without destabilizing the
> in-flight first-class-composition migration. The core claim from the prior
> analysis: finishing M1–M9 does **not** by itself hand you an exploration
> substrate — equipment scope, run isolation, and a legible composition surface
> are not deliverables of that program. So the question isn't "interleave vs.
> wait"; it's "start the additive, dependency-free pieces now (informed, and
> de-risking the expensive end of the roadmap) or build them later, blind and
> sequential." This plan runs two parallel, separately-disciplined tracks with a
> clean dependency contract between them.

## The goal, in one line

Turn each technique (recursion, intelligent holism/separation, re-integration)
from *a system you build* into *an arrangement you run* over a shared substrate —
so the next twenty experiments each cost a day, not a quarter. The deliverable is
optionality, not any one technique.

## The dependency cut

The six primitives from the substrate analysis split along one line: what depends
on the by-id dissolution (M4) and the typed seam (M5/M8), and what doesn't.

| Primitive | On the M1–M9 line? | Track / gate |
|---|---|---|
| 1 — self-similar unit (flow = composite harness) | M4 is the precondition; the merge itself is beyond M9 | Track B, gated on M4 |
| 2 — typed + enforced seam | **is** M8 + M5 | Track A (consumed by B) |
| 3a — context envelope | done (M1 route-aware availability) | already shipped |
| 3b — equipment scope | **not on the line** | Track B, start now |
| 4 — legible composition surface + repair edges | partial M7; the surface itself unscheduled | Track B, gated on M4 |
| 5 — isolation / change-packets | separate track (sandboxed pursuits) | Track B, start now |
| 6 — commensurable traces | mostly exists; ratchet separate | Track B, start now |

Three are start-now-additive (3b, 5, 6). Two are gated on the spine (1, 4). One
*is* the spine (2). That split is the whole plan.

## The two tracks

```
 TRACK A — correctness / unification spine      TRACK B — exploration substrate
 (the migration, on its own discipline)         (parallel, separately disciplined)

 M3b  serialize manifest fields                 E1  smallest demo — one task,
  │   (frontier today)                              H vs S, isolated, measured
  ▼                                             E2  harden the 3 orthogonal
 M4   LINCHPIN: dissolve by-id ───────────┐         primitives: kit / isolation
  │   → uniform, id-agnostic unit          │        / comparison
  ▼                                        └───► E3  unit-unification:
 M5   flip fail-closed gate ────────┐               flow = composite harness
  │                                 │               → uniform recursion
  ▼                                 ├─────────► E4  composition-as-data +
 M6   collapse data/schematic       │               repair edges (with M7)
  │                                 │               → planner-decided holism
  ▼                                 │
 M7   assembler ────────────────────┘
  │
  ▼
 M8   typed seam (Zod) + M5 enforce ──────────► E5  app-builder V at scale
  │                                                 (consumes typed+enforced seam)
  ▼
 M9   composed runtime
```

## Track A — the spine (stated, not redesigned)

Track A is the existing M1–M9 program; this plan does not alter it. It owes Track
B exactly two things, and Track B is sequenced around their arrival:

- **M4 — a uniform, id-agnostic unit.** Dissolving `findCompiledFlowPackageById`
  at the six call sites is the precondition for treating a built-in flow, a
  composed flow, and a nested sub-tree as *the same kind of thing*. Until it
  lands, "flow = composite harness" (E3) can only be faked with hand-authored
  sub-runs.
- **M5 + M8 — a typed, enforced seam.** Real payload bodies plus the fail-closed
  gate are what make an *arbitrary* arrangement safe at scale. Until they land,
  Track B runs only hand-authored, isolated, small experiments on name-matched
  seams, explicitly labeled shape-finding, not production claims.

Everything else in Track A (M6 collapse, M9 composed runtime) is independent of
Track B and proceeds on its own.

## Track B — the exploration substrate

| # | Deliverable | Primitive(s) | Technique unlocked | Gate | Build vs. reuse |
|---|---|---|---|---|---|
| **E1** | One task, two shapes, measured (the demo) | 3b·5·6 (minimal) | measured holism/separation on one task | none — **start now** | mostly reuse; thin glue |
| **E2** | Harden the three orthogonal primitives | 3b·5·6 | cheap repeatable holism/sep + re-integration | none | build (durable form) |
| **E3** | Unit-unification: flow = composite harness | 1 | uniform recursion | **M4** | build on M4 |
| **E4** | Composition-as-data + repair edges | 4 | planner-*decided* holism/sep; design repair | **M4**, with M7 | build with M7 |
| **E5** | App-builder V, end-to-end at scale | consumes 2 | the full down-decompose / up-assemble V | **M8 + M5** | build on the typed seam |

### E1 — the smallest "run one variant and measure it" demo

This is the keystone: the minimal thing that closes the measurement loop and
forces the three start-now primitives into existence in crude form. Every later
experiment is "add a third variant" or "turn one knob."

**Setup.** Pick one existing eval task with a defined `done_when` (reuse the eval
taskset; do not invent a task). Author two arrangements *by hand* over today's
block palette:

- **Variant H (hold whole):** `frame → one wide-envelope work harness (broad
  reads, full tools) → verify`.
- **Variant S (separate):** `frame → split into 2–3 leaf harnesses (narrow reads,
  each validates its I/O) → reassemble (compose) → verify`.

**Run.** Execute each variant in its own isolated worktree (reuse the existing
fanout/sub-run per-branch worktree path), so the demo is non-destructive and the
two runs cannot collide.

**Measure.** Emit one comparable record per variant: verdict against `done_when`,
the evidence/quality signal (from the existing verification machinery, not just
pass/fail), cost (the existing per-role run receipt), and — if it failed — the
seam it failed at.

**Output.** A one-page side-by-side: H passed at \$X in N steps; S passed at \$Y
in M steps (or failed at the reassembly seam). **Success = the loop runs and
yields a comparable verdict + cost for both shapes of the same task, safely.**

**Reuses:** eval task + `done_when`, worktree isolation, the run receipt, the
trace, existing blocks. **Builds:** a thin two-variant runner, the comparison
report, and a crude envelope/kit dial (hand-set reads + a per-harness tool list).
**Explicitly out of scope:** M4 (unit), M7 (assembler — variants are
hand-authored), M8 (types — name-matching is fine at this scale), the enforced
gate (eyeballed at this scale). Deferring all of these is exactly what makes E1
buildable *now*.

### E2–E5 in brief

- **E2** turns E1's crude glue into durable primitives: equipment scope as a
  first-class declared + write-tier-enforced field (authored **manifest-first**);
  isolation generalized into change-packets with a `disjoint-apply` join (the
  sandboxed-pursuits substrate); the comparison harness as a real A/B tool over
  any two arrangements. After E2, an experiment is config, not code.
- **E3** (after M4) makes a flow a composite harness, so a sub-tree is
  substitutable for a leaf and recursion is uniform rather than a hand-authored
  special case.
- **E4** (after M4, with M7) lifts arrangement — sequence, recurse, fan-out,
  loop, and the upward **design-repair edge** — into authorable/generatable data,
  so the chop/hold/fan-out planner becomes a swappable function and you can
  explore *intelligent* (planner-decided) holism/separation, not just
  hand-authored variants.
- **E5** (consuming M8 + M5) re-runs the experiments on the typed, enforced seam
  at scale — the app-builder V. This is where shape-findings from E1–E4 become
  production claims.

## The dependency contract

**Track A promises Track B:** M4 delivers the id-agnostic unit; M5 + M8 deliver
the typed, enforced seam. Track B builds nothing that front-runs these — E3 waits
for M4, E5 waits for M8/M5.

**Track B promises Track A — the must-not list:**

1. **Never special-case the engine.** Every experiment is data over the existing
   execution kinds (`sub-run`, `fanout`, slice-loop, recovery routes). If an
   experiment seems to need a new engine branch, that is a *finding* handed to
   Track A ("a primitive is missing"), not a hack. This is AGENTS.md's standing
   rule.
2. **No new by-id fallback.** Equipment scope (3b) is authored manifest-first, so
   it never creates the kind of by-id package field that M4 then has to dissolve
   (the mistake `engine_flags` had to unwind in M3b).
3. **Do not interleave into M-commits.** Track B lives in its own surface (an
   experiment runner, a few blocks, a comparison report). It must not dilute the
   migration's byte-identity / accommodation-ledger / adversarial-review
   discipline.
4. **No production claims before M5/M8.** E1–E4 results are labeled shape-finding;
   they are re-validated at E5 on the typed seam. (Match the proof to the claim —
   the same discipline as "byte-identity is not universal proof.")

**The payback to Track A:** E1–E4 learn the *shape* that recursion, holism, and
re-integration actually want — and that shape feeds the design of M7 (assembler),
M8 (which payloads the types must express), and M9 (composed runtime). The
alternative is building the expensive end of the roadmap blind to how the
techniques behave.

## Risks and honesty

- **Name-matched seams can flatter a result.** A holism/separation finding on
  E1–E2 might not survive real typing. Mitigation: the shape-finding labels and
  the E5 re-validation.
- **Shallow metrics.** Cost + pass/fail is not quality. Lean on the existing
  evidence/verification machinery for the quality signal, or the comparison
  rewards cheap-but-worse arrangements.
- **Re-integration gets more holistic as it ascends.** The up-pass of the V is
  real design work, not mechanical compose; E5 should hold-whole more the higher
  it climbs rather than assume clean composition.
- **The real deciding variable is capacity, not architecture.** If there is no
  room for a genuinely parallel, separately-disciplined track, E1 still slots in
  after M4/M5 — but you forfeit the de-risking of M7/M8 and the early learning.
  Interleaving Track B into the migration's single stream is the one option to
  avoid: it fragments the rigor that makes Track A trustworthy.

## First action

Build **E1** against one existing eval task. It is mostly wiring — two
hand-authored variants, the existing worktree isolation, the existing receipt,
and a comparison report — and it converts this entire discussion into a running
measurement loop you can extend one knob at a time.
