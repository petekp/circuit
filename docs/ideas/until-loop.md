# The until-loop: condition-gated iteration for flows

Status: `current-proposal`. This is the canonical implementation proposal for one
new engine capability. Cited file and line references are from the 2026-06-26
working tree; re-read before building, because line numbers drift.

## Build status (this branch)

Slice 1 of the build plan below is **built on `feat/until-loop`**: the
count-driven multi-step body loop, no judge and no ledger. What landed:

- `UntilLoopEngineFlag` plus `iteratesUntilCondition?` on
  `CompiledFlowEngineFlags` (`src/flows/types.ts`).
- `UntilCorridor` (`src/runtime/run/until-corridor.ts`), the fork of the slice
  corridor whose one real generalization is iteration-scoping *every* body step,
  not just the adjacent head and tail.
- The graph-runner wiring: the tail re-entry seam, `maxSteps` headroom, and the
  body-step count key, all inert when the flag is absent (byte-identical
  default).
- The full manifest path: `iterates_until_condition` on the `EngineFlagsManifest`
  schema and its `manifestEngineFlagsToInCode` translation, so a real flow that
  authors the flag onto its manifest keeps it at the manifest-to-runtime
  boundary.
- Up-front coherence validation (`assertUntilFlagCoherent`) that rejects a
  malformed flag cleanly before any step runs, the mutual-exclusion guard against
  setting both loop flags, and an explicit resume fence (until-loop resume is
  deferred to the ledger slice because per-iteration counts are not yet
  persisted).

Slice 1 is also **proven live**. A minimal two-step relay body flow that opts
into the flag ran against the real `claude` connector at autonomous depth: the
body re-entered to the iteration cap (head, tail, head, tail), each relay
returned a passing verdict, and the run closed `complete` and stopped at the cap
rather than looping on. A matched control of the same flow below the autonomous
floor ran the body once, which isolates the flag as the sole cause of the extra
iteration. That live path is now pinned deterministically: a runtime test drives
the loop through the genuine compiled-manifest boundary
(`fromCompiledFlow` translates `engine_flags.iterates_until_condition`, then the
corridor re-enters the body to the cap), so a regression in the manifest
translation or the corridor wiring is caught without a model call.

Slice 2 (the stop-judge) is **built on `feat/until-loop`**. The flag gained an
optional `stopJudge: {report, goalMetPath}` and a `needsAttentionRoute`; the
manifest schema and `manifestEngineFlagsToInCode` carry both. The corridor gained
`disposeIteration({goalProposed, evidenceConfirms})`, a pure decision with two
rules in order: a clean stop happens only on a goal the evidence confirms, and
everything else wants another pass but is bounded by the iteration cap, which can
only ever reach the needs-attention exit. The graph-runner tail seam, when a
`stopJudge` is set, reads only the judge's goal-met boolean (never the goal text),
disposes it against an evidence floor, and routes to re-enter, clean-stop, or
needs-attention. The evidence floor defaults to the same close-proof gap the
close path uses (`completeCloseProofGap`) and is injectable at the seam, which is
where slice 3's honesty-ledger latches will compose in. A flow with no `stopJudge`
keeps the slice-1 count-driven advance, byte-identical. Tests: the dispose
decision tree is proven pure and exhaustive, and end-to-end a judge that claims
done while the evidence floor refuses is blocked from `complete` and exhausts to
the needs-attention exit instead.

