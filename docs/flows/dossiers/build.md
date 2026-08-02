# Build

Public. 9 steps. Depths `low | medium | high`. `autonomous: true`. Engine flags:
`binds_execution_depth_to_relay_selection`, `iterates_slice_loop`. Declares a
primary result, so its terminal outcome is bound to it.

Corpus: 13 runs. **2 complete, 1 stopped, 10 aborted.** The most-used and
least-reliable flow in the catalog.

## 1. What a user expects

"Build this" is a request to hand over a piece of work and get it back done:

- **Make the change I described.** Not a plan for the change. The change.
- **Prove it works.** Run the tests. If they fail, fix it and run them again.
- **If you cannot finish, give me what you have.** Forty minutes of work that
  ends in nothing is worse than ten minutes that ends in a half-done branch and
  an honest note about what is left.
- **Do not wander.** Change what I asked about, not the six adjacent things.
- **Tell me what you changed** in enough detail that I can review it.
- **Do not lie about being done.** If verification did not pass, do not say the
  work is complete.

The third expectation is the one that matters most and is met the least.

## 2. What actually happens

```
frame-step      (checkpoint)   confirm the brief
analyze-step    (relay)        trace the call paths the change will touch
plan-step       (compose)      objective + verification plan
build-baseline  (verification) snapshot pre-change state
act-step        (relay)        implement, wall clock 7200000ms, tools enforced
verify-step     (verification) run the planned commands
build-touch-area(verification) enforce containment against the baseline
review-step     (relay)        independent audit by a separate worker
close-step      (compose)      emit build.result@v1
```

Routes back to `act-step` exist from `verify-step` (`advance`, `retry`) and
`review-step` (`retry`, `revise`). `act-step` carries
`acceptance_criteria` with three checks, including `changed_on_disk`, so a worker
that reports edits it did not make is caught and retried with feedback.

The honesty machinery here is genuinely good. `build-touch-area` enforces
containment, so scope creep is a detected condition rather than a hope.
`changed_on_disk` closes the most common false-done path. `review-step` runs a
different worker than `act-step`.

## 3. Friction

**Verification failure destroys the run.** This is the flow's defining problem
and it accounts for 4 of 13 runs on its own. `verify-step` routes `retry` to
`act-step`. When the change still does not pass, that retry exhausts and the
engine aborts. From the corpus, four times, each after 3 worker runs and 6 of 9
steps:

```
route 'retry' for step 'act-step' exhausted max_attempts=2;
last recovery reason: verification step 'verify-step' failed one or more commands
```

The implementation is on disk. The plan is on disk. The verification output is on
disk. The run throws all of it away and writes a result whose summary is "Run
closed with outcome aborted." A user in this position wants the diff and a choice.
They get nothing and retry by hand, which the corpus shows directly: "Enhance the
`circuit reclaim` command" was run four times before it completed.

This is the general engine gap in [README](README.md) finding 1, and Build is
where it costs the most, because Build is where the expensive work lives.

Note that the sibling case was already fixed. `src/flows/build/assembly-spec.ts:214-228`
carries a long comment explaining that routing an honest reviewer `reject` back to
`act-step` "exhausted max_attempts and aborted a working build", and the fix was
to put `reject` in the pass set so it flows forward to close. The exact same
reasoning applies to a verification failure and was not applied to it. A change
that does not pass tests yet is an honest state, not a contract violation.

**No degraded close.** There is no path from a failed verification to a partial
result. Compare Fix, which has an explicit `connector-failed` route from
`fix-review` to `fix-close` so a missing reviewer does not sink the run. Build has
no equivalent for its most common failure.

**The frame checkpoint has one choice.** `frame-step` policy offers exactly
`[{id: 'continue', label: 'Continue'}]` with `safe_default_choice: 'continue'`.
It is a confirmation dialog with an OK button and no Cancel. It costs a round trip
and decides nothing.

**Depth changes the worker, not the process.** `binds_execution_depth_to_relay_selection`
means `low | medium | high` picks a different model. The step path is identical.
A user asking for a "high effort build" gets a better worker running the same
nine steps, which is reasonable but is not what "high" implies.

**The slice loop is invisible.** `iterates_slice_loop` is set, but nothing in the
compiled flow tells the operator whether their goal will be decomposed into
slices or done in one pass. From the corpus, `steps=9` on completed runs means
one pass; the loop did not visibly engage. Prior work
(`project_feature_scale_build_comparison`) found H-scale goals never decomposed.

## 4. Confirmed bugs

**a. Verification-failure retry exhaustion aborts a working branch.** 4 of 13
corpus runs. Root cause is engine-level ([README](README.md) finding 1) but Build
could mitigate today the same way it already mitigated the reviewer case.

**b. `codex connector cannot honor effort 'none'`.** Aborted `analyze-step` on
2026-07-16 and again on 2026-07-19, three days apart, zero workers paid both
times. A pure input-validation failure reaching a subprocess. Should be rejected
before the run starts.

**c. `build-baseline` report writer crashes on a git-helper failure.** 2026-07-02:

```
verification step 'build-baseline': report writer failed
(build.baseline-snapshot@v1: git-state helper failed (exit 1):
node:internal/modules/cjs/loader:1503 throw err;
```

A raw Node module-resolution stack trace reaching the operator as an abort
reason. The baseline snapshot is a nice-to-have for containment enforcement; its
failure should degrade containment to "not enforced" and continue, not kill the
run.

**d. `claude-code subprocess timed out: no output for 180000ms (inactivity)`**
at `act-step`, 2026-07-11, 2 workers paid. A three-minute inactivity timeout on a
step with a two-hour wall clock budget. A worker thinking hard about a large
refactor looks identical to a hung worker.

## 5. What would make it superlative

**1. Never destroy a working branch.** On verification-failure exhaustion, route
to `close-step` with the honest result: implementation present, verification
failed, here is the output. The close-time primary-result bind already maps a
non-clean result to `stopped`, and after the 2026-07-29 fix `stopped`
reads correctly as "ran its full process and stopped without a clean result."
The machinery to do this honestly already exists and is already wired. Apply the
reasoning from `assembly-spec.ts:214` to verification. **This is the highest-value
single change in the catalog.**

**2. Make the failure legible where the user looks.** Fix
`source-record.ts:717` so an abort headlines its actual cause instead of blaming
process evidence and advising a corrected goal ([README](README.md) finding 2).
Four of Build's ten aborts currently misdirect the user.

**3. Validate connector inputs before spending anything.** Bug (b) cost two runs
for a value that could have been rejected at parse time. Every connector
capability the engine knows about should be checked against the resolved
selection before the first step runs.

**4. Degrade the baseline snapshot instead of dying on it.** Bug (c). Containment
enforcement is valuable; it is not worth the run.

**5. Replace the inactivity timeout with a progress signal.** Bug (d). A worker
that has not printed in three minutes is usually working. Either raise the
threshold to something defensible for a two-hour budget, or have the connector
emit a heartbeat.

**6. Either use the frame checkpoint or drop it.** One choice and a safe default
is a round trip that buys nothing. Give it a real second option (revise the
brief, narrow the scope) or start at `analyze-step`.

**7. Make the slice loop legible.** Say in the plan report whether the goal will
be decomposed and into what. An invisible loop that mostly does not engage is
worse than no loop, because it cannot be reasoned about or debugged.

### The one-sentence version

Build does careful, well-instrumented work and then throws it in the bin the
moment the tests do not pass, which is the single most common thing that happens
when you write code.
