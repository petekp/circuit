# Long-horizon supervision — heartbeat course-correction and crow's-nest views

Scope note, 2026-07-11: this remains a future model-in-the-loop idea. Its
“supervisor” is a trajectory reviewer, not the deterministic local process
supervisor in [the CLI rebuild plan](cli-first-principles.md). Its heartbeat is
scheduled model work, not worker health or lease liveness. The CLI rebuild owns
those lifecycle contracts.

Idea for letting Circuit drive multi-hour, mostly-unattended runs the
way an operator would supervise a junior engineer: an executor agent
grinds on the work, a supervisor agent wakes up periodically to check
vision-fit and course-correct, and a separate "status board" surface
keeps a glanceable picture for the human to swing by and catch up on.
Captured 2026-05-07 from a tweet describing exactly this setup spliced
together by hand:

> "I have Codex CLI in goal mode implementing a problem that's
> basically like build this entire video game. It's 12 hours in.
> Claude is using a heartbeat loop to keep checking in with the
> high level vision and course correcting Codex through the message
> bus. Codex GUI is in 'crow's nest' mode, generating custom images
> of the code base with diagrams of current progress and blockers,
> so I can swing by and catch up quickly. If only these features
> were all available in one product.."

The "if only these features were all available in one product" is the
opening. Circuit already owns the flow-runner layer. The question
is whether long-horizon supervision is a shape Circuit should grow
into, or whether it's a different product.

## What's actually being described

Three roles, all running concurrently, each doing a different job:

1. **Executor.** A coding agent in goal mode — given a high-level
   target ("build this video game"), expected to drive for hours
   without operator input. Picks tasks, writes code, runs tests, makes
   architectural calls inside the goal.
2. **Supervisor.** A second agent that does *not* write code. Wakes
   up on a heartbeat (every N minutes, or on signal), reads what the
   executor has done since last check, compares it against the
   high-level vision, and either lets it ride or sends a
   course-correction message into the executor's input stream.
3. **Crow's nest.** A third surface that produces *human-glanceable*
   status — diagrams, progress maps, blocker lists. Not in the loop
   that decides what to do; just a window the operator opens when
   they swing by.

The shape works because each role has a different time horizon. The
executor lives in minutes (next change, next test). The supervisor
lives in tens of minutes (is the trajectory still right?). The crow's
nest lives in seconds, but only when the operator looks at it.

Circuit today collapses all three into one agent doing one flow
in one session. That's right for short bounded work and wrong for
long-horizon work.

## The shape that fits Circuit

Circuit's adapter / worker / stage model already has most of the
pieces. The missing pieces are the heartbeat and the visual surface.

**Executor = a long-running worker relay.** Circuit's `workers`
adapter already runs implement-review-converge loops. Extend it from
"one batch, then return" to "drive the goal until done or blocked."
The work-item granularity stays small (the worker still works in
review-able batches), but the outer loop runs in the background
across many batches without the operator sitting on it.

**Supervisor = a stage that runs on a clock, not on the executor's
turn.** This is the genuinely new piece. Today, every Circuit stage
fires when the previous stage finishes. A heartbeat stage fires on a
timer — every 10 / 30 / 60 minutes — independent of where the
executor is. The supervisor reads the run record and the latest
diff, asks "are we still pointed at the goal?", and if not, writes a
**correction note** the executor will read at the start of its next
batch.