Slice 3 (the honesty ledger and `finalize()`, the make-or-break) is **built on
`feat/until-loop`**. A crash-durable, atomically-written run-folder ledger
(`honesty-ledger.json`) holds open overclaim latches. The close path gained a
finalize chokepoint: a `complete` close is downgraded to `stopped` while any
latch is open, mirroring the proof-gap gate but reading as an honest
non-completion rather than an abort. Under the flag, the run-boundary abort on an
exhausted in-step retry of a body step is intercepted: the engine latches the
unresolved overclaim and either re-enters a fresh iteration or, at the iteration
cap, exits `stopped` — it never aborts and never swallows. The latch clears only
when a later iteration re-runs that step and its check passes clean. The evidence
floor now reads the ledger, so a judge's met-claim cannot end the loop while a
latch is open. Building this surfaced and fixed a real carryover bug: recovery
failure evidence was not iteration-scoped for until body steps (a step's attempt
counter resets per iteration, so an earlier iteration's failed check was being
attributed to a later iteration's clean attempt). The slice-index loop scope was
generalized to a `loopBodyIndex` that covers both slice and until bodies. Tests:
15 ledger unit tests, the finalize chokepoint in isolation, and two end-to-end
real-exhaustion runs (an overclaim that never resolves exhausts to `stopped` with
the latch recorded; one that later resolves clean clears the latch and completes).

Slices 4 through 6 (carried notes, the cumulative budget cap, no-progress
steering) are **built on `feat/until-loop`**, composed at the shared stop-judge
tail seam. Slice 4: the judge writes an optional lesson alongside its goal-met
boolean; on a re-entering pass the engine appends it to a run-folder notes file
(`appendCarriedNote`, atomic, capped, modeled on the run-file store) and the next
head re-reads it, so a loop that repeats becomes one that learns. Slice 5: a
fail-closed cumulative cap (`evaluateUntilBudget`) sums per-relay usage off the
trace; at the cap the loop exits to needs-attention rather than spending another
pass, and an unmeasurable spend (a usage-less relay, or a USD cap with no
reported cost) fails closed to over-budget. A soft warning at 80% attaches a
closure-priority steer to the carried note. Slice 6: the judge writes an opaque
progress marker the engine compares only for equality; the first stall attaches a
"try a different approach" steer, and a consecutive-no-progress ceiling exits to
needs-attention before the iteration cap. All three are inert when their flag
fields are absent, so the default loop is byte-identical. The honesty stays
intact: a confirmed clean stop still completes regardless of budget or progress;
only a re-entering pass is ever forced to exhaust. Because these bounds are read
only on the stop-judge seam, the upfront validator now rejects any of them
declared without a stopJudge (a count-driven loop would silently ignore a spend
cap, a fail-open), and rejects a no-progress ceiling with no progress marker to
compare. Tests: unit tables for the notes module, the budget verdict (including
fail-closed), and the progress counter; plus end-to-end runs (carried-notes round
trip, soft-then-hard budget exit, fail-closed first-pass exit, no-progress ceiling
exit, changing progress that does not trip the ceiling, and two rejection cases
for an orphaned bound).

Slice 7 (per-iteration commit containment, opt-in and default off) is **built on
`feat/until-loop`**, the last and highest-blast-radius switch. When a flow
declares `iterationCommitContainment` AND the host injects a commit-containment
runner, each completed iteration is committed to a throwaway branch named
`${branchPrefix}-${runId}` (begun lazily on the first commit so it roots at the
pre-loop HEAD). The operator's branch ref never moves, so the operator owns the
merge; the engine never merges or pushes. The runner is an injected seam mirroring
the existing worktree runner, and the git-backed implementation is a factory
closed over an explicit project root, so the engine never reaches for ambient
cwd. Containment is fail-loud: a git error throws rather than letting a loop asked
to contain its commits run uncontained. The default stays byte-identical: with
the flag absent OR no runner injected, the engine makes zero git calls and the
loop mutates the working tree in place as before. Containment covers
the abort-intercept path too: an iteration that exhausts its in-step retries
never reaches the tail, so it is committed at the intercept instead, keeping the
branch history one-to-one with iterations and ensuring a stopped run still
contains its final pass. Tests: the engine seam against a recording fake (one
begin, one commit per iteration, indices in order) plus the inert-without-a-runner
case, two abort-intercept runs (an all-exhausting loop contains both passes and
begins the branch; an exhausted pass then a clean converging pass contains as two
commits in order), and a real git repo in a tmpdir for the factory (the throwaway
branch carries the commits, the base branch ref is untouched, an empty iteration
still records a commit, and a name collision throws).

No catalog flow opts into the flag yet; the live proof used an external
trusted-mirror manifest, and the host live-path wiring (constructing the git
runner from config) lands when a Converge catalog flow is authored. With slices 1
through 3 done, the MVP is complete: `complete` is structurally unreachable
through any exhaustion path or any open latch. Slices 4 through 7 add the
compounding, the bounds, and the containment on top of it, each opt-in and inert
by default. **All seven slices are now built.**

## One line

Give Circuit flows a `while` loop: re-enter a declared body of steps until a
goal condition is judged met and the engine independently confirms it, within
hard bounds. Today flows can run a body once, or a fixed number of times. They
cannot run it *until done*.

## The gap

Circuit's control flow has exactly two shapes today, both confirmed in code:

- **Run once.** The default. A route walks the schematic and stops.
- **For-each a fixed count.** The `iteratesSliceLoop` engine flag
  (`src/flows/types.ts:120`, driven by `SliceCorridor` in
  `src/runtime/run/slice-corridor.ts:38`) re-enters a `[head..tail]` body once
  per precomputed slice. It is a counted loop: the number of iterations is known
  before the loop starts.

What is missing is the third shape, the one every other language has: **repeat
until a condition holds.** A flow author cannot express "keep refactoring until
the test suite passes," "keep tightening this draft until the reviewer is
satisfied," or "keep working the backlog until it is empty or the budget runs
out." The iteration count is not knowable in advance because it depends on
results produced inside the loop.

This is not a small authoring gap. It is a missing primitive. The slice loop is
a `for`; this proposal is the `while`.

### Why it cannot be authored as flow topology today

A flow author cannot fake a `while` loop with a backward route. The cycle guard
forbids it. `loopBackTo` only wires a back-edge, and re-entering an
already-completed step trips `isCompletedStepReentryAbort`
(`src/runtime/run/run-transition.ts:55`), which aborts the run. That abort is
correct: it is what stops a malformed flow from spinning forever. The slice loop
is allowed to re-enter only because it is granted a narrow, iteration-scoped
exemption (`SliceCorridor.countKey` at `slice-corridor.ts:86` rewrites the step
identity per slice so re-entry is not seen as a repeat). A condition-gated loop
needs the same kind of sanctioned exemption, which means it is engine work, not
flow authoring.

Per AGENTS.md, that lands as one new `CompiledFlowEngineFlags` entry, a sibling
to `iteratesSliceLoop`. Flows stay catalog-derived. A run that does not set the
flag stays byte-identical.

## Use cases (overnight is only one)

The feature is the loop, not any single flow built on it. Things it unlocks:

- **Fix until green.** Re-run act and verify until the test or build evidence
  passes, then stop. The bounded inspect/fix/verify pattern, generalized.
- **Tighten until satisfied.** A draft or document loops through revise and
  review until a reviewer relay judges it good enough. The `tighten-loop` shape
  from the flow-file samples becomes a real construct.
- **Work a list until empty.** Pull the next item, do it, check the list, repeat
  until the backlog is empty or a budget is hit.
- **Converge a design.** Iterate a proposal against a critic until the critic
  stops finding load-bearing problems.
- **Overnight autonomous run.** A convergence loop with a large budget and
  `--autonomous` gate resolution. This is the gnhf-style use case, and it is one
  application of the primitive, not the primitive itself. The origin note
  (gnhf-style-bounded-loop, consolidated into the deprioritized ledger) worked
  that use case end to end.

Naming: the primitive is the **until-loop** (`iteratesUntilCondition`). A flow
that runs to a proven-done state on top of it is a good candidate to ship as
**Converge**, because the on-thesis property is that it converges on *proven*
done, not *claimed* done, and stops honestly when it cannot.

## The design

A new engine flag, `iteratesUntilCondition`, modeled field for field on
`SliceLoopEngineFlag` (`src/flows/types.ts:79`). It re-enters a declared
`[head..tail]` body once per iteration. Each iteration ends at a tail step whose
job is to propose whether the goal is met. The engine disposes that proposal
against independent evidence and a set of hard bounds, then either loops back,
stops clean, or stops honestly with a reason.

### The loop body

```
[frame-once] -> [plan-once] -> ( head: work-step  <- reads carried notes + open honesty latches )
                                     |   (in-step retry on its own recovery route, unchanged)
                                     v
                               [verify-step]   <- honesty checks (e.g. changed_on_disk) fire per iteration
                                     v
                               [stop-judge]    <- TAIL: reviewer relay, emits {goal_met, reason, lesson}
                                     |
   ENGINE DISPOSES at the tail seam (sibling to the slice-tail block in graph-runner):
     judge=continue, bounds ok          -> reenterRoute; advance iteration; append lesson; LOOP BACK
     judge=met AND evidence confirms     -> forward to [close]
     judge=met AND evidence does NOT     -> false-done BLOCKED: latch, route back to head
     iteration cap / budget / no-progress-> needsAttentionRoute -> [close]
     human checkpoint inside the body    -> HARD STOP (fail-closed, unchanged)
     unsanctioned cycle                  -> cycle guard ABORT (unchanged)

[close] -> finalize(ledger, stopCause)
```

### The stop-judge: propose, then dispose

The condition is a natural-language goal. Judging it is a model job, and that
judgment must never live in the engine. So the tail step is an ordinary
reviewer-role relay that emits a typed report, shaped like the existing
contract-quality lens: `{ goal_met: boolean, reason: string, lesson: string }`.

The engine reads only the boolean and disposes it against independent evidence.
A `goal_met = true` is honored only when the engine's own evidence floor agrees
(for example, `missingRunEvidence === undefined`). If the judge says done but the
evidence says otherwise, that is a blocked false-done: the engine latches it and
routes back to the head for another pass. This is the propose-vs-dispose split
that keeps Circuit honest, applied to the stop decision. A hallucinating judge
cannot end the loop on a claim alone.

### The honesty ledger and finalize() (the make-or-break)

This is the hardest part and the one a naive design gets wrong. Today, when an
honesty check like `changed_on_disk` catches a worker overclaim and the in-step
retries exhaust, the run propagates to `closeRun(context, 'aborted')` and no
state survives to a later decision. So "carry the overclaim forward and refuse to
call the loop done" does not exist yet. It is net-new state at the run-loop
failure seam, not a reuse of the honesty gate.

The honest implementation is an append-only, crash-durable run-folder ledger
(atomic write, torn-trace tolerant, per the durability tier-1 work) with latch
sets: open overclaims, exhausted steps, deferred gates, and budget state. Under
the flag, the run-boundary abort on an exhausted overclaim is intercepted:
instead of aborting, latch it, append a correction note to the carried log, and
route to the next iteration. The latch clears only when a later iteration re-runs
that step and the honesty check passes clean.

`finalize(ledger, stopCause)` is the single chokepoint that gates the terminal
label. It returns `complete` if and only if the stop cause is "goal met and
evidence confirmed" AND every latch set is empty. Any exhaustion cause (iteration
cap, budget, attempt exhaustion, no-progress ceiling) forces `needs_attention`.
This extends the existing "Run never closes complete by exhaustion" invariant
(`src/app/run-envelope/continuation-loop.ts:8`) to the body loop and to spend,
and makes "the loop succeeded" structurally unreachable through any exhaustion
path or any open latch. Build it as latch-plus-finalize, never as "swallow the
abort and keep going," which is the exact false-done laundering the thesis
forbids.

