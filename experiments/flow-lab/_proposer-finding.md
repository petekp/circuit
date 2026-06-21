# Proposer spike + verifier-repair loop — finding (REPRODUCED)

**This run:** 2026-06-21. **Model:** claude-haiku-4-5 (proposer), pinned, effort low.
**Cost:** ~$1.5 (offline floor is $0; only the haiku propose/repair calls cost).
**Harness:** `experiments/flow-lab/proposer-spike.ts` — tracked, default-OFF,
standalone (`npx tsx ...`), never imported by `src/`, never a vitest test.
**Raw data:** `_proposer-results.json` (full 8-task × 2-rep run, 2 repair rounds)
and `_proposer-results.build-feature-refactor-multi-flow.json` (targeted 4-round
re-probe). Method prompts read from disk: `_proposer-prompt.md`, `_repair-guidance.md`.

> **Provenance note.** The original spike (2026-06-20) was prose-only: its
> data-generating script (`_proposer-validate.ts`) was not kept on disk, so its
> figures (`1/8 → 6/8` runnable, single-rep) were unreproducible. This is a
> **faithful rebuild and re-run** on today's main, with the harness now committed.
> The rebuilt run uses **2 reps × 8 tasks = 16 trials** (vs the original's 8), so
> cite these as a reproduction with **new data and new denominators**, not the
> original's numbers. The floor itself also advanced between the two dates
> (Phases A/B/C + the fanout/sub-run terminal work all merged after 2026-06-20),
> so divergences are expected and are themselves a result. Genuineness of the
> harness (real floor, real pin, no false-positive path) was adversarially
> verified — see "Genuineness" below.

## The question

The north star has two halves. **VERIFY** — check a composed flow is good — is
shipped and test-locked: `composeFlow → evaluateValidity → evaluateRunnability` is
the same offline floor the live composed arm passed, so "RUNNABLE offline" is a
proven predictor of live-runnability. **PROPOSE** — turn a task into a flow shape —
was never wired into a callable unit. This spike asks: **can a pinned model do the
PROPOSE half, and can the (proven) verifier drive it to a runnable flow?**

## Setup

- 8 tasks spanning the shapes: simple fix (linear), flaky fix (loop),
  compare-3-approaches (fanout), two-standalone-tasks (sub-run), security audit
  (review-only), research/decide (no-act), build-a-feature (linear), refactor
  (linear). Each run twice (rep1/rep2). The model never saw the "expected shape".
- The proposer prompt gives the model the block menu + the four shapes + house
  patterns + the role-set JSON format + one worked example (`_proposer-prompt.md`).
- Each proposal is scored through the REAL floor (`composeFlow → evaluateValidity →
  evaluateRunnability`). On failure, the model is re-prompted with its own flow +
  the verifier's **exact error(s)** + a general error→action ruleset
  (`_repair-guidance.md`), capped at N repair rounds (default 2).

## Headline (this run, 16 trials, 2 repair rounds)

| metric | result |
|---|---|
| shape selection correct | **12/16** |
| raw runnable (no repair) | **4/16** |
| post-repair runnable (≤2 rounds) | **9/16** |
| paid model calls | 35 |

## Result 1 — the model picks the right SHAPE (reproduced, strong, stable)

12/16, and all four "misses" are soft: a `loop` for a simple fix (defensible —
verify-then-retry is a reasonable fix shape), and `review-only` for the
research-decide task ×2 (the model chose a review-intake opener instead of a
frame→analyze→close "no-act" shape — both are no-code-change shapes; this is the
scoring key being stricter than reality, not a real selection error). Each task's
shape was consistent across the two reps. **The PROPOSE half substantially works:
given the action space and house patterns, the model maps a task to a sensible
topology.** This reproduces the original Result 1.

## Result 2 — raw proposals rarely run (4/16), but less rarely than before

Raw-runnable rose from the original `1/8` to `4/16` (≈25%). The lift is the floor
advancing: `audit` (review-only) and `fix-flaky` (loop) now run raw because the
generic terminals shipped since 2026-06-20 made those shapes composable without a
family's internal scaffolding. Direction holds (raw is low); magnitude improved.

## Result 3 — verifier feedback DRIVES repair, but the RATE is budget- and guidance-sensitive

The original's clean `1/8 → 6/8` headline does **not** reproduce as a fixed number.
This run got `4/16 → 9/16` (≈56%) at 2 rounds. The **mechanism** reproduces — the
model reads a composer abort and drops the offending step or adds a precursor — but
the convergence RATE depends on the repair budget and the task wording. The targeted
4-round re-probe (`--max-repair=4`) decomposed the gap precisely:

| task | shape | 2-round | 4-round re-probe | class |
|---|---|---|---|---|
| fix-flaky | loop | RUN (raw / round1) | — | converges |
| compare-approaches | fanout | RUN @ round1 ×2 | — | converges |
| research-decide | review-only | RUN @ round1 ×2 | — | converges |
| audit | review-only | RUN raw ×2 | — | converges |
| fix-simple | linear/loop | rep1 raw RUN; rep2 WALL | — | rep2 = model emitted an invalid `stage` enum during repair (JSON-noise) |
| **refactor** | linear | WALL ×2 | **RUN @ round2 and round4** | **budget-sensitive** — more rounds rescue it |
| **build-feature** | linear | WALL ×2 | **WALL ×2** | **guidance gap** — resists even 4 rounds |
| **multi-flow** | sub-run | WALL ×2 | **WALL ×2** | **structural** — family-locked terminal |

So the `9/16` understates what repair can reach: with a 4-round budget, `refactor`
joins the converged set (effectively ~11/16), leaving three residual classes.

## Result 4 — the residual walls, by exact verifier reason

**(a) sub-run — genuine STRUCTURAL wall (the one remaining engine unlock).**
`goal-close: no input set satisfiable; needs one of [goal.contract@v1,
goal.attempt@v1, goal.evidence-evaluation@v1], have produced [goal.contract@v1,
goal.child-run@v1]`. A freely-composed sub-run (frame-goal → goal-child-run →
goal-close) does not produce `goal.attempt@v1` / `goal.evidence-evaluation@v1` —
those come from the goal family's internal attempt+evaluate steps. **4 repair rounds
do not help**, both reps. The generic-close pattern (`flow.result@v1`) that freed
linear/loop AND the fanout aggregate terminal was never extended to the sub-run
close. This is the precise next durable unlock — the same medicine, applied to one
more close writer. (Reproduces the original Result 4's sub-run diagnosis exactly.)

**(b) build-feature — repair-GUIDANCE gap (repairable in principle, not reached).**
Round 1: `plan(build.plan@v1): expected exactly one report writer for schema
'build.brief@v1', found 0` — the "build a feature" wording biases the model toward
a build-family `plan` step that needs `build.brief@v1` (unproduced). Round 2+: the
model drops `plan`, but now `act: no input set satisfiable; needs one of
[flow.brief@v1, diagnosis.result@v1] OR [flow.brief@v1, plan.strategy@v1] ...` —
`act` is starved. It oscillates (drop plan → act starves; keep plan → brief wall)
and never makes BOTH moves at once (drop the family-locked plan AND insert a
`diagnose`/researcher to feed `act`), even at 4 rounds. This is the
intermediate-writer-coupling wall the original named, and it is the one place the
rebuild diverges from the original prose (which reported build-feature converging).
Whether the divergence is model variance or a weaker repair ruleset is unresolved;
either way the lever is a better repair rule, not an engine change.

**(c) fanout — HOLDOUT NOW CLOSED (positive divergence).** In the original, fanout
was a named family-locked holdout that did NOT converge. Here it converges to
runnable at **round 1, both reps**, after the repair rule steers a separate
`run-verification` away from the fanout's internals
(`prototype.variant-aggregate@v1`). The fanout terminal work shipped since
2026-06-20 (the generic aggregate contract) is corroborated end-to-end through the
proposer harness: **the named frontier shrank from two shapes (fanout + sub-run) to
one (sub-run).**

## Genuineness (adversarially verified, 2026-06-21)

An adversarial reviewer confirmed: `runFloor` routes through the genuinely-exported
`composeFlow`/`evaluateValidity`/`evaluateRunnability` (the same functions the
shipped eval uses), a `runnable:true` verdict REQUIRES all three gates to pass and
every try/catch fails closed, degenerate/empty/junk role sets are all rejected by
the real floor (no false-positive path), the pin genuinely emits
`--model claude-haiku-4-5` (corroborated by a real `session_id` in a captured
timeout), and the method reads the prompt files from disk (no inlined divergent
copy). A defense-in-depth `checkedSteps > 0` assertion was added to `runFloor`.
**Verdict: GENUINE.** Counting can only deflate (relay failures and the
`MAX_MODEL_CALLS` backstop yield non-runnable), never inflate.

## What this means for the north star

1. **PROPOSE (shape selection) is reproduced and robust.** A model maps tasks to
   the right shapes, stable across reps. This half is no longer hypothetical.
2. **VERIFY-drives-repair reproduces as a MECHANISM**, not as a fixed rate. The
   cheap, trustworthy floor's error messages do steer the model to runnable flows —
   but the rate is sensitive to repair budget (2 rounds under-converges; `refactor`
   needs 2–4) and to a guidance gap on build-family-biased tasks.
3. **The frontier work paid off, visibly.** Fanout went wall→run through the
   proposer; the structural frontier is now exactly ONE shape: sub-run.
4. **A real product path remains** `propose → floor → (on wall) surface error →
   repair → floor`, capped at ~3–4 rounds, defaulting to the proven family template
   if it doesn't converge. Buildable and bounded.

## Next steps (in order of leverage)

- **Engine (highest):** a generic **sub-run close builder** that closes on whatever
  the child produced (`goal.child-run@v1` + the generic result), extending the
  proven `flow.result@v1` / fanout-aggregate generic-close pattern to the last
  family-locked terminal. TDD, byte-identical built-ins. This is the single
  remaining structural wall.
- **Harness/guidance (cheap):** a repair rule that breaks the build-family
  `plan`/`act` oscillation in one move ("if dropping `plan` starves `act`, ADD a
  `diagnose`/researcher"), and a default repair budget of 3–4. Would lift the
  linear-build convergence without touching the engine.
- **Optional capstone:** fold the loop into a `proposeFlow(task) → role set`
  callable unit with bounded verifier-feedback retry, so PROPOSE is a function, not
  an agent ritual — gated behind an opt-in flag, after the sub-run terminal lands.
