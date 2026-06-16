# Big overnight brief — foundation completion + frontier spike

> Status: highest-effort, multi-subagent (ultracode) overnight run. Written
> 2026-06-14. Goal: complete the rest of the **foundation** and a significant,
> *safe* portion of the **distinctive frontier** in one run, as separate held PRs.
> Locked decisions: **grain experiment = run (standard tier)**; **frontier forks =
> spike & surface**. Ambition is high; the discipline that keeps it safe is below —
> build everything well-specified, *run* the one experiment that produces missing
> data, and *prototype-and-surface* the few reserved judgment-forks rather than
> commit them.
>
> Ground first against: `fallible-executor-audit.md`,
> `grain-separability-experiment-design.md`, `decision-layer-exploration.md`,
> `e2-equipment-scope-spec.md`, the gap analysis in `paper-to-site-flow-brief.md`,
> and `exploration-substrate-two-track-plan.md`.

## How to run it

Fan subagents across the independent chunks. **One held PR per coherent chunk**
(partial completion just means you keep what finished). Highest effort. Prefer a
clean stopping point + report over forcing "done." Where chunks share files (the
runtime/run path especially), sequence them and note the recommended merge order
in the report.

## Tier A — finish the foundation (build all; well-specified)

- **A1 · Durability Tier 2 — the resumable cursor + channel rehydration.** Make a
  half-finished run forward-recoverable from durable state alone (per the audit's
  Tier-2 sizing). The core robustness unlock; also lifts the
  checkpoint-in-slice-loop ban once the slice index is durable.
- **A2 · Durability Tier 3 — crash-safe sub-run/fanout linkage** (children linked
  before join; no orphaned worktrees). **Gated on A1.**
- **A3 · Parallel decision inbox** — surface, triage, and resume the parked runs
  waiting on a fork (the "dozens in parallel, steer at forks" surface). **Gated on
  A1** (needs durable, resumable runs).
- **A4 · Stock the pantry (typed vocabulary)** — register bodies for the *uniform*
  generic spine contracts (lift from their flow-scoped actuals); **leave the
  divergent write-only umbrellas alone** (the M8 Option-1 call). Classify honestly;
  don't force-type a divergent generic. Then re-run the flow lab and report whether
  the assembler's shape-variety improved (a finding).
- **A5 · Migrate the 6 remaining built-ins onto the assembler** (zero-behavior-
  change, byte-identity-proven like build/pursue). Migrating a *differently-shaped*
  one (goal, explore) stress-tests assembler generality — **report whether it's
  genuinely general or still build-locked** (a finding that informs the chooser).
- **A6 · Real equipment skill/house-style injection** (beyond #88's trusted-suggest
  prototype, per the e2 spec); drive the skill-slot quality ratchet down. Tool
  scoping already shipped (#89) — this is the skills half.

## Tier B — a real chunk of the frontier (data-gated + spike-and-surface)

- **B0 · Pre-grain harness gate.** Validate the grain harness cheaply (fixture/dry
  check) against post-M9 **before** any spend. Broken → fix it harness-side
  (`experiments/`, no engine) or skip the live run and surface. Sound → proceed.
- **B1 · Run the grain experiment** (standard tier, extremes-first, **~$90–120 hard
  cap**). Apply its **pre-registered decision rule**. **Write the classification +
  evidence to the report before branching.**
- **B2 · Grain-verdict branch — the structure chooser.**
  - *Clear verdict* (coherence-dominates → conservative; verification-dominates →
    aggressive; crossover-at-S → threshold S): build the chooser at that setting,
    wire it into the assembler as the structure resolver, and **validate** via the
    flow lab (the quality ratchet improves).
  - *Ambiguous / null*: build the **thin conservative** chooser only and surface
    "needs more data." **Default to this safe branch on any genuine ambiguity.**
- **B3 · The two resolvers, properly** (structure from B2 + equipment) — built to
  the **same shape**; **record the shared shape** that emerges; **do NOT extract
  the unified abstraction** (earn it from instances — that extraction is a surfaced
  decision, not an overnight commit).
- **B4 · Spike-and-surface the deep forks — NOT committed to the engine.** For each
  of uniform recursion (E3), the resolver abstraction, and the adaptive
  bubble-up-recompile: a throwaway prototype/spike **plus a decision-ready spec**
  (the fork, the options, a recommendation, what it would take). Land these as docs
  + experiments only — never merged into `src/`.

## The conditionals in this plan (the verdict-gated edges)

- **Grain verdict → chooser depth** (B2). Predicate = the experiment's pre-
  registered rule; classification written before branching; default-to-safe on
  ambiguity.
- **A1 (Tier 2) success → A2 + A3**; A1 stalls/forks → surface it, skip the
  dependents, keep the independent chunks running.
- **B0 harness gate → B1 spend** only if the harness is sound.

## Finished-early backlog (never idle — priority order)

If everything above lands with time to spare: (1) decision-ready specs for the
surfaced deep forks (highest value — so the operator wakes to ratifiable specs);
(2) more built-in migrations / deeper equipment-skills; (3) richer grain-experiment
tasks for stronger data. All additive; **no deep-fork commits**.

## Rails (the contract)

- **One held PR per coherent chunk; HOLD MERGE on all.** Never merge, rebase main,
  or force-push. Note recommended merge order in the report.
- **Reserved deep forks (E3 / abstraction / adaptive) are surfaced, not committed**
  — regardless of any result. The grain verdict gates the *chooser's* depth only.
- **Budget:** the grain experiment is the *only* authorized model spend (standard
  cap). Everything else is offline/coding. No other live or budget runs.
- Never special-case the engine; failing-test-first for every `src/` change; full
  `npm run verify` green per PR.
- **Stop-and-report** on any unplanned blocker, or any genuine fork not covered by a
  pre-registered branch above. A clean partial + report beats a forced "done."
- Isolation per chunk (own worktree/branch); use a task list; fan subagents.

## Morning report (the deliverable)

`docs/ideas/overnight-run-report.md`: what landed per chunk (+ PR links and the
recommended merge order); the **grain verdict, its classification + evidence, and
which B2 branch was taken**; the A1→A2/A3 dependency outcome; the surfaced deep-fork
decisions with their specs; the findings (assembler generality from A5, vocabulary
payoff from A4); and what's left or blocked.
