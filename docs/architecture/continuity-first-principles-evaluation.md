# Continuity: a first-principles re-evaluation

Date: 2026-06-07
Status: evaluation only. No code or production-doc changes were made. Acting on
the recommendation is a separate, follow-on effort.

## The question

We have shipped several changes to the continuity system in quick succession
(PR #43 ambient harvest, PR #44 restore improvements, PR #45/#46 staleness
facts). The worry that prompted this review: are we applying patches upon
patches to something that is fundamentally flawed?

## The short answer

No, the foundation is not fundamentally flawed. A rip-and-replace would be the
wrong move and the evidence does not support it.

But the worry is half right, and the right half matters. Every fix so far has
landed on the restore side, where the thing that is actually broken cannot be
seen. The real defect lives on the capture side, in the shape of the record we
write. Until that is fixed once, properly, more restore-side patches will keep
circling the same un-fixed root and keep failing in the same way.

So the verdict is **sound foundation, with weaknesses that are larger and more
connected than a single missing feature**. The recommendation is a focused
refactor of the capture path, not a redesign of the system, and it should be
checked with a small probe before we commit to it.

## What continuity is actually for (first principles)

Before judging the code, three independent analyses reconstructed the job a
continuity system must do, without looking at how Circuit currently does it.
They converged on one framing:

> Continuity is **keeping the picture honest from one session to the next, not
> note-taking.** The unit that must survive is the project, not the session.
> Every saved claim is a guess about the present until it is checked against the
> live repo, and the system must never turn a stale guess into an instruction.

That job has two halves that both have to work:

- **Transport.** Do not drop forward intent, decisions, and the physical
  stopping point across the boundary.
- **Truth.** Describe the world as it is now, not as it was at capture.

From that, eight requirements are essential (their violation means the system
has failed at its core job, independent of any implementation):

- **R1 Reconcile before presenting.** On resume, check every carried claim
  against cheap live ground truth (branch, HEAD, diff, file existence, test or
  build state, PR status) before presenting it as actionable. Ground truth wins
  on conflict. Reconciliation is read-only with respect to the repo.
- **R2 Never resurrect dead work.** Never present a finished task, merged
  branch, satisfied objective, or settled decision as still-open, and never
  present voided intent (deleted target, abandoned approach, reverted change) as
  actionable.
- **R3 Capture at every boundary, automatically.** Fire at normal end,
  context-window compaction, and idle, without depending on the operator or a
  still-coherent agent to remember.
- **R4 One concrete next move.** Answer "what is the next correct action" as
  exactly one resumable step against the current state, not a backlog or menu.
- **R5 Report-only at the action boundary.** Orient the operator and a fresh
  agent; do not autonomously execute carried intent or declare work done on the
  record's authority.
- **R6 Closure propagates.** When work finishes or a decision is settled, the
  active resume pointer is retired so the next resume cannot present it as open.
- **R7 Bound to verifiable identity.** Each record is tied to a workspace,
  project, and branch derived from explicit ground truth, never from ambient
  assumptions like the process working directory.
- **R8 Honest absence.** When the record cannot be trusted (too stale, diverged,
  or absent), say so and fall through to a safe default rather than fabricating
  continuity.

Seven more requirements are good to have but not essential. They are listed here
once for completeness; only the first is referred to again later.

- Mark each carried claim with how sure we are it is still true (R9).
- Store pointers to the truth, not frozen copies of it.
- Pair each intent with what changed in the world since.
- Keep the surface skimmable.
- Carry the why, not just the what.
- Converge on one next pointer, not many.
- Make ambient capture cheap.

## The verdict

| | |
|---|---|
| Verdict | Sound foundation, with weaknesses |
| Confidence | High |
| Recommendation | Focused capture-path refactor, tested with a small probe first. Not a redesign. Not a one-line patch. |
| Fundamentally flawed? | No |

### What to do next, in plain English

If you read nothing else, this is the decision:

- **Do not rip it out and start over.** The foundation is sound. A rebuild would
  throw away work that is correct.
- **Run one small, read-only test first.** It checks the single risky idea the
  whole fix depends on: that the system can reliably tell "already answered" from
  "still open" by reading its own replies. Lowest cost, decides everything else.
- **If that test passes, fix the capture side once.** That is where the real
  problem lives. Today the system grabs your last message as the goal and has no
  way to notice the same session already handled it.
- **Separately, fix the one confirmed bug.** When you mark work done and clear
  it, the very next turn quietly brings it back. This is real, has a clear repro,
  and can go first because it does not depend on the test above.
