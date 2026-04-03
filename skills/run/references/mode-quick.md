# Mode: Quick

Clear task, known approach. The lightest path through the supergraph.

**Path:** triage -> scope -> confirm -> implement -> summarize

## Step: scope (synthesis)

Read the task and codebase. Write `artifacts/scope.md`:

```markdown
# Scope: <task>
## Task
<what needs to happen>
## Approach
<how to do it -- concrete, not abstract>
## Slices
<ordered list of implementation slices>
## Verification
<commands to verify success>
## Out of Scope
<what we are NOT doing>
```

**Augmentation injection:** If triage-result.md includes augmentations:
- Bug: Add `## Regression Contract` after Slices. List the failing test(s) to write
  before any code changes. The regression test becomes Slice 0.
- Migration: Add `## Coexistence Plan` after Slices. Describe how old and new
  coexist during the change.
- Cleanup: Add `## Removal Evidence` after Slices. List evidence that each removed
  item is genuinely dead.

**Mixed-signal handling:** If triage-result.md has a Secondary Signal, create a
prerequisite slice (Slice 0) addressing the secondary concern.

**Ambiguity check:** If the task is genuinely ambiguous (more than one reasonable
interpretation), ask ONE clarifying question before writing scope.md. Do not ask
if the task is clear.

**Gate:** scope.md exists with non-empty Task, Approach, Slices, Verification,
and Out of Scope sections.

**Route:** emit `pass` -> confirm

## Step: confirm (checkpoint)

Present scope.md to the user. Ask:

> Here is the proposed scope. Confirm, amend, or switch circuits?

Write `artifacts/scope-confirmed.md` (copy of scope.md with any amendments).

**Gate:** User selects `confirm` or `amend`.
- confirm -> implement
- amend -> scope (re-run with user's amendments)

## Step: implement (dispatch via workers)

Create the workers workspace:

```bash
IMPL_ROOT="${RUN_ROOT}/phases/implement"
mkdir -p "${IMPL_ROOT}/archive" "${IMPL_ROOT}/reports" "${IMPL_ROOT}/last-messages"
cp ${RUN_ROOT}/artifacts/scope-confirmed.md ${IMPL_ROOT}/CHARTER.md
```

Write prompt header at `${IMPL_ROOT}/prompt-header.md`:
- Mission: Implement the task described in CHARTER.md
- Inputs: Full scope-confirmed.md
- Output: convergence report
- Success criteria: All slices complete, tests pass

Compose and dispatch:
```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${IMPL_ROOT}/prompt-header.md \
  --skills workers,<domain-skills> \
  --root ${IMPL_ROOT} \
  --out ${IMPL_ROOT}/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${IMPL_ROOT}/prompt.md \
  --output ${IMPL_ROOT}/last-messages/last-message-workers.txt \
  --role implementer
```

After workers complete, synthesize `artifacts/implementation-handoff.md`:
```markdown
# Implementation Handoff: <task>
## What Was Built
## Tests Run and Verification Results
## Convergence Verdict
## Open Issues
```

**Gate:** implementation-handoff.md exists AND convergence = COMPLETE AND HARDENED.

**Route:** emit `to_summary` -> summarize

## Step: summarize (synthesis)

Read scope-confirmed.md and implementation-handoff.md. Write `artifacts/done.md`:

```markdown
# Done: <task>
## Changes
<what was changed, files affected>
## Verification
<test results, verification command output>
## Notes
<anything the user should know>
```

**Gate:** done.md exists with non-empty Changes, Verification, Notes.

**Route:** emit `pass` -> @complete
