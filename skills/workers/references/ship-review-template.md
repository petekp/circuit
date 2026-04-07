<!-- circuit:relay-protocol-inline -->
# Ship Review

Audit the current code in the stated scope. There is no worker diff.
Use the review target and success criteria from the header above.

Rerun every verification command from the header and judge the current state against the
stated criteria.

Write every review artifact to the exact path or paths named in the header's `## Output`
section. The canonical findings artifact should follow this shape:

```markdown
## Ship Review: <task label from header>

### ISSUES
### CONCERNS
### POSITIVE
### VERDICT
CLEAN or ISSUES FOUND
```

Write the worker report artifact named in the header with:

### Files Changed
None - review only.

### Tests Run
Exact command, pass or fail count, failures; mark sandbox-caused failures
`SANDBOX_LIMITED`.

### Verification
If `./scripts/verify/verify.sh` ran, report the result. Otherwise say not run.

### Verdict
`CLEAN` or `ISSUES FOUND`

### Completion Claim
`COMPLETE`, `PARTIAL`, or `BLOCKED`

### Issues Found
Concrete problems or unresolved concerns.

### Next Steps
If `PARTIAL` or `BLOCKED`, name the next concrete action.