### Per-gate policy under the flag

- **Honesty check overclaim** (e.g. `changed_on_disk`): the predicate is
  unchanged and still fires every iteration. Only the run-level consequence
  changes: latch and correct and re-enter, never silently abort, never swallow.
- **In-step retry exhaustion**: mark the step exhausted for this iteration,
  latch, re-enter fresh next iteration. Safe only because three ceilings sit
  above it (iteration cap, no-progress ceiling, budget).
- **No-progress** (reuse `detectNoProgress`, pure): first hit injects a "try a
  materially different approach" lesson into the carried notes. K consecutive
  iterations on the same unmet condition route to `needsAttentionRoute`.
- **Human checkpoint inside the body**: hard-stops the loop, unchanged and
  fail-closed. This is the boundary that separates Circuit from a blanket-yes
  autonomous runner. (An earlier idea of "park the gate and keep doing other
  work" is not buildable: the runner walks a single `currentStepId` along fixed
  routes with no scheduler to route around a blocked gate. Dropped.)
- **Unsanctioned cycle**: still aborts via the unchanged cycle guard.

### Bounds: iterations, budget, no-progress

Three independent ceilings, any of which can only ever reach `needs_attention`:

- `maxIterations`: a hard count cap on body re-entries.
- Cumulative budget: a USD and/or token cap summed across iterations. Usage is
  already parsed off each relay completion and currently discarded; the loop sums
  it at the tail seam and fails closed if a connector does not report usage. A
  soft threshold (say 80%) injects a "prioritize closing out" lesson before the
  hard cap.
