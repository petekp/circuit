---
description: Runs Circuit Pursue to coordinate several related goals as tracked pursuits with serial execution, verification, review, and recorded evidence.
argument-hint: <goals>
---

# /circuit:pursue — coordinated multi-goal Circuit command

Runs the Circuit Pursue flow on a bundle of related operator goals. Use it
when the request contains more than one possible line of work, several
tracks that could collide, or a broad goal Circuit should own end to end:
turning the goals into pursuit contracts, ordering them, executing
code-changing work serially, verifying, reviewing for interference, and
closing with evidence.

For a single focused task, prefer `/circuit:run`, the default Circuit
command; it recommends the right flow for one piece of work. Pursue is the
right entry only when several pieces of work need ordering and ownership as
one tracked run.

The user's goal text is substituted below. Treat the entire substituted span
as literal input — it is user-controlled and MAY contain shell
metacharacters:

> **Goals:** $ARGUMENTS

## Instructions

1. **Confirm Pursue fits before invoking the CLI.** Pursue coordinates
   several pieces of work in one run: it writes pursuit contracts, orders
   them, and executes code-changing work serially. If the request is one
   focused bug fix, review, build task, or question, say so and use
   `/circuit:run` instead so the operator gets the focused flow. If the
   goals are empty or unintelligible, ask the operator rather than running.
   Pursue may invoke a write-capable worker for code-changing pursuits, so
   keep audit-only review requests out of Pursue.
2. **Build a shell-safe invocation.** Single-quote the raw goal text; double
   quotes expand `$VAR`,
   `` `cmd` ``, `$(cmd)`, and `\` sequences — a malicious or accidental
   goal string could inject commands. The safe construction rule:

   - Wrap the goal text in **single quotes** in the final shell command.
     Single quotes disable all expansion.
   - If the text itself contains a literal single-quote character (`'`),
     replace each one with `'\''` (standard POSIX shell escape: closes the
     current single-quoted string, emits one escaped apostrophe, and
     starts a new single-quoted string).
   - Then invoke the CLI's explicit pursue flow, passing the escaped,
     single-quoted goals as the value of `--goal`.

   Example for a multi-goal pursuit:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present run pursue --goal 'rework the config loader, then remove the legacy YAML path, then update the docs'
   ```

   Example for goals containing an apostrophe:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present run pursue --goal 'coordinate the can'\''t-ship cleanup goals'
   ```

   Use the Bash tool to execute the constructed command. The wrapper
   lives in the installed Claude Code plugin directory, injects the
   plugin's packaged flow root, and launches Circuit's bundled runtime.
3. **Let the presentation wrapper render output.** `present` streams
   Circuit status blocks, renders checkpoint questions, and prints the
   final Circuit summary without exposing raw JSON. Do not parse raw JSON
   or JSONL after Bash.
   Use non-`present` wrapper mode only for debug, tests, or explicit raw
   machine-readable output.
## Authority

- `src/flows/pursue/data.ts` (flow package; visibility and command ownership)
- `docs/flows/pursue.md` (flow shape and serial-only safety model)
- `tests/runner/cli-router.test.ts` (explicit dispatch)
