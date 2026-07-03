# V1 announcement draft

Status: draft for Pete's redline. Not published anywhere. Written 2026-07-02
against [v1-launch-plan.md](v1-launch-plan.md) (framing ladder) and
[positioning.md](../positioning.md) (claim boundaries). Every line traces to a
registered claim or the honest-boundary section; nothing here needs a new
claim except the optional receipts post, which is explicitly gated below.

Style rules applied: one enemy (the improvised chat-shaped workflow), no em
dashes, mechanism shown not asserted, costs stated before the reader spends,
"it can't skip the proof" not "it can't fake done", loop language engine-level
only (no public converge command implied).

---

## Primary post (X)

> You don't have an agent problem. You have a process problem.
>
> Every session you re-teach your agent how you want work done: how to scope,
> what to check, when to stop. It follows along, mostly. Then it skips the
> step that mattered.
>
> I built Circuit to write the process down once and make it actually run.
> Flows with typed steps, checks the model can't talk its way past, and one
> dial that puts the expensive model only where judgment lives.
>
> Free, MIT, plugin for Claude Code and Codex → circuit.land

Alternate lead (if the masthead stays "antidote"): swap the first two lines
for "Your workflow is ad-hoc and improvised. You can feel it: every session
re-explains the same process, and the agent still skips steps." The rest is
unchanged. Pick whichever line the landing masthead shows on announcement
day so the post and the page say the same thing.

## Thread (follow-up posts, in order)

**2 / What a flow is.**
A flow is your process, written down: frame, plan, act, verify, review. Each
step runs in a fresh context with only what it needs, so a long session can't
rot the steps that come after. The same task runs the same way every time.

**3 / The floor.**
The step that says "done" doesn't get to decide. The engine checks that the
required evidence exists and the proof commands actually passed before a run
can advance or close. A run that gives up or runs out of tries reports
not-done. Honest failure is a result, not an embarrassment to paper over.

**4 / The dial.**
One power dial allocates models by role, per step. Turn it down and the step
that edits code drops to a cheap model while the research that steers the run
stays on the top tier. The reading that steers the run is the wrong place to
save. After the run, a receipt shows what each role spent.

**5 / Zero-cost first look.**
`circuit preview build --matrix` prints the whole allocation, every step,
every dial position, before anything runs. It costs nothing. There's a live
version of this readout on the landing page; turn the dial yourself.

**6 / The loop.**
Some work isn't one pass. A flow can re-run its body until its checks prove
the work done, inside hard ceilings on tries, budget, and progress. And if the body
edits its own verification command, a guard latches. It cannot green its own
test.

**7 / Where it's not worth it.**
Honestly: a process you run twice a month, or one that changes every week, is
better served by a rules file. Circuit pays off on processes you repeat,
where skipping a step has a real cost. And runs cost real money: a small task
is several minutes and a few dollars at the default dials. Review is
read-only and the safest first run. Preview is free.

**8 / Get started.**
Six flows ship today: Review, Fix, Build, Explore, Prototype, Pursue. Install
is one command in Claude Code or Codex. Docs, the dial demo, and the honest
boundary are all at circuit.land.

## Show HN

**Title:** Show HN: Circuit – encode the process your coding agent follows

**Body:**

I kept re-teaching my coding agent the same process every session: how to
scope a change, what to verify, when to stop and ask. Instructions files help
the agent know what I want. Nothing in them makes the steps actually happen.

Circuit is a plugin for Claude Code and Codex that runs work as flows: typed
steps, each in its own fresh context with a role (researcher, implementer,
reviewer), a tool scope, and a mechanical check. The check is run by the
engine, not the model: a step's output is parsed against a schema and its
proof commands have to pass before the run advances. A run that exhausts its
tries reports not-done instead of laundering into done.

The part people ask about first is the model economics. One power dial
allocates models by role, per step: at low power the implementer drops to a
cheap model while the researcher stays on the top tier, because the reading
that steers the run is the wrong place to save. `circuit preview <flow>
--matrix` prints the full allocation across dial positions without spawning
anything, and after a run the receipt shows spend per role.

Where it's not worth it: hand-authoring a flow takes real time, so a process
you rarely run or change weekly is better served by a rules file. Circuit
earns its keep on processes you repeat where skipping a step is expensive.
Runs cost real money (a small task: several minutes, a few dollars at default
dials; a low-power dial spends less; preview is free; the read-only Review
flow is the safest first run).

Six flows ship today (Review, Fix, Build, Explore, Prototype, Pursue). MIT.
I'd especially value feedback on the flow-authoring cost, which is the
honest weak point, and on the dial defaults.

https://circuit.land

---

## Appendix A: optional receipts post (GATED, do not publish yet)

A post citing the eval numbers (objective fix rate 8/14 vs 5/14 vanilla,
false "fixed" claims 2/14 vs 9/14, at roughly 13x the per-task cost) would be
the strongest single post in the thread. It is currently OUTSIDE
positioning.md, and the rule is claims live there first. To unblock it, add
an evals entry to positioning.md citing `evals/ledger/` as the mechanism,
with the honest nuance attached (14 held-out tasks, one model pair, one flow;
cost measured and stated, not hidden). Pete edits positioning.md, not the
assistant. If the entry doesn't land before announce, publish without this
post; the mechanism story stands on its own.

## Appendix B: sequencing checklist for announcement day

1. **Masthead first.** If the lead post opens "You don't have an agent
   problem, you have a process problem," the landing masthead should carry
   the matching frame before the post goes out (the locked-but-unapplied
   "Stop repeating yourself." swap, or keep "antidote" and use the alternate
   lead). Post and page must not disagree on day one.
2. **Pursue must be settled** (launch-plan blocker 4). The thread and the
   Show HN body name six flows. If pursue is demoted instead of proven, the
   roster changes in the post, the landing page, the docs, and the install
   prompt. Recommendation: prove it (contract doc + release proof run) rather
   than demote; proving is additive, demoting ripples through every public
   surface days before announce.
3. **Until-loop docs page** should be live before the loop post (post 6)
   points thousands of readers at a landing card with no docs behind it. In
   flight as a separate session as of 2026-07-02.
4. **First-run path** (launch-plan blocker 6): the quickstart already carries
   cost candor and the zero-cost preview hook. The remaining gap is the
   purpose-built five-minute demo run. Smallest honest version: a pinned
   "known-shape first task" recipe in the quickstart. Decide whether that
   ships before announce or is consciously waived; the announcement copy
   above does not promise it either way.