- **Leave the safety machinery alone.** The part that checks git before trusting
  the saved note is good. Keep it.

The rest of this document is the evidence and the engineering detail behind those
five points.

The clean-slate test is the clearest way to see why. If we designed continuity
today from the job above, the core would have four parts. Here is how the
current implementation scores against each, after correcting an initial
over-count that the adversarial review caught.

### Scorecard: two sound, one weak, one missing

**Part 1, capture trigger. Sound in shape, one firing point missing.** Harvest
is wired to both `Stop` and `SessionEnd` (`plugins/claude/hooks/hooks.json:14-33`).
It reads identity from the host's stdin, not `process.cwd()`. It swallows all
errors so it can never break the session. An incremental cursor keeps the
per-turn cost proportional to the new tail. The shape is right and would carry
into a clean-slate redesign. The one gap is coverage, not design: it fires on
turn end and session end but not on compaction, which Step 4 adds as one more
firing point (see Gap 2). What it captures is the weaker part, covered next.

**Part 2, record shape. Weak.** This is the correction. The record has no
place to record whether an intent is still open. `ContinuityNarrative` is four
prose strings (`goal`, `next`, `state_markdown`, `debt_markdown`), all required,
strict, with no status field (`src/schemas/continuity.ts:28-36`). Three
consequences follow, each a requirement missed at the model layer:

- `next` is a hardcoded constant on every ambient record
  (`src/cli/handoff.ts:2466`). R4's primary deliverable, the single concrete
  next move, carries zero per-record content on the highest-volume path. The
  record cannot derive a next step, only echo the last ask.
- There is no per-claim verification status (R9). The job is named
  truth-maintenance, and this is exactly the dimension the record omits.
- The one genuine run-state signal the schema does carry,
  `run_ref.runtime_status`, is never read by the brief renderer. It is a six-value
  status (`in_progress`, `complete`, `aborted`, `handoff`, `stopped`, `escalated`,
  `src/schemas/snapshot.ts:21-28`), so it can already tell a finished run from a
  live one. The ambient brief composer branches only on the record kind, and
  neither it nor the manual-brief composer reads the run status
  (`composeHandoffBrief`, `src/cli/handoff.ts:296-312`; `composeBriefFor`,
  `448-458`). The result: a record from a run that already finished is shown at
  resume the same way as a live one. The status is read only at save time, into a
  separate active-run file (`writeActiveRun`, `1574`), never into the brief. The
  record has three kinds, but the renderer treats them almost the same, so the
  extra kinds buy little.

**Part 3, restore contract. Sound on safety, but its rendering is part of the
defect.** The safety spine is genuinely strong and defeats the classic failure
modes. The git probe fails soft, omitting any fact it cannot read and collapsing
the whole probe to `{}` on any throw (`src/cli/handoff.ts:2350-2352`). The
"unchanged" result requires an explicit `head_advanced === false`. A cross-repo
guard gates the probe to the same tree, so project A never bleeds into B
(`673-674`, satisfying R7). Absence is reported honestly rather than invented
(R8). A report-only boundary clause forbids resuming unasked (R5). Keep all of
this. The caveat is in the next section: the same probe that is the safety spine
also renders the false-liveness line that turns the capture gap into a confident
but wrong "this is live" signal, caught only by the standing report-only
boundary.

**Part 4, satisfaction model. Missing.** There is no mechanism that
distinguishes "still open" from "already done." This is the center of the job
and it is absent.

So it is two parts sound, one weak (record shape), and one missing (satisfaction
model), and the weak and missing ones are the two the job names as its core. That
is a sound foundation with a real hole in the middle, not a rotten foundation.

One clarification on counting Part 3 as sound. "Part 3 sound" means the safety
mechanism survives (the soft-fail probe, the cross-repo guard, the honest
absence, the boundary clause), not that every line Part 3 prints reads correctly
today. The same part renders two lines that the ledger below tracks separately,
because they are different kinds of thing. One is a compensating patch: the
"check whether it landed" nudge. The other is a true git fact that only reads
wrong because of the upstream goal defect: the "unchanged" line. The two fire
under opposite conditions and never appear together. The "unchanged" line fires
when the repo has not moved since capture; once the capture side can tell open
from done, it stops reading as a false liveness claim, because it then sits next
to genuinely live work. The nudge fires on the other case, when the repo has
moved since capture (possibly in a later session), and asks the agent to check
whether those later commits already landed the work. The same-session capture fix
does not see that case, so the nudge is not retired. It is refined. The deeper fix
for it is the restore-side reconciliation (R1: check each carried claim against
live git before presenting it), not the capture-side classifier.

