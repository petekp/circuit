# Build slice decomposition + per-slice verify

Status: design locked, pre-implementation (2026-06-03). Branch `feat/skill-hooks`.
Decision: build the full engine sequential-slice loop (Path A) this session.

## What we are building

Today Build runs one implement pass and one verify pass over the whole
change:

```
frame -> analyze -> plan -> act -> verify -> review -> close
```

Under deep rigor, we want Build to implement and verify in ordered
slices, gating each slice before piling the next change on top:

```
frame -> analyze -> plan -> (act -> verify){slice 1} -> (act -> verify){slice 2} -> ... -> review -> close
```

A slice whose verify fails retries within the slice (bounded). If it
cannot be made green, the run stops there instead of building more on a
broken base.

## The corrected framing

The prior handoff said slicing "touches the execution-depth binding."
It does not, and cannot. `bindsExecutionDepthToRelaySelection` only
picks which worker model/effort a relay runs under. Depth is a
categorical label, never a number. Slice **count** comes from the plan
(one slice per success criterion). Depth only decides **whether** to
activate the loop.

## The engine constraint

Circuit runs a flow as a static graph fixed at compile time. The single
execution loop (`graph-runner.ts:614`) walks a cursor step to step and
holds a `completedStepCounts` map keyed by step id. A guard aborts the
run on re-entering an already-completed step ("route cycle detected")
unless an active `RecoveryCorridor` legitimizes it. There is no
counted-sequential-loop primitive, and a runtime-discovered slice count
cannot become N compiled steps.

So a slice loop must live in that loop, and re-entering `act` for slice 2
must not look like an illegal cycle.

## The key idea: slice-scoped completion accounting

When the slice loop is active, the loop keys `completedStepCounts` for
loop-body steps by `(stepId, sliceIndex)` instead of `stepId`. So:

- Re-entering `act` for slice 1 uses key `act-step@1`, count 0 -> attempt
  1, **not** a cycle. No guard change needed beyond computing the key.
- Each slice gets its own recovery/retry budget (the existing
  `max_attempts` mechanics, per slice).
- On resume, `completedStepCountsFromTrace` rebuilds the slice-scoped keys
  by reading `slice_index` off `step.completed` trace entries.

This single move sidesteps both cycle guards (incoming at 634-653,
outgoing at 794-812) and gives per-slice budgets for free.

## Why this is far smaller than feared

- **No file namespacing.** Slices share one working tree and verify
  re-runs the full suite cumulatively, so the **last slice's verify over
  the whole tree IS the whole-change verification.** Loop-body steps
  overwrite the canonical `reports/build/{implementation,verification}.json`
  each slice; the final values are correct for review/close. Per-slice
  evidence lives in the trace (`slice_index`-tagged entries).
