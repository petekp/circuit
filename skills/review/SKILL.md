---
name: review
description: >
  Standalone fresh-context code review. Use when code was changed manually or via
  plain Claude and you want an independent audit. Same schema and verdict language
  as review phases inside other workflows. One mental model across all circuits.
role: utility
trigger: >
  Use for /circuit:review, or when the user wants an independent code review.
---

# Review

Standalone fresh-context audit. Not every review needs to go through a full circuit.

## Phases

Intake -> Independent Audit -> Verification Rerun -> Verdict

## Phase: Intake

Determine what to review:

1. If the user specifies files or a diff: use that scope.
2. If there are uncommitted changes: review those.
3. If there is a recent commit or branch diff: review that.
4. Ask if unclear.

Gather context:
- What was the intent of these changes?
- Are there verification commands to run?
- Is there a brief.md or plan.md from a prior circuit run? If so, review against those.

No artifact written. This is context gathering.

## Phase: Independent Audit

Dispatch a reviewer in a fresh context.

```bash
step_dir="${RUN_ROOT:-$(mktemp -d)}/phases/review"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

Write prompt header at `${step_dir}/prompt-header.md`:
- Mission: Audit the changes. Check correctness, constraint violations, missing
  test coverage, scope drift, naming, dead code, security concerns. Do NOT modify
  source code -- diagnose only.
- Inputs: diff or file list, any available brief.md/plan.md context
- Output: `${step_dir}/reports/review-report.md`

```bash
# Pick 1-2 domain skills matching the affected code. Omit --skills if none apply.
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header "${step_dir}/prompt-header.md" \
  --skills "rust,tdd" \
  --root "${step_dir}" \
  --out "${step_dir}/prompt.md"

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt "${step_dir}/prompt.md" \
  --output "${step_dir}/last-messages/last-message.txt" \
  --circuit review \
  --role reviewer
```

## Phase: Verification Rerun

Resolve verification commands in this order. Use the first source that provides
concrete commands. Do not combine sources or invent commands.

1. **User-supplied:** Explicit commands provided by the user in this session.
2. **Artifact-declared:** Commands in brief.md `## Verification Commands` or
   plan.md `## Verification Commands` from the current or prior circuit run.
3. **Repo-declared:** Narrowly inferable commands from project configuration:
   - `package.json` scripts: `test`, `check`, `lint`, `typecheck`
   - `Makefile` / `justfile` / `Taskfile`: `test`, `check`, `lint` targets
   - Python: `pytest` (if `pyproject.toml`/`setup.cfg` configures it), `tox`
   - Rust: `cargo test`, `cargo clippy`
   - Go: `go test ./...`
   Only use commands the repo explicitly declares. Do not guess.
4. **None available:** Record "No authoritative verification command available"
   in review.md. This is a valid outcome, not a failure.

**Do not** run an expansive or expensive test command that the repo does not
clearly declare. Do not fall back to running "the project's default test suite"
as a vague catch-all.

Record in review.md exactly which source was used and which commands were run
(or that none were available).

## Phase: Verdict

Synthesize into `review.md` (or `artifacts/review.md` if inside a circuit run):

```markdown
# Review: <scope description>
## Contract Compliance
<if brief.md/plan.md exist: does implementation match?>
<if no contract: N/A -- standalone review>
## Findings
### Critical (must fix before ship)
<findings that block shipping>
### High (should fix)
<findings that should be addressed>
### Low (acceptable debt)
<minor issues or style concerns>
## Verification Rerun
<command outputs, pass/fail>
## Verdict: CLEAN | ISSUES FOUND
```

**Verdict rules:**
- **CLEAN:** No critical or high findings. Verification passes. Ship it.
- **ISSUES FOUND:** At least one critical or high finding. List what needs attention.

Present the verdict to the user with a summary:

> **Review verdict: CLEAN** -- No issues found. Verification passes.

or:

> **Review verdict: ISSUES FOUND** -- N critical, M high findings. See review.md for details.

## No Circuit Overhead

This utility does not write brief.md, plan.md, or result.md. It produces exactly
one artifact: review.md. It does not require a run root (creates a temp directory
if needed). It does not update active-run.md unless called from within a workflow.

## When Called From Within a Workflow

When the Review phase of Build, Repair, Migrate, or Sweep dispatches a review,
it uses the same schema and verdict language defined here. The only difference:
- The artifact goes to `${RUN_ROOT}/artifacts/review.md`
- Contract compliance checks against brief.md and plan.md
- The workflow handles the ISSUES FOUND retry loop
