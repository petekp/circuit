---
name: circuit:review
description: >
  Standalone fresh-context code review. Use when code was changed manually or via
  plain Claude and you want an independent audit. Same schema and verdict language
  as review phases inside other workflows. One mental model across all circuits.
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
- Output: `${step_dir}/review-findings.md`

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${step_dir}/prompt-header.md \
  --skills <domain-skills> \
  --root "${step_dir}" \
  --out ${step_dir}/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${step_dir}/prompt.md \
  --output ${step_dir}/last-messages/last-message.txt \
  --role reviewer
```

## Phase: Verification Rerun

If verification commands are available (from brief.md, plan.md, or user-provided),
re-run them and record results.

If no verification commands are available, run the project's default test suite.

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
