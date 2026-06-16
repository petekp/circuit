# Parallel decision inbox (chunk A3)

> Status: SURFACE-ONLY. Decision-ready spec, not committed to the engine.
> Written for the overnight run. Grounds against origin/main code in
> `src/app/run-status/`, `src/app/process-evidence/`, `src/app/operator-summary/`,
> `src/app/run-envelope/`, `src/cli/`, and `src/app/continuity/`.
>
> **Gating: A3 is gated on A1 (the Tier-2 resumable cursor).** A1 only banked its
> foundation slice this run. An inbox that promises *bulk resume* is promising
> something the substrate can only honor for one shape of parked run today. See
> "Why this is gated on A1" at the end.

---

## The vision in one paragraph

The frontier use case is "run dozens in parallel, steer at the forks." A run that
hits an operator checkpoint parks itself and waits. With dozens of parked runs,
the operator needs one surface that lists every run waiting on a decision, shows
what each fork is asking, flags which are stale, and lets the operator answer them
in bulk. Today you can resume exactly one parked run that you already know the
folder of. There is no aggregate surface. An inbox is that surface: discover all
parked runs, triage them, resume them. The good news is that almost all of the
parts already exist as per-run pieces. The inbox is mostly a fan-in (gather the
per-run projections), a filter (keep the parked ones), a triage layer (which fork,
how stale), and a batch front-end over the existing per-run resume. It is a
projection and listing layer, not new runtime.

---

## What exists today (verified against origin/main)

### The terminal "parked" outcome — `checkpoint_waiting`

A run that hits an operator checkpoint and exits cleanly lands in a single,
well-defined outcome that is already surfaced everywhere:

- **Run-status projection** — `src/app/run-status/runtime-run-folder.ts:343-368`
  builds a `RunStatusProjectionV1` with `engine_state: 'waiting_checkpoint'`,
  `reason: 'checkpoint_waiting'`, `legal_next_actions: ['inspect', 'resume']`, and
  a `checkpoint` block carrying the prompt, the allowed choices, and the
  `request_path`. This is the per-run fact an inbox row would render.
- **Process-evidence projection** — `src/app/process-evidence/projection.ts:162-197`
  (`projectCheckpointWaitingProcessEvidence`) emits `outcome: 'checkpoint_waiting'`
  with the checkpoint step id, request ref, and allowed choices.
- **Operator summary** — `src/app/operator-summary/writer.ts:90-105`
  (`CheckpointWaitingOperatorSummaryResult`) carries `outcome: 'checkpoint_waiting'`,
  the goal, the checkpoint step id, request path, and allowed choices.
- **Run envelope** — `src/app/run-envelope/source-record.ts:168-176` classes a
  `checkpoint_waiting` projection as `needs_attention`. So a parked run is already
  flagged as "needs a human," which is precisely the inbox's filter predicate.

So "what each fork is asking" (prompt + allowed choices), "where the request lives"
(request path), and "this needs you" (needs_attention) are all already projected,
per run.

### Per-run resume

- The CLI exposes `resume` — `src/cli/circuit.ts:211-213` routes the `resume`
  command to `runResumeCommand`.
- `src/cli/run.ts:487-509` (`runResumeCommand`) takes a `runFolder` and a
  `checkpointChoice`, confirms it is a runtime run folder, and calls
  `resumeCompiledFlow({ runDir, selection, ... })`.
- The projection that reads a run folder cold and tells you it is parked is
  `projectRuntimeRunStatusFromRunFolder` —
  `src/app/run-status/runtime-run-folder.ts:371` — which loads the trace and
  returns the `checkpoint_waiting` projection above.

So today you can: point at one run folder, read that it is parked and what it is
asking, and resume it with a choice. The piece that is missing is the *aggregate*:
nothing discovers all parked run folders, lists them together, or resumes a batch.

### Staleness facts (for triage)

`src/app/continuity/brief.ts:25-50` defines `StalenessFacts` (head_advanced,
capture_head_reachable, branch_gone, tree_clean, commits_since, current_head) and
`BriefGitProbe`, the deterministic git divergence between a captured baseline and
the live repo. This is the "how stale is this fork" signal the inbox triage column
wants. It already exists; the inbox would reuse it, not re-solve it.

---

## What an inbox adds (the delta)

Concretely, four thin layers over existing per-run pieces:

1. **Discovery (fan-in).** Walk the run-folder root, and for each folder call the
   existing `projectRuntimeRunStatusFromRunFolder`
   (`runtime-run-folder.ts:371`). One per-run projection per folder. No new
   per-run logic — just iterate and collect.
