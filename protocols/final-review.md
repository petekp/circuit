# Protocol: Final Review

## Purpose

This protocol covers the assessment-only review dispatch used as the terminal
quality gate in several circuits. The worker audits the implementation against
the execution contract and original intent, produces structured findings by
severity, and issues a SHIP-READY or ISSUES FOUND verdict. The worker does NOT
modify source code -- if issues are found, the orchestrator handles remediation
separately before re-running the review.

Circuits that use this protocol: `develop` (Step 10), `ratchet-quality`
(Step 16), `harden-spec` (Step 10, as plan review), `cleanup` (Step 7).

## Prerequisites

Before invoking this protocol, the circuit must have:

1. An **execution contract** -- the artifact that defines what was supposed to
   be built. Examples: `execution-packet.md`, `execution-charter.md`,
   `scope-confirmed.md`.
2. An **implementation evidence artifact** -- the artifact that records what
   was actually built. Examples: `implementation-handoff.md`,
   `execution-report.md`, `cleanup-batches.md`.
3. Optionally, an **intent artifact** -- the original user intent for
   fit-to-intent assessment. Examples: `intent-brief.md`, `mission-brief.md`,
   `failure-brief.md`.
4. The current repo state with implementation changes applied.

## Dispatch

### Setup

```bash
REVIEW_ROOT="${RUN_ROOT}/phases/<step-name>"
mkdir -p "${REVIEW_ROOT}/reports" "${REVIEW_ROOT}/last-messages"
```

### Header Schema

Write `${REVIEW_ROOT}/prompt-header.md` using the canonical header schema:

```markdown
# Step N: <Review Title>

## Mission
Audit the implementation against the execution contract and original intent.
Check for contract drift, correctness bugs, naming issues, dead code, missing
tests, and residue. Do NOT modify source code -- diagnose only.

## Inputs
[Full execution contract, full implementation evidence, digested intent artifact,
current repo state]

## Output
- **Path:** `${REVIEW_ROOT}/<review-artifact>.md`
- **Schema:** [See Output Schema below]

## Success Criteria
Every finding references a contract section or intent item. Findings are
categorized by severity, not listed as a flat list.

## Report Instructions
Write your primary output to the path above. Also write a standard report to
`reports/report.md` with these exact section headings:

### Files Changed
### Tests Run
### Verification
### Verdict
### Completion Claim
### Issues Found
### Next Steps
```

### Compose and Dispatch

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${REVIEW_ROOT}/prompt-header.md \
  --skills <domain-skills> \
  --root ${REVIEW_ROOT} \
  --out ${REVIEW_ROOT}/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${REVIEW_ROOT}/prompt.md \
  --output ${REVIEW_ROOT}/last-messages/last-message.txt
```

Do not include `workers` in the skills list -- this is a standalone dispatch,
not a workers delegation. Domain skills are optional; review-only steps often
use zero domain skills unless domain semantics would be underspecified.

### Verify and Promote

```bash
test -f ${REVIEW_ROOT}/<review-artifact>.md
cp ${REVIEW_ROOT}/<review-artifact>.md ${RUN_ROOT}/artifacts/<review-artifact>.md
```

If the worker only wrote `reports/report.md`, the orchestrator reads it and
synthesizes the review artifact manually using the output schema.

## Output Schema

The standard ship-review output format:

```markdown
# Ship Review: <subject>

## Contract Compliance (execution contract vs actual)

## Findings
### Critical (must fix before ship)
### High (should fix)
### Low (acceptable debt)

## Intentional Debt (deferred with rationale)

## Fit-to-Intent Assessment (compare to intent artifact)

## Verdict: SHIP-READY / ISSUES FOUND
```

Circuit-specific variants exist:

| Circuit | Review artifact | Variant sections |
|---------|----------------|-----------------|
| `develop` | `ship-review.md` | Standard schema above |
| `ratchet-quality` | `final-review.md` | Scope Reviewed, Review Coverage, Findings By Severity, Deferred Debt, Blockers, Verdict, Ready Means, Reopen Decision |
| `harden-spec` | `plan-review.md` | Plan Strengths, Blocking Gaps, Sequence Risks, Missing Verification, Approval Conditions, Verdict: READY / REVISE |
| `cleanup` | `verification-audit.md` | Build Result, Test Result, Verify Result, Warning Delta, Diff Sanity Check, Manifest Cross-Check, Candidate Verdict |

The verdict vocabulary also varies:
- `develop`: `SHIP-READY` / `ISSUES FOUND`
- `ratchet-quality`: `ship_ready` / `partial` / `reopen_execute`
- `harden-spec`: `READY` / `REVISE`
- `cleanup`: `CLEAN` / `ISSUES FOUND`

## Verdict Handling

### SHIP-READY Path

Circuit complete (or continues to the next synthesis step if one exists). The
review artifact becomes the terminal or near-terminal artifact in the chain.

### ISSUES FOUND Path

1. The orchestrator reads the review findings and addresses critical issues.
   This may involve:
   - Direct orchestrator fixes for small issues
   - A targeted worker dispatch for larger fixes
   - Updating the implementation artifact to reflect changes
2. Re-run the review step (same dispatch pattern, fresh worker session).
3. Maximum 2 total review attempts.

### Re-run Logic

After addressing critical findings:
- Re-dispatch with an updated header that includes the prior findings and
  what was fixed.
- The review worker starts fresh -- it does not carry forward prior context.
- If the second attempt still says ISSUES FOUND with critical findings,
  escalate.

## Circuit Breaker

Escalate to the user when:

- Ship review says ISSUES FOUND after 2 attempts
- The findings suggest structural problems that cannot be fixed locally
  (wrong approach, missing architecture, scope mismatch)
- The review worker contradicts itself between attempts on the same finding

Include in the escalation: the specific critical findings that persist, what
was attempted, and options (fix and re-review, accept as-is with documented
debt, reopen an upstream step, or abort).