The course-correction is the load-bearing detail. It is *not* the
supervisor barging in mid-batch. It's a queued message the executor
picks up at the next natural boundary (between batches in the
worker's loop). That keeps the executor's per-batch context clean
and avoids the supervisor and executor stomping on each other.

**Crow's nest = a separate read-only surface.** Circuit has
`active-run.md` as a passive runtime dashboard. The crow's nest is
the same idea, scaled up: instead of a text dashboard, a richer view
the operator can open. The tweet describes generated diagrams of the
codebase, but the cheaper v0 is structured prose: what's done, what's
in progress, what's blocked, with links into the run record. Diagrams
come later if the prose isn't dense enough.

The crow's nest is *not* in the decision loop. It does not influence
the executor or the supervisor. It only produces output the operator
reads. This separation matters — if the visualizer starts feeding
back into the loop, you have three agents arguing instead of two
working and one reporting.

## The three-clock pattern

Worth naming the underlying pattern, because it generalizes:

| Role        | Triggers on        | Reads     | Writes     |
| ----------- | ------------------ | --------- | ---------- |
| Executor    | task / batch       | task list | code, tests, run record |
| Supervisor  | wall-clock heartbeat | run record diffs | correction notes (consumed by executor) |
| Crow's nest | operator opens it (or its own clock for cached snapshots) | run record | human-only output |

Three independent clocks. The executor's clock is driven by work
finishing. The supervisor's clock is driven by time. The crow's
nest's clock is driven by the operator's attention.

Circuit's current model only has the first clock. The other two are
the real additions.

## Design constraints to get right

**Heartbeat cadence is per-run, not per-flow-type.** A 4-hour
Build doesn't want the same heartbeat as a 12-hour architecture change. Default
something sane (every 30 minutes?) and let the operator tune it per
run. Probably also wants a "max heartbeats per run" cap so a
runaway supervisor can't burn budget while unattended.

**Supervisor must be cheap and *narrow*.** The supervisor's job is
"is the trajectory still right?", not "review the diff line by
line." Give it a short, punchy prompt with the goal, the last
correction note, and a summary of what's changed since last check.
A long, exhaustive supervisor prompt run every 30 minutes for 12
hours is expensive *and* generates noise. The whole value of the
heartbeat is that it's lightweight.

**Course-correction notes are append-only and visible.** The
operator must be able to scroll the correction stream and see
exactly what the supervisor told the executor and when. No silent
nudges. This is also how the operator audits the supervisor when
they swing by — "did the supervisor steer us right at hour 6?" needs
to be a real question with a real answer in the record.

**Operator override beats supervisor.** If the operator joins
mid-run and corrects something themselves, the supervisor must
defer. Easiest implementation: operator messages go into the same
correction stream with a higher precedence flag, and the supervisor
reads that stream as input on its next heartbeat ("operator already
addressed this, no further note needed").

**Stop condition on the executor matters more than usual.** Today,
Circuit flows close at the end of a stage. A long-horizon
executor can't rely on stage boundaries — it needs a clear "goal
achieved" check, plus hard stops on (a) operator pause, (b) repeated
failures (worker can't converge after N attempts on the same item),
(c) supervisor escalation ("this is off the rails, stop"). Without
those, the executor will happily grind for 24 hours making the wrong
thing.

**Crow's nest output is cached and refreshed on its own clock.**
Generating it on every operator open is wasteful (the executor only
moves so fast) and slow. Generate it on a slower clock — say every
5–15 minutes, or on supervisor heartbeats — and serve a cached
snapshot when the operator opens it. The operator can manually
refresh if they want.

## Where this does *not* fit

**Short bounded work.** A 30-minute Repair does not want a
heartbeat supervisor. The operator sitting at the keyboard is a
cheaper, better supervisor for that horizon. This pattern only earns
its complexity when the operator is *not* there.

**Replacing review.** The supervisor is not the Reviewer. Review
runs once at Close with full context and the explicit job of
verdict-issuing. The supervisor runs many times during the run with
narrow context and the explicit job of trajectory-checking. They
overlap conceptually but not in scope.

**Replacing operator presence on hard calls.** The supervisor
should not make architecture decisions the operator would want to
weigh in on. When something genuinely uncertain comes up, the
correct supervisor action is "stop the executor and surface this to
the operator," not "decide on the operator's behalf." This is the
same `governance` rule from `MEMORY.md` — operator owns product
direction — applied to a long-horizon setting.

**Multi-executor parallelism.** The tweet describes one executor.
Two executors with one supervisor is plausible eventually but wildly
more complex (the supervisor has to reason about cross-executor
conflicts; the message bus needs routing). Park it. Get the
single-executor case clean first.

## Honest tradeoff

This adds a lot of surface area for a use case Circuit's current
operator (you, on Circuit itself) doesn't have. You stay close
to your work; you don't run 12-hour unattended sessions. So today
this idea solves a problem you don't currently have.

Two reasons it might still be worth thinking about:

1. **Marketplace fit.** "Circuit can run unattended for long stretches with a
   supervisor that course-corrects and a status board you check in
   the morning" is a clean external value prop. Other flow
   runners don't have this; the tweet suggests there's real demand
   and people are duct-taping it together by hand.
2. **It's a generalization of patterns Circuit already has.** The
   supervisor is a stage that runs on a different clock. The crow's
   nest is `active-run.md` with a richer renderer. Neither is a
   foreign concept; they're extensions of the existing model.

The honest counter-argument: **building this before any operator
asks for it is exactly the trap to avoid.** Circuit's recent
methodology strip cut a lot of speculative scaffolding. This idea
should sit in `docs/ideas/` and stay there until either (a) you
personally hit a long-horizon use case where you wish you had this,
or (b) someone in the marketplace says "I want to run Circuit unattended
for long stretches." Until then, the schematic-pattern path — operator stitches
together a supervisor by hand using existing tools — is the right
level of investment.

## What to prototype (when the time comes)

The cheapest experiment that proves the shape, not the full system.

**Step 1 — heartbeat stage, no supervisor logic yet.** Add a stage
type that fires on a timer. Wire it into one flow. Have it do
nothing but log "heartbeat fired at T+30m." Confirms the clock-driven
stage shape works inside the existing engine without breaking
turn-driven stages.

**Step 2 — supervisor reads run record, writes correction notes.**
Add a real supervisor prompt. Inputs: goal, last correction note,
diff since last heartbeat. Output: either "no note" or "correction:
\<text\>". The note goes into a queue the executor reads at the start
of its next batch. Test with a deliberately drifting executor to
confirm correction lands.

**Step 3 — long-running executor.** Extend the worker adapter to
drive a goal across many batches without returning to the operator.
Add the stop conditions (goal-met check, repeated-failure cap,
supervisor escalation). Run the same drift test end-to-end.

**Step 4 — crow's nest, prose first.** A separate stage that runs
on its own slow clock, reads the run record, and produces a
structured human-readable status snapshot. No diagrams. Test by
having the operator (you) actually use it — does the snapshot
answer "what's happening?" without making you read the full record?

**Step 5 — crow's nest, diagrams.** Only after step 4 proves the
prose snapshot is useful. Diagrams are cheap to generate (any
markdown-to-mermaid pipeline) but their value depends on the
underlying status data being right. Get the data right first.

Steps 1–3 prove the supervision loop. Steps 4–5 prove the
visualization surface. They're independent — either pair could ship
first if demand pulls one direction.

## Open questions

- Where does the correction-note queue live? Run record (visible,
  durable, slow) vs a sidecar file the worker polls (fast, less
  visible)? Probably the run record — visibility wins.
- Should the supervisor run on the same model as the executor, or a
  cheaper / different one? Cheaper makes sense (the heartbeat is
  narrow); different model might catch blind spots the executor's
  model has. Worth A/B-testing once the shape is real.
- What's the operator-pause UX? A signal file the supervisor reads?
  A specific slash command? Something more explicit? The "I'm here
  now, hands off" handoff between operator-supervised and
  agent-supervised needs a concrete shape.
- Does the supervisor need write access to anything beyond the
  correction queue? E.g. should it be able to edit the goal itself
  if it learns the goal was wrong? Probably no — that's an operator
  call — but worth deciding explicitly rather than by omission.
- How does this compose with continuity / handoff across session
  boundaries? Long-horizon runs naturally cross sessions. The
  supervisor and executor both need to resume from continuity, not
  from scratch, when the operator's session boundary triggers a
  recompaction.
- Does the crow's nest belong as a Circuit stage, or as an external
  read-only viewer that points at the run record? External is
  simpler and decouples the visualizer from the engine; in-engine
  gets first-class scheduling. Probably external.
- Is the supervisor a stage, a flow, or something new? Stages
  are turn-driven today; this is the first clock-driven one. Worth
  naming the new concept explicitly rather than overloading "stage."
