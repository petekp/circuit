---
name: handoff
description: >
  Save session state for the next session. A fresh session can resume
  automatically. Use when context is getting heavy, the user asks for a handoff,
  or you need to preserve progress before a session boundary. Also supports
  `/circuit:handoff done` to clear a pending handoff. Works alongside
  active-run.md (automatic continuity) as the intentional high-quality
  continuity path.
role: utility
---

# Handoff

Save session state for the next session. On the next `/clear` or
session start, the Circuit hook auto-injects it so the fresh session picks up
where this one left off. No clipboard, no paste.

## Relationship to active-run.md

Circuit provides two continuity mechanisms:

- **active-run.md** -- Automatic. Every workflow updates it after each phase. The
  SessionStart hook injects it. Gives basic continuity even when the user forgets
  to hand off. Low-effort, lower-fidelity.
- **handoff.md** -- Intentional. Written explicitly via `/circuit:handoff`. Distills
  hard-to-rediscover facts that active-run.md cannot capture (eliminated approaches,
  operating constraints, debug state). Higher-effort, higher-fidelity.

Both mechanisms coexist. Handoff.md is the richer path. active-run.md is the safety net.

## Modes

- `/circuit:handoff` -- capture current state and write to disk
- `/circuit:handoff done` -- delete the pending handoff

## Done Mode

Clears both continuity mechanisms so the next session starts fresh.

1. Compute the handoff path (see Storage below -- use git root if in a git repo, else $PWD)
2. If the handoff file exists, delete it.
3. If `.circuit/current-run` exists, remove it.
4. Find all `active-run.md` files under `.circuit/circuit-runs/` (any depth)
   and rename each to `completed-run.md`. This archives every run's dashboard,
   not just the currently pointed one, so the fallback heuristic finds nothing.
5. Report what was cleared:
   - If handoff was deleted or any runs were archived: "Cleared. Fresh session will start clean."
   - If nothing was found: "No handoff or active runs found. Already clean."
6. Stop here. Do not gather context or write a new handoff.

**Why all active-run.md files are archived:** `session-start.sh` has a fallback
heuristic that finds the most recently modified `active-run.md` when no explicit
pointer exists. Removing the pointer alone is not enough -- the fallback would
inject a finished or stale run. Archiving only the pointed run can surface a
different stale run instead of the welcome screen. Renaming all `active-run.md`
files to `completed-run.md` ensures the fallback finds nothing regardless of
how many prior runs exist. Run directories stay intact for reference.

## Capture Mode

### 1. Determine Working Directory and Slug Source

The handoff file is stored using a **git-root-normalized slug** so it can be found from any
subdirectory within the same repo.

1. If in a git repo: use `git rev-parse --show-toplevel` as the slug source
2. If not in a git repo: use `$PWD` as the slug source

DIR in the handoff should still be `$PWD` (the actual working directory), not the git root.
The slug source and DIR may differ -- that is correct.

**Worktree check:** If the project uses git worktrees, note the worktree path in STATE. The
slug is derived from the git root of the current worktree. If you are in a worktree, the slug
will be the worktree's git root, not the main repo's root.

### 2. Gather Hard-to-Rediscover Facts

Collect details that are expensive to recover:

- Original goal and current scope
- Exact resume point: what was happening when the handoff was requested
- Decisions already made, plus the reason they were made
- User preferences, repo rules, or operating constraints established during the session
- What passed, what failed, what was not run
- Blockers, risks, and open questions
- Ruled-out approaches and the constraint that ruled them out

If the work lives in a git repo, run `$CLAUDE_PLUGIN_ROOT/skills/handoff/scripts/gather-git-state.sh`
for reference, but do not encode anything in the handoff that `git status`, `git log`, or
`git diff` would show.

### 3. Separate Facts From Guesses

- **Observed facts**: commands run, files changed, errors seen, tests run
- **Current hypothesis**: what you currently believe is likely true
- **Open questions**: what still needs proof

Never imply certainty the session did not earn.

### 4. Classify Session Complexity

Classify by the number of distinct moving parts the consuming session needs to track:

- **Simple**: one thread, one file, clear outcome
- **Medium**: 2-3 concerns, some uncertainty, one active decision
- **Complex**: multiple threads, multiple eliminated approaches, active blockers

Most sessions are medium. Do not default to complex because the work felt hard.

### 5. Check for Debug Context

Is the session primarily about reproducing, diagnosing, or fixing a failure? If yes, STATE
must lead with the debug block before other STATE bullets.

### 6. Write the Handoff

Use exactly this structure. Omit DEBT if empty. STATE is never empty.

