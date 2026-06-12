# Circuit usage: what two months of sessions actually show

> **Correction (2026-06-10, from Pete).** The one-line verdict below ("the
> flows are a relic") is confounded and should not be cited as evidence of
> flow non-demand. Pete used Circuit's flows roughly a hundred times for real
> building work in the prior form at `~/Code/circuit-v1` (git history
> 2026-03-29 to 2026-04-16). His flow usage fell when the rearchitecture
> began, which is exactly the window this census measured; the method note
> below says these commands have no traffic before May, so the corpus was
> structurally blind to the v1-era usage. The census measured a founder
> rebuilding his tool, not abandoning it. What still stands on its own
> evidence: the continuity findings (Finding 1 and the handoff-depth
> distribution), the entry-point observation in Finding 3, and the
> counter-evidence section. The open question the data cannot answer is
> v1-to-v2 transfer: whether v2's added rigor preserved the ease that made
> v1 habit-forming. Standing assumption going forward: Pete does use the
> flows.

Date: 2026-06-05. Method: mined ~4,600 Claude Code session transcripts
across all of Pete's projects (~1.3 GB). Macro counts and the manual-chain
and handoff-depth measurements were taken directly with grep/jq and are
reproducible from `/tmp/circuit-usage-analysis/`. A 59-session fan-out was
also attempted; it failed twice on an args-passing bug (the file list never
reached the workflow script), so its qualitative leads were corroborated by
hand before being used here. Every number below was measured directly.

## The one-line verdict

Pete already migrated, with his hands, from Circuit-as-capability (flows you
summon) to Circuit-as-continuity (a thread that gets saved and restored). The
flows are a relic. The continuity is the live wire. The rigorous build chain
he believes in does not happen by hand when Circuit is absent. It does not
move elsewhere. It just stops.

## The cold numbers

All projects, all time (roughly May–June 2026; these commands have no traffic
before May).

- Organic flow commands Pete typed himself (`build`, `explore`, `run`,
  `review`, `prototype`): about **22 events total**. Breakdown: 8 build,
  5 explore, 4 run, 3 review, 3 prototype, 0 pursue. They cluster
  **May 7–21**. After about May 20, organic flow usage in real feature work
  is essentially zero.
- `/circuit:handoff` (save/resume continuity): **138 events** (117 May,
  22 June). About **6x all flow commands combined**, and the single most-used
  Circuit surface by a wide margin.
- `/goal` + `/write-goal` (structured-intent declarations, served by Codex):
  **135 events across 81 sessions** (83 write-goal, 52 goal). Of those 81
  sessions, **0 routed the goal into a Circuit flow**.
- `bin/circuit run`: 1,743 calls, but ~469 are inside the Circuit dev repo
  and most of the rest are throwaway QA/surface-test dirs. Only ~18 are
  organic use in a real non-Circuit project.

Monthly, the three Circuit-adjacent surfaces side by side (invocations):

| Month | Circuit flows | Circuit handoff | Goal declarations |
|---|---|---|---|
| May 2026 | 18 | 116 | 108 |
| Jun 2026 | 7  | 31  | 23  |

Read across, not down. In both months the summon-a-flow surface is outvoted
roughly 6:1 by continuity and again 6:1 by structured-intent declarations.

## Finding 1 — The thread dies at the session boundary, nowhere else

Nothing drops Circuit mid-session. Circuit gets dropped because the only thing
that re-engages it is a typed slash command, and a running thread never types
one. So the thread dies at exactly one place: the session boundary.

Measured: across all 138 handoff sessions, the handoff lands at a **median
98%** session depth (mean 94%); **124 of 138 are in the final 5%** of the
session. Handoff is a pure end-of-session reflex. It is the manual prosthetic
Pete reaches for because nothing holds the thread for him.

The shape is invoke-once-then-fall-back. Fire a flow once (rarely), do N turns
of raw freeform work with no Circuit in the loop, then fire `/circuit:handoff`
to bridge to the next session. In Pete's words (session 77de5808): "I'll use
circuit build and then from that point there's not really any continuity. It's
so easy to fall back into not using it for the next turn. I don't want to have
to manually invoke circuit:run everytime I do something."

## Finding 2 — Planning is real, but it routes around Circuit (and the logs see it poorly)

Pete describes loving that old Circuit "automated the typical chain I'd use
while building features: align on the problem, build a plan, adversarially
review the plan, implement with TDD, adversarially review that."

An initial text-only count over 555 of his genuine in-session turns found the
chain almost absent: "make a plan" ~0, "write a test / TDD" ~0, "now
implement" ~0; only review/critique 13, redo 5, align 2, continue/resume 42.
That count was wrong to lean on, and Pete flagged why: it only saw typed text.
It was structurally blind to three planning channels:

- **Plan mode** (Shift+Tab) records as a `permissionMode` field or an
  `ExitPlanMode` tool call, not typed words.
- **grill-me / grill-with-docs** are skill invocations, filtered out of the
  "genuine turns" set.
- **"interview me" / "grill me"** free-text the regex did not cover.

Measured directly, the attributable planning channels are:

- `/goal` + `/write-goal`: **135 invocations / 81 sessions**. Heavy, reliable.
- grill-me: 9 sessions (mostly Circuit-dev or analysis artifacts; ~1–2 in real
  feature work). grill-with-docs: 3. Plan subagent (`subagent_type:Plan`): 1.
- Plan mode: 2 recorded sessions — almost certainly an undercount, because the
  marker is only written under specific conditions.
- Free-text "interview me / grill me": **not measurable**. The skill catalog
  injected into nearly every session contains the grill-me description, so a
  naive grep matched ~2,691 sessions of injected catalog text, not Pete.

So the honest read is not "rigor vanishes without Circuit." It is: the planning
Pete can be shown to do (`/goal`, heavy) routes entirely around Circuit, and
the planning he is most sure he does (plan mode, interactive grilling) is the
kind logs capture worst, so its volume cannot be confirmed or refuted from this
data. Either way, none of it flows through Circuit. The appetite is not in
question. The routing is. A second-order lesson sits here too: interactive,
modal, conversational planning is the least observable kind of work, precisely
because it is not shaped like a command. Any system that wants to react to
planning has to instrument the mode and the conversation, not just the
command log.

## Finding 3 — Circuit lost the structured-intent slot to Codex goals

Pete's appetite for "declare a durable objective, plan it, review it
adversarially" is large and steady: 135 goal declarations across 81 sessions.
None of them flowed into Circuit. The job Circuit's flows were built for is
being done, frequently, by a different tool, because that tool's entry point
feels closer to how Pete actually starts work.

## Q1 — The moments Pete wished something had kicked in

Ranked by leverage. Honest about which are robust vs thin. Quotes verified
against raw transcripts.

1. **Session-boundary resume (robust).** The dominant, highest-leverage
   moment. Handoff is an end-of-session action in 124/138 sessions. Verbatim:
   "let's pick things back up in a fresh session" (2bf1355e, and 10 sessions
   carry this phrasing). Trigger: session end / session start in the same
   project. Hook: a Stop/SessionEnd host hook that auto-persists flow position
   and in-flight intent, plus a SessionStart hook that silently rehydrates it.
2. **Check-then-fix after a code change (thin, 1 session, high value).** The
   cleanest single "I wished it kicked in" receipt: "if i use react-doctor,
   personally, i want to immediately address all findings. how would we do
   that with this system?" and "it'd be good to have hooks before and after a
   step" (30dd4193). Trigger: after an edit matching a glob (e.g. `.tsx`).
   Hook: an after:edit-file hook, report-only first, that runs the reviewer
   and surfaces findings.
3. **Mid-build slice resume (4 sessions).** Handoffs that name the next slice:
   "let's proceed with slice 3 in a new session" (22f2383f); "Let's spec slice
   1 in a new session" (3db1b184). Hook: carry the slice cursor (done / next /
   per-slice verify state) across the boundary and auto-resume.
