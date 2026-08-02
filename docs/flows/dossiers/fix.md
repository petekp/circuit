# Fix

Public. 13 steps at `medium`/`high`, 12 at `low`. Depths `low | medium | high`.
`autonomous: true`. No engine flags. Declares a primary result, so its
terminal outcome is bound to it.

Corpus: 1 run. Aborted on retry exhaustion at `fix-verify` after 4 worker runs
and 7 of 13 steps.

## 1. What a user expects

"This is broken, fix it." The expectations are the sharpest in the catalog because
the success condition is objective:

- **Reproduce it first.** If you cannot make it fail, you cannot know you fixed it.
- **Find the actual cause**, not the nearest symptom.
- **Make the smallest change** that fixes it. Do not refactor the module.
- **Prove the bug is gone.** Run the thing that was failing. It should pass now.
- **Prove nothing else broke.**
- **If you cannot reproduce it, tell me** instead of changing code hopefully.

## 2. What actually happens

Fix is the most rigorous flow in the catalog and its ordering is its best idea:

```
fix-frame              (compose)      problem statement, scope, regression contract
fix-regression-baseline(verification)  PROVE THE BUG FAILS, before any edit
fix-baseline-snapshot  (verification)  record pre-change state + head_sha
fix-gather-context     (relay)         locate the code involved
fix-diagnose           (relay)         hypothesize and test the root cause
fix-act                (relay)         focused edit, tools enforced to 6
fix-change-set         (verification)  what actually changed vs the baseline
fix-verify             (verification)  run the planned commands
fix-regression-rerun   (verification)  PROVE THE BUG NOW PASSES
fix-review             (relay)         independent audit
fix-close              (compose)       emit fix.result@v1
```

`fix-regression-baseline` runs **before** any worker touches the checkout. That
ordering is the whole ballgame: it makes "the bug is fixed" a falsifiable claim
rather than an assertion. `fix-regression-rerun` closes the loop against the same
contract. `fix.result@v1` requires `regression_status` and `change_set_status` as
separate required sections, so the report cannot claim a fix without both.

`fix-act` carries `equipment_scope` with `enforcement: 'enforced'` and an explicit
six-tool allowlist. It is the only step in the catalog with an enforced tool
boundary.

`fix-review` has a `connector-failed` route straight to `fix-close`, so a missing
reviewer closes with proof evidence and `review_status: skipped` rather than
sinking the run. This is the right pattern and Build lacks it.

`low` depth drops `fix-review` and closes through `fix-close-low`.

## 3. Friction

**Two of thirteen steps are unreachable, and the flow says so in its own
purpose string:**

> `fix-no-repro-decision` and `fix-handoff` remain as future ask/handoff routing
> intent; they appear in compiled flows with declared ask/handoff recovery
> bindings, but the engine does not yet emit any failure cause those bindings
> accept, so no runtime path reaches them.

`fix-no-repro-decision` is the checkpoint that would handle "I could not
reproduce your bug", which is one of the six things a user expects. It is wired
in from four steps (`fix-diagnose`, `fix-act`, `fix-verify`, `fix-review` all
route `ask` to it) and can never fire. A reader of the schematic sees a flow that
handles no-repro. It does not.

**Same retry-exhaustion abort as Build.** The single corpus run:

```
route 'retry' for step 'fix-act' exhausted max_attempts=2;
last recovery reason: verification step 'fix-verify' failed one or more commands
```

Four workers paid, 7 of 13 steps, and the regression baseline had already proven
the bug. That proof is expensive and it was discarded along with everything else.
Fix has the most to lose here of any flow because its early steps are its most
valuable.

**`fix-act` reads reports that do not exist yet on first entry.** Its `reads`
list includes `fix/verification.json`, `fix/change-set.json`,
`fix/regression-rerun.json`, and `fix/review.json`, all written by later steps.
This is deliberate (retry feedback on re-entry) and it works, but it means the
step's declared inputs describe the retry case rather than the first pass, which
makes the schematic harder to read than it needs to be.

**Only one corpus run, ever.** For the flow whose success condition is the most
objective and whose value is the most obvious, that is the strongest signal in
this whole exercise that something about reaching it is wrong. Fix is not being
chosen. Two candidate reasons, both untested: Build absorbs bug work because the
router leans that way, or the one run aborting was enough to stop trying.

## 4. Confirmed bugs

**a. Retry exhaustion discards a proven regression baseline.** The corpus run.
Root cause is engine-level ([README](README.md) finding 1); Fix's exposure is the
worst in the catalog because of what its early steps cost.

**b. `fix-no-repro-decision` is unreachable dead structure.** Documented in the
flow's own purpose. It is not a latent bug so much as a promise in the shape of
the flow that the engine cannot keep.

**c. `fix-handoff` is unreachable dead structure.** Same cause. Declared as a
terminal from `fix-act`, `fix-close`, and `fix-no-repro-decision`.

**d. Inherited: aborted runs headline as an evidence failure.** See
[README](README.md) finding 2. Confirmed on Fix by the 2026-07-29 golden proof
recapture, which showed Fix's run surface changing from "Blocked: fix did not
produce enough process evidence" to the correct needs-follow-up text. The
`stopped` case is now fixed; the `aborted` case is not.

## 5. What would make it superlative

**1. Close honestly instead of aborting when verification fails.** Same as Build,
and more urgent here: the regression proof, the diagnosis, and the change set are
all on disk and all valuable on their own. A Fix run that reproduced the bug,
made a change, and could not get to green is a genuinely useful artifact. Today it
produces nothing.

**2. Make no-repro reachable.** This is the second-most-likely real outcome of a
bug report after a successful fix, and the flow already has the checkpoint built.
What is missing is an engine failure cause that the `ask` binding accepts. Until
then, `fix-diagnose` should be able to route a no-repro finding forward through
its report rather than needing an engine-emitted cause: the same
`route_from_report` mechanism Goal uses in six places.

**3. Work out why Fix is not being reached.** One run in two months for the
catalog's most rigorous flow. Check the router's Fix-versus-Build boundary against
real bug-shaped requests before building anything else on Fix.

**4. Cut or reach `fix-handoff`.** Dead structure in a schematic is a lie about
capability. Either wire it or delete it; do not ship a flow whose diagram shows a
path the engine cannot take.

**5. Declare first-pass reads separately from retry reads.** Cosmetic for the
engine, meaningful for anyone reading the flow.

### The one-sentence version

Fix has the best idea in the catalog, proving the bug fails before anyone touches
the code, and then discards that proof whenever the fix does not land on the
second try.
