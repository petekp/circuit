# Durability Tier-2: the forward-recovery cursor (decision-ready spec)

Status: decision-ready. One slice (Rank-1) is **built** on
`feat/durability-tier2-foundation`; the rest of this document is options and a
recommendation, **not** built.

## Context

Tier-1 durability shipped (#91): torn-trace tolerance, atomic whole-file
writes, `result.json` regeneration. The trace is now a trustworthy authority and
a parked checkpoint resumes soundly. What Tier-1 does **not** give us is
*forward recovery from a non-checkpoint crash*: today the only re-entry point is
a checkpoint boundary (`graph-runner.ts` — `currentStepId =
options.resumeCheckpoint?.stepId ?? flow.entry`). A `kill -9` between checkpoints
loses all progress since the last checkpoint, with no resume path.

The full analysis is in
`/Users/petepetrash/Code/circuit-durability-audit/docs/ideas/fallible-executor-audit.md`.
This spec is the decision layer on top of it.

## What this PR already banks (Rank-1)

`RecoveryCorridor.seedFromTrace(entries)` —
`src/runtime/run/recovery-corridor.ts`. It folds the durable `step.completed`
entries through the **same** `enter` / `clearIfExitingOrigin` transitions the
live loop applies after each step (`graph-runner.ts` ~697-726), landing a fresh
corridor on the **structural** corridor identity (which recovery route is
active, with what origin step) a live run held. It is wired behind `isResume`
next to the existing channel reseeds (`seedSkillHookInjectionsFromTrace`,
`seedPowerInferenceFromTrace`) and is **inert today**: the only resume
entrypoint is a checkpoint boundary, which never sits inside an open corridor,
so `existingTrace` replays to no active corridor. This is plumbing ahead of its
consumer — a Tier-2 cursor.

### The faithfulness boundary discovered while building it

The audit listed `RecoveryCorridor.active` as a "one rehydrator per channel"
item alongside `SliceCorridor`. Building it surfaced a sharper fact: the rehydrator
**cannot** be fully faithful from the trace alone, and the honest slice
restores *structure only*.

`ActiveRecovery` has five fields
(`recovery-corridor.ts` `interface ActiveRecovery`):

| field | source in the live loop | in the durable trace? |
|---|---|---|
| `originStepId` | `step.id` of the completing step | **yes** — `step.completed.step_id` |
| `route` | `route` taken | **yes** — `step.completed.route_taken` |
| `reason` | `details.reason` (executor outcome) | **no** |
| `failure` | `recoveryFailure` (trace-derived + `details`-classified) | **partial** (see below) |
| `acceptanceFeedback` | `details.acceptance_feedback` (executor outcome) | **no** |

`details` is the executor's `outcome.details` (`graph-runner.ts` `details =
outcome.details ?? {}`). It is **never persisted**: `StepCompletedTraceEntry`
(`src/schemas/trace-entry.ts`) is `.strict()` and carries only `step_id`,
`attempt`, `route_taken`, and optional `slice_index`. So `reason` and
`acceptanceFeedback` are not reconstructable.

`failure` is subtler. The `evidenceFor()` path already derives a failure ref
lazily from the trace at consume time, and a `guidance.decision` entry of
subject `recovery_route` *does* persist `failure_cause`/`failure_ref` — but only
when guidance fired (binding present, failure present, cause allowed), and the
`enter()`-time cause classification still depends on `details`
(`acceptance_feedback` → `failed_acceptance_criteria`; `route_source: 'report'`
→ `checkpoint_boundary`). So `failure` is at best partially and conditionally
reconstructable, not faithfully.

**Honest consequence, proven by a test** (`tests/runtime/recovery-corridor-rehydrate.test.ts`,
third case): after `seedFromTrace`, `lastReasonSuffix()` returns `''` and
`acceptanceFeedbackForReentry()` returns `undefined` even where the live run
carried a reason / feedback. The method documents this loudly and the test pins
it so no future consumer is silently misled. Restoring the payload is a spec
line below, not a fake in this slice.

This is exactly why the structural reseed is bankable now and the cursor is
not: the structural identity *is* trace-derivable; the payload is not, and
making it so is a schema change the cursor must own.

## The fork

Two genuinely different directions. They are not "more vs less of the same
thing" — they answer different questions.

- **Build a resumable cursor.** Re-enter the loop at the last `step.completed`
  after a non-checkpoint crash and continue forward. This makes a crash *cheap
  to recover* but introduces a hard new correctness obligation: every channel
  must rehydrate faithfully and every partially-applied step must be proven
  idempotent.
- **Stay projection/checkpoint-only and make crashes cheap to *restart*
  (Tier-3 shape).** Don't re-enter mid-flow at all. Instead invest in the
  foundations (channel rehydration, durable sub-run/fanout linkage) and make a
  full restart fast and safe. This trades recovery latency for a far smaller
  correctness surface.

The two load-bearing unknowns that decide which fork is cheap:

1. **Per-step idempotency.** A crash can land *after* a step's side effects
   (report writes, relay dispatch, sub-run spawn) but *before* its
   `step.completed`. Re-entering must either prove the step is safe to re-run or
   detect-and-skip the partial. This is per-step-kind work, not one switch.
2. **The app→runtime boundary for the staleness gate.** Forward recovery
   assumes the world has not moved under the run. The staleness facts that
   answer "did the repo / branch / files change since the crash" live in
   `src/app/continuity/brief.ts` (`StalenessFacts` ~25-50; `handoffBrief`
   ~585). **Nothing in `src/runtime` imports them today** (verified). A cursor
   that gates on staleness must either lift those facts behind a runtime port
   or duplicate the git probe — a real layering decision, not a function call.

## Options

### Option A — the general cursor (multi-week)

Re-enter the loop at any `step.completed`. The largest, most correct, most
expensive option.

- **New non-checkpoint resume entrypoint.** Today resume flows through
  `resumeCompiledFlow` → `resumeCompiledFlowResult`
  (`checkpoint-resume.ts` ~498, ~689), which gates hard on a checkpoint:
  `latestUnresolvedCheckpointResult` rejects a run with "no unresolved
  checkpoint request" (~178-196) and `checkpointStepResult` rejects a current
  step that "is not a checkpoint" (~198-208). Plus the boundary invariants in
  `run-boundary.ts` ~118-123 (resume requires a non-empty trace and rejects an
  already-closed run). A general cursor needs a *parallel* entrypoint that
  derives `currentStepId` from the last `step.completed` instead of a checkpoint
  request, while keeping the boundary invariants.
- **Rehydrate ALL channels, not just the two that seed today.** Beyond
  skill-hook and power-inference (already seeded) and the RecoveryCorridor
  structure (this PR), the cursor must rehydrate `SliceCorridor`
  (`slice-corridor.ts` `private slices` / `private index`) and reckon with the
  fanout in-memory accumulators (`executors/fanout.ts` `provisioned[]` /
  `outcomes[]` ~212-213). `SliceCorridor` is the hard one: the slice index must
  be reconstructed from per-slice trace facts, and
  `assertNoCheckpointInSliceLoop` (`graph-runner.ts` ~226, the ban that exists
  *because* mid-loop slice state is unrecoverable) would have to relax — only
  once the index is provably reconstructable.
- **Per-step-kind idempotency proof.** For each step kind, prove a re-run is
  safe or detect the partial and skip. This is the irreducible core; no amount
  of channel plumbing removes it.
- **StalenessFacts precondition gate.** Adopt the existing staleness facts as a
  *precondition*, not a "done" verdict — refuse to continue forward into a repo
  that moved under the run. Requires resolving unknown (2) above.

Size: multi-week design + build. Gated by the channel-rehydration foundation and
the idempotency proof. This is "the big one" from the audit.

### Option B — the bounded cursor (the smallest *honest* cursor, ~1–1.5 weeks)

The minimum that is defensible as a cursor, by *excluding* the hard cases rather
than solving them.

- **Linear flows only.** No slice loop, no fanout, no sub-run. This sidesteps
  `SliceCorridor` rehydration and the fanout/sub-run distributed-state problem
  entirely — the cursor simply refuses to resume a flow that uses them
  (a static manifest check, fail-closed).
- **Behind a flag.** Opt-in `engineFlags` switch, inert by default, so the
  default path stays exactly as sound as it is today.
- **Staleness-gated.** Same precondition gate as A, but its scope is small
  enough that a duplicated narrow git probe inside the runtime is acceptable if
  lifting `StalenessFacts` behind a port is too much for this slice (decide at
  build time; record which).
- **Idempotency, narrowed.** Only the step kinds reachable in a linear flow
  need proofs, and a crash-after-effects-before-`step.completed` can be handled
  conservatively (re-run the last step from a clean snapshot rather than
  detecting the partial), because there is no loop/branch to corrupt.

This is the honest floor: it delivers real forward recovery for the common
linear case, names what it cannot do, and refuses those flows outright instead
of risking them.

### Option C — don't build the cursor; invest the foundation + Tier-3 restart-cheapness

Treat the cursor as not-worth-it for now and instead:

- **Bank the channel-rehydration foundation** (this PR's
  `RecoveryCorridor.seedFromTrace`, plus a future `SliceCorridor` reseed) as
  inert, tested plumbing — so a later cursor is a smaller lift.
- **Make a full restart cheap and safe (Tier-3 shape).** Durable
  sub-run/fanout linkage (A2: parent records children *before* they run, a
  startup reaper reclaims orphaned worktrees from `executors/fanout.ts` ~281's
  SIGKILL-defeating `finally`) so a *restart* skips finished children instead of
  re-running them. This attacks crash *cost* without taking on the cursor's
  idempotency obligation.

Option C is the conservative pick: it keeps the correctness surface tiny and
still removes most of the real pain (re-running expensive finished children),
while leaving the cursor as a clean future option on top of banked plumbing.

## Recommendation

**Build Rank-1 now** (done in this PR: `RecoveryCorridor.seedFromTrace`,
structural-only, tested, wired inert behind resume). **Surface Option B as the
cursor spec** — the smallest honest cursor — and do **not** start it until the
two load-bearing unknowns are resolved with cheap probes first:

1. **Per-step idempotency.** Before designing the cursor, enumerate each step
   kind reachable in a *linear* flow and write down its crash-after-effects /
   before-`step.completed` behavior. If any kind cannot be made safe cheaply,
   that bounds the cursor further.
2. **The app→runtime staleness boundary.** Decide whether to lift
   `StalenessFacts` / the git probe behind a runtime port or duplicate a narrow
   probe in the runtime. This is a layering decision (`src/app` → `src/runtime`
   today has no such import) and should be made before, not during, the cursor
   build.

Prefer Option B over Option A: A's cost is dominated by `SliceCorridor`
rehydration + fanout/sub-run distributed state + full idempotency, none of which
B needs. Prefer building B over C only once the linear-case idempotency probe
comes back cheap; if it does not, C (foundation + Tier-3 restart-cheapness) is
the better investment.

## Dependencies on the full cursor (remain surface-only)

- **A2 — Tier-3 crash-safe sub-run / fanout linkage.** Durable parent→child
  intent records + a startup worktree reaper. This is a real distributed-state
  problem (parent + N children, partial completion, SIGKILL-proof cleanup) and
  the audit's largest, most design-led item. It is *adjacent* to the cursor
  (Option C can pursue restart-cheapness without it), but a forward-recovery
  cursor that resumes *into* an in-flight fanout depends on it. Surface-only.
- **A3 — parallel decision inbox.** Multiple concurrently-parked decisions
  resumed independently. This presumes the cursor can re-enter at arbitrary
  parked points, so it depends on the full cursor (Option A). Surface-only.

Both stay surface-only until the cursor fork is decided.
