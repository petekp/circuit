# Protocol: Workers Execute

## Purpose

This protocol covers the full workers delegation pattern: setting up a child
workspace, writing a CHARTER.md, assembling and dispatching the workers prompt,
and synthesizing the parent artifact from workers output. Use this protocol
whenever a circuit step delegates its implementation phase to the `workers`
skill for an implement -> review -> converge cycle.

Circuits that use this protocol: `develop` (Step 9), `run` (Step 3),
`repair-flow` (Step 7), `ratchet-quality` (Steps 3, 13, 15), `cleanup`
(Step 6).

## Prerequisites

Before invoking this protocol, the circuit must have:

1. A **source contract artifact** -- the upstream artifact that defines what
   workers must build. Examples: `execution-packet.md`, `scope-confirmed.md`,
   `repair-packet.md`, `execution-charter.md`.
2. A known `RUN_ROOT` for the current circuit run.
3. Domain skills selected per the circuit's Domain Skill Selection rules.

## Workspace Setup

Create the child root with the standard directory layout:

```bash
CHILD_ROOT="${RUN_ROOT}/phases/<step-name>"
mkdir -p "${CHILD_ROOT}/archive" "${CHILD_ROOT}/reports" \
  "${CHILD_ROOT}/last-messages" "${CHILD_ROOT}/review-findings"
```

All four directories are required. `archive/` holds reverted or superseded
state. `reports/` holds worker output including slice reports and the
convergence report. `last-messages/` holds raw worker output traces.
`review-findings/` holds review worker output.

Some circuits use variant child root paths:
- `ratchet-quality` Step 3: `${RUN_ROOT}/phases/step-3/attempts/<attempt-id>`
- `ratchet-quality` Step 13: `${RUN_ROOT}/phases/step-13/batches/<batch-id>`
- `ratchet-quality` Step 15: `${RUN_ROOT}/phases/step-15/repairs/<repair-id>`
- `cleanup` Step 6: `${RUN_ROOT}/phases/step-6/batches/<batch-id>`

The directory layout is identical regardless of path depth.

### CHARTER.md Creation

Write `${CHILD_ROOT}/CHARTER.md` from the source contract artifact. The
mapping depends on the circuit:

| Circuit | Source artifact | Mapping |
|---------|---------------|---------|
| `develop` | `execution-packet.md` | Direct copy |
| `run` | `scope-confirmed.md` | Translate scope sections to charter fields |
| `repair-flow` | `repair-packet.md` + `regression-contract.md` | Concatenate |
| `ratchet-quality` | Step-specific charter (varies by step) | Per-step schema |
| `cleanup` | Per-batch manifest | Batch Items, Evidence References, Allowed File Scope, Verification Commands, Revert Rule |

The charter is the single source of truth for the workers loop. Everything the
worker needs must be in CHARTER.md or composed into the prompt -- workers do
not read upstream circuit artifacts directly.

## Prompt Assembly

### Writing the Prompt Header

Write `${CHILD_ROOT}/prompt-header.md` using the circuit's canonical header
schema:

```markdown
# Step N: <title>

## Mission
Implement the work described in CHARTER.md using the workers
implement -> review -> converge cycle.

## Inputs
[Full text of the source contract, already copied as CHARTER.md]

## Output
- **Path:** `${CHILD_ROOT}/reports/report-converge.md`
- **Schema:** workers convergence report format

## Success Criteria
All slices converged with `COMPLETE AND HARDENED` verdict.

## Report Instructions
Write your primary output to the path above. Also write a standard report to
`reports/report.md` with these exact section headings:

### Files Changed
[List files modified or created]

### Tests Run
[List test commands and results, or "None" if no tests]

### Verification
[How the output was verified]

### Verdict
[CLEAN / ISSUES FOUND]

### Completion Claim
[COMPLETE / PARTIAL]

### Issues Found
[List any issues, or "None"]

### Next Steps
[What the next phase should focus on]
```

