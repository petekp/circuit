---
name: circuit:run
description: >
  Default circuit for tasks that benefit from structured execution but don't
  match a specialized circuit. 4 steps across 3 phases: Scope -> Execute ->
  Summary. Auto-scopes the work, shows the plan for confirmation, then runs
  implement/review/converge. Use when the approach is clear and the work is
  non-trivial. Not for tasks needing research (develop), architecture decisions
  (decide), debugging (repair-flow), cleanup, or migrations.
---

# Do Circuit

Auto-scope, confirm, execute. The default circuit for clear tasks that span
multiple files and benefit from planning, independent review, and convergence.

The key difference from other circuits: no interview, no research phase, no
decision phase. Claude reads the task and the codebase, writes a scope, shows
it to you, and executes on confirmation. One checkpoint, then autonomous
execution.

## When to Use

- Multi-file changes where the approach is clear
- Feature additions following existing patterns
- Refactoring with a known target shape
- Test additions and integration work
- Any non-trivial task where you want planning and review without the overhead
  of a full develop workflow

Do NOT use for:

- Tasks needing research before implementation (use `circuit:develop`)
- Architecture or protocol decisions (use `circuit:decide`)
- Debugging broken flows (use `circuit:repair-flow`)
- Dead code and stale docs removal (use `circuit:cleanup`)
- Large migrations with dual-system coexistence (use `circuit:migrate`)
- Truly trivial single-line changes, config edits, or typo fixes (skip circuits)

If you want to explicitly set priorities, non-goals, and kill criteria before
execution, use `circuit:develop --light` instead. It has an interactive
intent-lock step that circuit:run skips.

## Principles

- **Show the scope, then execute.** The user always sees the plan before any
  code is written. This is not zero-interaction autonomy.
- **Escalate, don't absorb.** If the task belongs in a specialized circuit,
  say so during scope. Don't try to handle everything.
- **One question max.** The scope step asks at most one clarifying question
  if the task is genuinely ambiguous. Not an interview.
- **Scope creep kills.** The Out of Scope section is enforced. Workers that
  stray beyond it are caught in review.

## Setup

```bash
RUN_SLUG="<task-slug>"
RUN_ROOT=".circuitry/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts"
```

Record `RUN_ROOT`. All paths below are relative to it.

## Domain Skill Selection

When dispatching workers, pick 1-2 domain skills matching the affected code.
Check `circuit.config.yaml` for a `do:` entry first. If no config exists,
auto-detect from the file scope in the confirmed scope.

Never exceed 3 total skills per dispatch.

## Dispatch Backend

Same as all circuits. Auto-detect: if `codex` is on PATH, use Codex CLI.
Otherwise, use Claude Code's Agent tool with `isolation: "worktree"`.

```bash
if command -v codex >/dev/null 2>&1; then
  # Codex backend
  cat ${step_dir}/prompt.md | codex exec --full-auto -o ${step_dir}/last-messages/last-message.txt -
else
  # Agent backend — invoke the Agent tool with prompt content
  # Agent(task=<prompt contents>, isolation="worktree")
fi
```

Or use the dispatch helper:
```bash
./scripts/relay/dispatch.sh \
  --prompt ${step_dir}/prompt.md \
  --output ${step_dir}/last-messages/last-message.txt
```

---

## Phase 1: Scope

### Step 1: Auto-Scope — `synthesis`

**Objective:** Read the task and codebase, produce a structured scope.

**Before writing scope, evaluate two things:**

1. **Ambiguity check.** Does the task have multiple plausible interpretations
   that would lead to materially different implementations? "Add dark mode"
   is clear. "Improve the auth flow" is ambiguous (could mean UX, security,
   performance, or architecture). If ambiguous, ask ONE clarifying question
   (not an interview), then proceed.

2. **Escalation check.** Does the task signal a specialized circuit?
   - Needs external research or the approach is genuinely unclear -> `circuit:develop`
   - Involves choosing between architectural approaches -> `circuit:decide`
   - Debugging a broken or flaky flow -> `circuit:repair-flow`
   - Removing dead code, stale docs, orphaned artifacts -> `circuit:cleanup`
   - Framework swap or migration with coexistence -> `circuit:migrate`

   If escalation detected, still write scope.md but include an Escalation Notes
   section. The user decides at the confirmation step whether to switch.