- **No proof-gate surgery.** The sequential loop already gates each slice
  during the run (a failing slice can't advance). By close time every
  slice passed, so the existing `completeCloseProofGap` (which needs the
  final verify proven) is correct as-is.
- **No resume-mid-slice problem.** Build's only checkpoint is `frame`,
  before the loop. No slice iteration is ever paused. (Constraint: a slice
  loop must not contain a checkpoint step. Documented + asserted.)
- **No new stage, no new canonical.** Stays inside `act`/`verify`. The
  canonical stage path `{frame,analyze,plan,act,verify,review,close}` is
  unchanged.

## Changes

### Engine (gated, behavior-named)

1. **New `engineFlags.iteratesSliceLoop`** on `CompiledFlowEngineFlags`
   (`src/flows/types.ts`):
   ```ts
   iteratesSliceLoop?: {
     readonly headStep: string;        // 'act-step'
     readonly tailStep: string;        // 'verify-step'
     readonly slicesFrom: { readonly report: string; readonly itemsPath: string }; // reports/build/plan.json, 'slices'
     readonly maxSlices: number;       // 8
     readonly activateWhenRigorAtLeast: 'deep';
   }
   ```
   Describes a behavior (a flow iterates a slice loop between two steps),
   not a flow name. Read at runtime via `findCompiledFlowPackageById`
   (same precedent as `bindsTerminalOutcomeToPrimaryResult`,
   graph-runner.ts:141).

2. **New `SliceCorridor`** (`src/runtime/run/slice-corridor.ts`), modeled
   on `RecoveryCorridor` (injected, pure, no IO except a lazy report
   read). Owns:
   - lazy init on first head-step entry: read the slice array from the
     plan report (`files.readJson` + `resolveDottedPath`, reusing the
     fanout machinery), cap at `maxSlices`; inert when rigor < deep or
     <= 1 slice (-> single pass, today's behavior);
   - `countKey(stepId)` -> slice-scoped key for loop-body steps;
   - `currentSliceIndex`, `currentSlice()`;
   - `shouldAdvance({stepId, route})` -> true at the tail's forward route
     when more slices remain;
   - `advance()` -> increments index, returns the head step id;
   - resume reconstruction of `currentSliceIndex` from trace.

3. **Loop wiring** (`graph-runner.ts`):
   - replace `completedStepCounts` get/set with `corridor.countKey(...)`;
   - inject `activeSliceIndex` + `activeSlice` into the loop-body step
     context (relay prompt learns which slice it is implementing);
   - after a tail step's forward route, if `corridor.shouldAdvance`,
     redirect the cursor to the head step instead of advancing to review;
   - raise `maxSteps` to account for `sliceCount * loopBody * attempts`.

4. **Trace**: optional `slice_index` (additive, `.strict()`-safe) on
   `step.entered`, `step.completed`, `check.evaluated`,
   `verification.command_evaluated`, and relay entries. Threaded via
   `context.activeSliceIndex` so executors tag their own entries.
   Load-bearing for resume reconstruction and per-slice audit.

### Build flow

5. **`BuildPlan.slices`** changes from `NonEmptyStringArray` to structured
   `z.array(BuildSlice).min(1)` where
   `BuildSlice = { id, intent, anticipated_file_extensions }`.
   Breaking change to `build.plan@v1`, edited in place (project allows
   breaking changes). Each slice carries its own anticipated files (the
   per-slice scope channel the skill-hooks edit-file design wants).
6. **Plan writer** (`writers/plan.ts`): emit structured slices 1:1 from
   `brief.success_criteria` (id `slice-1..`, intent = criterion,
   anticipated files inherited from context for now).
7. **Implementer relay-hint**: reference `activeSlice` ("you are
   implementing slice {id}: {intent}; report cumulative changed_files").
8. **Build `engineFlags.iteratesSliceLoop`** set in `data.ts`.

## Cost control: gate on deep rigor

Slicing N criteria means N implement + N verify passes. To keep the
common case cheap, the loop activates only at **deep** rigor (and above).
`lite`/`standard` Build keeps the single fast pass, unchanged. This bounds
the cost to operator-requested rigor and gives depth a real second
meaning (it newly affects topology under deep, a deliberate flagged
enhancement over original Circuit). Count still comes from the plan, not
depth.

## Tests + proofs

- `build-runtime-wiring` visited[] stays `[frame,analyze,plan,act,verify,review,close]`
  for standard rigor; a **new deep-rigor case** asserts the repeated
  `act,verify` sequence and per-slice trace tagging.
- new `build-slice-exec` (or extend `build-verification-exec`) for the
  loop mechanics (advance, per-slice budgets, stop-on-unfixable-slice).
- `build-report-writer` updated for structured `plan.slices`.
- `runtime-trace-contract` for `slice_index`.
- `flow-definition-compiler` for the new engine flag.
- re-emit generated artifacts (4 files) + Codex cache; new `sliced-build`
  deep-rigor proof scenario; full `npm run verify` on a clean tree.

## Adversarial review resolutions (2026-06-03, 4 skeptics, all "design-needs-fix", none broken)

The review walked the real engine code and ran probe traces. Core design
sound; the following fixes are folded in before/during coding.

**Advance via a real declared route, not a side-channel redirect (the
biggest fix).** `verify-step` gets a new route `advance` -> `act-step`.
When the verify executor returns its forward/pass route AND more slices
remain, the engine overrides `route = 'advance'` *before* target
resolution (graph-runner.ts:703). Then everything downstream stays
honest: `step.completed.route_taken='advance'` is truthful, target
resolution finds `act-step` via a declared route, the outgoing guard
evaluates `act-step@nextSlice` (slice-scoped count 0 -> no abort), and the
re-entry's `incomingRouteTaken='advance'` is a NORMAL route (no recovery
mechanics, corridor stays inert). This dissolves the dishonest-trace and
incoming-route hazards at once. `advance` is added to the normal-route
set so it never carries recovery mechanics. This IS a schematic change,
so circuit.json re-emits (the earlier "engine-only, no drift" note was
wrong).

**Slice-scoped completion keying at all three sites.** `corridor.countKey`
is used at the incoming read (626), the outgoing target read (784), and
the set (852) for loop-body steps; non-loop steps keep the bare stepId.
Two cycle guards confirmed correct under this keying by a step-by-step
trace walk; pinned with a deep-rigor test.

**Attempt-collision is safe but made explicit.** Reverse-iteration +
global monotonic `sequence` means the current slice's entries win in
`latestStepReportOrRelayRef` / `latestRecoveryFailureEvidence` /
`latestAdmittedVerdict` (verdict comes from the unique review-step). Still
thread `context.activeSliceIndex` into the recovery-evidence resolvers
(they can abort a run) and filter on `slice_index`; add code comments so a
future refactor doesn't silently break slice attribution.

**Proof gate made slice-aware (defense in depth).** Add `slice_index` to
`proofPolicyRequirementKey` (graph-runner.ts:401) and the proof-match
scope comparison (430-437) so close requires EVERY slice's verify proven,
not just the last requirement-keyed one. Structurally an unproven slice
can't advance (the verify executor only returns the forward route on
`passed`), but the gate is now an independent backstop. Direct test:
advancing past an unproven slice must abort.

**Unique decision_ids across slices.** Append slice index to slice-scoped
ids: `gd-proof-${stepId}-s${i}-${attempt}`, `gd-recovery-...-s${i}-...`
(guidance.ts), since attempt resets per slice and ids currently collide.

**Per-slice proof-assessment evidence paths.** Namespace
`reports/proof/${stepId}-s${i}-attempt-${attempt}.assessment.json` so a
later slice doesn't overwrite an earlier slice's evidence and invalidate
its trace `assessment_ref` hash. Relay result files stay last-slice-wins
(documented; per-slice content lives in the trace).

**No-checkpoint-in-loop invariant, enforced.** Compile/runtime assertion:
when `iteratesSliceLoop` is set, no step in `[headStep..tailStep]` is a
checkpoint. Resume-mid-slice confirmed unreachable for Build (only the
checkpoint executor emits a waiting outcome; Build's sole checkpoint is
`frame`, before the loop), so `currentSliceIndex` reconstructs trivially.
`completedStepCountsFromTrace` is made slice-aware (reads `slice_index`).

**maxSteps slice-aware.** When the loop is active,
`maxSteps = preLoop(3) + maxSlices*perSliceWorst(5) + postLoop(4)`
(= 47 at maxSlices=8), set explicitly instead of the
`flow.steps.length*4 = 28` default that a multi-slice run would exceed.

**Activation = `context.depth === 'deep'`** (the reliable runtime field),
not `axes.rigor`. Deep Build is checkpoint-gated, so the loop only ever
runs in the post-resume phase; the deep test is therefore a resume test.

**Slice-count source corrected (see fork below).** The default brief's 3
success_criteria include two global gates ("Verification passes", "Review
completes"), so 1:1 criteria->slice produces semantically empty slices.
Slices should come from the repo-reading researcher as real work units.

**Trace `slice_index` optional everywhere; standard runs emit none.** Add
optional `slice_index` to each touched `.strict()` schema; test that a
standard (non-deep) Build trace contains zero `slice_index` keys.

**Operator legibility.** Thread `activeSliceIndex`/total into the progress
projection ("Making the change - slice 2 of 3: <intent>...") so the loop
is legible; today progress keys purely on stepId and would show identical
lines.

**Static-unroll alternative** (compile K fixed act/verify pairs, no engine
change) was reconsidered and rejected: it caps slices at a visible K,
K-folds the schematic and proof surface, and isn't reusable by other
flows. The dynamic loop is a clean engine capability other flows opt into
via the flag. (Pete chose Path A explicitly.)

**Blast radius corrected.** The existing deep-rigor `checkpoint` proof
(capture-golden-run-proofs.ts) currently completes a 7-step single pass
and WILL drift to a sliced run; it must be re-captured (the design first
listed only a new proof). Proof backing `plan.json` files
(routed-build, plan-execution, abort, checkpoint) embed `slices` and
change shape string[]->object[]; re-capture all. `flow-definition-compiler.test.ts:514`
is an exact `.toEqual` on build.engineFlags and breaks on the new flag.

## Increment 3 outcome: one real bug, three documented deferrals

The advance-past-unproven safety test caught a **genuine correctness bug**
(the exact attempt-collision the review predicted): `latestRecoveryFailureEvidence`
matched an earlier slice's failed `(verify-step, attempt 1)` check against a
later slice's clean attempt, tagging the clean `advance` as a post-failure
recovery route and aborting the run. Fixed by slice-filtering the resolver and
tagging the verify/act executors' `check.evaluated` (and
`verification.command_evaluated`) with `slice_index`. The sibling
`latestStepReportOrRelayRef` needs no filter (every execution writes a report,
so reverse-iteration returns the current slice's by recency).

Three review items are **deliberately deferred** (token frugality; correctness
is complete and tested):

- **Proof-gate requirement-key slice-awareness.** The close gate only enforces
  the last slice's verify proof. This is safe because the loop structurally
  cannot advance past an unproven slice (the verify executor returns a recovery
  route, not the forward route, on failure) — now proven by the
  "stops at the first slice that cannot pass verification" test. The gate would
  only matter against a future loop-wiring regression, and making it slice-aware
  ripples into the `.strict()` ProofAssessment + guidance-decision scope schemas
  and their contract tests. Deferred.
- **Unique slice-scoped decision_ids.** `gd-proof-${stepId}-${attempt}` collides
  across slices. `completeCloseProofGap` survives this (it dedupes by
  requirement-key + index order, not decision_id). It is latent ambiguity for a
  future audit/run-inspection tool that joins proof.assessed → guidance.decision
  by id. Deferred until that consumer exists.
- **Per-slice proof-assessment file paths.** Slice N overwrites slice 0's
  `reports/proof/<step>-attempt-1.assessment.json`; slice 0's trace
  `assessment_ref` hash then mismatches the file. No live ref-hash auditor reads
  these files (the close gate reads trace entries). The per-slice evidence that
  matters (pass/fail, intents, changed files) lives slice-tagged in the trace.
  Deferred.

## Implementation increments (test-first, each verify:fast-green)

1. Schema + `CompiledFlowEngineFlags.iteratesSliceLoop` type + pure
   `SliceCorridor` (unit-tested) + structured `BuildSlice`, researcher
   emits slices, plan carries them, `advance` route in schematic. Corridor
   still inert (no loop wiring).
2. graph-runner loop wiring (advance-route override, slice-scoped
   countKey, slice_index trace + threading, maxSteps, no-checkpoint
   assertion) + failing deep-rigor exec test first, then green.
3. Proof-gate slice-awareness + unique decision_ids + evidence-resolver
   threading + per-slice assessment paths + the advance-past-unproven
   abort test.
4. Operator progress legibility + standard-run-emits-no-slice_index test.
5. Re-emit circuit.json (advance route) + recapture proofs (incl.
   checkpoint) + full `npm run verify` on a clean tree + commit.

## Open questions for the adversarial pass

1. Does slice-scoped `countKey` interact safely with the `RecoveryCorridor`
   during an in-slice retry (verify-fail -> retry -> act within slice i)?
2. Is the cursor redirect on advance correctly NOT counted as a forward
   route to review (no spurious `step.completed` route_taken pointing at
   review)?
3. Resume reconstruction: with the only checkpoint at frame, is there any
   path where loop-body completions exist at resume time and must rebuild
   slice-scoped keys?
4. Does `latestAdmittedVerdict` / close verdict derivation behave when
   `act`/`verify` complete multiple times with the same attempt number
   across different slices?
5. maxSteps headroom: exact bound so a legitimate N-slice deep run never
   trips `maxSteps exceeded`.
