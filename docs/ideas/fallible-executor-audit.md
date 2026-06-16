# Fallible-executor audit — can a crashed run be reconstructed from durable state?

**Verdict: GAPS-FOUND.** Circuit is a *graceful-park-and-resume-at-an-operator-checkpoint*
system, not a crash-resumable one. A run can only be resumed from a checkpoint
that exited cleanly (`checkpoint_waiting`). If the OS process dies anywhere
*between* checkpoints — which is the entire body of every step, every relay,
every slice loop, every fanout — the run cannot be continued and cannot be
re-run in place. The durable record (the trace) faithfully captures *what
happened up to the kill*, but nothing reads that record to *resume forward
work* unless it ends at an unresolved checkpoint request. The trace is the
authority for **inspection and close-time projection**, not for **mid-run
recovery**.

This audit is read-only. It assesses durability and resumability of internal
run state. It does **not** audit world-divergence/staleness (did the repo move
under a parked run) — that is the adjacent continuity-staleness concern; the
intersection is noted where the two meet.

Scope of source read: `src/runtime/run/`, `src/runtime/trace/`,
`src/runtime/executors/`, `src/runtime/fanout/`, `src/shared/atomic-io.ts`,
grounded against `docs/contracts/continuity.md`, `docs/flows/run.md`, and the
run-centered specs. Probes were driven through the runtime API
(`runCompiledFlow` / `runCompiledFlowWithWaiting` / `resumeCompiledFlow`) via
vitest, because the CLI resume path is a thin wrapper over `resumeCompiledFlow`.

---

## The one-paragraph mental model

A run is a folder. The **trace** (`trace.ndjson`) is an append-only,
one-JSON-object-per-line log and is the sequence authority. Every other file in
the run folder — `result.json`, the reports, the relay request/receipt/result —
is a *projection* derived from, and written alongside, the trace. The engine
advances by **appending a durable fact to the trace before it proceeds** to the
next action (write-before-proceed holds — see Check 2). On a clean checkpoint
pause the engine returns a `checkpoint_waiting` result and the process exits
with the trace ending at a `checkpoint.requested` entry. **That ending is the
only thing `resumeCompiledFlow` knows how to pick up.** Resume re-enters at the
checkpoint step, replays the in-memory channels it knows how to rebuild from the
trace, and runs forward. There is no "resume from the last completed step"; the
only resumable point is an unresolved checkpoint.

---

## Durable-state map

| Artifact | Path | Writer | Atomic? | Role |
|---|---|---|---|---|
| Trace | `trace.ndjson` | `TraceStore.append` (`trace-store.ts:91`, `appendFile`) | No (append, no fsync) | **Sequence authority.** Every state-advancing fact. |
| Manifest snapshot | `manifest.snapshot.json` | `writeRuntimeManifestSnapshot` (`manifest-snapshot.ts`) | No (`RunFileStore.writeJson`) | Flow identity + primary-result pointer, written at run start. |
| Run result | `reports/result.json` | `writeRuntimeRunResult` → `RunFileStore.writeJson` (`result-writer.ts:23`) | No | Close-time **projection** of the trace. Only written at `closeRun`. |
| Reports | `reports/**.json` | step executors via `RunFileStore.writeJson/writeText` | No | Per-step output (compose, relay request/receipt/result, checkpoints). |
| Child runs | `<sibling>/…` | sub-run / fanout branches | No | Durable in their own folders; linked to parent only at join. |

**Reconstructable-from-trace channels** (rebuilt on resume):
`skillHookInjections` (`seedSkillHookInjectionsFromTrace`, `graph-runner.ts:381`)
and `powerInference` (`seedPowerInferenceFromTrace`, `graph-runner.ts:385`).

**Memory-only channels** (lost on any crash, never rehydrated):
`SliceCorridor.slices` / `SliceCorridor.index` (`slice-corridor.ts:41-42`),
`RecoveryCorridor.active` (`recovery-corridor.ts:62`),
fanout `provisioned[]` / `outcomes[]` (`fanout.ts:212-213`).

---

## Check 1 — Durable-state inventory

Every run-folder artifact is listed in the map above. The load-bearing fact:
`result.json` is **not** independent state — `closeRun` builds it entirely from
`context.trace.getAll()` (`run-close.ts:84,109,173`) and the manifest's
primary-result pointer (`run-close.ts:60`). So the trace + manifest are the
complete durable substrate; everything else is derivable. The corollary
(Check 4): if you have the trace you can in principle rebuild any projection —
but the engine only does so at close time, never as a recovery step.