3. **Slice count.** If auto-scope produces more than 6 slices, note in scope.md
   that this task may benefit from `circuit:develop` for its full planning and
   decision machinery. Not a hard gate; the user decides.

**Write** `${RUN_ROOT}/artifacts/scope.md`:

```markdown
# Scope: <task summary>

## Task
<user's original request, verbatim>

## Approach
<1-3 sentences: what will change and how>

## Slices

### Slice 1: <description>
- **files:** <file list>
- **verification:** `<command>`
- **success_criteria:** <what "done" looks like for this slice>

### Slice 2: <description>
- **files:** <file list>
- **verification:** `<command>`
- **success_criteria:** <what "done" looks like for this slice>

## Verification
<commands to run after all slices complete, newline-separated>

## Out of Scope
<what this task does NOT include, to prevent scope creep>

## Escalation Notes
<if detected: which specialized circuit and why. Omit section if no escalation.>
```

Each Slice heading becomes a manage-codex batch.json entry. The structured
fields (`files`, `verification`, `success_criteria`) map directly to
`file_scope`, `verification_commands`, and `success_criteria` in batch.json.
This is not prose inference; each field is first-class data.

**Gate:** `scope.md` exists with non-empty Approach, at least one Slice with
`files:` and `verification:`, non-empty Verification, and non-empty Out of Scope.

---

### Step 2: Scope Confirmation — `interactive`

**Objective:** Show the scope to the user before any code is written.

Present `scope.md`. Frame it as:

> Here's the scope for your task. [N] slices touching [list key files].
>
> 1. Confirm and proceed
> 2. Amend the scope (tell me what to change)
> 3. Switch to [recommended circuit] (if Escalation Notes present)

**If user confirms:** Write `${RUN_ROOT}/artifacts/scope-confirmed.md` as a
copy of `scope.md` with a `## Confirmation` section appended:

```markdown
## Confirmation
Confirmed by user. Proceeding with execution.
```

**If user amends:** Rewrite the scope with their changes, then write
`scope-confirmed.md` with the amended content and:

```markdown
## Confirmation
Amended by user: <brief description of changes>. Proceeding with execution.
```

**If user switches:** Invoke the recommended circuit and stop this one. Write
`scope-confirmed.md` with:

```markdown
## Confirmation
User chose to switch to circuit:<name>. Stopping circuit.
```

**Gate:** `scope-confirmed.md` exists. If it contains "switch to circuit:",
the circuit stops here.

---

## Phase 2: Execute

### Step 3: Implement — `dispatch` (via manage-codex)

**Objective:** Build against the confirmed scope with independent review.

This step delegates to manage-codex for the full implement -> review -> converge
cycle. The orchestrator creates the workspace and translates scope-confirmed.md
into a CHARTER.md.

**Setup:**

```bash
IMPL_ROOT="${RUN_ROOT}/phases/implement"
mkdir -p "${IMPL_ROOT}/archive" "${IMPL_ROOT}/handoffs" \
  "${IMPL_ROOT}/last-messages" "${IMPL_ROOT}/review-findings"
```

**Create CHARTER.md from scope-confirmed.md:**

Read `${RUN_ROOT}/artifacts/scope-confirmed.md` and write
`${IMPL_ROOT}/CHARTER.md` with this mapping:

| scope-confirmed.md | CHARTER.md |
|---------------------|------------|
| `## Task` | Mission preamble |
| `## Approach` | Implementation approach |
| `## Slices` | Slice definitions (each becomes a batch.json entry) |
| `## Verification` | Verification commands (union for convergence) |
| `## Out of Scope` | Non-goals (enforced during review) |

Each Slice heading in scope-confirmed.md maps to a batch.json slice with:
- `task`: the Slice heading description
- `file_scope`: the `files:` field
- `verification_commands`: the `verification:` field
- `success_criteria`: the `success_criteria:` field (first-class, not inferred)
- `domain_skills`: from circuit.config.yaml or auto-detected from file scope

**Write the prompt header** at `${IMPL_ROOT}/prompt-header.md`:

Use the canonical header schema with:
- Mission: Implement the work described in CHARTER.md using the manage-codex
  implement -> review -> converge cycle
