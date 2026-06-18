# Brief — thin the Build envelope to cash in context-pull

> Status: **implementation-spec. Decision-ready; builds in `src/`.** Date
> 2026-06-18, grounded on `main` at HEAD `c8026ef2`. This is the explicit unlock
> the context-pull last-mile report names
> ([`context-pull-last-mile-report.md`](context-pull-last-mile-report.md),
> "Recommended next step"). A branch/worktree `feat/thin-envelope-unlock` may
> already exist — **check it out and continue it** rather than starting fresh.

---

## 0. The problem (why this, why now)

On-demand context-pull is fully built and safe (PRs #112–#115), but **low-yield in
production**. The last-mile confirmation found the reason: the Build plan
**over-provisions**. The plan step inlines the researcher's *narrow* synthesis
(`observations`) directly into the plan's `approach` prose, so the implementer is
**already handed** the narrow slice and is rarely starved of it. When a real worker
*is* starved, it is of the *bulky* `sources`, whose pull saves only ~1.3x — not the
designed ~10x, which only materializes when the **narrow** slice is the withheld,
pulled thing.

Two changes convert the channel from a low-yield fail-safe into the saving it was
designed for:

1. **Thin the envelope** — stop inlining the full `observations` synthesis into the
   plan's `approach`; expose it as a **pullable slice** (`analyze-step.observations`)
   the implementer fetches only when genuinely starved.
2. **Lift the corridor skip** — at deep depth (slice loop active) the implementer is
   the corridor head step, so its pulls are **silently dropped** (no delivery, no
   finding). Make pulls legible (resolve-and-record, and deliver when enabled)
   inside corridors too.

Together these make the narrow pull arise and pay (~11x on the measured probe),
and close the one refusal path that is currently invisible — the two preconditions
the report set for revisiting **default-ON**.

---

## 1. Current state (grounded in `src/`)

### 1a. The inlining site

`src/flows/build/writers/plan.ts` builds the plan's `approach` by joining the
researcher's observations into prose:

```ts
const approach =
  grounding === undefined
    ? baseApproach
    : `Grounded in a codebase read (${grounding.sources.length} sources): ${grounding.observations.join(' ')} Then ${baseApproach}`;
```

`grounding` is the analyze step's `build.context@v1` report (`BuildContext` in
`src/flows/build/reports.ts`), which carries `observations` (the narrow synthesis)
and `sources` (the bulky per-site notes). The implementer (`act-step`, a relay,
`src/flows/build/assembly-spec.ts`) receives only `brief` + `plan` — so today the
`observations` reach it **only** as a substring of `approach`. The implementer's
output contract (`BuildImplementation`) already carries the optional
`context_request` field with the conservative describe text.

### 1b. The pull channel (no change needed to the mechanism)

`src/runtime/run/context-pull.ts` resolves a typed query (`from_step` + `field_path`)
against a parent's typed report. **Pullable slices are automatic from the report
shape** — there is no "expose this field" declaration; `analyze-step.observations`
is *already* pullable. So thinning the envelope does not strand the implementer: the
slice it stops being spoon-fed becomes the slice it can pull on demand.

### 1c. The corridor skip

`src/runtime/run/graph-runner.ts` guards the resolve-and-record context-pull seam
with `!sliceCorridor.isActive()` (around the `options.contextPuller !== undefined &&
options.contextDelivery === undefined && … && !sliceCorridor.isActive()` condition).
Its own comment names this as over-conservative:

> "the slice-loop skip is over-conservative here (context-pull never mutates, so the
> reshape reason — slice-scoped completion keys — does not apply): a request surfaced
> inside a corridor is dropped WITHOUT a finding … Lifting the skip (resolve + record
> inside corridors too) is a battle-test item, gated on a deep-depth test."

For Build, the slice loop activates at depth `high` and deeper (`iteratesSliceLoop`
in `src/flows/build/assembly-spec.ts`, `head_step: 'act-step'`), so exactly the
deep-depth runs where pulls matter most are where they vanish.

### 1d. The delivery flag

`enableContextDelivery` (opt-in, default OFF) is threaded in
`src/runtime/run/compiled-flow-runner.ts` and `checkpoint-resume.ts` via
`options.enableContextDelivery === true ? { contextDelivery: … } : {}`. This brief
does **not** flip the default; it makes default-ON *defensible* by removing the two
blockers.

---

## 2. The change (scope)

### Change A — thin the envelope (the core unlock)