2. **Filter.** Keep folders whose projection is `checkpoint_waiting` (equivalently,
   whose envelope outcome is `needs_attention` for the checkpoint reason). This is
   a one-line predicate over an existing field.
3. **Triage.** For each parked run, render: which fork (the checkpoint prompt +
   allowed choices, already in the projection), how stale (run a `BriefGitProbe`
   against the run's captured baseline → `StalenessFacts`), and a stable ordering
   (e.g. oldest-first, or staleness-first). This is composition of two existing
   projections.
4. **Batch resume.** A front-end that, given a set of (runFolder, choice) pairs,
   calls the existing per-run `resumeCompiledFlow` for each
   (`run.ts:487-509`). The actuator is the per-run resume; the inbox just drives
   it N times.

The honest framing: the inbox is **mostly a read model** plus a thin batch driver.
The discovery + filter + triage layers are pure projection and add no runtime
surface. Only the batch-resume driver touches execution, and it touches it through
the existing per-run entrypoint, not a new one.

---

## The fork

**Build a read-only inbox surface now, or wait for durable resumable runs (A1)
before building anything that resumes in bulk?**

The inbox naturally splits along exactly this line:

- The **read model** (discovery + filter + triage) is honest today. It lists the
  runs that are genuinely parked-and-resumable (`checkpoint_waiting`), shows their
  forks, and flags staleness. Every run it lists *can* be resumed one at a time
  right now. This part promises nothing the substrate cannot honor.
- The **bulk-resume driver** is where the gating bites. A batch front-end that
  says "resume all 12" is only as trustworthy as the resume substrate beneath it.
  Today resume works for exactly one shape: a run parked at a clean checkpoint
  (the audit's Probe A). A run that *crashed* mid-step is a dead folder — it is
  `needs_attention` too, but it is not resumable (Probes B/B2). If the inbox
  conflates "parked" and "needs attention," it will list dead runs next to
  resumable ones and offer a resume button that fails on half of them.

---

## Options

### Option 1 — Read-only inbox now (discovery + filter + triage; no batch resume)

Ship the read model. List all `checkpoint_waiting` runs, show each fork and its
staleness, link to per-run resume. The operator still resumes one at a time
(existing CLI), but now they can *see* the whole queue and decide where to spend
attention.

- **Scope:** a discovery/listing app module + a triage renderer; a CLI subcommand
  (e.g. `circuit inbox`) and/or a section in an existing status surface.
- **Touches:** new app module under `src/app/run-status/` (or a sibling
  `src/app/inbox/`), a CLI wiring point, reuse of
  `projectRuntimeRunStatusFromRunFolder` and `BriefGitProbe`. No runtime change.
  No new resume path.
- **Honest about the substrate:** lists only `checkpoint_waiting` (the genuinely
  resumable shape), and links to the existing per-run resume. Promises nothing
  the substrate cannot honor.
- **Sizing:** ~3-4 days. Mostly projection wiring + a renderer + a discovery walk.

### Option 2 — Inbox with bulk resume now

Option 1 plus a batch driver that resumes a selected set in one command.

- **Scope:** Option 1 + a batch-resume command that loops the existing per-run
  `resumeCompiledFlow`.
- **The catch:** bulk resume only honestly works for `checkpoint_waiting` runs.
  That is fine *today* — but the value of bulk resume is highest precisely for the
  crash-recovery case (a power blip kills the host, dozens of in-flight runs die
  mid-step, you want to revive them all at once). That case is exactly what the
  substrate cannot do until A1. So bulk resume now solves the *cheap* case (clean
  parks, which you could resume one-by-one anyway) and not the *expensive* case
  (crashes, which is the real reason you want a batch). It over-promises against
  what A1 will eventually unlock.
- **Sizing:** ~5-6 days, but with a misleading payoff curve until A1.

### Option 3 — Wait for A1, then build the whole inbox

Build nothing until the resumable cursor lands, then build discovery + triage +
bulk resume on top of a substrate that can revive both clean parks and crashes.

- **Risk:** the read-model value (just *seeing* the parked queue) is real and
  available today, and is held hostage to a multi-week item for no substrate
  reason. The read model does not need A1.

---

## Recommendation

**Ship the read-only inbox now (Option 1); defer bulk resume until A1's cursor
lands (then add it as Option 2's driver).**

Reasoning:

- The read model is honest today and immediately useful. The whole point of
  "steer at the forks" is *seeing* the forks; an operator with a dozen parked runs
  needs the queue view before they need a batch button. Discovery + filter +
  triage promise nothing the substrate cannot honor — every listed run is a
  genuinely resumable `checkpoint_waiting` run, and the inbox links to the
  existing per-run resume.
- Triage is where the read model earns its keep. Staleness (`StalenessFacts`) is
  the signal that tells the operator *which* parked run to answer first — the one
  whose repo has not moved is safe to resume; the one whose branch is gone needs a
  fresh look. That value is available now and does not depend on A1.
- Bulk resume should wait, because its real payoff is the crash-recovery case, and
  that case is exactly what A1 unlocks and what the substrate cannot honor today.
  Shipping bulk resume now would mean a batch button that works for clean parks
  (which barely need it) and silently fails for crashes (which are the reason you
  want it). Better to add the driver the day the substrate can back it.
- Critically, the read model must list **only** `checkpoint_waiting`, not all of
  `needs_attention`. `needs_attention` also covers dead crashed folders and
  missing-evidence runs (`source-record.ts:168-176`), which are not resumable. An
  inbox that lists those next to resumable parks and offers resume would lie about
  what the substrate can do. Filter on the resumable outcome, not the attention
  flag.

So: A3-now = the read-only inbox (discovery + filter on `checkpoint_waiting` +
staleness triage + links to per-run resume). A3-later = the batch-resume driver,
added when A1 makes "resume" mean "revive any parked-or-crashed run."

---

## What it would take (the read-only inbox, A3-now)

1. **A discovery walk** — iterate the run-folder root, call
   `projectRuntimeRunStatusFromRunFolder` (`runtime-run-folder.ts:371`) per folder,
   skip folders that do not parse as runtime traces (the function already returns
   `undefined` for those).
2. **A filter** — keep projections with `reason === 'checkpoint_waiting'`. This is
   the resumable-park predicate, narrower than `needs_attention` on purpose.
3. **A triage renderer** — for each kept run, render the fork (prompt + choices
   from the projection's `checkpoint` block) and run a `BriefGitProbe`
   (`brief.ts:46-50`) against the run's captured baseline to attach
   `StalenessFacts`. Order by staleness or age. Reuse the existing brief render
   conventions so a missing staleness signal never renders a wrong claim (the
   brief's every-field-optional discipline, `brief.ts:25-37`).
4. **A surface** — a `circuit inbox` CLI subcommand that prints the triaged list,
   each row linking to `circuit resume <folder> <choice>` (the existing per-run
   path, `run.ts:487`). Optionally a section in an existing status surface.
5. **Failing test first** — fixtures: a run folder parked at a checkpoint, a dead
   crashed folder, and a closed folder; assert the inbox lists only the parked one,
   renders its fork, and attaches staleness; assert dead/closed folders are
   excluded.
6. **No runtime change. No new resume path. No engine special-casing.** Pure
   app-layer projection + a CLI front-end over existing entrypoints.

## What it would take (bulk resume, A3-later, on top of A1)

1. A batch-resume command taking a set of (runFolder, choice) pairs, looping the
   existing per-run `resumeCompiledFlow` (`run.ts:500`).
2. A staleness precondition gate per run before resuming (reuse `StalenessFacts`),
   so a stale-world run is flagged rather than blindly resumed.
3. Once A1's cursor exists, broaden the inbox filter from `checkpoint_waiting` only
   to "any run with a resumable cursor position," so the batch can revive crashes,
   not just clean parks. This broadening is the whole reason bulk resume waits for
   A1.

---

## Why this is gated on A1

Resume today honors exactly one shape of durable state: a trace ending at an
unresolved checkpoint (the audit, Check 4; `resumeCompiledFlow` rejects empty
traces, closed runs, and runs with no unresolved checkpoint). The audit's probes
are blunt about it: a clean park resumes (Probe A); a crash mid-step is a dead
folder that can be neither resumed nor restarted (Probes B/B2). So "resume" is a
narrow guarantee, and an inbox is a promise *about* resume. A bulk-resume inbox
promises to revive a queue of parked runs — but the substrate can only revive the
ones that parked cleanly, not the ones that crashed. The crash case is exactly
what A1's resumable cursor is for, and A1 only banked its foundation slice this
run. So the read model (which lists only the genuinely resumable
`checkpoint_waiting` runs and links to the existing per-run resume) is honest today
and ships now; the bulk-resume driver (whose real value is reviving crashes)
waits for A1.

The staleness intersection is the second A1 dependency the bulk driver inherits.
The moment any resume continues forward work, the "did the world move under the
parked run" question becomes load-bearing (the audit's continuity-staleness
intersection note). The inbox already wants `StalenessFacts` for its triage
column, so the precondition gate is the same facts, surfaced for triage in the
read model and enforced as a gate in the bulk driver. The inbox should adopt
`StalenessFacts` / `handoffBrief` (`src/app/continuity/brief.ts`), not re-solve
staleness.