## Check 2 — Write-before-proceed (PASS)

The engine appends the durable fact **before** it takes the next irreversible
action, at every step kind. Empirically confirmed by the SIGKILL-mid-relay
probe, whose trace ends like this (24 entries, abridged):

```
 9  step.entered        (compose-step)
10  step.report_written (compose wrote reports/compose.json)
11  check.evaluated
12  step.completed      (compose-step)        ← compose fully durable
13  step.entered        (relay-step)
22  relay.started
24  relay.request       (reports/relay.request.json written)  ← KILL fires here
    [relay.receipt / relay.result / relay.completed / step.completed: ABSENT]
```

The relay *request* is durable on disk **before** the relayer body runs (the
kill fires inside that body). So the ordering invariant holds: the trace never
gets ahead of reality, and never lags it in a way that would let a half-done
action be mistaken for done. This is the property that *makes* the trace
trustworthy as an authority. The gap is not the ordering — it is that nothing
consumes this perfectly-ordered record to move forward.

## Check 3 — Write durability / atomicity (GAP)

Two layers of non-durability, neither of which is a bug in normal operation but
both of which bound the crash-recovery story:

1. **No atomic write on the run hot path.** `RunFileStore` writes with a bare
   `writeFile` (`run-file-store.ts:23` for JSON, `:35` for text) — no
   staging-file + `renameSync`, no `fsync`. The trace uses `appendFile`
   (`trace-store.ts:91`) — likewise no `fsync`. Circuit *owns* an atomic writer,
   `src/shared/atomic-io.ts` ("Atomic file writes for control-plane artifacts",
   staging + `renameSync` + validate hook), and uses it for the control plane —
   continuity harvest, memory merge/effect, project store, uninstall
   (`grep -rl atomic-io src` → `app/continuity/harvest.ts`,
   `app/history/memory-*.ts`, `memory/project-*.ts`, `cli/uninstall.ts`). **No
   file under `src/runtime` imports it.** So the discipline exists and is applied
   to the slow control plane, but the run-execution plane is deliberately outside
   its scope.

2. **The nuance that saves the common case.** A *returned* `writeFile`/`appendFile`
   syscall survives `kill -9` on the same host via the OS page cache — the bytes
   are handed to the kernel and outlive the process. The probe confirms this:
   after SIGKILL, `reports/compose.json` and `reports/relay.request.json` and the
   full trace are all present and intact. So **process death (SIGKILL) does not
   tear a completed write.** What the missing atomicity *does* expose is the
   narrower power-loss / kernel-panic / partial-flush window, and torn appends —
   see Check 7 / PROBE C, where a half-written final trace line bricks the run.

## Check 4 — Reconstruction / resume path (the core gap)

`resumeCompiledFlow` is the only forward-recovery entrypoint, and it accepts
exactly one shape of durable state: a loaded trace that ends with an
**unresolved checkpoint request**. The gates (`run-boundary.ts`,
`checkpoint-resume.ts`):

- `run-boundary.ts:114-122` — load the existing trace; reject resume if the
  trace is empty, reject if it contains `run.closed`.
- `checkpoint-resume.ts` — reject if the run has no unresolved checkpoint
  request, reject if the re-entry step is not a checkpoint.
- `graph-runner.ts:442` — `currentStepId = resumeCheckpoint?.stepId ?? flow.entry`.
  There is no "last completed step" cursor. Resume either re-enters at a
  checkpoint or starts at the entry.

On resume the engine **rebuilds two in-memory channels from the trace**
(`seedSkillHookInjectionsFromTrace:381`, `seedPowerInferenceFromTrace:385`) — so
those are genuinely reconstructable. But everything that is not a checkpoint
boundary has no re-entry point at all.

## Check 5 — In-memory windows (GAP)

Mutable run state that lives only in `RunContext`/the loop and is lost on any
non-checkpoint crash:

- **`SliceCorridor`** (`slice-corridor.ts:41-42`): `private slices` and
  `private index = 0`. The constructor seeds from `deps.flag` only — never from
  the trace. The engine *itself* documents this as unrecoverable:
  `graph-runner.ts:223` — "a checkpoint pausing mid-loop would lose the live
  slice index" — and `assertNoCheckpointInSliceLoop` (`:226`, invoked `:358`)
  **forbids** placing a checkpoint inside a slice loop for exactly this reason.
  Consequence: a slice loop is, by construction, a single uninterruptible
  between-checkpoint window. A crash at slice 7 of 10 loses slices 1–7 entirely;
  there is no resumable point inside the loop even in principle.
- **`RecoveryCorridor`** (`recovery-corridor.ts:62-64`): `private active`,
  constructed from deps only, no trace seeding. The active recovery route is
  memory-only.
- **fanout `provisioned[]` / `outcomes[]`** (`fanout.ts:212-213`): branch
  worktrees and branch outcomes accumulate in memory until the join.

## Check 6 — Sub-run / fanout linkage (GAP)

Children are durable in their own folders, but the parent only records them at
the *end*:

- **Sub-run**: `childRunDir = join(dirname(context.runDir), childRunId)`
  (`sub-run.ts:162`) — a *sibling* run folder. The child runs to its own
  `result.json`; the parent reads that result and binds it only at join
  (`sub-run.ts:216`). A parent crash after the child closed but before the parent
  records the join leaves a fully-finished orphan child with no parent linkage,
  and re-running the parent re-runs the child from scratch.
- **Fanout**: branch outcomes live in the in-memory `outcomes[]` (`fanout.ts:213`,
  `:259`); the aggregate report and the `fanout.joined` trace entry are written
  only after all branches finish (`fanout.ts:311,327`). Worktree cleanup is in a
  `finally` (`fanout.ts:281-282`) — which **does not run under SIGKILL** (the
  kill is uncatchable), so a mid-fanout crash **orphans provisioned worktrees**.
  Completed branch child folders survive, but the parent has no durable record of
  which branches finished, and there is no resume path to skip them: re-running
  re-executes every branch.

## Check 7 — The named failure + empirical probes

Probes driven through the runtime API. The kill is `process.kill(process.pid,
'SIGKILL')` *inside the stub relayer body* — uncatchable, no `finally`, a
faithful `kill -9` at the "after dispatch, before result" death point.

| Probe | Durable state fed to a fresh executor | Observed result |
|---|---|---|
| **A** (control) | a checkpoint parked by a clean exit (`runCompiledFlowWithWaiting`, depth `high`) | `isWaiting = true` → `resumeCompiledFlow` → `outcome: complete`. **The one resumable path works.** |
| **B** | the SIGKILLed-mid-relay run, then `resumeCompiledFlow` | ✗ `runtime checkpoint resume rejected: run has no unresolved checkpoint request` |
| **B2** | the same dead folder, then a fresh `runCompiledFlow` | ✗ `runtime baseline requires a fresh run directory; existing directory is not empty (manifest.snapshot.json, reports, trace.ndjson)` |
| **C** | a parked checkpoint whose **final trace line is torn** (truncated mid-JSON), then `resumeCompiledFlow` | ✗ `Unterminated string in JSON at position 354` — a raw `SyntaxError` from `JSON.parse` in `TraceStore.load` (`trace-store.ts:50`), not a Circuit-level diagnostic. **A torn trace tail bricks the run with an opaque error and no recovery.** |
| **D** | a cleanly **closed** run, then `resumeCompiledFlow` | ✗ `runtime checkpoint resume rejected: run is already closed` |

The named failure, settled: **kill at a checkpoint = preserved and resumable
(Probe A). Kill between checkpoints = lost (Probes B/B2).** The run folder after
a between-checkpoints kill contains `manifest.snapshot.json`,
`reports/compose.json`, `reports/relay.request.json`, and a `trace.ndjson` that
ends mid-step at `relay.request` — but **no `result.json`, no `run.closed`, no
`checkpoint.requested`** — and so it can be neither resumed (no checkpoint) nor
restarted in place (not empty). It is a dead folder.

---

## Death-point catalogue — exactly where work is lost