- No-progress ceiling: K consecutive iterations with no change to the unmet
  condition set.

### Carried notes: the compounding mechanism

Each iteration appends a short, length-capped log (the judge's `lesson`, plus any
correction or no-progress steer) to a notes file in the run folder. The head step
declares that file in its `reads`, and the prompt composer re-reads declared
files on every invocation, so the notes re-inline fresh each iteration with no
new injection machinery, framed as data not instructions. This reuses the
ambient-continuity harvest-and-inject pattern. It is what turns a loop that
merely *repeats* into one that *learns* across iterations, which is the on-thesis
codify-and-compound lever.

## Engine changes

Nine changes, each tied to a real seam. This is the same seam map worked in
the origin gnhf note; reproduced here so this proposal is self-contained.

1. **`UntilLoopEngineFlag` interface** plus `iteratesUntilCondition?` on
   `CompiledFlowEngineFlags` (`src/flows/types.ts:79` and `:120` as the model).
   Fields: `headStep`, `tailStep`, `bodySteps: readonly string[]` (the full span,
   required), `reenterRoute`, `stopJudge:{goalMetPath, lessonPath}`,
   `notes:{report}`, `maxIterations`, `cumulativeUsdCap?` / `cumulativeTokenCap?`,
   `noProgressCeiling`, `needsAttentionRoute`,
   `activateWhenDepthAtLeast:'autonomous'`.
