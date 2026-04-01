# Relay Protocol

Canonical reference. Templates inline this now. `compose-prompt.sh` appends this file only
for legacy templates that do not already contain report sections.

Write report files to the exact path or paths named in the header's `## Output`
section.

Common patterns:
- implement or review main report: `<relay-root>/reports/report-<slice-id>.md`
- converge report: `<relay-root>/reports/report-converge.md`
- fallback report: `<relay-root>/reports/report.md`
- canonical review findings: `<relay-root>/review-findings/review-findings-<slice-id>.md`

Required sections:
- `### Files Changed`
- `### Tests Run` - exact command, pass or fail count, failures; mark sandbox-caused
  failures `SANDBOX_LIMITED`
- `### Verification` - verifier result or `not run`
- `### Verdict`
  - review: `CLEAN` or `ISSUES FOUND`
  - converge: `COMPLETE AND HARDENED` or `ISSUES REMAIN`
  - implement: `N/A - implementation report`
- `### Completion Claim` - `COMPLETE`, `PARTIAL`, or `BLOCKED`
- `### Issues Found`
- `### Next Steps` - required for `PARTIAL` or `BLOCKED`

The canonical review verdict still lives in the review-findings artifact named in the
header. Echo it in the report so the orchestrator can cross-check artifacts.
