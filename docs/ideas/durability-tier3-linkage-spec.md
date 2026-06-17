# Durability Tier-3 — crash-safe sub-run / fanout linkage (chunk A2)

> Status: **PARTLY BUILT — the reaper (A2-now) SHIPPED; the linkage (A2-later)
> still surfaced.** Updated 2026-06-16. The recommendation below was followed: the
> startup worktree reaper (Option 1) shipped as an A1-independent fix
> (`src/runtime/fanout/worktree-reaper.ts` + `src/runtime/fanout/run-owner-lock.ts`
> + `src/cli/reclaim.ts`, PR #99). The deeper **A2-later linkage** — deterministic
> child ids + intent records + skip-finished — remains a spec, and is now folded
> into the Option-C restart path
> ([`durability-tier3-restart-linkage-spec.md`](durability-tier3-restart-linkage-spec.md)),
> not the abandoned forward-recovery cursor. See
> [`north-star-status.md`](north-star-status.md).
>
> *(Original status: "SURFACE-ONLY. Decision-ready spec, not committed to the
> engine. … Gating: A2 is gated on A1." The gating applied to A2-later only; the
> reaper was always A1-independent, which is exactly why it shipped first.)*
> Grounds against the fallible-executor audit (`fallible-executor-audit.md`,
> Check 6 and the Tier-3 sizing) and origin/main code at
> `src/runtime/executors/sub-run.ts` and `src/runtime/executors/fanout.ts`.

---

## The problem in one paragraph

A parent run can spawn children: a sub-run step runs one child flow, a fanout step
runs N branches in parallel. Each child is durable in its own folder. But the
parent only records the link to a child at the **end** (the join). If the OS kills
the parent process after a child finished but before the parent wrote the join,
the child is a finished orphan with no parent linkage. Re-running the parent
re-runs that child from scratch. For fanout there is a second loss: the worktree
cleanup that removes per-branch checkouts lives in a `finally`, and a `finally`
does not run under `SIGKILL`. So a mid-fanout crash leaves provisioned worktrees
on disk with nothing to reclaim them. This is a real distributed-state problem:
one parent, N children, partial completion, and cleanup that must survive an
uncatchable kill.

---

## What the code does today (verified against origin/main)

### Sub-run — link recorded only at join

`src/runtime/executors/sub-run.ts`:

- `:161-162` — the child gets a fresh id and a **sibling** run folder:
  `childRunDir = join(dirname(context.runDir), childRunId)`. The id is a random
  UUID, so it is not derivable after a crash.
- `:163-172` — the parent appends `sub_run.started` to its trace *before* running
  the child. This names `child_run_id`, `child_flow_id`, `child_entry_mode`,
  `child_depth`. Good: the intent that a child *was started* is durable.
- `:177-206` — `context.childRunner(...)` runs the child to its own
  `result.json`. The parent does not read or bind anything until this returns.
- `:216-251` — only after the child returns does the parent copy the child result
  into its own report and append `sub_run.completed` with the verdict.

The gap: `sub_run.started` records that *a* child started, but the parent has no
durable record that the child *finished* until `sub_run.completed`. If the kill
lands in the window between the child closing its own `result.json` and the parent
appending `sub_run.completed`, the parent's trace ends at `sub_run.started`. On a
fresh executor there is no path that says "a child with this id already has a
closed result.json next door, admit it instead of re-running." Re-running the
parent generates a new UUID and runs a new child.

### Fanout — outcomes in memory, join after all branches, cleanup in a `finally`

`src/runtime/executors/fanout.ts`:

- `:212-213` — `provisioned: string[]` (worktree paths) and `outcomes:
  BranchOutcome[]` are plain in-memory arrays. They accumulate as branches run.
- `:219-264` — branches run under `runWithConcurrency`. Each branch appends its
  own `fanout.branch_started` / `fanout.branch_completed` to the parent trace
  (see `src/runtime/fanout/branch-execution.ts:51-71`, `:266`, `:318`, `:440`,
  `:529`). So per-branch *trace* facts are durable.
- `:249` — `if (branchNeedsWorktree(branch)) provisioned.push(worktreePath)`. The
  worktree path is deterministic: `controlPlaneRoot/worktrees/<runId>/<stepId>/<branchId>`
  (`:242-248`). This determinism matters for the reaper below.
- `:281-289` — the `finally` removes every provisioned worktree. **A `finally`
  does not run under `SIGKILL`.** So a kill mid-fanout orphans every worktree that
  was provisioned but not yet removed.
- `:310-321` — the aggregate report is written only after all branches finish.
- `:325-337` — `fanout.joined` (the parent's durable record of which branches
  completed, and the selected branch) is appended last.

The gap has two halves. First, the parent's *aggregate* and `fanout.joined` are
written only at the end, so a mid-fanout kill loses the parent's roll-up even
though the per-branch trace facts survive. Second, and worse, the worktrees leak:
the only thing that removes them is the SIGKILL-skipped `finally`.

Note: the per-branch `fanout.branch_completed` trace facts are actually *richer*
than the sub-run case. A reaper or a resume reading the parent trace can already
see which branches completed. The fanout linkage gap is narrower than sub-run's;
the worktree-orphaning gap is the sharp one.

---

## The fork

**Do we make children crash-safe-linked, or do we accept re-run cost and only
stop the worktree leak?**

The two failures have very different blast radius:

- **Orphaned worktrees (fanout only)** are a real, unbounded disk leak. Every
  killed fanout run leaves N checkouts on disk forever. There is no operator
  surface that lists them and no command that reclaims them. This is a bug today
  regardless of resumability.
- **Re-running a finished child** wastes work (a child sub-run can be a full
  build, dollars and minutes) but is *correct*: the child is idempotent enough
  that re-running it produces a valid result. It is a cost problem, not a
  correctness problem.

So the fork is really: pay for full intent-record linkage (so a fresh executor
*skips* finished children), or just fix the leak (a reaper) and let re-run cost
stand until A1's cursor makes resume real.

---

## Options

### Option 1 — Reaper only (stop the leak, accept re-run cost)

Add a startup-time worktree reaper. On run start (or as a `circuit` maintenance
subcommand), scan `controlPlaneRoot/worktrees/<runId>/...` for worktree dirs whose
owning run is closed or dead, and `git worktree remove` them. The worktree path is
deterministic (`fanout.ts:242-248`), and the run folder for `<runId>` tells you
whether that run closed. This is a reclaimer, not a `finally` — it survives
SIGKILL because it runs *after* the crash, on the next invocation.

- **Scope:** one reaper module + a wiring point at run start, plus a manual
  `circuit reclaim` style subcommand for operator-driven cleanup.
- **Touches:** new file under `src/runtime/fanout/` (or an app-level maintenance
  module), a call site at run boundary, the worktree runner's `remove`. No change
  to the trace schema. No change to sub-run.
- **Does NOT fix:** finished orphan children get re-run. Sub-run linkage gap
  stays.
- **Sizing:** ~2-3 days. Self-contained, no schema work, testable with a
  fixture run folder + a fake worktree runner.

### Option 2 — Intent-record linkage + reaper (the full Tier-3 fix)

Record the child folder *before* the child runs (an intent record), so a fresh
executor can find finished children and skip them; plus the reaper from Option 1
for the worktrees.

The mechanism:

1. **Deterministic child ids.** Today `childRunId = randomUUID()`
   (`sub-run.ts:161`, `branch-execution.ts:438`, `:492`). Derive the child id
   instead from `(parentRunId, stepId, attempt[, branchId])` so a re-run computes
   the *same* id and can find the prior child folder. This is the keystone: an
   intent record is useless if the re-run cannot name the same child.
2. **Intent record before run.** The parent already appends `sub_run.started` /
   `fanout.branch_started` before running the child. Promote these to a true
   *intent record*: include the deterministic child folder path so the parent
   trace says "I am about to run a child at THIS path with THIS id." (Sub-run
   already records `child_run_id`; add the path. Fanout branch-started already
   records `worktree_path`; add the child result path.)
3. **Skip-finished on re-entry.** When the parent re-runs a step (under A1's
   cursor, or even on a plain re-run for the idempotent case), before invoking
   `childRunner`, check whether the deterministic child folder already holds a
   closed `result.json`. If so, admit it through the same verdict path
   (`evaluateChildResult`, `sub-run.ts:50-71`; `branchResult`,
   `branch-execution.ts:80-92`) instead of re-running. The admit logic already
   exists; this just feeds it a found result instead of a fresh one.
4. **Reaper** (Option 1) for the worktrees a mid-fanout kill orphaned.

- **Scope:** deterministic-id helper, intent-record trace fields, a
  skip-finished branch in both `sub-run.ts` and `branch-execution.ts`, plus the
  reaper.
- **Touches:** `src/runtime/executors/sub-run.ts`, `src/runtime/executors/fanout.ts`,
  `src/runtime/fanout/branch-execution.ts`, the trace schema (new optional fields
  on `sub_run.started` / `fanout.branch_started`), the reaper module, and the
  resume re-entry path A1 builds.
- **Fixes:** both the re-run cost and the worktree leak. Closes Check 6 fully.
- **Sizing:** ~1.5-2 weeks. The audit calls this "the largest item, design-led,
  multi-week." Deterministic ids and skip-finished are the design risk: the child
  must be *safe* to skip, which means the parent's admit decision must be a pure
  function of the child result (it is today) and the child must not have
  externally-visible side effects that a re-run would otherwise re-apply. For a
  sub-run that writes to a worktree this is clean; for one that mutates the shared
  checkout it is not, and that case should refuse to skip.

### Option 3 — Do nothing now, fold into A1

Accept that linkage is a sub-problem of forward recovery. When A1's cursor lands,
the same re-entry machinery that resumes a parent step will naturally need to
decide "did my child finish," so build linkage *then*, inside the cursor work,
not as a separate effort. Risk: the worktree leak persists in the meantime, which
is a live bug, not a deferred feature.

---

## Recommendation

**Ship the reaper now (Option 1) as a standalone, A1-independent fix; defer the
intent-record linkage (Option 2) into the A1 cursor work.**

Reasoning:

- The worktree leak is a real, unbounded disk bug that exists today and does not
  depend on A1. It is small, self-contained, and has no schema cost. There is no
  reason to hold it behind a multi-week cursor. Ship it.
- The intent-record linkage only pays off when there is a re-entry path that *uses*
  the skip-finished branch. That path is A1's cursor. Building deterministic ids
  and skip-finished before the cursor exists means writing machinery with no
  consumer — exactly the inert-with-no-consumer shape the run already hit with
  `RecoveryCorridor.seedFromTrace`. Better to build linkage as a named slice
  *inside* the cursor milestone, where it has a consumer on day one.
- The re-run cost (Option 2's other half) is a correctness-safe inefficiency. It
  can wait. The leak cannot.

So: A2-now = the reaper (Option 1). A2-later = deterministic ids + intent records
+ skip-finished, sequenced as a slice of A1 (Option 2 minus the reaper). This
splits a multi-week item into a shippable piece and a gated piece, and it gets the
live bug fixed without waiting.

---

## What it would take (the reaper, A2-now)

1. **A reaper module** (new file, e.g. `src/runtime/fanout/worktree-reaper.ts`).
   Input: the control-plane worktrees root and a predicate for "owning run is
   dead or closed." For each `worktrees/<runId>/<stepId>/<branchId>` dir, resolve
   the run folder for `<runId>`; if it has `run.closed` in its trace, or it is a
   dead folder (no `checkpoint.requested`, no `run.closed`, per the audit's
   dead-folder definition), `worktreeRunner.remove` it. Best-effort, never throws.
2. **A wiring point.** Call the reaper at run start (run-boundary) for the current
   run's leftover worktrees, and expose it as an operator subcommand
   (`circuit reclaim` or similar) so a human can reclaim across all runs.
3. **A failing test first.** A fixture: a run folder whose trace ends mid-fanout
   (no `fanout.joined`) plus a fake worktree on disk; assert the reaper removes it
   and a closed run's worktrees are also removed, while a *live* parked run's
   worktrees are left alone.
4. **No schema change. No sub-run change. No engine special-casing.** The reaper
   reads existing trace facts and the deterministic worktree path.

## What it would take (the linkage, A2-later, inside A1)

1. **Deterministic child ids** — replace `randomUUID()` at `sub-run.ts:161`,
   `branch-execution.ts:438`, `:492` with a derivation from
   `(parentRunId, stepId, attempt, branchId?)`. Failing test: a re-run computes
   the same child id.
2. **Intent-record trace fields** — add the child folder path to `sub_run.started`
   and the child result path to `fanout.branch_started` (optional fields, additive
   schema bump).
3. **Skip-finished re-entry** — in both executors, before `childRunner`, probe the
   deterministic child folder for a closed `result.json`; if found, feed it to the
   existing admit path (`evaluateChildResult` / `branchResult`) and skip the run.
   Refuse to skip when the child mutated the shared checkout (no isolating
   worktree) — re-applying that is not safe.
4. **Idempotency proof** — a test that kills a parent after a child closes but
   before the join, then resumes via A1's cursor, and asserts the child is admitted
   from disk, not re-run.

---

## Why this is gated on A1

The audit settles it (`fallible-executor-audit.md`, Check 4 and the Tier-2/Tier-3
sizing): the only forward-recovery entrypoint today is `resumeCompiledFlow`, and
it accepts exactly one shape of durable state — a trace ending at an unresolved
checkpoint. There is no "resume from last completed step" cursor. A mid-fanout or
mid-sub-run crash is a *between-checkpoints* death, which has no re-entry point at
all (Probes B/B2). So even if A2 recorded a perfect intent record, there is
nothing that re-enters the parent step to *consume* it: the parent run is a dead
folder that can be neither resumed (no checkpoint) nor restarted in place (not
empty). The skip-finished branch needs a re-entry caller, and that caller is A1's
cursor.

This run only banked A1's *foundation* slice (`RecoveryCorridor.seedFromTrace` — a
fold over `step.completed` facts, inert until a cursor reads it). The cursor proper
is the multi-week item. Until it lands, A2's linkage half has no consumer, which is
exactly why the recommendation splits the reaper (A1-independent, ship it) from the
linkage (A1-gated, build it as an A1 slice).

One more dependency the linkage inherits from A1: the staleness boundary. The
moment a fresh executor admits a finished child instead of re-running, the
continuity-staleness question (did the repo move under the parked parent) becomes
load-bearing, just as it does for any forward recovery. The linkage slice should
adopt the existing staleness facts as a precondition gate (see the parallel-inbox
spec's note on `StalenessFacts` / `handoffBrief`), not re-solve them.