```
# Handoff
WRITTEN: <ISO 8601 timestamp, e.g. 2026-04-03T14:30:00Z>
DIR: /absolute/path/to/working/directory

NEXT: [DO: <exact command, file:line, or concrete step> | DECIDE: <decision name> -- options: A) <option>, B) <option>]
GOAL: <one sentence -- what done looks like> [VERIFY: confirm this is still the right target before acting]
STATE:
- <what is true right now that git cannot show -- one bullet per fact>
DEBT:
- RULED OUT: <approach> -- <why, short form>
- DECIDED: <decision> -- <reason>
- BLOCKED: <blocker> -- <unblocking condition>
- CONSTRAINT: <operating rule>
```

**Field rules:**

- **WRITTEN**: mandatory, always first line after the header. ISO 8601 timestamp of when the handoff was created. Used by the consuming session to assess staleness.
- **DIR**: mandatory, after WRITTEN. Absolute path to the actual working directory (`$PWD`). The cold-start anchor.
- **NEXT**: mandatory. Prefixed `DO:` or `DECIDE:`.
  - `DO:` means the action is ready to execute. Use only when unambiguous.
  - `DECIDE:` means the session ended at a branch point. Name the decision and list options.
  - `DECIDE: need user input -- <specific question>` when it genuinely requires the user.
  - **Asymmetry rule**: a false DO executes the wrong thing; a false DECIDE wastes one cycle. When uncertain, use DECIDE.
- **GOAL**: one sentence. Ends with `[VERIFY: confirm this is still the right target before acting]`. This annotation is an instruction to the consuming agent, not prose to trim.
- **STATE**: only facts invisible to git. Noun phrases and verb phrases only. No hedging, no narrative. For debug sessions, lead with: `hypothesis:`, `repro:`, `expected:`, `actual:`, `eliminated:`.
- **DEBT**: every entry must carry a typed prefix: `RULED OUT:`, `DECIDED:`, `BLOCKED:`, or `CONSTRAINT:`. No unprefixed entries. Format: `<PREFIX>: <subject> -- <compressed rationale>`. Target ~25 tokens per entry. If more is needed, use a reference: `RULED OUT: JWT -- scaling cost; see prior session STATE for full reasoning`. For research sessions, DEBT includes collapsed argument chains as RULED OUT entries.

### 7. Apply Compression

Token targets (soft, DEBT-excluded):
- Simple: 80 tokens
- Medium: 150 tokens
- Complex: 300 tokens

DEBT entries are excluded from ceiling tracking. The per-entry ~25 token guideline applies instead.

Apply compression in this order. Stop when within target:

1. Cut anything git can show (`git status`, `git log`, `git diff`)
2. Cut history -- what was done is not what needs to happen next
3. Cut hedging -- write the belief, not the uncertainty wrapper
4. Cut narrative in STATE -- noun phrases and verb phrases only
5. Compress DEBT entries to ~25 tokens using reference links for full context
6. Never cut a DEBT entry entirely unless it is genuinely no longer relevant

### 8. Adapt to Task Type

The structure is the same for all task types. Content differs:

- **Coding/debugging**: STATE = test results, file:line of failure, active worktrees; DEBT = ruled-out approaches with the constraint that eliminated them
- **Planning/research**: STATE = what evidence exists and where; DEBT = collapsed argument chains (the reasoning thread eliminated, not just the conclusion)
- **Multi-worktree**: DIR = primary worktree; STATE includes other worktree paths and their pause points; NEXT picks one thread

## Storage

The handoff uses **git-root-normalized slugs** so it can be found from any subdirectory.

1. If in a git repo: use `git rev-parse --show-toplevel` as the slug source
2. If not in a git repo: use `$PWD` as the slug source
3. Replace every `/` with `-` to get the project slug
4. Write to: `~/.claude/projects/<slug>/handoff.md`

Example: invoking `/circuit:handoff` from `/Users/petepetrash/Code/circuit/hooks` uses git root
`/Users/petepetrash/Code/circuit`, slug becomes `-Users-petepetrash-Code-circuit`,
handoff goes to `~/.claude/projects/-Users-petepetrash-Code-circuit/handoff.md`.

Use the Write tool. Overwrite any existing handoff at that path.

**Note:** Auto-resume on `/clear` requires the Circuit session-start hook to be active.
Without it, the handoff file is written to disk but must be manually referenced in a new
session. The hook handles detection, validation, and injection automatically.

## Output

After writing, confirm briefly:

> Handoff saved. `/clear` when ready for a fresh session.

Do not display the handoff contents. Do not copy to clipboard. The hook handles injection.

## active-run.md Integration

When writing a handoff during an active circuit run, also check for
`${RUN_ROOT}/artifacts/active-run.md`. If it exists:

1. Read it for current workflow, rigor, phase, and goal context.
2. Include the active-run state as context in the handoff STATE section.
3. Update active-run.md to reflect the pause:
   ```markdown
   ## Current Phase
   pause
   ## Next Step
   Resume from handoff.md
   ## Last Updated
   <ISO 8601 timestamp>
   ```

This ensures both continuity mechanisms are synchronized.

After updating this skill, verify the hook wrapper in the Circuit plugin's
`hooks/session-start.sh` is consistent with this format before closing.