2. **New `UntilCorridor`** (`src/runtime/run/until-corridor.ts`, fork of
   `slice-corridor.ts`). Three real generalizations: `isLoopBodyStep`
   (`slice-corridor.ts:57`) must return true for any id in `bodySteps`, not just
   head and tail (the shipped slice loop has adjacent head and tail, so a
   multi-step body is untested today and the first intermediate step would abort
   on re-entry); `countKey` (`slice-corridor.ts:86`) returns
   `${stepId}#i${iterationIndex}` for every body step; replace count-driven
   advance with `disposeIteration({goalProposed, evidenceConfirms, usageSoFar,
   noProgress, iterationIndex})`.
3. **Construct the corridor and extend `maxSteps` headroom** in the graph runner:
   `default + maxIterations * bodySteps.length`.
4. **Wire body-step `countKey` / `isLoopBodyStep` into the step preamble**,
   mirroring the slice block. The cycle guard stays unchanged; the
   iteration-scoped count key is the entire exemption.
5. **Tail dispose seam**, a sibling to the slice tail block in the graph runner:
   read the judge boolean via `goalMetPath`, compute `evidenceConfirms`, sum
   trace usage, run `detectNoProgress`, call `disposeIteration`, select
   `reenterRoute` / `needsAttentionRoute` / forward.
6. **Honesty ledger** (`src/runtime/run/honesty-ledger.ts`, new) plus the
   intercept at the run-boundary abort seam. The make-or-break above.
7. **`finalize(ledger, stopCause)`** at the close path, the single anti-launder
   chokepoint, wired to host status through the existing terminal-outcome
   binding.
8. **Cumulative usage accumulator** at the tail seam, reading the per-relay usage
   already extracted on `relay.completed`. Fail closed on missing usage.
9. **Stop-judge report and notes append** are flow-package and engine-glue
   respectively: the judge is a flow report schema (no NL in the engine); the
   notes append is read-existing, append, atomic write, length-capped, modeled on
   the continuity harvest.

Checkpoints stay fail-closed and `detectNoProgress` is reused as-is. Nothing in
the engine learns the goal text; it only disposes a boolean against evidence.

## Build plan (smallest viable first)

1. **(medium, engine) Count-driven multi-step body loop, no judge, no ledger.**
   Add the flag, `UntilCorridor`, the tail re-entry seam, and `maxSteps`
   headroom, advancing on a fixed `maxIterations` count only (judge stubbed to
   always-continue). Proves the one genuinely new primitive in isolation:
   iteration-scoping a full multi-step `[head..tail]` span, which the slice loop
   never exercised. Offline test on a 3-step body fixture asserting no cycle-guard
   abort on intermediate re-entry, and byte-identical default when the flag is
   absent. **Build this first**: getting the count-key generalization wrong would
   silently abort on the first intermediate body step.
2. **(medium, flow + engine) Stop-judge plus propose-vs-dispose.** Reviewer tail,
   engine reads the boolean and disposes against the evidence floor; a met-claim
   with unmet evidence routes back to head (false-done blocked). Deterministic
   judge stub keeps the loop policy offline-provable.
3. **(large, engine) Honesty ledger plus `finalize()`.** Behavioral test: a judge
   that claims done while an overclaim latch is open must yield `needs_attention`,
   never `complete`.

   Slices 1 through 3 are the MVP: a bounded, judge-gated, honestly terminating
   `while` loop.