The Report Instructions section with exact relay headings is required.
`compose-prompt.sh` checks for `### Files Changed`, `### Tests Run`, and
`### Completion Claim`. If missing, it appends `relay-protocol.md` which
contains unresolved `{slice_id}` placeholders that contaminate the prompt.

Also include in the header:
- Domain skills and verification commands from the source contract
- Any circuit-specific constraints (slice order, boundary ownership, etc.)

### Composing the Prompt

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${CHILD_ROOT}/prompt-header.md \
  --skills workers,<domain-skills> \
  --root ${CHILD_ROOT} \
  --out ${CHILD_ROOT}/prompt.md
```

The `workers` skill is always first in the skills list. Domain skills follow.
Never exceed 3 total skills. The `--root` flag resolves `{relay_root}` tokens
in the assembled prompt.

## Dispatch

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${CHILD_ROOT}/prompt.md \
  --output ${CHILD_ROOT}/last-messages/last-message-workers.txt
```

The dispatch helper auto-detects the backend:
- **Codex CLI** (when `codex` is on PATH): pipes the prompt to
  `codex exec --full-auto`
- **Agent fallback** (when Codex is not installed): invokes the Claude Code
  Agent tool with `isolation: "worktree"`

The artifact chain, gates, and report format are identical regardless of
backend.

## Post-Dispatch Synthesis

After workers completes, the orchestrator reads child state and synthesizes
the parent circuit artifact. Always read in this order:

1. `${CHILD_ROOT}/reports/report-converge.md` -- the convergence verdict
   (primary source of truth)
2. `${CHILD_ROOT}/batch.json` -- slice metadata showing what was built
3. `${CHILD_ROOT}/reports/report-<last-slice-id>.md` -- the last
   implementation slice report (find the slice id from `batch.json`)

**Important:** Workers review workers may overwrite per-slice report files.
If a slice report is missing or appears to be a review artifact, use
`batch.json` slice metadata and the convergence report to reconstruct what
was built. Do not guess from chat residue.

### Writing the Parent Artifact

The parent artifact schema varies by circuit:

| Circuit | Parent artifact | Key sections |
|---------|----------------|-------------|
| `develop` | `implementation-handoff.md` | What Was Built, Tests Run, Convergence Verdict, Open Issues |
| `run` | `execution-handoff.md` | What Was Built, Tests Run, Convergence Verdict, Open Issues |
| `repair-flow` | `repair-handoff.md` | Slices Implemented, Files Touched, Tests Added, Verification, Residual Risks, Verdict |
| `ratchet-quality` | Varies by step | Step-specific schema from the circuit's SKILL.md |
| `cleanup` | `cleanup-batches.md` (appended per batch) | Items, Verification, Disposition |

## Gate

The protocol is complete when:

1. The parent artifact exists at its expected path
2. The convergence verdict is `COMPLETE AND HARDENED`
3. Verification commands from the source contract pass

If convergence says `ISSUES REMAIN`, the workers loop should have addressed
them internally. If it did not, escalate to the user.

### Verification

```bash
test -f ${CHILD_ROOT}/reports/report-converge.md
test -f ${RUN_ROOT}/artifacts/<parent-artifact>.md
```

## Circuit Breaker

Escalate to the user when:

- Any workers slice hits `impl_attempts > 3` or
  `impl_attempts + review_rejections > 5`
- Convergence fails after max attempts (circuit-specific retry budget)
- A review reveals the task is more complex than the source contract
  anticipated (unexpected dependencies, architectural issues)
- Workers reports a scope violation (out-of-scope edits detected)

Include in the escalation: counter values, failure output, the failure
pattern, and options (adjust scope, skip the problematic slice, switch
circuits, or abort).

### Retry and Revert

- Retry budgets are circuit-specific. `ratchet-quality` uses per-batch
  budgets from `execution-charter.md`. Other circuits typically allow 1-2
  full workers dispatches per step.
- Revert means `git reset --hard <baseline-commit>` for the allowed file
  scope. The baseline commit should be recorded in CHARTER.md under
  `## Baseline Commit` before dispatch.
- On revert, archive the child root state and record the reverted SHA and
  reason in the parent artifact.