| Death point | What is durable after | Resumable? | What is lost |
|---|---|---|---|
| At a parked checkpoint (clean exit) | full trace ending `checkpoint.requested` | **Yes** | nothing |
| Mid-relay (after `relay.request`, before result) | trace through `relay.request`; request report | No | the relay round-trip + everything after; folder is dead |
| Mid-step body (after `step.entered`, before `step.completed`) | trace through `step.entered` | No | the step + all forward work |
| Inside a slice loop | trace through the last completed sub-step | No | the **whole loop** (slice index is memory-only) |
| Mid-fanout (some branches done) | finished branch child folders | No | parent linkage + all branches re-run; **worktrees orphaned** |
| After child sub-run closed, before parent join | orphan child `result.json` | No | parent re-runs the child from scratch |
| After `run.closed` appended, before `result.json` written (`run-close.ts:157` vs `:178`) | closed trace, **no `result.json`** | No (resume rejects closed runs, Probe D) | `result.json` — recoverable *in principle* from the trace, but **no code path regenerates it** |

---

## Per-gap sizing (a sizing, not a fix)

This audit sizes the parallel/unattended-execution milestone. The gaps fall into
three tiers by how much engine surface a real fix would touch.

**Tier 1 — small, self-contained, high value.**
- **Torn-trace tolerance (Probe C).** `TraceStore.load` (`trace-store.ts:50`)
  `JSON.parse`s every line and throws on the first bad one. A torn *final* line
  (the only line a crash can tear, since appends are sequential) should be
  detectable and droppable with a clear diagnostic instead of an opaque
  `SyntaxError`. Size: one function, plus a decision on whether a dropped tail
  line is "ignore and continue" or "halt with a named error." ~half a day.
- **Regenerate `result.json` for a closed-but-projectionless run.** All inputs
  are in the closed trace; `closeRun` already knows how to build the projection.
  A "if `run.closed` present and `result.json` absent, re-derive it" path closes
  the narrowest death window. Size: small, but needs a new entrypoint since
  resume deliberately rejects closed runs. ~half a day.
- **Atomic writes on the run hot path.** `atomic-io.ts` already exists; route
  `RunFileStore.writeJson/writeText` through `writeJsonAtomic/writeTextAtomic`.
  The trace is append-only so it can't use staging+rename as-is — it would need
  an `fsync`-after-append option, or accept the page-cache survival guarantee as
  sufficient for SIGKILL and document power-loss as out of scope. Size: small for
  reports/result, a design decision for the trace. ~1 day.

**Tier 2 — medium, touches the loop.**
- **A resumable cursor for completed steps.** Today the only re-entry point is a
  checkpoint (`graph-runner.ts:442`). A general "resume from last
  `step.completed`" would let a between-checkpoints crash continue. This is the
  big one: it means re-entering the loop at an arbitrary step, rebuilding *all*
  in-memory channels from the trace (not just the two that seed today), and
  proving idempotency of any partially-applied step. Size: the core of the
  milestone — a multi-week design+build, gated by the channel-rehydration work
  below.
- **Rehydrate the memory-only channels.** `RecoveryCorridor` and `SliceCorridor`
  would each need a `seed…FromTrace` like the two that already exist. `SliceCorridor`
  is the hard one — the slice index would have to be reconstructed from per-slice
  trace facts, and the `assertNoCheckpointInSliceLoop` ban could then relax. Size:
  one rehydrator per channel; the slice index is the tricky part. ~1 week.

**Tier 3 — larger, distributed-state shape.**
- **Crash-safe sub-run / fanout linkage.** Make the parent record child folders
  *before* the children run (an intent record), so a fresh executor can find
  finished children and skip them, and orphan worktrees can be reclaimed. This is
  a real distributed-state problem (parent + N children, partial completion,
  cleanup that survives SIGKILL). Worktree orphaning alone (`fanout.ts:281`)
  wants a startup-time reaper, not just a `finally`. Size: the largest item;
  design-led, multi-week, and the part most likely to want its own spec.

**What does not need fixing:** write-before-proceed (Check 2) is correct, and the
checkpoint park/resume path (Probe A) is sound. The trace is a trustworthy
authority; the milestone is about *consuming* it for forward recovery, not about
making it more durable.

---

## Intersection with continuity-staleness (noted, not audited)

Tier 2's "resume from last completed step" assumes the world has not moved under
the run. The moment a fresh executor continues forward work, the
continuity-staleness question (did the repo / branch / files change since the
crash) becomes load-bearing in a way it is not for a checkpoint park, where the
operator is present to judge. Any forward-recovery work should adopt the existing
staleness facts (`StalenessFacts` / `handoffBrief`) as a precondition gate, not
re-solve them. That boundary is where this audit stops.