In `src/flows/build/writers/plan.ts`, stop inlining the full `observations`
synthesis into `approach`. Keep `approach` a real instruction (the `baseApproach`
"smallest safe change inside scope" line, plus a brief grounding *pointer* — e.g.
"a codebase read produced N sources and an observations synthesis; pull
`analyze-step.observations` if you need it"), but **do not paste the full
synthesis**. The narrow slice now lives only in the analyze report, pullable.

Update the implementer relay-hint (`src/flows/build/relay-hints.ts`) so the worker
knows the synthesis is available as `analyze-step.observations` to pull when
genuinely starved — narrowly, never reflexively, refuse-honestly when unpullable
(the existing conservative guidance, pointed at the now-withheld slice).

**Conservative default:** keep a thin grounding pointer in `approach` (sources
count + that an observations slice exists), so a worker that never pulls is no
worse off than a worker handed a one-line summary; it is the *full* synthesis that
moves behind the pull.

### Change B — lift the corridor skip

In `src/runtime/run/graph-runner.ts`, stop dropping the head-step's context-pull
inside an active slice corridor. Resolve-and-record the request (and, when
`contextDelivery` is enabled, deliver-and-retry) inside the corridor too, since
context-pull **never mutates run state** — the slice-loop reason for the skip
(slice-scoped completion keys, which the *equipment reshape* needs) does not apply
to a read-only pull. Keep every other guard (terminal-close skip, per-step budget,
the `Object.hasOwn` field fence, fail-safe on any error). Rewire the channel on
resume so a corridor pull spent before a crash is not double-counted (mirror the
existing `seedContextDeliveryFromTrace` discipline).

### What this unlocks (not in this brief)

With A + B landed and measured, **default-ON** becomes a separate, now-defensible
decision (its own ratification). This brief stops at making the narrow pull arise,
pay, and stay legible — and **re-running the battle-test to confirm** the ~10x in
the thinned regime.

---

## 3. Rails / out of scope

- **Do NOT flip `enableContextDelivery` to default-ON in this brief.** That is the
  reserved follow-up; land the prerequisites and the measurement first.
- **Do NOT touch the pull mechanism** (`context-pull.ts` resolution, the
  `Object.hasOwn` fence, the budget). The channel already supports the slice; this
  brief changes *what the envelope withholds* and *where pulls are legible*, not how
  a pull resolves.
- **Engine boundary holds.** Change A is in the `build` flow package
  (`src/flows/build/**`); Change B is in the runtime (`src/runtime/run/graph-runner.ts`).
  Do not put build-specific logic in the engine — the corridor-skip lift is a
  general read-only-pull legibility fix, not build-specific.
- **Byte-stability where it should hold.** A run that surfaces no `context_request`
  must be behaviorally unchanged except for the (intended) `approach` prose change.
  Regenerate `generated-surfaces` / the plugin runtime bundle if the flow bytes move
  (`npm run check-flow-drift`), and treat any *other* flow's drift as a bug.

---

## 4. Verification (failing-test-first)

- **Change A:** update/extend `tests/runner/build-grounded-planning.test.ts` (the
  Frame→Analyze→Plan topology + plan assembly test) to assert the plan's `approach`
  **no longer contains the full observations synthesis** but still grounds the work,
  and that `observations` remains a typed field on the analyze report (pullable).
  Add/adjust a build report-writer test for the new `approach` shape.
- **Change B:** add a failing-test-first runtime case (mirror
  `tests/runner/context-pull-real.test.ts` / `context-delivery-real.test.ts`) that
  drives a **deep-depth** run with the slice loop active, surfaces a `context_request`
  from the head step, and asserts the pull is now **resolved-and-recorded** (a
  `run.context-pull` trace entry, or a delivery + retry when enabled) instead of
  silently dropped. Cover the resume re-thread (no double-count).
- **Re-run the battle-test** in the thinned regime and record the realized saving
  (the report's `runtime-binding-battle-test.test.ts` / the capture harnesses are
  experiments-only; use them to confirm the narrow slice is now the withheld one and
  the saving approaches ~11x). This is measurement, not a merge gate, but it is the
  proof the unlock worked.
- Full `npm run verify` green; focused proofs per AGENTS.md (flow-authoring change →
  `flow-facts` + catalog completeness + `check-flow-drift`; runtime change →
  runtime-context + runtime tests).

## 5. Definition of done / safe-to-merge

- `npm run verify` green (full canonical gate).
- Change A: the plan no longer pastes the full synthesis; the slice is pullable; the
  implementer hint points at it; build-planning tests updated and passing.
- Change B: head-step pulls inside an active corridor are resolved-and-recorded (and
  delivered when enabled), legible in the trace, fail-safe, resume-safe; new
  deep-depth test passing.
- A no-`context_request` run is behaviorally unchanged except the intended `approach`
  prose; no unintended flow-byte drift (`check-flow-drift` clean after regenerating
  the build flow's own surfaces).
- The battle-test re-run is recorded (a short note appended to
  `context-pull-last-mile-report.md` or a new `thin-envelope-run-report.md`) showing
  the realized saving in the thinned regime.
- `enableContextDelivery` default is **unchanged** (still OFF).

## 6. Open decisions (STOP-AND-REPORT if hit)

- **How thin is the pointer?** If removing the synthesis from `approach` measurably
  *hurts* the implementer when it does **not** pull (e.g. a worker without delivery
  enabled that also does not pull), that is a signal the pointer is too thin — report
  it rather than silently re-inlining. The goal is "pull or be pointed at it," not
  "starve."
- **Corridor resume re-thread subtlety.** If lifting the skip inside the slice loop
  interacts with the slice-scoped completion keys in a way the read-only assumption
  misses (it should not — pulls do not mutate — but verify with the deep-depth test),
  STOP and report; do not weaken the slice-corridor guards to force it.

---

## Hand-off prompt for Claude Code

Copy-paste the block below into Claude Code (run from the repo root,
`/Users/petepetrash/Code/circuit`).

```text
You are implementing a brief in the Circuit repo. Work from the repo root and stay
inside it.

1. Read docs/ideas/thin-build-envelope-brief.md in full, then AGENTS.md and the
   grounding files it cites: src/flows/build/writers/plan.ts,
   src/flows/build/reports.ts, src/flows/build/relay-hints.ts,
   src/flows/build/assembly-spec.ts, src/runtime/run/graph-runner.ts (the
   context-pull seam + the !sliceCorridor.isActive() skip),
   src/runtime/run/context-pull.ts, and context-pull-last-mile-report.md. Follow the
   repo rails: read before write, FAILING-TEST-FIRST, plain English with the
   operator, and enumerate 2-3 hypotheses before acting.

2. A branch/worktree feat/thin-envelope-unlock may already exist — check `git branch
   -a` and `git worktree list`. If it exists, continue on it; otherwise create
   feat/thin-envelope-unlock.

3. Implement Change A (thin the envelope: stop inlining the full observations
   synthesis into the plan's `approach`; keep a thin grounding pointer; point the
   implementer relay-hint at the pullable analyze-step.observations slice) and
   Change B (lift the corridor skip so head-step context-pulls inside an active
   slice loop are resolved-and-recorded, and delivered when enabled, fail-safe and
   resume-safe). Write the failing tests FIRST for both (§4).

4. Honor the rails in §3: do NOT flip enableContextDelivery to default-ON; do NOT
   change the pull mechanism / the Object.hasOwn fence / the budget; keep the engine
   boundary (build-package change vs runtime change). Regenerate the build flow's own
   generated surfaces if its bytes move and confirm `npm run check-flow-drift` is
   clean with no OTHER flow drifting.

5. Re-run the battle-test / capture harness in the thinned regime to confirm the
   narrow slice is now the withheld-and-pulled one and the saving approaches ~11x.
   Record it in a short run report (append to context-pull-last-mile-report.md or add
   docs/ideas/thin-envelope-run-report.md; if you add a doc, add its
   docs/ideas/catalog.json entry so `npm run check-ideas` stays green).

6. Run `npm run verify` (full) — it must be green.

Definition of "safe enough to merge" (all must hold):
  - npm run verify is green (full canonical gate).
  - Change A and Change B both implemented with their failing-tests-first now
    passing; the new deep-depth corridor-pull test passes.
  - A no-context_request run is behaviorally unchanged except the intended `approach`
    prose; check-flow-drift is clean (only the build flow's own surfaces moved, on
    purpose).
  - enableContextDelivery default is still OFF (git diff confirms).
  - The thinned-regime battle-test result is recorded.

Merge handling: when the above hold, commit with a conventional message (e.g.
"feat(context-pull): thin the Build envelope + lift the corridor skip"). If a GitHub
remote + gh CLI are available and the repo uses PRs (it does — history is "Merge pull
request #NNN from petekp/..."), open a PR, wait for CI green, then merge. Otherwise
no-ff merge the branch into main locally. Then update the docs/ideas/north-star-status.md
context row and the §4 "On-demand context pull" paragraph to reflect the thinned
regime + the realized saving, and report: branch, commits, verify result, the
measured saving, files changed, and any blocker.

If a §6 open decision trips (the thin pointer measurably starves a non-pulling
worker, or the corridor lift interacts badly with slice-scoped completion keys), or
any safety criterion fails, STOP and report instead of merging — do not weaken the
slice-corridor guards to force it.
```