- Inputs: Full text of CHARTER.md
- Output path: `${IMPL_ROOT}/handoffs/handoff-converge.md`
- Output schema: manage-codex convergence handoff format
- Success criteria: All slices converged with `COMPLETE AND HARDENED` verdict
- Handoff: Standard relay handoff headings (`### Files Changed`,
  `### Tests Run`, `### Completion Claim`) to prevent relay-protocol.md
  contamination

**Compose and dispatch:**

```bash
./scripts/relay/compose-prompt.sh \
  --header ${IMPL_ROOT}/prompt-header.md \
  --skills manage-codex,<domain-skills> \
  --root ${IMPL_ROOT} \
  --out ${IMPL_ROOT}/prompt.md

./scripts/relay/dispatch.sh \
  --prompt ${IMPL_ROOT}/prompt.md \
  --output ${IMPL_ROOT}/last-messages/last-message.txt
```

**After manage-codex completes**, synthesize `execution-handoff.md`:

Read (in this order):
1. `${IMPL_ROOT}/handoffs/handoff-converge.md` (convergence verdict)
2. `${IMPL_ROOT}/batch.json` (slice metadata)
3. The last implementation slice handoff (find slice id from batch.json)

Note: manage-codex review workers may overwrite per-slice handoff files. If a
slice handoff is missing or appears to be a review artifact, use batch.json
slice metadata and the convergence handoff to reconstruct what was built.

Write `${RUN_ROOT}/artifacts/execution-handoff.md`:

```markdown
# Execution Handoff: <task summary>
## What Was Built (from batch slices and convergence)
## Tests Run and Verification Results
## Convergence Verdict
## Open Issues (from convergence findings, if any)
```

**Gate:** `execution-handoff.md` exists AND convergence verdict is
`COMPLETE AND HARDENED`. If convergence says `ISSUES REMAIN`, the manage-codex
loop should have addressed them. Escalate to user if it didn't.

**Verify:**
```bash
test -f ${IMPL_ROOT}/handoffs/handoff-converge.md
test -f ${RUN_ROOT}/artifacts/execution-handoff.md
```

---

## Phase 3: Summary

### Step 4: Done Summary — `synthesis`

**Objective:** Summarize what was done for the user.

Read `scope-confirmed.md` and `execution-handoff.md`. Write
`${RUN_ROOT}/artifacts/done.md`:

```markdown
# Done: <task summary>

## Changes
- <file>: <what changed>
- <file>: <what changed>

## Verification
<commands run and their results>

## Notes
<anything the user should know: edge cases, deferred work, follow-ups>
```

**Gate:** `done.md` exists with non-empty Changes and Verification results.

---

## Artifact Chain Summary

```
scope.md → scope-confirmed.md [user confirms] → execution-handoff.md → done.md
```

Four artifacts. The scope is the plan. scope-confirmed is the user-approved
plan. execution-handoff is the convergence result. done is the receipt.

## Resume Awareness

If `${RUN_ROOT}/artifacts/` already has files, determine the resume point:

1. Check artifacts in chain order: `scope.md` -> `scope-confirmed.md` ->
   `execution-handoff.md` -> `done.md`
2. **Check for switch sentinel.** If `scope-confirmed.md` contains
   "switch to circuit:", the user chose to leave circuit. Do NOT resume
   into the execute phase. Report that the circuit was stopped and the user
   switched to a different circuit.
3. Find the last complete artifact with a passing gate
4. For Step 3 (Implement): check `${RUN_ROOT}/phases/implement/batch.json`
   for manage-codex resume state. Run
   `./scripts/relay/update-batch.sh --root ${RUN_ROOT}/phases/implement --validate`
   to confirm batch consistency before resuming.
5. Compare `head_at_plan` in batch.json with `git rev-parse HEAD`. Match ->
   resume from first pending slice. Mismatch -> warn the user.
6. Continue from the next step after the last complete artifact

## Circuit Breaker

Escalate to the user when:
- Any manage-codex slice hits `impl_attempts > 3` or
  `impl_attempts + review_rejections > 5`
- Convergence fails after max attempts
- A review reveals the task is more complex than the scope anticipated
  (unexpected dependencies, architectural issues)

Include in the escalation: counter values, failure output, the failure pattern,
and options (adjust scope, skip the problematic slice, switch to
`circuit:develop`, or abort).
