<!-- circuit:relay-protocol-inline -->
# Adversarial Review

Inspect the implementation diff with `git diff --stat` and `git diff`.
Use the original task, success criteria, and worker claim from the header above.
If the header is missing one of those inputs, call out the gap in the report instead
of guessing.

Rerun every verification command from the header. If a command the worker claimed passed
does not pass for you, verdict = `ISSUES FOUND`.

Write every review artifact to the exact path or paths named in the header's `## Output`
section. The canonical findings artifact should follow this shape:

```markdown
## Review: <task label from header>

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