## The root cause: the capture side is blind to fulfilment

The defect has one root. The capture path treats the last thing the user said as
the project's current goal, and it has no way to know that the same session
already answered it.

Confirmed in source:

- The transcript parser skips every non-user turn:
  `if (entry.type !== 'user') continue` (`src/cli/handoff.ts:1954`). The
  assistant turns, which are the only evidence that an intent was answered, are
  discarded at the door.
- `ParsedTranscript` is `{ intents, summary }` with no slot for open versus
  satisfied (`src/cli/handoff.ts:1860-1863`).
- The goal is literally the last intent: `goal = intents[last] ?? fallback`,
  with no fulfilment check (`src/cli/handoff.ts:2449-2452`).
- The restore-time staleness probe is given only the captured head and branch;
  intent text is excluded by construction (`BriefGitProbe`, `97-101`, invoked at
  `673-680`), so it cannot reason about whether the ask was already done.

This is why the recency heuristic is biased toward resurrecting finished work.
The freshest user turn is also the one most likely to have just been answered.
The system's single most prominent output, the headline goal, is therefore
structurally tilted toward replaying done work.

We saw this live this session: a request that had already been merged was
restored as the live goal, next to "Repo unchanged since capture." The only
thing that stopped a re-do was the boundary note telling the agent to confirm
first, plus the agent bothering to run `git log`.

## Why this is a misleading liveness signal, not just stale notes

This is the second correction from the review, and it raises the severity, but
with one important qualification.

The defect is not that restore passively fails to catch a stale intent. It is
that the restore path we call the strongest piece of the system prints a
confident statement that the carried work is live, when it is already done.

Here is how that happens. Say a request was answered earlier in the same
session, the working tree is clean, and there are no new commits. To the restore
check, the repo looks untouched since capture, so it prints the affirmative line
"Repo unchanged since capture." A comment in that code states the intent plainly:
"the resume point is live" (`src/cli/handoff.ts:345-368`).

So on the most common ambient path, with an already-answered last intent, the
system prints a confident liveness claim beside work that is already done, and
the line that says so comes from the very probe that is otherwise the safety
spine. The two parts are coupled: the strong restore probe amplifies the weak
capture record into a false-liveness signal. You cannot call the capture gap
isolated to one part when its most visible symptom is generated by another.

