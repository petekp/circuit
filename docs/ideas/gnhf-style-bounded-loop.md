# gnhf-style bounded autonomous loop in Circuit

Status: `current-proposal`. Feasibility analysis plus an implementation sketch.
Nothing here is built. Verify every file and line against current source before
treating any seam as implementation truth. Cited line numbers are from the
2026-06-26 working tree.

## What gnhf is

[gnhf](https://github.com/kunchenguid/gnhf) ("Good Night, Have Fun") is an
overnight autonomous loop. Its own words: it "repeatedly calls another coding
agent until a natural-language stop condition is met." The load-bearing
primitives are a runtime iteration loop, stop conditions and budgets
(`--max-iterations`, `--max-tokens`, `--stop-when "<observable condition>"`),
fully unattended execution, a separate git commit per successful iteration, a
`notes.md` running log carried into the next iteration's prompt, non-interactive
agent subprocess invocation, and an optional `--worktree` parallel mode. Its
sibling [no-mistakes](https://github.com/kunchenguid/no-mistakes) supplies the
"blanket yes" automatic posture. See the sibling note in memory for the market
read.

## The question and the short answer

What would it take for Circuit to support something like this as a flow?

Less than the framing suggests. Circuit already owns most of the substrate. The
gnhf loop is not authorable as flow topology, but the missing pieces are a
handful of additive changes on seams that already exist, gated behind one new
`CompiledFlowEngineFlags` entry. The bounded version is roughly two weeks of
engine work, plus one genuinely hard part: a calibrated natural-language
stop-condition judge.

The single most important correction to the obvious framing: "Circuit is a
one-shot DAG with no runtime loop" is wrong. `src/runtime/run/graph-runner.ts`
is a route-driven step machine, routes can point backward, and
`src/app/run-envelope/continuation-loop.ts` is already a bounded autonomous loop
with no-progress escalation and a "never closes complete by exhaustion"
invariant, wired into the real CLI via `--autonomous`. The loop kernel ships.
What is missing is gnhf's character, not the loop itself.

## Capability map

Seven axes, each mapped against real code.

| gnhf primitive | Circuit today | Gap | Lands as |
|---|---|---|---|
| Non-interactive agent subprocess | Full (`connectors/subprocess.ts`, `claude-code.ts` `-p`/stream-json/`--tools`, 3 backends) | failures collapse to one `connector_failed` (`relay.ts:616-666`); no backoff classifier | engine, small |
| Unattended / headless run | Full (`--autonomous` + `safe_default_choice` auto-resolve) | gnhf assumes blanket `-y`; Circuit fails closed on undeclared gates | mixed, small |
| Parallel isolated worktrees | Full, ahead of gnhf (`fanout` + `worktree add -b` + reaper + join policies) | semantic: breadth-fanout of one step, not N overnight goals | engineFlag, small |
| Iterate-until-condition loop | Partial (`continuation-loop.ts` real but capped; back-edges cap ~2; cycle guard aborts re-entry) | no open-ended, budget-governed relaunch; continuation is structured, not NL | engineFlag, medium |
| Stop conditions / budgets | Partial (iteration caps match; `stop_conditions` recorded but never judged) | no model-judged stop-when; no token/cost cap at all | mixed, medium |
| `notes.md` carry-forward | Partial (typed reads/writes strong; loop threads only `{processId, attemptNumber}`) | no freeform running log injected into the next iteration | engine, small |
| Commit-per-iteration | Partial (Circuit reads git hard for honesty; writes only `worktree add -b`, reaped) | engine never commits; a flow author cannot emit a commit | engine, medium |
| Live companion supervisor | None (supervision is structural and end-of-stage) | concurrent watcher that polls and intervenes mid-run | engine, large (defer) |

## The boundary verdict

AGENTS.md protects one rule: flows derive from `src/flows/catalog.ts` and must
not require editing `src/runtime`; special engine behavior is opt-in only via
`CompiledFlowEngineFlags`. So the load-bearing question is whether an open-ended,
condition-gated relaunch loop is expressible as flow topology.

It is not. Three reasons, all in the code:

1. `loopBackTo` (`composer.ts:61-67`) only wires a back-edge. The runtime bounds
   it, and the cycle guard (`graph-runner.ts:647-668`, via
   `isCompletedStepReentryAbort` in `run-transition.ts:55-66`) aborts on
   re-entry of an already-completed step. That is the exact opposite of
   repeat-until-condition.
2. The one near-uncapped loop, `runContinuationLoop`
   (`src/app/run-envelope/`), is engine machinery driven by the `--autonomous`
   axis, not authored as flow edges. It is still capped at
   `max_process_attempts <= 10` and gated by typed required-evidence
   satisfaction, never a natural-language judge.
3. The only flow-opt-in loop construct, `iteratesSliceLoop`, is a count-driven
   for-each over a precomputed array (`slice-corridor.ts`), with no condition
   evaluation.

The clean shape is therefore a new `CompiledFlowEngineFlags` entry, a sibling to
`iteratesSliceLoop`, that re-enters a declared `[head..tail]` body until a
stop-judge says stop or a budget is hit. Flows still opt in declaratively, the
catalog stays the source of truth, and a non-flagged run stays byte-identical.

## The design: a flagged-body loop

Architecture picked after three independent designs were verified against the
real engine. The verifier's pick was `graph-runner-flagged-body`, because the
slice loop already proves every hard primitive it needs: cycle-guard exemption
via iteration-scoped count keys, tail to head redirect through a declared
advance route, `maxSteps` headroom, and byte-identical behavior when the flag is
absent. The run-envelope alternative needed four separate seam changes (re-run
routing, schema cap above 10, an `AttemptRunner`/`AttemptResult` signature
ripple, a new child-run injection point), runs a whole heavyweight flow per
iteration, and does not match the "one iteration equals one agent invocation"
shape.

### The pitch

gnhf says blanket-yes, barrels through the night uncapped, and lets the agent
declare its own done. Circuit's better version is the structural inverse: a
bounded `[head..tail]` body that re-enters once per iteration until a worker
stop-judge says done AND the engine independently confirms the evidence floor is
met, gated by an append-only honesty ledger whose single `finalize()` function
makes "the loop succeeded" provably equivalent to "every honesty latch was
cleared by real on-disk work, and nothing was exhausted." Overclaims and in-step
exhaustion are deferred-with-correction (carried forward as ground truth into
the next iteration's prompt), never swallowed. Human checkpoints still fail
closed. Budget and iteration caps can only ever reach `needs_attention`. The
carried notes log is the compounding mechanism. It is opt-in via one engine
flag, flows stay catalog-derived, and a non-flagged run is byte-identical.

### The flow

One flow run, `depth=autonomous`, flag `iteratesBodyLoop` set:

```
[frame-once] -> [plan-once] -> (LOOP BODY ENTRY: head = act-step)
                                     |
                                     v
                           [act-step]    <- head; reads notesReport (data-not-instructions) + open ledger latches
                                     |    (in-step max_attempts retry on its own recovery route, unchanged)
                                     v
                           [verify-step] <- changed_on_disk CHECK fires here per iteration
                                     |
                                     v
                           [stop-judge]  <- TAIL; reviewer-role relay; reads stopWhen text + verify evidence + notes;
                                     |       emits typed report {stop_when_satisfied, reason, lesson}
                                     |
   ENGINE DISPOSES at the tail seam (graph-runner.ts:880-887 sibling block):
     1. sum trace usage; run detectNoProgress over iteration history
     2. evidenceSatisfied = (missingRunEvidence === undefined)
     3. branch:
        - judge=continue, budget ok, no-progress ok -> route=reenterRoute; corridor.advance(); append lesson; LOOP BACK
        - judge=stop AND evidenceSatisfied=true     -> forward route to [close]
        - judge=stop AND evidenceSatisfied=false    -> FALSE-DONE BLOCKED: latch, route back to head (correction)
        - iteration cap / budget cap / no-progress-K -> route=needsAttentionRoute -> [close]
        - human checkpoint encountered in body       -> HARD STOP checkpoint_waiting (fail-closed, unchanged)
        - unsanctioned cycle (non-reenter re-entry)  -> cycle guard ABORT (unchanged)

[close] runs finalize(ledger, stopCause):
   stopCause in {iteration_cap, budget, attempt_exhaustion, no_progress_ceiling} -> needs_attention ALWAYS
   stopCause == evidence_satisfied -> complete ONLY IF open_overclaims empty AND no exhausted_step gates
                                      required evidence AND no blocking deferred_gate; else needs_attention
```

The operator sees a per-iteration notes log (`reports/loop/notes.md`), the
honesty ledger (open overclaims, exhausted steps, deferred gates, budget state),
and a final status that is either `complete` (every latch cleared by real work)
or `needs_attention` with a stop reason naming exactly what is unfinished and
where the budget went. Loop work is contained on a throwaway worktree branch and
the operator owns the merge.

### The honesty ledger and finalize() (the make-or-break)

The verification pass flagged this as the single hardest part, and corrected an
under-specification all three loop designs shared. Today a `changed_on_disk`
overclaim that exhausts in-step retries propagates to
`closeRun(context, 'aborted')` (`graph-runner.ts:860-872`, via
`recoveryRouteForFailure` in `relay.ts`), with no latch surviving to a later
stop decision. So "carry the overclaim forward and block stop-complete" does not
exist today. It is net-new state threading at the run-loop failure seam, not a
reuse of the honesty gate.

The honest implementation is an append-only, crash-durable run-folder ledger
(atomic write, torn-trace tolerant, per durability tier-1) with latch sets:
`open_overclaims`, `exhausted_steps`, `deferred_gates`, `budget_state`. Under
the flag, the run-boundary abort on an exhausted overclaim is intercepted:
instead of `closeRun('aborted')`, latch the overclaim, append a correction block
to the notes log, and route to the next iteration. The overclaim clears zero
evidence and clears the latch only when a later iteration re-runs that step and
`changed_on_disk` passes clean.

`finalize(ledger, stopCause)` is the single chokepoint that gates the terminal
label. It returns `complete` iff `stopCause == evidence_satisfied` AND
`open_overclaims` is empty AND no exhausted step gates required evidence AND no
blocking deferred gate. Any exhaustion cause (iteration cap, budget, attempt
exhaustion, no-progress ceiling) forces `needs_attention`. This extends the
`continuation-loop.ts:117-122` "never complete by exhaustion" invariant to the
body loop and to spend, and makes "the loop succeeded" structurally unreachable
through any exhaustion path or any open latch. Implement it as latch plus
finalize, never as "swallow the abort and continue," which is precisely the
false-done laundering the thesis forbids.

### Per-gate policy under the flag

- `changed_on_disk` overclaim: the predicate (`acceptance-criteria.ts:116-144`)
  is unchanged and still fires per iteration. What changes is the run-level
  consequence: latch and correct and re-enter, never abort, never swallow.
- In-step `max_attempts` exhaustion (`graph-runner.ts:223-234`): mark the step
  exhausted for this iteration, latch, re-enter fresh next iteration. Safe only
  because three ceilings sit above it (iteration cap, no-progress K, budget).
- No-progress (`no-progress.ts:34-61`, reused pure): first hit latches and
  injects a "try a materially different approach" lesson (steering, the
  feed-forward lever). K consecutive on the identical unmet set routes to
  `needsAttentionRoute`.
- Human checkpoint in the body: hard-stops the loop (`checkpoint_waiting`),
  unchanged from `checkpoint.ts:263-267`. This is the fail-closed boundary that
  distinguishes Circuit from gnhf. The earlier design idea of "park and continue
  with independent remaining work" was dropped: the verifier confirmed the
  graph-runner walks a single `currentStepId` along fixed routes
  (`graph-runner.ts:607-608`) with no scheduler to route around a blocking gate,
  so that half is not buildable as described.
- Unsanctioned cycle: still aborts via the unchanged cycle guard.

## Engine changes

Each tied to a real seam the verifier confirmed.

1. `BodyLoopEngineFlag` interface plus `iteratesBodyLoop?` on
   `CompiledFlowEngineFlags` (`src/flows/types.ts:118-120`). Modeled field for
   field on `SliceLoopEngineFlag` (`types.ts:79-102`). Fields: `headStep`,
   `tailStep`, `reenterRoute`, `bodySteps: readonly string[]` (the full span,
   required), `stopJudge:{satisfiedPath, lessonPath}`, `notesReport:{report}`,
   `maxIterations`, `cumulativeUsdCap?`/`cumulativeTokenCap?`,
   `noProgressCeiling`, `needsAttentionRoute`, `commitBranch?`,
   `activateWhenDepthAtLeast:'autonomous'`.
2. New `BodyCorridor` (`src/runtime/run/body-corridor.ts`, fork of
   `slice-corridor.ts:37-123`). Three real generalizations the verifier flagged:
   `isLoopBodyStep` must return true for any id in `bodySteps`, not just
   head/tail (the shipped slice loop has adjacent head/tail, so a multi-step body
   is untested and the first intermediate step would abort on re-entry);
   `countKey` returns `${stepId}#i${iterationIndex}` for every body step; replace
   count-driven `shouldAdvance` with
   `disposeIteration({stopProposed, evidenceSatisfied, usageSoFar, noProgress, iterationIndex})`.
3. Construct `BodyCorridor` and extend `maxSteps` headroom near
   `graph-runner.ts:466-474`: `default + maxIterations * bodySteps.length`.
4. Wire body-step `countKey`/`isLoopBodyStep` into the step preamble
   (`graph-runner.ts:621-630`), mirroring the slice block. The cycle guard stays
   unchanged; the iteration-scoped count key is the entire exemption.
5. Tail re-entry / dispose seam (`graph-runner.ts:880-887`), a sibling to the
   slice tail block. Read the judge boolean via `stopJudge.satisfiedPath`,
   compute `evidenceSatisfied`, sum trace usage, run `detectNoProgress`, call
   `bodyCorridor.disposeIteration(...)`, select `reenterRoute` /
   `needsAttentionRoute` / forward.
6. Honesty ledger (`src/runtime/run/honesty-ledger.ts`, new) plus the intercept
   at `graph-runner.ts:860-872`. The make-or-break carry above.
7. `finalize(ledger, stopCause)` at the close path, the single anti-launder
   chokepoint. Wires the non-complete outcome to host status via the existing
   `bindsTerminalOutcomeToPrimaryResult` pattern (`types.ts:114-117`).
8. Cumulative usage accumulator at the tail seam, reading `extractRelayUsage`
   (`claude-code.ts:441-492`) off the `relay.completed` trace entry
   (`relay.ts:764`). Fail closed on missing usage. Cap hit yields
   `budget_exhausted` to finalize.
9. Engine-emitted notes append at the dispose seam plus free re-inlining: the
   head step declares `notesReport` in its `reads`, and `composeRelayPrompt`
   reads the file on every invocation (`relay-support.ts:441`), so an appended
   notes file re-inlines fresh each iteration with zero new injection machinery,
   framed data-not-instructions (`relay-support.ts:389-407`). Net-new is only
   the append of the judge's lesson (read-existing, append, atomic write,
   modeled on `harvest.ts:29-53`), length-capped like the brief
   (`brief.ts:585-639`).
10. Stop-judge report is a flow-package report, not engine code. The tail is a
    reviewer-role relay; natural-language judgment never enters the engine. Shape
    `{stop_when_satisfied, reason, lesson}`, modeled on the contract-quality lens
    (`contract-quality.ts:60-83`). The engine reads only the boolean and disposes
    against independent evidence (propose-vs-dispose, `autonomous-run.ts:23-40`):
    a stop is honored only when the judge and `missingRunEvidence === undefined`
    agree.

## Slice plan

Smallest viable first, each independently mergeable.

1. (medium, engine) Count-driven multi-step body loop, no judge, no ledger. Add
   the flag, `BodyCorridor`, the tail re-entry seam, and `maxSteps` headroom,
   advancing on a fixed `maxIterations` count only (judge stubbed to
   always-continue). Proves the one genuinely-new primitive in isolation:
   iteration-scoping a full multi-step `[head..tail]` span, which the slice loop
   never exercised. Offline test on a 3-step body fixture asserting no
   cycle-guard abort on intermediate re-entry, and byte-identical default when
   the flag is absent.
2. (medium, flow + engine) Stop-judge: reviewer tail plus propose-vs-dispose.
   The engine reads the boolean and disposes against `evidenceSatisfied`; a stop
   with unmet evidence routes back to head (false-done blocked). Use a
   deterministic judge stub so the loop policy stays offline-provable.
3. (large, engine) Honesty ledger plus `finalize()` chokepoint. Behavioral test:
   a judge that says stop-complete while an overclaim latch is open must yield
   `needs_attention`, never `complete`.
4. (small, engine + flow) Notes carry. Turns bounded-and-honest into
   bounded-honest-and-compounding.
5. (small, engine) Cumulative budget cap, fail closed. Soft 80% threshold injects
   a closure-priority lesson.
6. (small, engine) No-progress steering plus K-ceiling.
7. (medium, engine, opt-in, default no commits) Loop-scoped commit containment on
   a throwaway worktree branch; engine-emitted commit per passing iteration;
   operator owns the merge.

First slice to build: slice 1. It delivers standalone value (a bounded, honestly
terminating re-entry loop) and de-risks the only unproven primitive. Getting the
count-key generalization wrong would silently abort on the first intermediate
body step, so it must be nailed and tested in isolation, including the
byte-identical-when-absent assertion.

## What makes it better than gnhf

- Bounded by construction. Hard `maxIterations` plus cumulative USD/token cap
  plus per-step `max_attempts`, versus gnhf's uncapped barrel-through. Exhaustion
  of any budget can only reach `needs_attention`, never a clean done.
- Honest abort over false done. `finalize()` makes `complete` structurally
  unreachable except by clearing every honesty latch with real on-disk work.
  gnhf lets the agent declare its own done.
- Fail-closed on human gates. A checkpoint in the body hard-stops the loop
  instead of being auto-crossed, the exact inverse of gnhf's blanket-yes.
- Honesty gates that actually catch overclaim. `changed_on_disk` fires every
  iteration and a self-reported overclaim is carried forward as the agent's own
  ground truth, not papered over.
- Compounding, not just continuing. The carried notes log feeds each iteration's
  derived lesson (and each no-progress steer) into the next prompt as
  data-not-instructions. This is the on-thesis codify-and-compound lever, which
  gnhf has no analog for.
- Engine owns the bounded branch, human owns the merge. Loop commits land on a
  throwaway worktree branch, versus gnhf's agent-supplies-its-own-commits
  straight onto your work.
- Natural-language judgment stays out of the engine. The stop-judge is a worker
  relay and the engine only disposes its proposal against an independent evidence
  floor, so a hallucinating judge cannot launder a false-done.

## Open questions

- Depth label. The slice loop maxes at `high`; this proposes a new `autonomous`
  depth tier (already present in `slice-corridor.ts:19` `DEPTH_ORDER`). Confirm
  `autonomous` is the right activation floor versus reusing `tournament`, and
  whether the autonomous axis-config requirement should gate it.
- Which flow opts in first. A new dedicated overnight flow, or extend an existing
  one? A new flow avoids the slice loop and body loop colliding on one iteration
  index (they cannot nest under the single-counter model).
- Latch-clear topology. An overclaim latch clears only if the same step re-runs.
  For a strictly linear body that never re-enters the offending step, the run can
  only end `needs_attention`. Acceptable, or does the judge need to route a
  targeted re-do of just that step?
- Commit model default. Per-passing-iteration commits contain blast radius, but
  an overnight run can still pile up many real-but-honest-but-wrong committed
  iterations (`changed_on_disk` catches overclaims, not bad-but-honest edits).
  Squash-at-end versus per-iteration default?
- Budget fail-closed ergonomics. Failing closed on missing usage is safe but
  halts a legitimate run behind a connector that does not emit usage. Acceptable
  for v1, or add a per-connector "usage-trusted" flag?
- `stop_conditions` reuse. Should `stopWhen` source from the dead
  `RunGoalContract.stop_conditions` field (`run-envelope.ts:122`), so the
  contract writers and the loop finally agree, or keep `stopWhen` on the flag?

## Provenance

Built from two code-grounded workflows on 2026-06-26: a seven-axis feasibility
map of the engine against gnhf's primitives, and a design-and-verify pass that
produced three independent loop architectures, adversarially verified every
load-bearing seam against the actual source, and synthesized the picked design.
Treat the file and line references as a starting map, not a guarantee; re-read
before building. See `bespoke-flow-generation-design.md` and
`portable-flow-file-format.md` for the adjacent "encode your process" on-ramps,
and `long-horizon-supervision.md` for the deferred companion-supervisor idea.
