# F14 — interrupted-run recovery: handoff for the discovery surface

Status: written 2026-07-03 for Pete. Slice 1 (honest resume rejection) shipped
to main tonight. Slices 2 and 3 are deferred here because they add a new public
command surface and a runtime write-path change during the v1 feature freeze,
which is your call, not an overnight one.

## What F14 is

An **interrupted run** is a run folder whose process died mid-execution. Its
trace has the runtime bootstrap and one or more step entries, but it never
reached a checkpoint (so there is nothing to resume) and never wrote its close
record (so it never finished). A crash, a closed laptop, a killed terminal all
land here.

The public run-status projection reports such a folder as `engine_state: open`,
`reason: active_or_unknown`. That reason is honest but blunt: from a run folder
alone we cannot tell "still running in another terminal" from "crashed an hour
ago". There is no durable liveness marker to tell them apart.

The finding had three edges. The operator who crashes mid-run:

1. **points `resume` at the folder** and gets an internal rejection string.
2. **cannot find the folder again** — `inbox` lists only runs waiting at a
   checkpoint, and `circuit runs show` needs a folder path you already have.
3. **cannot tell a dead run from a live one** — nothing on disk distinguishes
   them, so any recovery UI would have to guess.

## What shipped tonight (Slice 1)

Edge 1 only. `circuit resume` pointed at an interrupted (or already-finished, or
damaged) run folder now answers in plain language keyed on the public
run-status projection, and always points at the inspection command, instead of
leaking the internal rejection string
(`runtime checkpoint resume rejected: run has no unresolved checkpoint request`).

- Code: `nonResumableRunMessage()` in [`src/cli/run.ts`](../../src/cli/run.ts).
  It wraps the `resumeCompiledFlow` call in `runResumeCommand`; on any throw it
  projects the folder's status and writes an honest, actionable message, exit 2.
- Test: [`tests/runner/resume-interrupted.test.ts`](../../tests/runner/resume-interrupted.test.ts)
  builds a hand-authored interrupted run folder (bootstrap + one `step.entered`,
  no checkpoint, no close) and asserts the message names the interruption,
  points at `circuit runs show`, and never leaks internal vocabulary.

This slice is safe because it changes only what a failed resume prints. It
reuses the existing public projection (`projectRunStatusFromRunFolder`) and adds
no new command, no new on-disk contract, and no runtime write-path change.

The message deliberately says "interrupted before it reached one, **or** it is
still running elsewhere" for the `open` case. That ambiguity is the honest
answer until Slice 3 gives us a liveness marker. Do not tighten it to claim
"interrupted" with certainty before that marker exists — it would sometimes lie
about a run that is genuinely still going.

## What is deferred (Slices 2 and 3)

### Slice 2 — a discovery surface (edge 2)

The operator needs to *find* the interrupted run without already knowing its
path. Two candidate shapes, pick one:

- **`circuit runs list`** — a new subcommand next to the existing
  `circuit runs show` in [`src/cli/runs.ts`](../../src/cli/runs.ts). It scans
  the runs root, projects each folder through `projectRunStatusFromRunFolder`,
  and prints a table (run id, flow, goal, engine_state, folder). This is the
  most discoverable and the most general — it also answers "what runs do I
  have?", which nothing currently does.
- **`inbox --all` / `inbox --interrupted`** — extend the existing inbox instead
  of adding a command. Inbox today filters to `checkpoint_waiting` only; a flag
  would widen it to include `open` folders. Lower surface-area, but overloads a
  command whose whole identity today is "things waiting on you".

Recommendation: **`circuit runs list`.** It is the honest general primitive;
inbox stays "things waiting on you". Both reuse the projection, so neither needs
new engine code. The cost is a new public command surface — hence your call
under the freeze.

Whichever ships needs: the subcommand, a JSON mode mirroring `runs show`, a
test over a fixture runs root containing one of each engine_state, and a docs
entry. No proof scenario changes (this reads existing folders; it asserts no new
runtime behavior).

### Slice 3 — a durable liveness marker (edge 3)

To ever say "interrupted" with certainty (rather than "interrupted or still
running"), the runtime needs to record liveness so a reader can distinguish a
dead process from a live one. Sketch:

- On run start, write a small `liveness.json` (pid + a monotonically bumped
  heartbeat timestamp) into the run folder; refresh it at step boundaries.
- The projection gains a real `interrupted` state: `open` **and** the heartbeat
  is stale beyond a threshold (or the pid is gone) ⇒ `interrupted`; `open` with
  a fresh heartbeat ⇒ genuinely running.
- `resume`'s `open`-case message then splits: a truly-interrupted run can offer
  a real recovery path (re-run from the last completed step via the existing
  `--reuse-children-from` machinery); a live run says "still running, don't
  resume".

This is the real feature. It touches the runtime write path (a new artifact
written during every run), adds a state to the public `RunStatusProjectionV1`
discriminated union in [`src/schemas/run-status.ts`](../../src/schemas/run-status.ts)
(a public contract change), and wants proof coverage. It is the largest of the
three and the least reversible — squarely a post-announcement feature.

Watch-outs:

- pid reuse: a recycled pid can make a dead run look alive. The heartbeat
  timestamp is the primary signal; pid is a secondary hint, not the authority.
- clock skew and the staleness threshold need a deliberate default; too tight
  and a slow live step reads as dead, too loose and recovery lags.
- adding a union member is a breaking change for any consumer that exhaustively
  matches `engine_state`. Grep for `engine_state` switches before landing it.

## Suggested sequencing

1. Slice 1 — **done, on main.**
2. Slice 2 (`circuit runs list`) — small, safe, high operator value; ship soon
   after the announcement.
3. Slice 3 (liveness + `interrupted` state) — schedule as a proper feature with
   its own proof scenario; it is the one that makes recovery real.