The qualification: this is degraded-but-guarded, not unguarded false
instruction. The default boundary clause ("confirm the current goal with the
user before acting on it, and do not resume this work unasked") is appended to
every ambient brief, unchanged case included (`src/cli/handoff.ts:314-315`,
fired at `427-430`). So the wrong liveness line never stands alone as an
instruction to act. What is broken is that the only thing catching the false
signal is the report-only boundary plus the agent bothering to check, not the
record being correct. That is still a real severity increase over passive stale
notes. The system emits a false-liveness signal instead of staying silent. But it
is a misleading signal behind a standing guard, not a direct order to redo
finished work. We saw exactly this play out this session: the boundary clause and a manual
`git log` were what stopped the re-do.

## Three essential gaps, plus one concrete bug

The original framing called this "one missing part." The review showed it is
three essential requirements, plus a separate, verified defect.

**Gap 1, satisfied work resurfaces (R2, never resurrect dead work). Confirmed,
high severity.** The blind-replay defect above. Root: no fulfilment dimension in
the record, no assistant-turn reading at capture.

**Gap 2, no capture on compaction (R3, capture at every boundary). Confirmed,
medium severity.** There is no `PreCompact` hook anywhere (a grep over
`plugins/` and `src/` returns zero). Harvest fires only on `stop` and
`session-end` (`harvest.ts:66`). Compaction is handled only on the restore side,
and it relies on a prior `Stop` having already harvested. R3 names compaction
explicitly, so a fix scoped only to the satisfaction part would ship with a
second essential boundary uncovered. The earlier verdict marked the `PreCompact`
hook "optional," which is wrong for an essential requirement.

**Gap 3, finished work resurfaces (R6, closure propagates). Confirmed, medium
severity.** `done` keeps the
ambient record by default; only `--clear-ambient` drops it
(`src/cli/handoff.ts:1771`). So the just-finished request resurfaces on the next
restore for the automatic layer, even though closure is honored for the manual
layer.

Gap 3 and the bug below are the same closure root (R6) seen at two tiers, not two
independent problems: Gap 3 is the default-keep behavior, and the bug is that
even the explicit opt-out (`--clear-ambient`) does not stick. Both are fixed by
one durable closure marker (a "tombstone") in Step 3; they are listed separately because
the bug is a verified, repro-able defect with its own severity, while Gap 3 is
the design-level requirement it sits under.

**The bug: `done --clear-ambient` is reverted within one turn. Confirmed by
direct trace, high severity.** This is the most actionable finding and it is a
genuine defect, independent of the framing debate.

1. The `Stop` hook has no matcher (`plugins/claude/hooks/hooks.json:14-23`), so
   `harvest.ts` runs at the end of every turn, not just at session end.
2. `done --clear-ambient` calls `removeAllAmbientRecords`, which deletes the
   record files and the cursor files (`src/cli/handoff.ts:2189-2196`), then
   writes an index with no ambient pointer (`1771-1779`).
3. The next `Stop` re-runs `harvestAmbientContinuity`. Because the cursor was
   just deleted, it does a full re-read of the still-live transcript, rebuilds
   an ambient record from the just-finished work, and re-points the index
   (`2432`, `2454-2516`). There is no tombstone, no "this session was
   deliberately closed" marker, and the only skip conditions are no-transcript,
   unreadable, and nothing-to-harvest (`2421-2446`), none of which apply.

The documented promise that `--clear-ambient` wipes the snapshot "so finished
work does not resurface at the next session" (`plugins/claude/commands/handoff.md`)
is therefore broken by the very next harvest. This earns an unqualified high. The
recency gap above was only degraded-but-guarded. This one silently breaks an
explicit operator instruction: you asked it to clear, and it un-cleared itself.
That is worse than a wrong liveness line. Honoring an explicit closure needs a
durable tombstone written by `clearContinuity` (the function `done` actually
runs, `src/cli/handoff.ts:2691`) and honored by `harvestAmbientContinuity`. That
is a different missing piece from the satisfaction part, and the capture-side
fulfilment tag does not fix it. Step 3 works out the tombstone's scope, because
the clear is repo-wide while the work it must keep buried is per-session. On test
coverage: the clear and harvest paths have CLI integration tests in
`tests/runner/handoff-harvest.test.ts` (`handoff done` at 1605-1610,
`done --clear-ambient` at 1620-1630). But the resurrection sequence has no test: a
`--clear-ambient` followed by the next-turn harvest that re-creates the record.

## Is it "patches upon patches on a flawed core"?

Half right, and worth stating precisely because it changes what we do next.

The accretion is real and it does point at one root. Git forensics confirm the
subsystem is about one day old (born in commit `293ece89`). Since then, four
follow-up commits across three PRs (#44, #45, #46) have touched `handoff.ts`. The
capture-side selector `goal = intents[last]` has not been modified since its
birth. One follow-up (`2fd64470`, PR #44) deleted an adjacent line in the same
region, but left the selector logic untouched, and the schema has not changed at
all. So zero follow-ups touched the deep capture root: the line that picks the
goal.

The design note for the staleness work flags a sibling capture-side lever it
calls "harvest-side intent quality"
(`docs/ideas/continuity-staleness-check.md:180-193`). That is a related but
shallower defect: junk text leaking into the headline intent (the note's example
is the `write-goal` skill body landing as the "Latest request"), not the deeper
inability to tell an answered intent from an open one that this evaluation argues
is the root. The note does not defer that lever. It says to fix it "first or
alongside" the staleness work and warns that staleness taken alone is "a local
optimum." One of the four follow-ups did exactly that: commit `40e4c8d9` (Slice 0
of the staleness spec) extended the harvest parser's drop filter to stop the
skill-body leak. So one follow-up landed on the capture side and fixed the
shallow lever; the other three landed on the restore or render side; and none
touched the deep root, the selector. The fulfilment-blindness defect this
evaluation argues is central is still there.

But this is the healthy form of accretion so far, not decay. It is a young
feature whose follow-ups fixed the shallow capture-side lever and matured the
restore-side safety, while the deep capture-side root (flagged in the design
note's own words) keeps waiting. The largest follow-up (PR #44) is a clean,
unrelated improvement. One earlier false git fact was caught and corrected inside
the same PR by the review loop within twenty minutes, which is a working process,
not cruft.

So the honest reading is: the core they are circling is sound, and the part they
keep routing around is the deep capture-side root the design note itself flagged,
not a foundation flaw. The danger is not the past patches. It is the future ones. The
restore side, by construction, cannot see whether the ask was already answered.
Every additional restore-side mitigation (the "check whether it landed" nudge,
`--clear-ambient`, the staleness proxy) is compensating for information that
never reaches it. That mismatch between where the weakness lives (capture) and
where the patches land (restore) is the real signal in the operator's worry. The
fix is to stop patching the restore side and fix the capture side once.

## Keep versus compensating: the ledger

Keep (coherent, would survive a clean-slate redesign):

- Auto-harvest on `Stop` plus `SessionEnd`, identity from hook stdin, errors
  swallowed.
- Incremental harvest cursor with a head fingerprint that forces a full re-read
  on shrink, rotate, or compaction. The cursor design is sound and stays; Step 1
  changes the fields it stores, not its role (see migration cost).
- Restore precedence pending then ambient then empty, with honest fall-through.
- Soft-fail git probe and its "unchanged" gate, which requires an explicit signal
  before "unchanged" is even computed (the gate, not the printed line; the line
  itself is tracked separately below, as a true fact that is misread rather than a
  patch).
- Cross-repo guard gating the probe to the same tree.
- The fact-versus-render split for branch gone versus merged.

Compensating (a patch standing in for a missing model capability):

- `goal = intents[last]` with no fulfilment check; parser skips assistant turns.
  The root design flaw.
- A hardcoded constant `next` on every ambient record.
- The "check whether it landed" render-time nudge, which fires when the repo
  moved after capture and asks the agent to do the correlation the system declined
  to compute. The same-session capture fix does not cover this diverged case, so
  this nudge is refined rather than retired (see the recommendation).
- `--clear-ambient` as the only way to stop finished work resurfacing, standing
  in for a record-level done marker the model lacks.
- A frozen git-status snapshot stored in the record's state text, not
  re-checked at restore (low severity; the facts that matter, like the branch and
  the commit, are re-checked).

Two more items, of a different kind. Neither is a patch, so neither belongs on
the compensating list, but the fix changes the context they sit in.

- The "Repo unchanged since capture." render line (`src/cli/handoff.ts:366-368`)
  is a true git fact, not a patch. It reads as a confident liveness claim only
  because it prints beside an already-satisfied goal. The fix is upstream: once
  the capture side can tell open from done, the line prints next to genuinely live
  work and stops misleading. The line is kept, not removed; the lie was in the
  goal, not in this line. The soft-fail probe that produces it stays (it is on the
  Keep list above as a mechanism).
- A feature that already exists and is never used: the record carries a real "this
  run finished" signal (`run_ref.runtime_status`), read when the record is saved
  but never read by the part that builds the resume brief
  (`src/cli/handoff.ts:296-312`, `448-458`). Step 2 turns it on rather than
  replacing it.

## Recommendation

Do a focused, additive refactor of the capture path. Do not redesign the
foundation. Do not pretend it is a one-line change. Sequence it so the riskiest
assumption is tested first.

**Step 0, test the riskiest idea first.** The whole approach rests on one unproven
assumption: that reading the assistant's own turns lets us classify an intent as
satisfied more reliably than plain recency. Before changing any selection logic,
run a read-only probe over a corpus of real multi-turn transcripts (not the
short title-stub files that dominate a naive scan) and measure classification
accuracy against the recency baseline. If it does not clearly beat recency, do not
ship the capture-side classifier. The foundation verdict does not depend on this
probe: the safety spine stands either way, so "sound foundation, focused refactor"
still holds. The fallback is the restore-side reconciliation named below (R1):
check each carried claim against live git at restore, which catches a stale goal
without having to classify it at capture. This is the single genuine risk in the
plan, and it has a defined exit.

**Step 1, satisfaction model (R2, never resurrect dead work).** Extend the parser to read the assistant's
own replies, not just the user's requests, using the per-turn data already in the
transcript (when each turn happened and how turns link to each other). Add one new
field: a per-request status of open, likely-done, or cannot-tell, defaulting to
cannot-tell when unsure (this also tags each claim with how sure we are, R9).
Change goal selection from "the
last request" to "the most recent still-open request," falling back to the last
request marked cannot-tell. Derive the next step from that open request instead of
a fixed constant. One caveat: the incremental harvest cursor today stores only
collapsed intent strings and a summary (`HarvestCursor`,
`src/cli/handoff.ts:1974-1980`), with no assistant turns and no per-turn linkage.
A request captured in an earlier harvest is, by the time its answering reply
arrives in a later tail, just a bare string the cursor cannot attach a reply to.
So Step 1 either carries per-request status in the cursor across harvests or forces
a full re-read each time. Either way the cursor's stored fields change; it is not
untouched (see migration cost).

**Step 2, two render wins.** Read `run_ref.runtime_status` in the brief renderer
so a finished run-backed record is not injected as live (the status already exists
in the active-run file; this surfaces it at resume too). The field has six values
(`in_progress`, `complete`, `aborted`, `handoff`, `stopped`, `escalated`), so the
renderer has to map each to live or closed, not just the obvious two: `in_progress`
is live; `complete` and `aborted` are closed; `escalated` should be flagged rather
than resumed blindly; and `handoff` and `stopped` are the ambiguous ones that need
an explicit call before this ships. That makes Step 2 a small mapping decision, not
a one-line read. Make the intent status visible in the brief so a likely-satisfied
item is labeled, not hidden.

**Step 3, durable closure (R6, closure propagates) and the bug.** Add a tombstone
written by `clearContinuity` and honored by `harvestAmbientContinuity`, so
`done --clear-ambient` is not reverted by the next turn's harvest. Scope it per
session, so it buries only the cleared session's own finished work and never
silences a concurrent session's genuinely new work. One feasibility note:
`clearContinuity` runs from `done` without a session id or transcript path, so it
cannot call `deriveAmbientStem` directly. It does not need to.
`removeAllAmbientRecords` already enumerates the records it is about to delete, and
each one carries its own `ambient_provenance` (`transcript_path`, `session_id`,
`src/cli/handoff.ts:2476-2480`). `clearContinuity` reads that provenance off those
records and writes a per-session tombstone keyed on the recovered identity plus
the transcript position at clear time. Lift it by that position: the same session
re-harvests only once new intents arrive past the cleared point. Note the grain
the fix has to bridge: the clear (`removeAllAmbientRecords`, `2189-2196`) is
repo-wide, while the resurrection it must prevent is per-session. Of the three
functions that touch the index (`saveContinuity`, `clearContinuity`,
`harvestAmbientContinuity`), only `clearContinuity` writes the tombstone and only
`harvestAmbientContinuity` would otherwise violate it. This step is independent of
the classifier (Step 0) and can go first, but size it as small-to-moderate, not
trivial. Write the failing test first; the surrounding clear and harvest paths are
covered, but the clear-then-reharvest resurrection is not.

**Step 4, compaction (R3, capture at every boundary).** Add a `PreCompact` harvest hook so the in-flight
plan is captured before a compaction, rather than relying on a prior `Stop`.
Consider a Codex `Stop`/`SessionEnd` harvest equivalent, or at minimum an
explicit signpost that capture is currently Claude-only. On the third boundary R3
names, idle: there is no host idle or timeout capture hook on either host (the
only timeouts are harvest and brief execution limits), so idle is uncovered by
construction. Treat it as out of scope until a host exposes an idle signal; `Stop`
on turn-end is the closest existing proxy. Flag it as a known gap, not a silent
one.

Keep untouched: the entire restore safety contract, the soft-fail probe, the
cross-repo guard, the three-kind discriminated union (its variants and
discriminator, not every field inside them, since Step 1 adds one optional field),
and the dual-host hook adapters. This is the restore mechanism, not every line it
renders. Of the two render lines the
ledger tracks, the "unchanged" line is a true git fact that stops misleading once
Step 1 selects an open intent, because it then sits next to live work. The "check
whether it landed" nudge, the one compensating patch, is not retired by these
steps: it covers the case where the repo moved after capture, which the
same-session classifier does not see. Retiring it would take the restore-side
reconciliation (R1, above), which is out of scope here.

### Migration cost

Moderate and bounded. Existing tests lock today's behavior, so these have to be
updated alongside the change:

- The tests that assert "newest request becomes the goal" must flip to
  "newest open request wins."
- The saved-record format is strict: it rejects any unexpected field. Adding a
  status field needs a careful format change that keeps the existing format tests
  green. Adding a new "captured during compaction" source tag touches a locked
  list of allowed sources.
- Existing records on disk are the sharp edge, not just the tests. The record
  schema is `.strict()` with `schema_version: z.literal(1)`
  (`src/schemas/continuity.ts`). A new required field makes every already-saved
  ambient record fail to parse, and the pure-ambient restore path returns
  `record_invalid` with no fall-through (`src/cli/handoff.ts:761-766`), so the
  operator would see a malformed-record error instead of their continuity. The
  safe path, and the one that keeps this an additive refactor, is to add the
  status and source fields as optional with a safe default, so old records still
  parse. A `schema_version` bump with a read-side upgrade is the heavier
  alternative. Ambient records are disposable freshness caches, so a one-time
  invalidation is survivable, but only if it stays silent-safe rather than
  surfacing that malformed error.
- Step 1 changes the incremental harvest cursor. Today it stores only collapsed
  intent strings and a summary (`HarvestCursor`, `1974-1980`); per-request status
  must either be carried in the cursor across harvests or recomputed from a forced
  full re-read. The cursor survives in shape but its stored fields change, so it is
  not untouched. This is arguably the harder half of Step 1.
- The staleness work locked its exact wording line by line, so any new
  intent-status text has to be added without disturbing those existing lines.
- The rule that "marking done keeps the auto-snapshot" has to be revisited if
  answered requests start retiring themselves.

Free (no test renegotiation): the restore ordering, the two-host parity tests (the
brief command does not change), and the cross-repo and fail-safe guarantees. The
clear path is not free: Step 3 adds the tombstone write there, with its own new
test. The exact identifiers and line numbers for all of the above are in the
confidence ledger.

## Step 0 results (probe run 2026-06-07): NO-GO on the capture-side classifier

The probe ran. The capture-side classifier does not clearly beat recency, so by
the exit criterion above we do not ship it. The detail matters, because the same
data points at a cheaper fix that is already mostly in place.

**Method.** Read-only scan of every transcript under `~/.claude/projects`
(4,695 files). 134 qualified as real multi-turn sessions (at least 5 genuine user
intents, after the production intent filter). A structural fact shaped everything:
133 of 134 end with an assistant turn, because the Stop hook fires right after the
assistant replies. So "was the last request responded to" is almost always true
and carries no signal, and trailing acknowledgments ("thanks", "perfect") are rare
(5.2%). The only place an open-vs-done signal can live is the content of the
assistant's final turn, which the parser currently discards. The candidate
classifier was therefore a deterministic lexical scan of that final turn for
completion cues ("done", "merged", "all green") versus continuation cues ("next
I'll", "still need", "saved continuity to resume at X"). Gold labels came from a
strong-model judge reading each session's neighborhood, blind to the classifier's
prediction, with the question framed as the product question: "at session end, was
there genuine unfinished work the user would want to resume?" Six were hand-checked
and agreed with the judge.

**The problem is real and large.** 66 of 134 sessions (49%) ended already
satisfied. Recency resurfaces the last intent as live every time, so today roughly
half of all resurfaced "goals" are already-finished work.

**The classifier fails both gates.**

- False-resurrection: the lexical classifier still resurfaces 49 of 66 satisfied
  sessions, which is 0.74x the recency baseline. The gate was 0.50x or better.
  FAIL.
- Over-burying: it wrongly suppressed 7 of 67 genuinely-open sessions (10.4%), all
  cases where the assistant had saved a handoff naming next-session work but also
  used completion language for a sub-task. The gate was near-zero. FAIL.

**Why it fails is structural, not a tuning miss.** 58% of sessions (78 of 134)
land in "cannot-tell", and that bucket is a coin flip (41 satisfied, 36 open). A
richer lexicon cannot fix this: the deciding information is semantic, and the
harvest is a deterministic, no-model, every-turn CLI by design. You cannot run a
satisfaction judge inside it without adding a model call to every Stop, which is
exactly the cost the harvest was built to avoid. So the classifier is precluded by
the architecture, and the probe confirms it empirically.

**The data hands us the cheaper fix.** One deterministic signal that the harvest
already has cleanly splits the corpus: did the assistant save an explicit handoff,
or did the session fall back to the ambient auto-snapshot?

- Explicit-save sessions (70): 81% open. A record was deliberately written with a
  real goal and next step. Resume language fits.
- Ambient-only sessions (64): 83% already satisfied. This is the blind-resurrection
  population, and five times out of six its "goal" is already done.

This is exactly the precedence the resolver already encodes (prefer the manual
save, treat ambient as the fallback safety net), and the ambient brief already
renders as non-directive context: "Latest request" rather than "resume", plus the
boundary "this is an automatic snapshot, not a saved plan ... do not resume this
work unasked", plus git-staleness reconciliation. In other words, the restore-side
reconciliation the exit criterion names as the fallback (R1) is, for the common
case, already shipped by the warm-writer slimming, the restore-improvements, and
the staleness work. The 83%-done ambient population is handled by framing it as
"here is the last thing, confirm before acting", which is the honest register for a
signal that is right about one time in six.

**Revised build set.** Step 1 (the capture-side satisfaction classifier) and the
ambient half of Step 2 (an inferred `goal_status` label) are cancelled: they
depend on a classifier that does not work. What survives, and is worth building:

- **Step 2a, run-backed status in the brief.** Read `run_ref.runtime_status` in
  the brief render so a finished run-backed record is not shown as live. This reads
  a real recorded field, not an inferred one, so it is unaffected by the gate. The
  safety boundary already blocks auto-resume, so this is a legibility win, not a
  safety fix, but it is cheap, deterministic, and removes a genuine inconsistency
  (the active-run file shows the status; the brief does not).
- **Step 4, coverage.** A `PreCompact` harvest hook (capture the in-flight plan
  before a compaction, not only on Stop), an honest signpost that capture is
  Claude-first with the Codex path documented, and idle flagged as an uncovered
  gap (no host idle signal exists).

R1 beyond what is already shipped (retiring the staleness nudge, reconciling more
carried claims) stays available but low-value: the ambient framing already absorbs
the common case.

**Honesty note on the judge.** The gold labels came from the same model family
that designed the classifier, so there is a circularity risk. It is mitigated three
ways: the judge read full content while the classifier read only structure, the
judge was blind to the classifier's prediction, and the headline effects (49%
satisfied overall, 83% satisfied among ambient-only) are large enough that a
handful of mislabels cannot flip the verdict. The structural argument (no model in
the harvest) holds regardless of the labels.

## What this evaluation did not do

The evaluation itself changed no code. The follow-on efforts, updated for the
Step 0 result:

1. The Step 0 probe (read-only). DONE, 2026-06-07. Verdict: NO-GO on the
   capture-side classifier; see the results section above.
2. The capture-path refactor (Steps 1 and the ambient half of Step 2). CANCELLED
   by the Step 0 gate.
3. The `done --clear-ambient` tombstone fix (Step 3), failing-test-first. SHIPPED
   in PR #47.
4. The surviving render win (Step 2a) and the compaction and host-parity coverage
   (Step 4). BUILT, 2026-06-07, failing-test-first. Step 2a renders
   `run_ref.runtime_status` in the brief; Step 4 adds the `PreCompact` harvest
   hook (`source: "pre-compact"`) and documents the two by-design gaps (Codex
   captures nothing on its own; idle is uncovered) in
   [`continuity.md`](../contracts/continuity.md#capture-coverage-and-its-gaps).

## Confidence ledger

**Confirmed (read directly in current source):**

- `ParsedTranscript` has no fulfilment slot (`handoff.ts:1860-1863`); parser
  skips non-user turns (`1954`); `goal = intents[last]` (`2449-2452`); `next` is
  a constant (`2466`).
- `ContinuityNarrative` is four strings, strict, no status
  (`continuity.ts:28-36`).
- The staleness probe excludes intent text (`97-101`, invoked `673-680`); soft-
  fail collapse to `{}` (`2350-2352`); cross-repo guard (`673-674`);
  `stalenessUnchanged` and the "unchanged" line with the "resume point is live"
  comment (`345-351`, `364-368`).
- `composeHandoffBrief` (`296-312`) and `composeBriefFor` (`448-458`) never read
  `runtime_status`, so a complete run-backed record is injected at resume like a
  live one; the status is read only at save time (`writeActiveRun`, `1574`).
- The `Stop` hook has no matcher (`hooks.json:14-23`); `clearContinuity` keeps
  ambient by default (`1771`); `removeAllAmbientRecords` deletes record and
  cursor (`2189-2196`); harvest re-creates after a clear with no tombstone
  (`2421-2516`). These paths are covered by CLI tests, but the clear-then-
  reharvest resurrection sequence is not.
- No `PreCompact` hook exists; harvest source is only stop or session-end
  (`harvest.ts:66`); Codex has only a session-start hook, no harvest.

**Supported (inferred from confirmed evidence):**

- The headline goal is systematically biased toward resurfacing done work,
  because the freshest turn is the one most likely to have just been answered.
- A satisfied-at-capture intent with no later commits renders as "Repo unchanged
  since capture" next to the done request.
- On Codex, the staleness and age windows drift, because capture only happens on
  Claude.

**Uncertain (needs a probe):**

- Whether reading assistant turns reliably classifies an intent as satisfied in
  real transcripts. This is the one assumption the whole fix depends on, which is
  why Step 0 exists.
- The real-world frequency of the blind-replay bug. Observed anecdotally and in
  the design note, not quantified.

## Method

This evaluation was produced by a multi-phase adversarial workflow: three
independent first-principles reconstructions of the job (done without reading the
code, to avoid anchoring), six grounded subsystem maps with citations, five
diverse seam-hunting lenses, a synthesized verdict, and five skeptics tasked with
refuting it. Two skeptics dissented, both arguing the first-pass verdict
understated the problem. Their findings were verified against source and folded
in: the corrected part count, the false-liveness framing, the honest fix scope,
the second and third essential gaps, and the `done --clear-ambient` resurrection
bug. That is why the verdict here is more severe and more precise than a single
pass would have produced.