4. **Deferred test or QA pass (5 sessions).** "in the next session i need you
   to do a thorough test of the Claude Code plugin using the
   circuit-surface-test skill" (76883f34). Hook: persist the entry skill and
   prior findings.
5. **Review-findings carry-over (3 sessions).** "let's address all findings in
   a new session" (e075a32e). Hook: persist findings as a structured worklist
   and auto-load it.

The biggest single bucket is a bare "continue" with no anchor: "let's continue
where we left off in a fresh session" (376b00fc), or bare `/circuit:handoff`
with no args (0c74642e). The layer must reconstruct the anchor itself, because
Pete often supplies nothing.

## Q2 — The smallest ambient version worth running

Ambient continuity: between turns and across sessions, Circuit silently keeps
the thread (what we are doing, what is decided, what is open) and restores it
on resume, with no command typed. This is the one surface Pete already votes
for 6:1 with his hands.

Concrete enough to build:

- A Stop/SessionEnd host hook writes current flow position plus in-flight
  intent to the project's continuity store. No `/circuit:handoff` needed.
- A SessionStart hook detects an unfinished thread in the same project and
  silently primes the new session with a grounded "here is where we were, here
  is the next step," derived from the last flow step, last edits, last open
  task.
- For the bare-"continue" case (the largest bucket), reconstruct the anchor
  from the thread itself, so it never depends on Pete's recall.

