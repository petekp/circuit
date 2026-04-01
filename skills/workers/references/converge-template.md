# Convergence Assessment

Final quality gate. Do not modify source. Decide only `COMPLETE AND HARDENED` or
`ISSUES REMAIN`.

Use the original mission, completed-slice summaries, and verification union from the
header above. If the header includes structured slice summaries, audit against them; if
it does not, call out the missing evidence explicitly in the report.

Independently:
- review the full diff against the baseline described in the header
- rerun the union of verification commands listed in the header
- confirm completeness, residue cleanup, consistent terms and patterns, adequate tests,
  and clean diff hygiene

Treat permission, bind, and sandbox failures as `SANDBOX_LIMITED`; note them separately.
They do not block a hardened verdict by themselves.

If issues remain, list slice candidates in this format:

```markdown
- **Issue**: [description]
  **Scope**: [files or directories]
  **Severity**: [must-fix | should-fix | nice-to-have]
  **Suggested approach**: [how to address it]
```

Write the convergence report to the exact path named in the header's `## Output`
section, using:

### Files Changed
None - assessment only.

### Tests Run
Exact command, pass or fail count, failures; mark sandbox-caused failures
`SANDBOX_LIMITED`.

### Verification
If `./scripts/verify/verify.sh` ran, report the result. Otherwise say not run.

### Verdict
`COMPLETE AND HARDENED` or `ISSUES REMAIN`

### Completion Claim
`COMPLETE`, `PARTIAL`, or `BLOCKED`

### Issues Found
Anything that blocks a hardened verdict or still looks risky.

### Next Steps
If the verdict is not hardened, name the next concrete action.
