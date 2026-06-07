# Continuity staleness check

Status: design exploration, 2026-06-07. Design only, no engine or runtime
edits. Builds on the shipped A2 age signal. Every current-behavior claim
below is cited to source.

## What this explores

An ambient brief faithfully replays the last harvested intent
(`narrative.goal`) and a generic next step (`narrative.next`). Neither
knows whether that intent already landed. The restore is therefore *safe*
but not *oriented*: the boundary disclaimer stops a fresh agent from
blindly resuming, but the brief still presents a done request as if it
were pending.

Observed live on 2026-06-07: a fresh session restored a snapshot whose
`Latest request` was "please commit and push and merge to main", a request
that had already merged hours earlier (PR #44, `18e13ac1`). The disclaimer
held, but the agent had to reconstruct "is this done?" by hand against git.

This explores letting Circuit do that reconstruction deterministically.

## The headline distinction

"Stale" means three different things. Conflating them is the trap.

1. **Temporal** staleness: the record is old. Already shipped as the A2
   age line (`composeAmbientBrief` renders `relativeAge`,
   `src/cli/handoff.ts:334-337`, `:415-432`). Weak on its own.
2. **State-divergence** staleness: the world moved since capture. HEAD
   advanced, branch merged or gone, tree went dirty to clean. Cheap and
   deterministic. Does not by itself prove the goal is done.
3. **Intent-satisfaction** staleness: the specific captured request looks
   accomplished. The valuable one, and the hard one, because it means
   mapping fuzzy language ("merge to main") to an observable fact (a merge
   commit reachable from HEAD).

The unlock: #2 is a cheap deterministic proxy for #3. Report structural
divergence as facts and let the agent reading the brief (which is good at
language) close the gap to the intent. This doc adds #2. It does not try
to compute #3 in the engine.

## Recommendation up front

1. Report-only. Emit deterministic divergence facts plus one boundary
   clause. Never rewrite the harvested intent, never suppress the brief.
2. Ambient-only. Matches the A2 precedent: a manual save is a deliberate
   act, so its freshness is the operator's concern
   (`src/cli/handoff.ts:334-335`). Manual saves keep their `handoff done`
   clear path.
3. Deterministic facts, never a verdict. Circuit states what moved in git.
   It does not decide "done". That inference stays with the agent, holding
   the goal text, where a model already sits. This honors the house rule:
   rule-based detection, no model-picking.

## The substrate already exists

Ambient records capture git state at harvest time. `GitState` carries
`cwd`, `branch?`, `head?`, `base_commit?` (`src/schemas/continuity.ts:18-26`),
and the ambient writer populates `git.branch` and `git.head`
(`src/cli/handoff.ts:2176-2180`). The harvest path already takes an
injectable git probe (`AmbientGitProbe`, `src/cli/handoff.ts:2153`).

So the brief, when it renders an ambient record, has the captured `head`
and `branch` in hand. A staleness check is reading state we already store
and comparing it to the world now. No schema change is required for the
captured side.

## The signals, ranked

Computed at brief time against the captured `git.head` / `git.branch`:

| Signal | Probe | Strength |
|---|---|---|
| Capture HEAD reachable from current HEAD | `git merge-base --is-ancestor <head> HEAD` | strong: work built on top, capture point is now history |
| Capture branch merged or gone | `git branch --merged` / `rev-parse --verify <branch>` fails | strong for "land it" intents |
| Tree clean now | `git status --porcelain` empty | medium: was-dirty to clean implies committed, stashed, or discarded |
| Commits since capture | `git rev-list --count <head>..HEAD` | medium |
| Branch switched | current branch differs from `git.branch` | weak |
| Just old | `created_at` age | weak, already shipped (A2) |

The strongest composite is "capture HEAD reachable" plus "capture branch
merged or gone". That is as close to "the work landed" as you get without
reading the intent. It is exactly the observed test-case shape.

## What it does: report-only

The available-brief envelope gains a structured `staleness` object, source
of truth, soft-failing every field to omitted:

```
staleness: {
  head_advanced: boolean,
  capture_head_reachable: boolean,
  branch_merged_or_gone: boolean,
  tree_clean: boolean,
  commits_since: number,
}
```

`composeAmbientBrief` (`src/cli/handoff.ts:285-307`) renders a
deterministic block from it, slotted between "Recent state" and the
boundary:

```
Repo state since capture:
- Captured on branch feat/continuity-restore-improvements at 2fd64470.
- That branch is now merged and no longer present.
- The captured commit is already in the current history (HEAD 18e13ac1).
- Working tree is clean.
```

The boundary line gains one clause:

```
Boundary: This is an automatic snapshot, not a saved plan. The repo has
advanced since it was captured, so check whether the captured request
already landed before acting. Confirm the current goal with the user, and
do not resume this work unasked.
```

Circuit never says "you are done". It states facts. The agent connects
"branch merged, commit in history, tree clean" to "merge to main".

Pre-computing these facts only pays off under one assumption: the
consumer does not reliably check git itself. That holds for the human
reading the brief, for weaker models, and for hosts that inject the brief
as plain context. A strong agent could run the same probes on its own, so
the value here is raising the floor deterministically for every consumer,
not doing something the best agent could not. State that assumption
plainly; it is the whole case against doing nothing.

## Rejected: verdict and suppression

- **Intent verdict in the engine** (keyword-match the goal against git):
  natural-language parsing inside a deterministic CLI. False-positives on
  "do not merge yet", locale-bound, untestable without language fixtures.
  Model-picking wearing a regex.
- **Suppress the brief on a strong signal**: never let a heuristic blind a
  real resume point. This is the same reason A4 exists
  (`src/cli/handoff.ts:556-595`): a wrong suppression silently loses the
  one thing the system is for.
- **Soften the suggestion** (rewrite `narrative.next` to "may be
  complete"): editing the harvested intent on a guess, wrong in the
  confident direction. Hold as a gated follow-up, strongest-composite-only,
  once the signal is trusted.

## Frame check: is this a local optimum?

Reviewed 2026-06-07 against "are we polishing the wrong thing?". Verdict:
the mechanism is sound within its frame; the real finding is a sibling
lever the frame hides.

Within the frame (orient the ambient brief about whether the captured
request already landed), brief-time git facts is the right mechanism. The
adjacent frames are weaker on mechanism:

- **Detect at harvest time, not brief time.** Reject. Staleness is a
  read-time property: git can move between the last harvest and the next
  restore (another terminal, the GitHub UI, a teammate) with no Circuit
  session running to observe it. Harvest can only enrich the captured
  baseline (see `base_commit` below), not detect divergence that happens
  after it.
- **Track intent lifecycle (mark an intent done at its source).** The
  more-correct-in-principle direction, but completion detection is the
  same fuzzy intent-to-fact mapping this spec deliberately leaves to the
  agent, and doing it in-engine would be rule-based and brittle.
  Run-backed continuity already has a lifecycle (`runtime_status`); the
  ambient path is the unstructured fallback by definition. This is a
  larger product bet (track every session like a run), not a cheaper
  staleness signal.
- **A general "is this resume point live?" check.** Git is the canonical,
  highest-signal, deterministic source for "did code land". Generalizing
  now is premature; the structured `staleness` object already admits more
  signals additively.
- **Do nothing; the disclaimer suffices.** The real competitor, answered
  in the report-only section above: pre-computing wins only under the
  stated "consumer does not self-check git" assumption.

The genuine finding is a sibling lever: **harvest-side intent quality.**
The brief's "Latest request" is just the last harvested user turn
(`src/cli/handoff.ts:2166-2169`) filtered by prefix and marker regexes
(`isDroppedIntent`, `src/cli/handoff.ts:1692-1699`). Those regexes target
host tags and command headers, not the expanded skill body, so the
`write-goal` skill text leaked in as the headline "Latest request" in this
session's snapshot on 2026-06-07. Staleness cannot orient a garbage
intent: "did 'Base
directory for this skill...' land?" has no answer. Intent quality is
therefore both cheaper and a precondition. It does not block this work; it
reorders it. Fix or at least file the intent-quality leak first or
alongside, so staleness operates on a real intent. This is the one place
the staleness frame, taken alone, would have been a local optimum.

## Correctness traps

- **Rebase or amend breaks "ancestor".** If the operator rebased, the
  captured HEAD may not be an ancestor even though the work landed. So
  "reachable" is sufficient, not necessary. Never read "not reachable" as
  "not done".
- **Unrelated advance.** HEAD can move for other work. "HEAD advanced"
  alone is weak. Only the composite is strong, and only the agent, holding
  the goal text, connects divergence to *this* intent. This is the reason
  to emit facts, not a verdict.
- **Graceful degradation.** Detached HEAD, no branch captured, not a git
  repo, probe throws: omit the block, never throw the hook. Same contract
  as `relativeAge` returning undefined (`src/cli/handoff.ts:415-417`).
- **Cross-repo guard.** Compare against the project root being briefed.
  The record stores `git.cwd`; a mismatch means the comparison is
  meaningless and the block should be omitted.

## Slice plan (TDD)

1. Failing test: an ambient brief whose captured branch is merged and
   whose HEAD is reachable renders a "Repo state since capture" block and
   the extended boundary clause. Inject a stub git probe; assert on the
   text and the structured `staleness` object.
2. Add the injectable git probe to the brief path, mirroring the harvest
   probe (`AmbientGitProbe`). Default implementation runs the git commands
   with short timeouts, each failing soft.
3. Render the block in `composeAmbientBrief`; extend the boundary line.
4. Fixture cases: merged-branch (strong), rebased (reachable false, work
   still landed, no false "done"), clean-advance-by-other-work (weak),
   not-a-repo (block omitted), unchanged (see open decision).
5. `npm run verify`. Dual-host parity: the block must render identically
   through the Claude spawn hook and the Codex in-process path, since both
   render the same record.

## Open decisions

- **Unchanged case.** When nothing diverged (HEAD unchanged, same tree),
  omit the block or show a single `- Repo unchanged since capture` line?
  Leaning toward showing it: "unchanged" is itself orientation, telling
  the agent the snapshot world still matches the real world, so the resume
  point is live.
- **base_commit.** Ambient harvest does not currently store
  `git.base_commit` (`src/cli/handoff.ts:2176-2180`). The "branch merged"
  probe does not need it, but capturing it would sharpen the "merged into
  base" check. Optional, not day-one.