4. **(small, engine + flow) Carried notes.** Turns repeat into learn.
5. **(small, engine) Cumulative budget cap, fail closed.** Soft threshold injects
   a closure-priority lesson.
6. **(small, engine) No-progress steering plus K-ceiling.**
7. **(medium, engine, opt-in, default off) Per-iteration commit containment** on a
   throwaway worktree branch; operator owns the merge. Highest blast radius;
   ships last and off by default.

## Why Converge gates on a boolean, not a metric

`karpathy/autoresearch` runs the same loop shape in the optimize flavor: hill-climb
a scalar metric (`val_bpb`), keep the change if the number improved, `git reset` if
not, and repeat forever. It is tempting to add a metric-gated Converge variant that
keeps the best-scoring iteration. That variant is deliberately declined, for two
reasons that are load-bearing for this whole design.

1. **The ratchet needs an ungameable oracle Circuit does not have.** autoresearch
   stays honest only because `prepare.py` (the eval) is read-only and the agent
   physically cannot touch it. Circuit's analog is a worker-adjacent verification
   command, which the body can edit. The moment the body can influence the number,
   a keep-best ratchet launders Goodhart gaming as monotone progress. (The
   frozen-eval detective latch, from the learning-from-autoresearch note, imports the
   read-only-surface *shape* without the metric ratchet, precisely because the
   shape is the safe half.)

2. **An optimizer's natural terminus is the one this loop forbids.** An
   optimize-a-number run ends by exhausting its budget and keeping the best so far.
   That is a clean, expected non-failure for an optimizer. But it is exactly the
   success-through-exhaustion path the honesty ledger and `finalize()` are built to
   make unreachable for a Converge run. A boolean goal is what lets "ran out of
   iterations" mean `needs_attention`, never `complete`.

Two nuggets are worth keeping without the loop: carried notes could optionally
carry a verification command's numeric result as read-only context for the worker
to reason over (a `results.tsv`-style memory), and `commit-containment.ts` could
gain a revert-to-champion op, but only if a trustworthy metric oracle ever lands. A
scalar metric-convergence variant (a `metricPath` plus keep-best hill-climb) is
deferred until a concrete continuous-metric flow exists that needs it; it serves an
optimize-a-number thesis, not the proven-done honesty thesis this loop was built
for.

## Open questions

- **Depth label.** The slice loop maxes at `high`; this proposes activating at a
  new `autonomous` tier, which already exists in
  `slice-corridor.ts:19` `DEPTH_ORDER`. Confirm `autonomous` is the right
  activation floor versus reusing `tournament`.
- **Which flow opts in first.** A new dedicated flow, or extend an existing one?
  A new flow avoids the slice loop and until-loop colliding on one iteration
  index (they cannot nest under the single-counter model). Lean: a new flow.
- **Latch-clear topology.** An overclaim latch clears only if the same step
  re-runs. For a strictly linear body that never re-enters the offending step,
  the run can only end `needs_attention`. Acceptable, or does the judge need to
  route a targeted re-do of just that step?
- **Commit model default.** Squash-at-end versus per-iteration. `changed_on_disk`
  catches overclaims, not bad-but-honest edits, so an overnight run can still
  pile up many real-but-wrong committed iterations.
- **Budget fail-closed ergonomics.** Failing closed on missing usage is safe but
  halts a legitimate run behind a connector that does not report usage. Add a
  per-connector "usage-trusted" flag, or accept it for v1?
- **Where the goal text lives.** Should `goalCondition` source from the existing
  but unused `RunGoalContract.stop_conditions` field, so the contract writers and
  the loop finally agree, or carry it on the flag?

## Relationship to other notes

- The gnhf-style-bounded-loop note (consolidated into
  [`deprioritized-ledger.md`](./deprioritized-ledger.md)): the origin and the
  worked overnight use case. It framed the loop around the gnhf comparison;
  this note is the general primitive we implement from. They share the engine
  seam map.
- `portable-flow-file-format.md` and `bespoke-flow-generation-design.md`: the
  "encode your process" on-ramps. A flow author who can write a portable flow file
  or generate one will want the until-loop as a construct those flows can use.
- `long-horizon-supervision.md`: the deferred live companion-supervisor idea,
  out of scope here.