Firm constraint Pete set: the trigger must be rule-based, not model-chosen.
"I don't want the model to pick" (2bf1355e). Ambient firing is deterministic
rules over observable events (lifecycle, goal-set, glob-matched edits), with
the semantics in operator config.

## Honest counter-evidence

- Ambient structure would actively annoy Pete in fast iterative design. Session
  8032be99 is an entire session of manual UI tweaks by choice: "undo the button
  changes. just make the primary CTA bg 90% transparent by default and 100 on
  hover." A plan step, a review gate, or an after-edit reviewer there is pure
  friction. He accepts this: "some don't fit cleanly or would be confusing. i
  think that's totally fine" (30dd4193).
- "Good enough" base Claude genuinely wins for ordinary single-step work. His
  words: "you've gotten good enough, without any plugins or whatnot, that I
  typically don't need to use it. When I use it, it feels like it's against the
  grain somehow" (77de5808). "just vibe with me" appears verbatim across 7
  sessions.
- Implication: ambient firing must stay silent on low-stakes single-step edits.
  High bar to fire. Report-only by default. If in doubt, do nothing visible.

## What to build first

1. **Auto-continuity across the session boundary.** Stop/SessionEnd persist
   plus SessionStart rehydrate, same project, no command typed. This is the
   124/138 death point and the 6:1 hand-vote. Everything else funnels through
   it.
2. **Carry the slice cursor and findings ledger across that boundary.** Once #1
   exists, persist the structured state the resumes actually need (next slice +
   verify state; open findings as a worklist).
3. **One after-edit, glob-keyed, report-only loop.** react-doctor on `.tsx`
   edits, surface findings, offer to fix. Highest-value recurring "wished it
   kicked in" with a real ask behind it. Report-only so it never blocks a
   design loop.
4. **A silence gate.** Before anything fires visibly, gate on stakes: skip
   single-step, low-risk, fast-iteration edits. This is the guardrail that
   keeps ambient from becoming the next thing Pete abandons.

## Caveat on method

Trust tiers for this report:

- **Direct census, trust fully:** all macro counts (flows, handoff, goal,
  monthly table, `bin/circuit run` split) and the handoff-depth distribution.
  These grep the full ~4,583-file population.
- **Direct measurement, trust with stated limits:** the planning-channel counts
  in Finding 2. Reliable for command- and skill-shaped activity (`/goal`, grill
  skills, Plan subagent); blind to plan mode (conditionally logged) and
  free-text interview requests (polluted by injected skill-catalog text). The
  original text-only "manual chain ~0" framing was retracted for this reason.
- **Leads, not counts:** the Q1 archetype ranking. The 59-session structured
  fan-out failed twice (an args-passing bug left the file list empty), so no
  per-session frequency table exists. The archetypes were mined from raw
  transcripts by rescue agents and then corroborated by confirming each cited
  quote is real (5–10 hits apiece). Treat frequencies as approximate.

Two of the grep passes during this analysis produced inflated numbers from
catalog-injection and over-broad regex (a "grill me" text count of ~2,691
sessions; a loose Plan-subagent count of 261). Both were caught and discarded.
They are noted here as a reminder that log-mining inflates as easily as it
undercounts, and every load-bearing number above was re-checked against that.
